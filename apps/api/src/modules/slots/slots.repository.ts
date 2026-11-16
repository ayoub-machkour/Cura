import type { Pool } from 'pg';
import { type Db, isPgError, PgErrorCode } from '../../infra/db/transaction';
import { SlotUnavailableError } from '../booking/booking.errors';

export interface SlotRecord {
  id: string;
  doctorId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface LockedSlot extends SlotRecord {
  status: 'open' | 'blocked';
  onlineBookable: boolean;
}

/** Statuts qui "occupent" un créneau — aligné avec les WHERE des contraintes SQL. */
export const ACTIVE_APPOINTMENT_SQL = `a.status NOT IN ('cancelled', 'no_show')`;

const COLUMNS = `s.id, s.doctor_id AS "doctorId", s.starts_at AS "startsAt", s.ends_at AS "endsAt"`;

/** Filtre commun "créneau réellement disponible". */
const AVAILABLE_SQL = `
  s.status = 'open'
  AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND ${ACTIVE_APPOINTMENT_SQL})`;

export class SlotsRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * SELECT … FOR UPDATE : sérialise toutes les transactions qui visent CE créneau.
   * La seconde attend que la première commite, puis relit la ligne à jour.
   * Au-delà de lock_timeout → SlotUnavailableError(LOCK_CONTENTION).
   */
  async lockForBooking(slotId: string, tx: Db): Promise<LockedSlot | null> {
    try {
      const { rows } = await tx.query<LockedSlot>(
        `SELECT ${COLUMNS}, s.status, s.online_bookable AS "onlineBookable"
           FROM slots s
          WHERE s.id = $1
            FOR UPDATE`,
        [slotId],
      );
      return rows[0] ?? null;
    } catch (err) {
      if (isPgError(err) && err.code === PgErrorCode.LockNotAvailable) {
        throw new SlotUnavailableError(slotId, 'LOCK_CONTENTION');
      }
      throw err;
    }
  }

  /**
   * Requête DISTINCTE exécutée APRÈS le verrou : en READ COMMITTED chaque instruction
   * prend un nouveau snapshot, elle voit donc le RDV que la transaction concurrente
   * vient de commiter.
   */
  async hasActiveAppointment(slotId: string, tx: Db): Promise<boolean> {
    const { rows } = await tx.query<{ taken: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = $1 AND ${ACTIVE_APPOINTMENT_SQL}) AS taken`,
      [slotId],
    );
    return rows[0]?.taken ?? false;
  }

  async findById(slotId: string): Promise<SlotRecord | null> {
    const { rows } = await this.pool.query<SlotRecord>(`SELECT ${COLUMNS} FROM slots s WHERE s.id = $1`, [slotId]);
    return rows[0] ?? null;
  }

  /** Créneaux libres d'un médecin sur une période — keyset (starts_at, id) sur uq_slots_doctor_start. */
  async listAvailable(params: {
    doctorId: string;
    from: Date;
    to: Date;
    onlineOnly: boolean;
    minDurationMinutes: number;
    limit: number;
    after?: readonly [string, string];
  }): Promise<SlotRecord[]> {
    const values: unknown[] = [params.doctorId, params.from, params.to, params.onlineOnly, params.minDurationMinutes, params.limit + 1];
    let keyset = '';
    if (params.after) {
      values.push(params.after[0], params.after[1]);
      keyset = `AND (s.starts_at, s.id) > ($7::timestamptz, $8::uuid)`;
    }
    const { rows } = await this.pool.query<SlotRecord>(
      `SELECT ${COLUMNS}
         FROM slots s
        WHERE s.doctor_id = $1
          AND s.starts_at >= $2 AND s.starts_at < $3
          AND ($4::boolean = false OR s.online_bookable)
          AND s.ends_at - s.starts_at >= make_interval(mins => $5::int)
          AND ${AVAILABLE_SQL}
          ${keyset}
        ORDER BY s.starts_at, s.id
        LIMIT $6`,
      values,
    );
    return rows;
  }

  /**
   * Créneaux libres les plus proches (dans le temps) d'un instant donné.
   * Fenêtre de ±14 jours : la requête reste un range scan sur (doctor_id, starts_at).
   */
  async findNearestAvailable(q: {
    doctorId: string;
    around: Date;
    notBefore: Date;
    minDurationMinutes: number;
    onlineOnly: boolean;
    excludeSlotIds: string[];
    limit: number;
  }): Promise<SlotRecord[]> {
    const { rows } = await this.pool.query<SlotRecord>(
      `SELECT ${COLUMNS}
         FROM slots s
        WHERE s.doctor_id = $1
          AND ($2::boolean = false OR s.online_bookable)
          AND s.starts_at >= GREATEST($3::timestamptz, $4::timestamptz - interval '14 days')
          AND s.starts_at <= $4::timestamptz + interval '14 days'
          AND s.ends_at - s.starts_at >= make_interval(mins => $5::int)
          AND NOT (s.id = ANY($6::uuid[]))
          AND ${AVAILABLE_SQL}
        ORDER BY abs(extract(epoch FROM s.starts_at - $4::timestamptz)), s.starts_at
        LIMIT $7`,
      [q.doctorId, q.onlineOnly, q.notBefore, q.around, q.minDurationMinutes, q.excludeSlotIds, q.limit],
    );
    return rows;
  }

  /**
   * Génère les créneaux dans le fuseau du médecin, entièrement en SQL (gestion exacte
   * des changements d'heure). Les créneaux déjà existants ou chevauchants sont ignorés
   * (ON CONFLICT DO NOTHING couvre aussi la contrainte d'exclusion) : opération idempotente.
   */
  async generate(params: {
    doctorId: string;
    timezone: string;
    from: string;
    to: string;
    weekdays: number[];
    dayStart: string;
    dayEnd: string;
    slotMinutes: number;
    onlineBookable: boolean;
  }): Promise<number> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO slots (doctor_id, starts_at, ends_at, online_bookable)
       SELECT $1,
              (d + $6::time + make_interval(mins => $8::int * i)) AT TIME ZONE $2,
              (d + $6::time + make_interval(mins => $8::int * (i + 1))) AT TIME ZONE $2,
              $9::boolean
         FROM generate_series($3::date::timestamp, $4::date::timestamp, interval '1 day') AS d,
              generate_series(0, floor(extract(epoch FROM ($7::time - $6::time)) / 60 / $8::int)::int - 1) AS i
        WHERE extract(isodow FROM d)::int = ANY($5::int[])
       ON CONFLICT DO NOTHING`,
      [
        params.doctorId,
        params.timezone,
        params.from,
        params.to,
        params.weekdays,
        params.dayStart,
        params.dayEnd,
        params.slotMinutes,
        params.onlineBookable,
      ],
    );
    return rowCount ?? 0;
  }
}
