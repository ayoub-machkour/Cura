/**
 * Implémentation PostgreSQL du BookingRepository.
 * SQL explicite et paramétré : aucune magie d'ORM sur le chemin critique,
 * le plan d'exécution et les verrous posés sont lisibles directement.
 */
import type { Queryable, Tx } from '../../infra/db/transaction';
import type {
  AppointmentRow,
  AppointmentTypeRow,
  BookingRepository,
  LockedSlot,
  NearestSlotsQuery,
  NewAppointment,
  OutboxEvent,
  SlotRow,
} from './booking.ports';

/** Statuts qui "occupent" un créneau — doit rester aligné avec les WHERE des contraintes SQL. */
const ACTIVE_STATUS_SQL = `status NOT IN ('cancelled', 'no_show')`;

const APPOINTMENT_COLUMNS = `
  id,
  doctor_id           AS "doctorId",
  patient_id          AS "patientId",
  appointment_type_id AS "appointmentTypeId",
  slot_id             AS "slotId",
  starts_at           AS "startsAt",
  ends_at             AS "endsAt",
  status
`;

const SLOT_COLUMNS = `
  s.id,
  s.doctor_id AS "doctorId",
  s.starts_at AS "startsAt",
  s.ends_at   AS "endsAt"
`;

export class PgBookingRepository implements BookingRepository {
  async lockSlot(tx: Tx, slotId: string): Promise<LockedSlot | null> {
    // FOR UPDATE : la 2e transaction qui vise ce créneau ATTEND ici que la 1re
    // ait commité (ou expire après lock_timeout). Elle relira alors la ligne à jour.
    const { rows } = await tx.query<LockedSlot>(
      `SELECT ${SLOT_COLUMNS},
              s.status,
              s.online_bookable AS "onlineBookable"
         FROM slots s
        WHERE s.id = $1
          FOR UPDATE`,
      [slotId],
    );
    return rows[0] ?? null;
  }

  async hasActiveAppointmentOnSlot(tx: Tx, slotId: string): Promise<boolean> {
    // Requête DISTINCTE, exécutée APRÈS l'obtention du verrou : en READ COMMITTED,
    // chaque instruction prend un nouveau snapshot et voit donc le RDV que la
    // transaction concurrente vient de commiter.
    const { rows } = await tx.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM appointments WHERE slot_id = $1 AND ${ACTIVE_STATUS_SQL}
       ) AS "exists"`,
      [slotId],
    );
    return rows[0]?.exists ?? false;
  }

  async insertAppointment(tx: Tx, input: NewAppointment): Promise<AppointmentRow> {
    const { rows } = await tx.query<AppointmentRow>(
      `INSERT INTO appointments
         (doctor_id, patient_id, appointment_type_id, slot_id,
          starts_at, ends_at, source, idempotency_key, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${APPOINTMENT_COLUMNS}`,
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
    const row = rows[0];
    if (!row) throw new Error('INSERT … RETURNING returned no row');
    return row;
  }

  async insertOutboxEvent(tx: Tx, event: OutboxEvent): Promise<void> {
    await tx.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [event.aggregateType, event.aggregateId, event.eventType, JSON.stringify(event.payload)],
    );
  }

  async findAppointmentType(db: Queryable, id: string): Promise<AppointmentTypeRow | null> {
    const { rows } = await db.query<AppointmentTypeRow>(
      `SELECT id,
              duration_minutes AS "durationMinutes",
              bookable_online  AS "bookableOnline",
              is_active        AS "isActive"
         FROM appointment_types
        WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findByIdempotencyKey(db: Queryable, patientId: string, key: string): Promise<AppointmentRow | null> {
    const { rows } = await db.query<AppointmentRow>(
      `SELECT ${APPOINTMENT_COLUMNS}
         FROM appointments
        WHERE patient_id = $1 AND idempotency_key = $2`,
      [patientId, key],
    );
    return rows[0] ?? null;
  }

  async findSlotById(db: Queryable, slotId: string): Promise<SlotRow | null> {
    const { rows } = await db.query<SlotRow>(
      `SELECT ${SLOT_COLUMNS} FROM slots s WHERE s.id = $1`,
      [slotId],
    );
    return rows[0] ?? null;
  }

  async findNearestAvailableSlots(db: Queryable, q: NearestSlotsQuery): Promise<SlotRow[]> {
    // Fenêtre de ±14 jours : la requête reste un range scan sur
    // uq_slots_doctor_start (doctor_id, starts_at) au lieu de trier toute la table.
    const { rows } = await db.query<SlotRow>(
      `SELECT ${SLOT_COLUMNS}
         FROM slots s
        WHERE s.doctor_id = $1
          AND s.status = 'open'
          AND ($2::boolean = false OR s.online_bookable)
          AND s.starts_at >= GREATEST($3::timestamptz, $4::timestamptz - interval '14 days')
          AND s.starts_at <= $4::timestamptz + interval '14 days'
          AND s.ends_at - s.starts_at >= make_interval(mins => $5::int)
          AND NOT (s.id = ANY($6::uuid[]))
          AND NOT EXISTS (
                SELECT 1 FROM appointments a
                 WHERE a.slot_id = s.id AND a.${ACTIVE_STATUS_SQL}
              )
        ORDER BY abs(extract(epoch FROM s.starts_at - $4::timestamptz)), s.starts_at
        LIMIT $7`,
      [q.doctorId, q.onlineOnly, q.notBefore, q.around, q.minDurationMinutes, q.excludeSlotIds, q.limit],
    );
    return rows;
  }
}
