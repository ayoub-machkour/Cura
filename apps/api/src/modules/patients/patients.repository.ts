import type { Pool } from 'pg';
import { ConflictError } from '../../common/errors';
import { type Db, isConstraintViolation } from '../../infra/db/transaction';

export interface PatientRecord {
  id: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  sex: 'F' | 'M' | 'X' | null;
  phone: string;
  email: string | null;
  nationalId: string | null;
  createdAt: Date;
}

export interface NewPatient {
  firstName: string;
  lastName: string;
  birthDate: string;
  sex?: 'F' | 'M' | 'X' | null;
  phone: string;
  email?: string | null;
  nationalId?: string | null;
}

export type PatientChanges = Partial<NewPatient>;

const COLUMNS = `
  id, first_name AS "firstName", last_name AS "lastName", birth_date AS "birthDate", sex,
  phone, email::text AS email, national_id AS "nationalId", created_at AS "createdAt"`;

/** Liste blanche champ DTO → colonne : seule source des noms de colonnes dynamiques (aucune injection possible). */
const UPDATABLE: Record<keyof PatientChanges, string> = {
  firstName: 'first_name',
  lastName: 'last_name',
  birthDate: 'birth_date',
  sex: 'sex',
  phone: 'phone',
  email: 'email',
  nationalId: 'national_id',
};

function translate(err: unknown): never {
  if (isConstraintViolation(err, 'uq_patients_national_id')) {
    throw new ConflictError('NATIONAL_ID_TAKEN', 'Un patient existe déjà avec ce numéro d’identité');
  }
  throw err;
}

export class PatientsRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: NewPatient, db: Db = this.pool): Promise<PatientRecord> {
    try {
      const { rows } = await db.query<PatientRecord>(
        `INSERT INTO patients (first_name, last_name, birth_date, sex, phone, email, national_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COLUMNS}`,
        [input.firstName, input.lastName, input.birthDate, input.sex ?? null, input.phone, input.email ?? null, input.nationalId ?? null],
      );
      return rows[0]!;
    } catch (err) {
      translate(err);
    }
  }

  async findById(id: string, db: Db = this.pool): Promise<PatientRecord | null> {
    const { rows } = await db.query<PatientRecord>(
      `SELECT ${COLUMNS} FROM patients WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  }

  async update(id: string, changes: PatientChanges, db: Db = this.pool): Promise<PatientRecord | null> {
    const entries = Object.entries(changes).filter(([, v]) => v !== undefined) as [keyof PatientChanges, unknown][];
    if (entries.length === 0) return this.findById(id, db);

    const sets = entries.map(([key], i) => `${UPDATABLE[key]} = $${i + 2}`);
    try {
      const { rows } = await db.query<PatientRecord>(
        `UPDATE patients SET ${sets.join(', ')}
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING ${COLUMNS}`,
        [id, ...entries.map(([, v]) => v)],
      );
      return rows[0] ?? null;
    } catch (err) {
      translate(err);
    }
  }

  /**
   * Liste alphabétique paginée (keyset sur lower(nom), lower(prénom), id),
   * avec recherche optionnelle "contient" accélérée par l'index trigramme.
   */
  async list(params: {
    limit: number;
    after?: readonly [string, string, string];
    search?: string;
  }): Promise<(PatientRecord & { sortLast: string; sortFirst: string })[]> {
    const values: unknown[] = [params.limit + 1];
    const where = ['deleted_at IS NULL'];

    if (params.search) {
      values.push(`%${escapeLike(params.search.toLowerCase())}%`);
      where.push(`lower(last_name || ' ' || first_name) LIKE $${values.length}`);
    }
    if (params.after) {
      values.push(...params.after);
      const n = values.length;
      where.push(`(lower(last_name), lower(first_name), id) > ($${n - 2}, $${n - 1}, $${n}::uuid)`);
    }

    const { rows } = await this.pool.query<PatientRecord & { sortLast: string; sortFirst: string }>(
      `SELECT ${COLUMNS}, lower(last_name) AS "sortLast", lower(first_name) AS "sortFirst"
         FROM patients
        WHERE ${where.join(' AND ')}
        ORDER BY lower(last_name), lower(first_name), id
        LIMIT $1`,
      values,
    );
    return rows;
  }
}

/** Neutralise les jokers LIKE saisis par l'utilisateur (% et _). */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
