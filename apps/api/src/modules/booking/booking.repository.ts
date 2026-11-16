/**
 * Accès aux rendez-vous et à l'outbox. SQL uniquement.
 * Les violations de contraintes sont traduites en erreurs métier ICI : le service
 * ne connaît pas les codes SQLSTATE ni les noms de contraintes.
 */
import type { Pool } from 'pg';
import type { AppointmentStatus } from '@cura/shared';
import { type Db, isPgError, PgErrorCode } from '../../infra/db/transaction';
import { ConflictError, UnauthorizedError } from '../../common/errors';
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
  version: number;
  checkedInAt: Date | null;
  consultationStartedAt: Date | null;
  completedAt: Date | null;
  followUpOfId: string | null;
}

/** RDV verrouillé pour une transition, avec les jours calendaires calculés dans le fuseau du médecin. */
export interface LockedAppointment extends AppointmentRecord {
  /** Jour local du RDV (YYYY-MM-DD). */
  appointmentDay: string;
  /** Jour local de `now` (YYYY-MM-DD). */
  today: string;
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
  followUpOfId?: string;
}

export interface OutboxEvent {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

const columns = (alias = '') => {
  const a = alias ? `${alias}.` : '';
  return `
  ${a}id, ${a}doctor_id AS "doctorId", ${a}patient_id AS "patientId", ${a}appointment_type_id AS "appointmentTypeId",
  ${a}slot_id AS "slotId", ${a}starts_at AS "startsAt", ${a}ends_at AS "endsAt", ${a}status, ${a}source, ${a}version,
  ${a}checked_in_at AS "checkedInAt", ${a}consultation_started_at AS "consultationStartedAt", ${a}completed_at AS "completedAt",
  ${a}follow_up_of AS "followUpOfId"`;
};
const COLUMNS = columns();

/** Horodatage posé par chaque statut cible (liste blanche : aucun nom de colonne dynamique non maîtrisé). */
const TIMESTAMP_FOR_STATUS: Partial<Record<AppointmentStatus, string>> = {
  confirmed: 'confirmed_at',
  checked_in: 'checked_in_at',
  in_consultation: 'consultation_started_at',
  completed: 'completed_at',
  no_show: 'no_show_at',
};

/** Un patient déjà présent dans une file d'attente ne peut pas y entrer une seconde fois. */
function translateQueueConflict(err: unknown): unknown {
  if (isPgError(err) && err.constraint === 'uq_appointments_patient_in_queue') {
    return new ConflictError('PATIENT_ALREADY_IN_QUEUE', 'Ce patient est déjà en salle d’attente ou en consultation');
  }
  return err;
}

export class BookingRepository {
  constructor(private readonly pool: Pool) {}

  async insert(input: NewAppointment, tx: Db): Promise<AppointmentRecord> {
    try {
      const { rows } = await tx.query<AppointmentRecord>(
        `INSERT INTO appointments
           (doctor_id, patient_id, appointment_type_id, slot_id, starts_at, ends_at, source, idempotency_key, note, follow_up_of)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
          input.followUpOfId ?? null,
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

  /**
   * Verrouille le dossier patient : sérialise les réservations simultanées d'un MÊME patient
   * (sinon 5 requêtes parallèles compteraient toutes « 0 RDV » et dépasseraient la limite).
   * Ordre des verrous toujours créneau → patient : aucun interblocage possible.
   */
  async lockPatient(patientId: string, tx: Db): Promise<{ firstName: string } | null> {
    const { rows } = await tx.query<{ firstName: string }>(
      `SELECT first_name AS "firstName" FROM patients WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [patientId],
    );
    return rows[0] ?? null;
  }

  async findPatientFirstName(patientId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ firstName: string }>(`SELECT first_name AS "firstName" FROM patients WHERE id = $1`, [patientId]);
    return rows[0]?.firstName ?? null;
  }

