import type { Pool } from 'pg';
import type { Role, UpdateMedicalProfileRequest } from '@cura/shared';
import type { Db } from '../../infra/db/transaction';

export interface MedicalProfileRecord {
  patientId: string;
  bloodType: UpdateMedicalProfileRequest['bloodType'];
  allergies: string[];
  chronicConditions: string[];
  currentMedications: string[];
  pastSurgeries: string[];
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  notes: string | null;
  updatedAt: Date;
}

const COLUMNS = `
  patient_id AS "patientId", blood_type AS "bloodType", allergies, chronic_conditions AS "chronicConditions",
  current_medications AS "currentMedications", past_surgeries AS "pastSurgeries",
  emergency_contact_name AS "emergencyContactName", emergency_contact_phone AS "emergencyContactPhone",
  notes, updated_at AS "updatedAt"`;

export class MedicalRepository {
  constructor(private readonly pool: Pool) {}

  async patientExists(patientId: string, db: Db = this.pool): Promise<boolean> {
    const { rowCount } = await db.query(`SELECT 1 FROM patients WHERE id = $1 AND deleted_at IS NULL`, [patientId]);
    return (rowCount ?? 0) > 0;
  }

  async find(patientId: string, db: Db = this.pool, forUpdate = false): Promise<MedicalProfileRecord | null> {
    const { rows } = await db.query<MedicalProfileRecord>(
      `SELECT ${COLUMNS} FROM patient_medical_profiles WHERE patient_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [patientId],
    );
    return rows[0] ?? null;
  }

  async upsert(patientId: string, p: UpdateMedicalProfileRequest, actorUserId: string, db: Db): Promise<MedicalProfileRecord> {
    const { rows } = await db.query<MedicalProfileRecord>(
      `INSERT INTO patient_medical_profiles
         (patient_id, blood_type, allergies, chronic_conditions, current_medications, past_surgeries,
          emergency_contact_name, emergency_contact_phone, notes, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (patient_id) DO UPDATE SET
         blood_type = EXCLUDED.blood_type, allergies = EXCLUDED.allergies,
         chronic_conditions = EXCLUDED.chronic_conditions, current_medications = EXCLUDED.current_medications,
         past_surgeries = EXCLUDED.past_surgeries, emergency_contact_name = EXCLUDED.emergency_contact_name,
         emergency_contact_phone = EXCLUDED.emergency_contact_phone, notes = EXCLUDED.notes,
         updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING ${COLUMNS}`,
      [
        patientId,
        p.bloodType,
        p.allergies,
        p.chronicConditions,
        p.currentMedications,
        p.pastSurgeries,
        p.emergencyContactName,
        p.emergencyContactPhone,
        p.notes,
        actorUserId,
      ],
    );
    return rows[0]!;
  }

  /** Trace QUI a modifié QUELS champs (jamais les valeurs : pas de copie de données de santé). */
  async recordChange(change: { patientId: string; fields: string[]; actorUserId: string; actorRole: Role }, db: Db): Promise<void> {
    await db.query(
      `INSERT INTO patient_medical_profile_changes (patient_id, fields, actor_user_id, actor_role) VALUES ($1, $2, $3, $4)`,
      [change.patientId, change.fields, change.actorUserId, change.actorRole],
    );
  }
}
