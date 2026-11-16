import { z } from 'zod';
import { IsoDate, IsoDateTime, Uuid } from '../primitives';
import { AppointmentStatus } from './appointments';

export const QueueQuery = z.object({ doctorId: Uuid });
export type QueueQuery = z.infer<typeof QueueQuery>;

export const QueueEntryDto = z.object({
  appointmentId: Uuid,
  patientId: Uuid,
  patientFirstName: z.string(),
  patientLastName: z.string(),
  appointmentTypeId: Uuid,
  startsAt: IsoDateTime,
  status: AppointmentStatus,
  version: z.number().int(),
  checkedInAt: IsoDateTime.nullable(),
  consultationStartedAt: IsoDateTime.nullable(),
  /** Rang dans la salle d'attente (1 = prochain appelé), null hors salle d'attente. */
  position: z.number().int().min(1).nullable(),
  /** Patient attendu dont l'heure de RDV est dépassée. */
  isLate: z.boolean(),
});
export type QueueEntryDto = z.infer<typeof QueueEntryDto>;

/** File d'attente du jour d'un médecin (jour calendaire dans SON fuseau). */
export const QueueDto = z.object({
  doctorId: Uuid,
  date: IsoDate,
  inConsultation: QueueEntryDto.nullable(),
  /** Patients arrivés, ordre d'arrivée (premier arrivé, premier appelé). */
  waiting: z.array(QueueEntryDto),
  /** Patients attendus aujourd'hui, pas encore arrivés, par heure de RDV. */
  expected: z.array(QueueEntryDto),
});
export type QueueDto = z.infer<typeof QueueDto>;

/** Vue patient : sa place dans la file (app mobile). */
export const QueuePositionDto = z.object({
  appointmentId: Uuid,
  status: AppointmentStatus,
  /** Nombre de patients à passer avant lui (0 = c'est son tour ou il est en consultation). */
  patientsAhead: z.number().int().min(0).nullable(),
});
export type QueuePositionDto = z.infer<typeof QueuePositionDto>;
