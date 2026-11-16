/**
 * Contrat temps réel (Socket.io, chemin /socket.io).
 *
 * Authentification : le cookie httpOnly de session est envoyé automatiquement à la
 * connexion (navigateur), ou `auth: { token }` pour un client natif.
 *
 * Salles :
 *  - patient  → rejoint automatiquement `patient:<patientId>` (ses propres RDV uniquement) ;
 *  - médecin  → rejoint automatiquement `doctor:<doctorId>` ;
 *  - personnel → émet `subscribe` { doctorId } pour suivre l'agenda / la file d'un médecin.
 *
 * Livraison « au moins une fois » : un même événement peut arriver deux fois (dédupliquer
 * par `id`) et l'ordre n'est pas garanti entre instances (comparer `data.version`).
 * Recommandation client : traiter l'événement comme un signal d'invalidation et
 * recharger la file / l'agenda concernés.
 */
import { z } from 'zod';
import { IsoDateTime, Uuid } from '../primitives';
import { AppointmentDto, AppointmentStatus } from './appointments';

export const REALTIME_PATH = '/socket.io';

export const REALTIME_EVENTS = ['appointment.booked', 'appointment.cancelled', 'appointment.status_changed'] as const;
export const RealtimeEventType = z.enum(REALTIME_EVENTS);
export type RealtimeEventType = z.infer<typeof RealtimeEventType>;

export const AppointmentEventData = AppointmentDto.extend({
  previousStatus: AppointmentStatus.nullable().optional(),
});

export const RealtimeEnvelope = z.object({
  /** Identifiant unique et croissant de l'événement (clé de déduplication). */
  id: z.string(),
  type: RealtimeEventType,
  occurredAt: IsoDateTime,
  data: AppointmentEventData,
});
export type RealtimeEnvelope = z.infer<typeof RealtimeEnvelope>;

export const SubscribeRequest = z.object({ doctorId: Uuid });
export type SubscribeRequest = z.infer<typeof SubscribeRequest>;

/**
 * Disponibilités en direct (tout utilisateur connecté, y compris les patients) :
 * émettre `watch_availability` { doctorId } puis recevoir `slot.availability`.
 * Aucune donnée personnelle : seulement « tel créneau vient d'être pris / libéré ».
 */
export const AVAILABILITY_EVENT = 'slot.availability';
export const AvailabilityEvent = z.object({
  doctorId: Uuid,
  slotId: Uuid,
  startsAt: IsoDateTime,
  available: z.boolean(),
});
export type AvailabilityEvent = z.infer<typeof AvailabilityEvent>;

export type SubscribeAck = { ok: true } | { ok: false; code: string; message: string };
