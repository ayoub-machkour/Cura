import type { Pool } from 'pg';
import type { FamilyRelationship } from '@cura/shared';
import { ConflictError } from '../../common/errors';
import { type Db, isConstraintViolation } from '../../infra/db/transaction';
import type { PatientRecord } from '../patients/patients.repository';

export interface DependentRecord extends PatientRecord {
  relationship: FamilyRelationship;
}

export class FamilyRepository {
  constructor(private readonly pool: Pool) {}

  async isGuardian(userId: string, patientId: string, db: Db = this.pool): Promise<boolean> {
    const { rowCount } = await db.query(`SELECT 1 FROM patient_guardians WHERE user_id = $1 AND patient_id = $2`, [userId, patientId]);
    return (rowCount ?? 0) > 0;
  }

  async dependentIds(userId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ patientId: string }>(
      `SELECT patient_id AS "patientId" FROM patient_guardians WHERE user_id = $1`,
      [userId],
    );
    return rows.map((r) => r.patientId);
  }

  async listDependents(userId: string): Promise<DependentRecord[]> {
    const { rows } = await this.pool.query<DependentRecord>(
      `SELECT p.id, p.first_name AS "firstName", p.last_name AS "lastName", p.birth_date AS "birthDate", p.sex,
              p.phone, p.email::text AS email, p.national_id AS "nationalId", p.created_at AS "createdAt",
              g.relationship
         FROM patient_guardians g
         JOIN patients p ON p.id = g.patient_id AND p.deleted_at IS NULL
        WHERE g.user_id = $1
        ORDER BY p.birth_date, p.first_name`,
      [userId],
    );
    return rows;
  }

  /** Verrouille le compte titulaire : les ajouts simultanés de proches sont sérialisés (limite fiable). */
  async lockGuardianAndCount(userId: string, db: Db): Promise<number> {
    await db.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM patient_guardians WHERE user_id = $1`, [userId]);
    return rows[0]?.n ?? 0;
  }

  async link(input: { userId: string; patientId: string; relationship: FamilyRelationship; createdBy: string }, db: Db): Promise<void> {
    try {
      await db.query(
        `INSERT INTO patient_guardians (user_id, patient_id, relationship, created_by) VALUES ($1, $2, $3, $4)`,
        [input.userId, input.patientId, input.relationship, input.createdBy],
      );
    } catch (err) {
      if (isConstraintViolation(err, 'pk_patient_guardians')) {
        throw new ConflictError('ALREADY_LINKED', 'Cette personne est déjà rattachée à ce compte famille');
      }
      throw err;
    }
  }

  async unlink(userId: string, patientId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM patient_guardians WHERE user_id = $1 AND patient_id = $2`, [userId, patientId]);
    return (rowCount ?? 0) > 0;
  }
}
