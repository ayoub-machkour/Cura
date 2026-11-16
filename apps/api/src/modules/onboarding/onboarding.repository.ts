/**
 * Invitations d'activation de compte. SQL uniquement : seule l'empreinte du code est stockée.
 */
import type { Pool } from 'pg';
import type { Db } from '../../infra/db/transaction';

export interface InvitationRecord {
  id: string;
  patientId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  failedAttempts: number;
}

export class OnboardingRepository {
  constructor(private readonly pool: Pool) {}

  /** Verrouille le dossier : deux invitations simultanées pour un même patient sont sérialisées. */
  async lockPatient(patientId: string, db: Db): Promise<{ birthDate: string } | null> {
    const { rows } = await db.query<{ birthDate: string }>(
      `SELECT birth_date AS "birthDate" FROM patients WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [patientId],
    );
    return rows[0] ?? null;
  }

  async revokeActive(patientId: string, db: Db): Promise<void> {
    await db.query(
      `UPDATE patient_invitations SET revoked_at = now() WHERE patient_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [patientId],
    );
  }

  async insert(input: { patientId: string; codeHash: string; createdBy: string; expiresAt: Date }, db: Db): Promise<void> {
    await db.query(
      `INSERT INTO patient_invitations (patient_id, code_hash, created_by, expires_at) VALUES ($1, $2, $3, $4)`,
      [input.patientId, input.codeHash, input.createdBy, input.expiresAt],
    );
  }

  /** Verrouille l'invitation : deux tentatives simultanées avec le même code sont sérialisées. */
  async lockByCodeHash(codeHash: string, db: Db): Promise<InvitationRecord | null> {
    const { rows } = await db.query<InvitationRecord>(
      `SELECT id, patient_id AS "patientId", expires_at AS "expiresAt", used_at AS "usedAt",
              revoked_at AS "revokedAt", failed_attempts AS "failedAttempts"
         FROM patient_invitations
        WHERE code_hash = $1
          FOR UPDATE`,
      [codeHash],
    );
    return rows[0] ?? null;
  }

  async recordFailedAttempt(id: string, db: Db): Promise<number> {
    const { rows } = await db.query<{ failedAttempts: number }>(
      `UPDATE patient_invitations SET failed_attempts = failed_attempts + 1 WHERE id = $1 RETURNING failed_attempts AS "failedAttempts"`,
      [id],
    );
    return rows[0]?.failedAttempts ?? 0;
  }

  async markUsed(id: string, db: Db): Promise<void> {
    await db.query(`UPDATE patient_invitations SET used_at = now() WHERE id = $1`, [id]);
  }
}