  /** Visite d'origine d'un RDV de contrôle. */
  async findFollowUpOrigin(id: string, tx: Db): Promise<{ patientId: string; status: AppointmentStatus } | null> {
    const { rows } = await tx.query<{ patientId: string; status: AppointmentStatus }>(
      `SELECT patient_id AS "patientId", status FROM appointments WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** RDV à venir encore actifs (réservés ou confirmés) d'un patient. */
  async countUpcomingActive(patientId: string, now: Date, tx: Db): Promise<number> {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM appointments
        WHERE patient_id = $1 AND starts_at > $2 AND status IN ('scheduled', 'confirmed')`,
      [patientId, now],
    );
    return rows[0]?.n ?? 0;
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

  /**
   * Verrouille le RDV (FOR UPDATE) et calcule, dans le fuseau du médecin, son jour local
   * et celui de `now` : le service compare sans faire d'arithmétique de fuseau en JS.
   */
  async lockForTransition(id: string, now: Date, tx: Db): Promise<LockedAppointment | null> {
    const { rows } = await tx.query<LockedAppointment>(
      `SELECT ${columns('a')},
              to_char(a.starts_at AT TIME ZONE d.timezone, 'YYYY-MM-DD') AS "appointmentDay",
              to_char($2::timestamptz AT TIME ZONE d.timezone, 'YYYY-MM-DD') AS "today"
         FROM appointments a
         JOIN doctors d ON d.id = a.doctor_id
        WHERE a.id = $1
          FOR UPDATE OF a`,
      [id, now],
    );
    return rows[0] ?? null;
  }

  /** Visite sans rendez-vous : créée directement « arrivée », sans créneau. */
  async insertWalkIn(
    input: { doctorId: string; patientId: string; appointmentTypeId: string; arrivedAt: Date; durationMinutes: number; note?: string },
    tx: Db,
  ): Promise<AppointmentRecord> {
    try {
      const { rows } = await tx.query<AppointmentRecord>(
        `INSERT INTO appointments
           (doctor_id, patient_id, appointment_type_id, slot_id, starts_at, ends_at, status, source,
            idempotency_key, checked_in_at, note)
         VALUES ($1, $2, $3, NULL, $4, $4::timestamptz + make_interval(mins => $5), 'checked_in', 'desk',
                 gen_random_uuid(), $4, $6)
         RETURNING ${COLUMNS}`,
        [input.doctorId, input.patientId, input.appointmentTypeId, input.arrivedAt, input.durationMinutes, input.note ?? null],
      );
      return rows[0]!;
    } catch (err) {
      throw translateQueueConflict(err);
    }
  }

  /** Applique un changement de statut, pose l'horodatage associé et incrémente la version. */
  async applyStatus(id: string, to: AppointmentStatus, at: Date, tx: Db): Promise<AppointmentRecord> {
    const timestampColumn = TIMESTAMP_FOR_STATUS[to];
    const setTimestamp = timestampColumn ? `, ${timestampColumn} = $3` : '';
    try {
      const { rows } = await tx.query<AppointmentRecord>(
        `UPDATE appointments
            SET status = $2::appointment_status, version = version + 1 ${setTimestamp}
          WHERE id = $1
          RETURNING ${COLUMNS}`,
        timestampColumn ? [id, to, at] : [id, to],
      );
      return rows[0]!;
    } catch (err) {
      if (isPgError(err) && err.constraint === 'uq_appointments_one_consultation_per_doctor') {
        throw new ConflictError('DOCTOR_BUSY', 'Le médecin a déjà un patient en consultation');
      }
      throw translateQueueConflict(err);
    }
  }

  /** Historique immuable : qui a changé quel statut, et quand. */
  async insertStatusChange(
    change: { appointmentId: string; from: AppointmentStatus | null; to: AppointmentStatus; actorUserId: string | null },
    tx: Db,
  ): Promise<void> {
    try {
      await tx.query(
        `INSERT INTO appointment_status_changes (appointment_id, from_status, to_status, actor_user_id)
         VALUES ($1, $2, $3, $4)`,
        [change.appointmentId, change.from, change.to, change.actorUserId],
      );
    } catch (err) {
      // Jeton encore valide d'un compte supprimé entre-temps : la session n'est plus légitime.
      if (isPgError(err) && err.constraint === 'appointment_status_changes_actor_user_id_fkey') {
        throw new UnauthorizedError('SESSION_INVALID', 'Session invalide, veuillez vous reconnecter');
      }
      throw err;
    }
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
  /** RDV d'un ou plusieurs dossiers (compte famille). */
  async listForPatients(params: {
    patientIds: string[];
    scope: 'upcoming' | 'past';
    now: Date;
    limit: number;
    after?: readonly [string, string];
  }): Promise<AppointmentRecord[]> {
    const upcoming = params.scope === 'upcoming';
    const values: unknown[] = [params.patientIds, params.now, params.limit + 1];
    let keyset = '';
    if (params.after) {
      values.push(params.after[0], params.after[1]);
      keyset = `AND (starts_at, id) ${upcoming ? '>' : '<'} ($4::timestamptz, $5::uuid)`;
    }
    const { rows } = await this.pool.query<AppointmentRecord>(
      `SELECT ${COLUMNS} FROM appointments
        WHERE patient_id = ANY($1::uuid[])
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
