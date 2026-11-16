/**
 * Accès aux rendez-vous et à l'outbox. SQL uniquement.
 * Les violations de contraintes sont traduites en erreurs métier ICI : le service
 * ne connaît pas les codes SQLSTATE ni les noms de contraintes.
 */
import type { Pool } from 'pg';
import type { AppointmentStatus } from '@cura/shared';
import { type Db, isPgError, PgErrorCode } from '../../infra/db/transaction';
import { DuplicateIdempotencyKeyError, PatientTimeConflictError, SlotUnavailableError } from './booking.errors';

export type BookingSourceValue = 'mobile' | 'desk' | 'phone';

export interface AppointmentRecord {
  id: string;
  doctorId: string;
  patientId: string;
  appointmentTypeId: string;
  slotId: string | null;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  source: BookingSourceValue;
}

export interface NewAppointment {
  doctorId: string;
  patientId: string;
  appointmentTypeId: string;
  slotId: string;
  startsAt: Date;
  endsAt: Date;
  source: BookingSourceValue;
  idempotencyKey: string;
  note?: string;
}

export interface OutboxEvent {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

const COLUMNS = `
  id, doctor_id AS "doctorId", patient_id AS "patientId", appointment_type_id AS "appointmentTypeId",
  slot_id AS "slotId", starts_at AS "startsAt", ends_at AS "endsAt", status, source`;

export class BookingRepository {
  constructor(private readonly pool: Pool) {}

  async insert(input: NewAppointment, tx: Db): Promise<AppointmentRecord> {
    try {
      const { rows } = await tx.query<AppointmentRecord>(
        `INSERT INTO appointments
           (doctor_id, patient_id, appointment_type_id, slot_id, starts_at, ends_at, source, idempotency_key, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${COLUMNS}`,
        [
          input.doctorId,
          input.patientId,
          input.appointmentTypeId,
          input.slotId,
          input.startsAt,
          input.endsAt,
          input.source,
          input.idempotencyKey,
          input.note ?? null,
        ],
      );
      return rows[0]!;
    } catch (err) {
      if (!isPgError(err)) throw err;
      switch (err.constraint) {
        case 'uq_appointments_idempotency':
          throw new DuplicateIdempotencyKeyError();
        case 'ex_appointments_patient_overlap':
          throw new PatientTimeConflictError();
        case 'uq_appointments_active_slot':
        case 'ex_appointments_doctor_overlap':
          throw new SlotUnavailableError(input.slotId, 'ALREADY_BOOKED');
      }
      if (err.code === PgErrorCode.LockNotAvailable) throw new SlotUnavailableError(input.slotId, 'LOCK_CONTENTION');
      throw err;
    }
  }

  async findByIdempotencyKey(patientId: string, key: string): Promise<AppointmentRecord | null> {
    const { rows } = await this.pool.query<AppointmentRecord>(
      `SELECT ${COLUMNS} FROM appointments WHERE patient_id = $1 AND idempotency_key = $2`,
      [patientId, key],
    );
    return rows[0] ?? null;
  }

  async lockById(id: string, tx: Db): Promise<AppointmentRecord | null> {
    const { rows } = await tx.query<AppointmentRecord>(`SELECT ${COLUMNS} FROM appointments WHERE id = $1 FOR UPDATE`, [id]);
    return rows[0] ?? null;
  }

  async markCancelled(id: string, reason: string | null, tx: Db): Promise<AppointmentRecord> {
    const { rows } = await tx.query<AppointmentRecord>(
      `UPDATE appointments
          SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, version = version + 1
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [id, reason],
    );
    return rows[0]!;
  }

  /** Keyset (starts_at, id) : à venir en ordre croissant, passés en ordre décroissant. */
  async listForPatient(params: {
    patientId: string;
    scope: 'upcoming' | 'past';
    now: Date;
    limit: number;
    after?: readonly [string, string];
  }): Promise<AppointmentRecord[]> {
    const upcoming = params.scope === 'upcoming';
    const values: unknown[] = [params.patientId, params.now, params.limit + 1];
    let keyset = '';
    if (params.after) {
      values.push(params.after[0], params.after[1]);
      keyset = `AND (starts_at, id) ${upcoming ? '>' : '<'} ($4::timestamptz, $5::uuid)`;
    }
    const { rows } = await this.pool.query<AppointmentRecord>(
      `SELECT ${COLUMNS} FROM appointments
        WHERE patient_id = $1
          AND starts_at ${upcoming ? '>=' : '<'} $2
          ${keyset}
        ORDER BY starts_at ${upcoming ? 'ASC' : 'DESC'}, id ${upcoming ? 'ASC' : 'DESC'}
        LIMIT $3`,
      values,
    );
    return rows;
  }

  /** Agenda d'un médecin (index ix_appointments_doctor_time). */
  async listForDoctor(params: {
    doctorId: string;
    from: Date;
    to: Date;
    limit: number;
    after?: readonly [string, string];
  }): Promise<AppointmentRecord[]> {
    const values: unknown[] = [params.doctorId, params.from, params.to, params.limit + 1];
    let keyset = '';
    if (params.after) {
      values.push(params.after[0], params.after[1]);
      keyset = `AND (starts_at, id) > ($5::timestamptz, $6::uuid)`;
    }
    const { rows } = await this.pool.query<AppointmentRecord>(
      `SELECT ${COLUMNS} FROM appointments
        WHERE doctor_id = $1 AND starts_at >= $2 AND starts_at < $3
          ${keyset}
        ORDER BY starts_at, id
        LIMIT $4`,
      values,
    );
    return rows;
  }

  async insertOutboxEvent(event: OutboxEvent, tx: Db): Promise<void> {
    await tx.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload) VALUES ($1, $2, $3, $4)`,
      [event.aggregateType, event.aggregateId, event.eventType, JSON.stringify(event.payload)],
    );
  }
}
