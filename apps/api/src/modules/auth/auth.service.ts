/**
 * Logique d'authentification : inscription, connexion, rotation des refresh tokens, déconnexion.
 * Ne connaît ni HTTP (cookies posés par les routes) ni SQL (délégué aux repositories).
 */
import { randomUUID } from 'node:crypto';
import type { CreateStaffUserRequest, RegisterPatientRequest, UserDto } from '@cura/shared';
import { NotFoundError, UnauthorizedError } from '../../common/errors';
import type { PasswordHasher } from '../../common/security/password-hasher';
import { type AccessTokenService, randomToken, sha256Hex } from '../../common/security/tokens';
import type { TransactionManager } from '../../infra/db/transaction';
import type { AppLogger } from '../../infra/logger';
import type { PatientsRepository } from '../patients/patients.repository';
import type { AuthRepository, UserRecord } from './auth.repository';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
/** Fenêtre pendant laquelle un jeton tout juste tourné n'est pas considéré comme volé (2 onglets qui rafraîchissent ensemble). */
const ROTATION_GRACE_MS = 30_000;

export interface ClientContext {
  ip?: string;
  userAgent?: string;
}

export interface Session {
  user: UserDto;
  accessToken: string;
  accessTokenTtlSeconds: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  csrfToken: string;
}

interface AuthServiceDeps {
  tx: TransactionManager;
  auth: AuthRepository;
  patients: PatientsRepository;
  hasher: PasswordHasher;
  accessTokens: AccessTokenService;
  refreshTtlDays: number;
  logger: AppLogger;
}

const invalidCredentials = () => new UnauthorizedError('INVALID_CREDENTIALS', 'Email ou mot de passe incorrect');
const invalidRefresh = () => new UnauthorizedError('INVALID_REFRESH_TOKEN', 'Session expirée, veuillez vous reconnecter');

export function toUserDto(u: Pick<UserRecord, 'id' | 'email' | 'role' | 'patientId' | 'doctorId'>): UserDto {
  return { id: u.id, email: u.email, role: u.role, patientId: u.patientId, doctorId: u.doctorId };
}

export class AuthService {
  private dummyHash?: Promise<string>;

  constructor(private readonly deps: AuthServiceDeps) {}

  /** Inscription patient (app mobile) : dossier patient + compte, atomiquement. */
  async registerPatient(input: RegisterPatientRequest, ctx: ClientContext): Promise<Session> {
    const passwordHash = await this.deps.hasher.hash(input.password);
    const user = await this.deps.tx.run(async (db) => {
      const patient = await this.deps.patients.create(
        {
          firstName: input.firstName,
          lastName: input.lastName,
          birthDate: input.birthDate,
          phone: input.phone,
          email: input.email,
        },
        db,
      );
      return this.deps.auth.createUser({ email: input.email, passwordHash, role: 'patient', patientId: patient.id }, db);
    });
    this.deps.logger.info({ event: 'auth.registered', userId: user.id }, 'patient registered');
    return this.openSession(user, ctx);
  }

  async createStaffUser(input: CreateStaffUserRequest, actorId: string): Promise<UserDto> {
    const passwordHash = await this.deps.hasher.hash(input.password);
    const user = await this.deps.auth.createUser({
      email: input.email,
      passwordHash,
      role: input.role,
      doctorId: input.doctorId ?? null,
    });
    this.deps.logger.info({ event: 'auth.staff_created', userId: user.id, role: user.role, actorId }, 'staff user created');
    return toUserDto(user);
  }

  async login(email: string, password: string, ctx: ClientContext): Promise<Session> {
    const { auth, hasher, logger } = this.deps;
    const user = await auth.findUserByEmail(email);

    if (!user) {
      // Même coût de calcul qu'un vrai compte : on ne révèle pas quels emails existent.
      await hasher.verify(password, await this.getDummyHash());
      logger.info({ event: 'auth.login_failed', reason: 'unknown_email', ip: ctx.ip }, 'login failed');
      throw invalidCredentials();
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      logger.warn({ event: 'auth.login_blocked', userId: user.id, ip: ctx.ip }, 'login attempt on locked account');
      throw new UnauthorizedError('ACCOUNT_LOCKED', `Compte temporairement verrouillé. Réessayez dans ${LOCK_MINUTES} minutes.`);
    }

    const valid = await hasher.verify(password, user.passwordHash);
    if (!valid || !user.isActive) {
      await auth.recordLoginFailure(user.id, MAX_FAILED_LOGINS, LOCK_MINUTES);
      logger.info({ event: 'auth.login_failed', reason: valid ? 'inactive' : 'bad_password', userId: user.id, ip: ctx.ip }, 'login failed');
      throw invalidCredentials();
    }

    // Paramètres de hachage durcis depuis l'inscription ? On re-hache de façon transparente.
    const rehash = hasher.needsRehash(user.passwordHash) ? await hasher.hash(password) : undefined;
    await auth.recordLoginSuccess(user.id, rehash);
    logger.info({ event: 'auth.login', userId: user.id, role: user.role, ip: ctx.ip }, 'login succeeded');
    return this.openSession(user, ctx);
  }

