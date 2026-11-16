/**
 * Lecture de la file d'attente du jour. Le « jour » est calculé dans le fuseau du
 * médecin, et converti en bornes UTC pour rester un range scan sur
 * ix_appointments_doctor_time (doctor_id, starts_at, id).
 */
import type { Pool } from 'pg';
import type { AppointmentStatus } from '@cura/shared';

export interface QueueRow {
  appointmentId: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  appointmentTypeId: string;
  doctorId: string;
  startsAt: Date;
  status: AppointmentStatus;
  version: number;
  checkedInAt: Date | null;
  consultationStartedAt: Date | null;
}

/** Nombre maximal de RDV d'un médecin sur une journée : borne de sécurité, jamais atteinte en pratique. */
export const MAX_DAY_APPOINTMENTS = 500;

const ACTIVE_TODAY = `('scheduled', 'confirmed', 'checked_in', 'in_consultation')`;

export class QueueRepository {
  constructor(private readonly pool: Pool) {}

  /** Jour local courant (YYYY-MM-DD) du médecin, ou null si le médecin n'existe pas. */
  async localDay(doctorId: string, now: Date): Promise<string | null> {
    const { rows } = await this.pool.query<{ day: string }>(
      `SELECT to_char($2::timestamptz AT TIME ZONE timezone, 'YYYY-MM-DD') AS day FROM doctors WHERE id = $1`,
      [doctorId, now],
    );
    return rows[0]?.day ?? null;
  }

  async todayForDoctor(doctorId: string, now: Date): Promise<QueueRow[]> {
    const { rows } = await this.pool.query<QueueRow>(
      `WITH day AS (
         SELECT timezone AS tz, date_trunc('day', $2::timestamptz AT TIME ZONE timezone) AS local_start
           FROM doctors WHERE id = $1
       )
       SELECT a.id AS "appointmentId", a.patient_id AS "patientId",
              p.first_name AS "patientFirstName", p.last_name AS "patientLastName",
              a.appointment_type_id AS "appointmentTypeId", a.doctor_id AS "doctorId",
              a.starts_at AS "startsAt", a.status, a.version,
              a.checked_in_at AS "checkedInAt", a.consultation_started_at AS "consultationStartedAt"
         FROM day
         JOIN appointments a
           ON a.doctor_id = $1
          AND a.starts_at >= (day.local_start AT TIME ZONE day.tz)
          AND a.starts_at <  ((day.local_start + interval '1 day') AT TIME ZONE day.tz)
         JOIN patients p ON p.id = a.patient_id
        WHERE a.status IN ${ACTIVE_TODAY}
        ORDER BY a.starts_at, a.id
        LIMIT ${MAX_DAY_APPOINTMENTS}`,
      [doctorId, now],
    );
    return rows;
  }

  async findAppointmentOwner(appointmentId: string): Promise<{ patientId: string; doctorId: string; status: AppointmentStatus } | null> {
    const { rows } = await this.pool.query<{ patientId: string; doctorId: string; status: AppointmentStatus }>(
      `SELECT patient_id AS "patientId", doctor_id AS "doctorId", status FROM appointments WHERE id = $1`,
      [appointmentId],
    );
    return rows[0] ?? null;
  }
}
