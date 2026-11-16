import type { Pool } from 'pg';
import type { CreateDoctorRequest } from '@cura/shared';
import { ConflictError } from '../../common/errors';
import { type Db, isConstraintViolation } from '../../infra/db/transaction';

export interface DoctorRecord {
  id: string;
  firstName: string;
  lastName: string;
  specialty: string;
  registrationNumber: string;
  timezone: string;
  isActive: boolean;
}

const COLUMNS = `
  id, first_name AS "firstName", last_name AS "lastName", specialty,
  registration_number AS "registrationNumber", timezone, is_active AS "isActive"`;

export class DoctorsRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateDoctorRequest): Promise<DoctorRecord> {
    try {
      const { rows } = await this.pool.query<DoctorRecord>(
        `INSERT INTO doctors (first_name, last_name, specialty, registration_number, timezone)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${COLUMNS}`,
        [input.firstName, input.lastName, input.specialty, input.registrationNumber, input.timezone],
      );
      return rows[0]!;
    } catch (err) {
      if (isConstraintViolation(err, 'uq_doctors_registration')) {
        throw new ConflictError('REGISTRATION_NUMBER_TAKEN', 'Ce numéro d’inscription est déjà utilisé');
      }
      throw err;
    }
  }

  async findById(id: string, db: Db = this.pool): Promise<DoctorRecord | null> {
    const { rows } = await db.query<DoctorRecord>(`SELECT ${COLUMNS} FROM doctors WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** Médecins actifs, ordre alphabétique (keyset, index ix_doctors_active_name). */
  async listActive(limit: number, after?: readonly [string, string, string]) {
    const values: unknown[] = [limit + 1];
    let keyset = '';
    if (after) {
      values.push(...after);
      keyset = `AND (lower(last_name), lower(first_name), id) > ($2, $3, $4::uuid)`;
    }
    const { rows } = await this.pool.query<DoctorRecord & { sortLast: string; sortFirst: string }>(
      `SELECT ${COLUMNS}, lower(last_name) AS "sortLast", lower(first_name) AS "sortFirst"
         FROM doctors
        WHERE is_active ${keyset}
        ORDER BY lower(last_name), lower(first_name), id
        LIMIT $1`,
      values,
    );
    return rows;
  }
}
