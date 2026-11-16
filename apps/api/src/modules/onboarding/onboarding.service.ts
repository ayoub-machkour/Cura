/**
 * Activation du compte mobile d'un patient DÉJÀ connu du cabinet.
 *
 * Le cabinet génère un code à usage unique (le patient a été identifié au guichet) ;
 * le patient le saisit avec sa date de naissance. Son compte est alors rattaché à son
 * dossier existant : il retrouve automatiquement tout son historique.
 *
 * Pourquoi pas un rattachement automatique par téléphone ? Un numéro est partagé
 * (famille) ou recyclé : on exposerait le dossier médical d'un tiers.
 *
 * Sécurité : code de ~40 bits d'entropie, stocké haché, usage unique, expiration
 * 7 jours, une seule invitation active par patient, blocage après 5 dates de
 * naissance erronées, réponse d'erreur identique quel que soit le motif.
 */
import { randomInt } from 'node:crypto';
import { type ClaimAccountRequest, INVITATION_ALPHABET, INVITATION_CODE_LENGTH, type InvitationResponse } from '@cura/shared';
import type { Clock } from '../../common/clock';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../common/errors';
import type { PasswordHasher } from '../../common/security/password-hasher';
import { sha256Hex } from '../../common/security/tokens';
import type { TransactionManager } from '../../infra/db/transaction';
import type { AppLogger } from '../../infra/logger';
import type { AuthRepository } from '../auth/auth.repository';
import type { AuthService, ClientContext, Session } from '../auth/auth.service';
import type { OnboardingRepository } from './onboarding.repository';

export const INVITATION_TTL_DAYS = 7;
export const MAX_CLAIM_ATTEMPTS = 5;

/** Code lisible (alphabet sans ambiguïté), tirage uniforme par CSPRNG. */
export function generateInvitationCode(): string {
  return Array.from({ length: INVITATION_CODE_LENGTH }, () => INVITATION_ALPHABET[randomInt(INVITATION_ALPHABET.length)]).join('');
}

export const formatInvitationCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

const invalidInvitation = () =>
  new BusinessRuleError('INVALID_INVITATION', 'Code d’activation invalide ou expiré, ou date de naissance incorrecte. Contactez le cabinet.');

interface Deps {
  tx: TransactionManager;
  onboarding: OnboardingRepository;
  users: AuthRepository;
  auth: AuthService;
  hasher: PasswordHasher;
  clock: Clock;
  logger: AppLogger;
}

export class OnboardingService {
  constructor(private readonly deps: Deps) {}

  /** Génère (ou régénère) le code d'activation d'un patient. Le code n'est renvoyé qu'ici, une seule fois. */
  async createInvitation(patientId: string, actorId: string): Promise<InvitationResponse> {
    const { tx, onboarding, clock, logger } = this.deps;
    const code = generateInvitationCode();
    const expiresAt = new Date(clock.now().getTime() + INVITATION_TTL_DAYS * 86_400_000);

    await tx.run(async (db) => {
      if (!(await onboarding.lockPatient(patientId, db))) throw new NotFoundError('Patient');
      if (await onboarding.patientHasAccount(patientId, db)) {
        throw new ConflictError('PATIENT_ALREADY_HAS_ACCOUNT', 'Ce patient a déjà un compte sur l’application');
      }
      await onboarding.revokeActive(patientId, db); // un seul code valide à la fois
      await onboarding.insert({ patientId, codeHash: sha256Hex(code), createdBy: actorId, expiresAt }, db);
    });

    // Le code n'apparaît JAMAIS dans les logs.
    logger.info({ event: 'onboarding.invitation_created', patientId, actorId }, 'invitation created');
    return { code: formatInvitationCode(code), expiresAt: expiresAt.toISOString() };
  }

  async claim(input: ClaimAccountRequest, ctx: ClientContext): Promise<Session> {
    const { tx, onboarding, users, auth, hasher, clock, logger } = this.deps;
    const passwordHash = await hasher.hash(input.password); // calcul coûteux hors transaction

    const outcome = await tx.run(async (db) => {
      const invitation = await onboarding.lockByCodeHash(sha256Hex(input.code), db);
      const usable =
        invitation &&
        !invitation.usedAt &&
        !invitation.revokedAt &&
        invitation.expiresAt > clock.now() &&
        invitation.failedAttempts < MAX_CLAIM_ATTEMPTS;
      if (!usable) return { kind: 'invalid' as const, invitationId: invitation?.id };

      const patient = await onboarding.lockPatient(invitation.patientId, db);
      if (!patient || patient.birthDate !== input.birthDate) {
        // L'échec doit être COMMITÉ (compteur anti-force brute) : pas d'exception dans la transaction.
        const attempts = await onboarding.recordFailedAttempt(invitation.id, db);
        return { kind: 'wrong_birth_date' as const, invitationId: invitation.id, attempts };
      }

      const user = await users.createUser({ email: input.email, passwordHash, role: 'patient', patientId: invitation.patientId }, db);
      await onboarding.markUsed(invitation.id, db);
      return { kind: 'ok' as const, user };
    });

    if (outcome.kind !== 'ok') {
      logger.warn(
        { event: 'onboarding.claim_failed', reason: outcome.kind, invitationId: outcome.invitationId, ip: ctx.ip, ...(outcome.kind === 'wrong_birth_date' ? { attempts: outcome.attempts } : {}) },
        'account claim failed',
      );
      throw invalidInvitation();
    }

    logger.info({ event: 'onboarding.account_claimed', userId: outcome.user.id, patientId: outcome.user.patientId }, 'account claimed');
    return auth.startSession(outcome.user, ctx);
  }
}
