/**
 * Ports (interfaces) dont dépend le BookingService.
 * Le service ne connaît ni `pg` ni `ioredis` directement (Dependency Inversion) :
 * on peut le tester avec des doubles et changer d'infrastructure sans le toucher.
 */
import type { Queryable, Tx } from '../../infra/db/transaction';

export type BookingSource = 'mobile' | 'desk' | 'phone';

export interface LockedSlot {
  id: string;
  doctorId: string;
  startsAt: Date;
  endsAt: Date;
  status: 'open' | 'blocked';
  onlineBookable: boolean;
}

export interface SlotRow {
  id: string;
  doctorId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface AppointmentTypeRow {
  id: string;
  durationMinutes: number;
  bookableOnline: boolean;
  isActive: boolean;
}

export interface AppointmentRow {
  id: string;
  doctorId: string;
  patientId: string;
  appointmentTypeId: string;
  slotId: string | null;
  startsAt: Date;
  endsAt: Date;
  status: string;
}

export interface NewAppointment {
  doctorId: string;
  patientId: string;
  appointmentTypeId: string;
  slotId: string;
  startsAt: Date;
  endsAt: Date;
  source: BookingSource;
  idempotencyKey: string;
  note?: string;
}

export interface OutboxEvent {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface NearestSlotsQuery {
  doctorId: string;
  around: Date;
  notBefore: Date;
  minDurationMinutes: number;
  onlineOnly: boolean;
  excludeSlotIds: string[];
  limit: number;
}

export interface BookingRepository {
  /** SELECT … FOR UPDATE : sérialise toutes les tentatives sur ce créneau. */
  lockSlot(tx: Tx, slotId: string): Promise<LockedSlot | null>;
  hasActiveAppointmentOnSlot(tx: Tx, slotId: string): Promise<boolean>;
  insertAppointment(tx: Tx, input: NewAppointment): Promise<AppointmentRow>;
  insertOutboxEvent(tx: Tx, event: OutboxEvent): Promise<void>;
  findAppointmentType(db: Queryable, id: string): Promise<AppointmentTypeRow | null>;
  findByIdempotencyKey(db: Queryable, patientId: string, key: string): Promise<AppointmentRow | null>;
  findSlotById(db: Queryable, slotId: string): Promise<SlotRow | null>;
  findNearestAvailableSlots(db: Queryable, query: NearestSlotsQuery): Promise<SlotRow[]>;
}

export interface SlotHold {
  ownerId: string;
  token: string;
  expiresAt: Date;
}

/**
 * Pré-réservation temporaire (TTL) posée quand le patient SÉLECTIONNE un créneau.
 * Couche UX uniquement : elle évite qu'un patient remplisse son formulaire pour
 * rien. La garantie d'unicité, elle, reste dans PostgreSQL.
 */
export interface SlotHoldStore {
  acquire(slotId: string, ownerId: string, ttlMs: number): Promise<SlotHold | null>;
  getHolder(slotId: string): Promise<SlotHold | null>;
  release(slotId: string, ownerId: string, token: string): Promise<void>;
  /** Parmi `slotIds`, ceux qui sont tenus par quelqu'un d'autre que `ownerId`. */
  heldByOthers(slotIds: readonly string[], ownerId: string): Promise<Set<string>>;
}

export interface Clock {
  now(): Date;
}

export interface Logger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
