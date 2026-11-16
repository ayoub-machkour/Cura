/**
 * Accès aux données des comptes et refresh tokens. SQL uniquement, aucune règle métier.
 * Les violations de contraintes PostgreSQL sont traduites ici en erreurs métier :
 * la couche service ne connaît pas les codes SQLSTATE.
 */
import type { Pool } from 'pg';
import type { UserRole } from '@cura/shared';
import { BusinessRuleError, ConflictError } from '../../common/errors';
import { type Db, isConstraintViolation } from '../../infra/db/transaction';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  patientId: string | null;
  doctorId: string | null;
  isActive: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}

export interface NewUser {
  email: string;
  passwordHash: string;
  role: UserRole;
  patientId?: string | null;
  doctorId?: string | null;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

export type RevocationReason = 'rotated' | 'logout' | 'reuse_detected' | 'password_change' | 'admin';

const USER_COLUMNS = `
  id, email::text AS email, password_hash AS "passwordHash", role,
  patient_id AS "patientId", doctor_id AS "doctorId", is_active AS "isActive",
  failed_login_attempts AS "failedLoginAttempts", locked_until AS "lockedUntil"`;

export class AuthRepository {
  constructor(private readonly pool: Pool) {}

  async findUserByEmail(email: string, db: Db = this.pool): Promise<UserRecord | null> {
    const { rows } = await db.query<UserRecord>(`SELECT ${USER_COLUMNS} FROM users WHERE email = $1`, [email]);
    return rows[0] ?? null;
  }

  async findUserById(id: string, db: Db = this.pool): Promise<UserRecord | null> {
    const { rows } = await db.query<UserRecord>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async createUser(input: NewUser, db: Db = this.pool): Promise<UserRecord> {
    try {
      const { rows } = await db.query<UserRecord>(
        `INSERT INTO users (email, password_hash, role, patient_id, doctor_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${USER_COLUMNS}`,
        [input.email, input.passwordHash, input.role, input.patientId ?? null, input.doctorId ?? null],
      );
      return rows[0]!;
    } catch (err) {
      if (isConstraintViolation(err, 'uq_users_email')) {
        throw new ConflictError('EMAIL_TAKEN', 'Un compte existe déjà avec cet email');
      }
      if (isConstraintViolation(err, 'uq_users_doctor')) {
        throw new ConflictError('DOCTOR_ALREADY_LINKED', 'Ce médecin possède déjà un compte');
      }
      if (isConstraintViolation(err, 'users_doctor_id_fkey')) {
        throw new BusinessRuleError('DOCTOR_NOT_FOUND', 'Le médecin indiqué n’existe pas');
      }
      throw err;
    }
  }

  /** Incrémente les échecs ; verrouille le compte au-delà du seuil. Atomique (une seule requête). */
  async recordLoginFailure(userId: string, maxAttempts: number, lockMinutes: number): Promise<void> {
    await this.pool.query(
      `UPDATE users
          SET failed_login_attempts = failed_login_attempts + 1,
              locked_until = CASE
                WHEN failed_login_attempts + 1 >= $2 THEN now() + make_interval(mins => $3)
                ELSE locked_until
              END
        WHERE id = $1`,
      [userId, maxAttempts, lockMinutes],
    );
  }

  async recordLoginSuccess(userId: string, newPasswordHash?: string): Promise<void> {
    await this.pool.query(
      `UPDATE users
          SET failed_login_attempts = 0,
              locked_until = NULL,
              last_login_at = now(),
              password_hash = COALESCE($2, password_hash)
        WHERE id = $1`,
      [userId, newPasswordHash ?? null],
    );
  }

  async insertRefreshToken(
    input: { userId: string; familyId: string; tokenHash: string; expiresAt: Date; userAgent?: string; ip?: string },
    db: Db = this.pool,
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [input.userId, input.familyId, input.tokenHash, input.expiresAt, input.userAgent?.slice(0, 512) ?? null, input.ip ?? null],
    );
    return rows[0]!.id;
  }

  /** Verrouille la ligne : deux rafraîchissements simultanés du même jeton sont sérialisés. */
  async findRefreshTokenForUpdate(tokenHash: string, db: Db): Promise<RefreshTokenRecord | null> {
    const { rows } = await db.query<RefreshTokenRecord>(
      `SELECT id, user_id AS "userId", family_id AS "familyId", expires_at AS "expiresAt",
              revoked_at AS "revokedAt", revoked_reason AS "revokedReason"
         FROM refresh_tokens
        WHERE token_hash = $1
          FOR UPDATE`,
      [tokenHash],
    );
    return rows[0] ?? null;
  }

  async findFamilyByTokenHash(tokenHash: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ familyId: string }>(
      `SELECT family_id AS "familyId" FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    return rows[0]?.familyId ?? null;
  }

  async revokeToken(id: string, reason: RevocationReason, replacedBy: string | null, db: Db): Promise<void> {
    await db.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2, replaced_by = $3
        WHERE id = $1 AND revoked_at IS NULL`,
      [id, reason, replacedBy],
    );
  }

  async revokeFamily(familyId: string, reason: RevocationReason, db: Db = this.pool): Promise<number> {
    const { rowCount } = await db.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId, reason],
    );
    return rowCount ?? 0;
  }
}
