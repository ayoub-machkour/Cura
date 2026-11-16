import { z } from 'zod';
import { APPOINTMENT_STATUSES, BOOKING_SOURCES, LIMITS } from '../constraints';
import { IsoDateTime, page, PaginationQuery, safeText, Uuid } from '../primitives';
import { SlotDto } from './slots';

export const AppointmentStatus = z.enum(APPOINTMENT_STATUSES);
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;
export const BookingSource = z.enum(BOOKING_SOURCES);

export const BookAppointmentRequest = z.object({
  slotId: Uuid,
  appointmentTypeId: Uuid,
  /** Généré par le client AVANT l'envoi et réutilisé à chaque retry. */
  idempotencyKey: Uuid,
  /** Jeton reçu lors de la pré-réservation du créneau. */
  holdToken: z.string().min(16).max(128).optional(),
  note: safeText(LIMITS.note.max).optional(),
  /** Requis pour le personnel (réservation pour un patient), interdit pour un patient. */
  patientId: Uuid.optional(),
});
export type BookAppointmentRequest = z.infer<typeof BookAppointmentRequest>;

export const HoldSlotRequest = z.object({ appointmentTypeId: Uuid });
export const SlotParams = z.object({ slotId: Uuid });

export const SlotHoldResponse = z.object({
  slotId: Uuid,
  holdToken: z.string(),
  expiresAt: IsoDateTime,
});
export type SlotHoldResponse = z.infer<typeof SlotHoldResponse>;

export const CancelAppointmentRequest = z.object({
  reason: safeText(LIMITS.cancelReason.max).optional(),
});

export const AppointmentDto = z.object({
  id: Uuid,
  doctorId: Uuid,
  patientId: Uuid,
  appointmentTypeId: Uuid,
  slotId: Uuid.nullable(),
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  status: AppointmentStatus,
  source: BookingSource,
  /** Incrémenté à chaque changement : sert au verrouillage optimiste (expectedVersion). */
  version: z.number().int().min(1),
  checkedInAt: IsoDateTime.nullable(),
  consultationStartedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
});
export type AppointmentDto = z.infer<typeof AppointmentDto>;

/** Corps commun des transitions de statut. */
export const AppointmentTransitionRequest = z.object({
  /** Si fourni, la transition échoue (409 STALE_VERSION) quand le RDV a changé entre-temps. */
  expectedVersion: z.number().int().min(1).optional(),
});
export type AppointmentTransitionRequest = z.infer<typeof AppointmentTransitionRequest>;

export const AppointmentPage = page(AppointmentDto);

export const ListMyAppointmentsQuery = PaginationQuery.extend({
  scope: z.enum(['upcoming', 'past']).default('upcoming'),
});
export type ListMyAppointmentsQuery = z.infer<typeof ListMyAppointmentsQuery>;

export const ListAgendaQuery = PaginationQuery.extend({
  doctorId: Uuid,
  from: IsoDateTime,
  to: IsoDateTime,
}).refine((q) => q.from < q.to, { error: '`from` doit précéder `to`', path: ['to'] });
export type ListAgendaQuery = z.infer<typeof ListAgendaQuery>;

export const SlotUnavailableReason = z.enum([
  'ALREADY_BOOKED',
  'HELD_BY_OTHER',
  'LOCK_CONTENTION',
  'BLOCKED',
  'NOT_ONLINE_BOOKABLE',
  'TOO_LATE',
]);
export type SlotUnavailableReason = z.infer<typeof SlotUnavailableReason>;

/** Corps d'une réponse 409 : l'UX enchaîne directement sur les alternatives. */
export const SlotUnavailableResponse = z.object({
  code: z.literal('SLOT_UNAVAILABLE'),
  reason: SlotUnavailableReason,
  message: z.string(),
  requestId: z.string().optional(),
  alternatives: z.array(SlotDto),
});
export type SlotUnavailableResponse = z.infer<typeof SlotUnavailableResponse>;
