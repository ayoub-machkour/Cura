/**
 * Contrats de l'API de réservation, partagés entre l'API, l'app cabinet et l'app mobile.
 * Une seule définition Zod ⇒ validation runtime côté serveur + types statiques côté clients.
 */
import { z } from 'zod';

const isoDateTime = z.string().datetime({ offset: true });

export const SlotDto = z.object({
  id: z.string().uuid(),
  doctorId: z.string().uuid(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
});
export type SlotDto = z.infer<typeof SlotDto>;

export const BookAppointmentRequest = z.object({
  slotId: z.string().uuid(),
  appointmentTypeId: z.string().uuid(),
  /** Généré par le client AVANT l'envoi et réutilisé à chaque retry. */
  idempotencyKey: z.string().uuid(),
  /** Jeton reçu lors de la sélection du créneau (pré-réservation Redis). */
  holdToken: z.string().min(16).max(128).optional(),
  note: z.string().trim().max(500).optional(),
});
export type BookAppointmentRequest = z.infer<typeof BookAppointmentRequest>;

export const AppointmentDto = z.object({
  id: z.string().uuid(),
  doctorId: z.string().uuid(),
  patientId: z.string().uuid(),
  appointmentTypeId: z.string().uuid(),
  slotId: z.string().uuid().nullable(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  status: z.enum([
    'scheduled', 'confirmed', 'checked_in', 'in_consultation', 'completed', 'cancelled', 'no_show',
  ]),
});
export type AppointmentDto = z.infer<typeof AppointmentDto>;

export const SlotHoldResponse = z.object({
  slotId: z.string().uuid(),
  holdToken: z.string(),
  expiresAt: isoDateTime,
});
export type SlotHoldResponse = z.infer<typeof SlotHoldResponse>;

/** Raisons pour lesquelles un créneau n'est plus réservable. */
export const SlotUnavailableReason = z.enum([
  'ALREADY_BOOKED',      // un autre patient l'a obtenu
  'HELD_BY_OTHER',       // pré-réservé par un autre patient (Redis TTL)
  'LOCK_CONTENTION',     // contention extrême : on n'attend pas indéfiniment
  'BLOCKED',             // fermé par le cabinet
  'NOT_ONLINE_BOOKABLE', // réservable uniquement au secrétariat
  'TOO_LATE',            // délai minimum de prévenance dépassé
]);
export type SlotUnavailableReason = z.infer<typeof SlotUnavailableReason>;

/** Corps d'une réponse HTTP 409 : l'UX enchaîne directement sur les alternatives. */
export const SlotUnavailableResponse = z.object({
  code: z.literal('SLOT_UNAVAILABLE'),
  reason: SlotUnavailableReason,
  message: z.string(),
  alternatives: z.array(SlotDto),
});
export type SlotUnavailableResponse = z.infer<typeof SlotUnavailableResponse>;

export const ApiErrorResponse = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponse>;