  /**
   * Rotation : chaque refresh token ne sert qu'UNE fois. Présenter un jeton déjà
   * tourné (hors fenêtre de grâce) = vol probable → toute la famille est révoquée.
   */
  async refresh(rawToken: string, ctx: ClientContext): Promise<Session> {
    const { tx, auth, logger } = this.deps;
    const tokenHash = sha256Hex(rawToken);

    const outcome = await tx.run(async (db) => {
      const token = await auth.findRefreshTokenForUpdate(tokenHash, db);
      if (!token) return { kind: 'invalid' as const };

      if (token.revokedAt) {
        const recentlyRotated =
          token.revokedReason === 'rotated' && Date.now() - token.revokedAt.getTime() < ROTATION_GRACE_MS;
        if (recentlyRotated) return { kind: 'invalid' as const };
        // La révocation doit être COMMITÉE : on ne lève pas d'erreur dans la transaction.
        await auth.revokeFamily(token.familyId, 'reuse_detected', db);
        return { kind: 'reused' as const, userId: token.userId };
      }
      if (token.expiresAt <= new Date()) return { kind: 'invalid' as const };

      const user = await auth.findUserById(token.userId, db);
      if (!user || !user.isActive) return { kind: 'invalid' as const };

      const next = await this.issueRefreshToken(user.id, token.familyId, ctx, db);
      await auth.revokeToken(token.id, 'rotated', next.id, db);
      return { kind: 'ok' as const, user, next };
    });

    if (outcome.kind === 'reused') {
      logger.warn({ event: 'auth.refresh_reuse_detected', userId: outcome.userId, ip: ctx.ip }, 'refresh token reuse detected — family revoked');
      throw invalidRefresh();
    }
    if (outcome.kind === 'invalid') throw invalidRefresh();

    return this.buildSession(outcome.user, outcome.next.raw, outcome.next.expiresAt);
  }

  /** Révoque toute la famille (l'appareil courant). Idempotent. */
  async logout(rawToken: string | undefined, userId?: string): Promise<void> {
    if (!rawToken) return;
    const familyId = await this.deps.auth.findFamilyByTokenHash(sha256Hex(rawToken));
    if (familyId) await this.deps.auth.revokeFamily(familyId, 'logout');
    this.deps.logger.info({ event: 'auth.logout', userId }, 'logout');
  }

  async me(userId: string): Promise<UserDto> {
    const user = await this.deps.auth.findUserById(userId);
    if (!user || !user.isActive) throw new NotFoundError('Utilisateur');
    return toUserDto(user);
  }

  private async openSession(user: UserRecord, ctx: ClientContext): Promise<Session> {
    const next = await this.issueRefreshToken(user.id, randomUUID(), ctx);
    return this.buildSession(user, next.raw, next.expiresAt);
  }

  private async issueRefreshToken(
    userId: string,
    familyId: string,
    ctx: ClientContext,
    db?: Parameters<AuthRepository['insertRefreshToken']>[1],
  ) {
    const raw = randomToken(32);
    const expiresAt = new Date(Date.now() + this.deps.refreshTtlDays * 86_400_000);
    const id = await this.deps.auth.insertRefreshToken(
      { userId, familyId, tokenHash: sha256Hex(raw), expiresAt, userAgent: ctx.userAgent, ip: ctx.ip },
      db,
    );
    return { id, raw, expiresAt };
  }

  private buildSession(user: UserRecord, refreshToken: string, refreshExpiresAt: Date): Session {
    const { accessTokens } = this.deps;
    return {
      user: toUserDto(user),
      accessToken: accessTokens.sign({ sub: user.id, role: user.role, pid: user.patientId, did: user.doctorId }),
      accessTokenTtlSeconds: accessTokens.ttlSeconds,
      refreshToken,
      refreshExpiresAt,
      csrfToken: randomToken(24),
    };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.deps.hasher.hash(randomToken());
    return this.dummyHash;
  }
}
