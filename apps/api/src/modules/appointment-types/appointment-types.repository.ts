import type { Pool } from 'pg';
import type { CreateAppointmentTypeRequest, UpdateAppointmentTypeRequest } from '@cura/shared';
import { ConflictError } from '../../common/errors';
import { type Db, isConstraintViolation } from '../../infra/db/transaction';

export interface AppointmentTypeRecord {
  id: string;
  code: string;
  label: string;
  durationMinutes: number;
  colorHex: string;
  bookableOnline: boolean;
  defaultPriceCents: number;
  isActive: boolean;
}

const COLUMNS = `
  id, code, label, duration_minutes AS "durationMinutes", color_hex AS "colorHex",
  bookable_online AS "bookableOnline", default_price_cents AS "defaultPriceCents", is_active AS "isActive"`;

const UPDATABLE: Record<keyof UpdateAppointmentTypeRequest, string> = {
  label: 'label',
  durationMinutes: 'duration_minutes',
  colorHex: 'color_hex',
  bookableOnline: 'bookable_online',
  defaultPriceCents: 'default_price_cents',
  isActive: 'is_active',
};

export class AppointmentTypesRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateAppointmentTypeRequest): Promise<AppointmentTypeRecord> {
    try {
      const { rows } = await this.pool.query<AppointmentTypeRecord>(
        `INSERT INTO appointment_types (code, label, duration_minutes, color_hex, bookable_online, default_price_cents)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [input.code, input.label, input.durationMinutes, input.colorHex, input.bookableOnline, input.defaultPriceCents],
      );
      return rows[0]!;
    } catch (err) {
      if (isConstraintViolation(err, 'uq_appointment_types_code')) {
        throw new ConflictError('CODE_TAKEN', 'Ce code de motif existe déjà');
      }
      throw err;
    }
  }

  async update(id: string, changes: UpdateAppointmentTypeRequest): Promise<AppointmentTypeRecord | null> {
    const entries = Object.entries(changes).filter(([, v]) => v !== undefined) as [keyof UpdateAppointmentTypeRequest, unknown][];
    const sets = entries.map(([key], i) => `${UPDATABLE[key]} = $${i + 2}`);
    const { rows } = await this.pool.query<AppointmentTypeRecord>(
      `UPDATE appointment_types SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, ...entries.map(([, v]) => v)],
    );
    return rows[0] ?? null;
  }

  async findById(id: string, db: Db = this.pool): Promise<AppointmentTypeRecord | null> {
    const { rows } = await db.query<AppointmentTypeRecord>(`SELECT ${COLUMNS} FROM appointment_types WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** Liste courte (quelques dizaines de motifs) : pas de pagination nécessaire. */
  async list(options: { onlyActive: boolean; onlyOnline: boolean }): Promise<AppointmentTypeRecord[]> {
    const { rows } = await this.pool.query<AppointmentTypeRecord>(
      `SELECT ${COLUMNS} FROM appointment_types
        WHERE ($1::boolean = false OR is_active)
          AND ($2::boolean = false OR bookable_online)
        ORDER BY label`,
      [options.onlyActive, options.onlyOnline],
    );
    return rows;
  }
}
