/**
 * BookingService — réservation d'un créneau, sûre en cas d'accès concurrents.
 *
 * ┌──────────────────────────── Stratégie à 3 niveaux ────────────────────────────┐
 * │ 1. Redis (UX)        Pré-réservation TTL posée à la SÉLECTION du créneau.     │
 * │                      Évite qu'un patient remplisse un formulaire pour rien.   │
 * │                      Advisory : si Redis tombe, on continue sans.             │
 * │ 2. SELECT FOR UPDATE Sérialise les transactions qui visent le MÊME créneau.   │
 * │                      La 2e attend la 1re, puis constate que c'est pris.       │
 * │ 3. Contraintes SQL   EXCLUDE + UNIQUE partiel : même un bug applicatif ne     │
 * │                      peut pas produire de double réservation.                 │
 * └───────────────────────────────────────────────────────────────────────────────┘
 *
 * En cas de collision : rejet propre (409) + créneaux alternatifs les plus proches,
 * calculés HORS transaction pour ne jamais prolonger la détention du verrou.
 */
import type { Pool } from 'pg';
import type { SlotDto } from '@medcine/shared';
import { PgErrorCode, isPgError, withTransaction } from '../../infra/db/transaction';
import {
  DomainError,
  InvalidAppointmentTypeError,
  NotFoundError,
  PatientTimeConflictError,
  SlotUnavailableError,
} from './booking.errors';
import type {
  AppointmentRow,
  BookingRepository,
  BookingSource,
  Clock,
  Logger,
  SlotHoldStore,
  SlotRow,
} from './booking.ports';

export interface BookingConfig {
  /** Attente max sur le verrou d'un créneau. Une transaction de réservation dure quelques ms. */
  lockTimeoutMs: number;
  /** Délai minimum entre maintenant et le début du RDV (réservation en ligne). */
  minLeadTimeMinutes: number;
  /** Nombre d'alternatives proposées au patient. */
  alternativesCount: number;
}

export interface BookCommand {
  patientId: string;
  slotId: string;
  appointmentTypeId: string;
  idempotencyKey: string;
  source: BookingSource;
  holdToken?: string;
  note?: string;
}

export interface BookingResult {
  appointment: AppointmentRow;
  /** true si la requête est un rejeu d'une réservation déjà réussie (retry réseau). */
  replayed: boolean;
}

interface BookingServiceDeps {
  pool: Pool;
  repo: BookingRepository;
  holds: SlotHoldStore;
  clock: Clock;
  logger: Logger;
  config: BookingConfig;
}

export class BookingService {
  constructor(private readonly deps: BookingServiceDeps) {}

  async book(cmd: BookCommand): Promise<BookingResult> {
    const { pool, repo } = this.deps;

    // ── 0. Idempotence : le client a peut-être déjà réussi puis perdu la réponse.
    const previous = await repo.findByIdempotencyKey(pool, cmd.patientId, cmd.idempotencyKey);
    if (previous) return { appointment: previous, replayed: true };

    // ── 1. Pré-contrôle Redis (rapide, sans toucher la base).
    await this.assertNotHeldByAnotherPatient(cmd);

    // ── 2. Transaction critique — la plus courte possible.
    try {
      const appointment = await withTransaction(
        pool,
        async (tx) => {
          const slot = await repo.lockSlot(tx, cmd.slotId); // ⟵ point de sérialisation
          if (!slot) throw new NotFoundError('Slot', cmd.slotId);

          if (slot.status !== 'open') {
            throw new SlotUnavailableError(slot.id, 'BLOCKED');
          }
          if (cmd.source === 'mobile') {
            if (!slot.onlineBookable) throw new SlotUnavailableError(slot.id, 'NOT_ONLINE_BOOKABLE');
            if (slot.startsAt < this.earliestOnlineStart()) throw new SlotUnavailableError(slot.id, 'TOO_LATE');
          }

          const type = await repo.findAppointmentType(tx, cmd.appointmentTypeId);
          if (!type || !type.isActive) throw new NotFoundError('AppointmentType', cmd.appointmentTypeId);
          if (cmd.source === 'mobile' && !type.bookableOnline) {
            throw new InvalidAppointmentTypeError('Ce motif ne peut pas être réservé en ligne.');
          }
          const slotMinutes = (slot.endsAt.getTime() - slot.startsAt.getTime()) / 60_000;
          if (type.durationMinutes > slotMinutes) {
            throw new InvalidAppointmentTypeError('La durée de ce motif dépasse celle du créneau.');
          }

          // Le verrou est acquis : ce contrôle voit l'état réellement commité.
          if (await repo.hasActiveAppointmentOnSlot(tx, slot.id)) {
            throw new SlotUnavailableError(slot.id, 'ALREADY_BOOKED');
          }

          const created = await repo.insertAppointment(tx, {
            doctorId: slot.doctorId,
            patientId: cmd.patientId,
            appointmentTypeId: type.id,
            slotId: slot.id,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            source: cmd.source,
            idempotencyKey: cmd.idempotencyKey,
            note: cmd.note,
          });

          // Même transaction ⇒ l'événement existe si et seulement si le RDV existe.
          // Consommé par : agenda live (Socket.io), planification des rappels J-1 / H-2.
          await repo.insertOutboxEvent(tx, {
            aggregateType: 'appointment',
            aggregateId: created.id,
            eventType: 'appointment.booked',
            payload: {
              appointmentId: created.id,
              doctorId: created.doctorId,
              patientId: created.patientId,
              slotId: slot.id,
              startsAt: created.startsAt.toISOString(),
              endsAt: created.endsAt.toISOString(),
              source: cmd.source,
            },
          });

          return created;
        },
        { lockTimeoutMs: this.deps.config.lockTimeoutMs },
      );

      // ── 3. Post-commit, best effort : libérer la pré-réservation.
      await this.releaseHoldQuietly(cmd);
      return { appointment, replayed: false };
    } catch (err) {
      return this.recover(err, cmd);
    }
  }

  /**
   * Traduit un échec en résultat métier :
   * - rejeu concurrent de la même requête → on renvoie le RDV existant ;
   * - violation de contrainte / contention de verrou → SlotUnavailableError ;
   * - toute SlotUnavailableError est enrichie avec les alternatives.
   */
  private async recover(err: unknown, cmd: BookCommand): Promise<BookingResult> {
    const conflict = this.toConflict(err, cmd);
    if (!conflict) throw err;

    // Double tap avec la même clé : la 1re requête a gagné, la 2e a buté sur
    // le verrou ou la contrainte. Ce n'est pas un conflit, c'est un rejeu.
    const replay = await this.deps.repo.findByIdempotencyKey(this.deps.pool, cmd.patientId, cmd.idempotencyKey);
    if (replay) return { appointment: replay, replayed: true };

    if (conflict instanceof SlotUnavailableError) {
      throw conflict.withAlternatives(await this.findAlternatives(cmd));
    }
    throw conflict;
  }

  private toConflict(err: unknown, cmd: BookCommand): DomainError | null {
    if (err instanceof SlotUnavailableError) return err;
    if (err instanceof PatientTimeConflictError) return err;
    if (!isPgError(err)) return null;

    switch (err.code) {
      case PgErrorCode.LockNotAvailable:
        return new SlotUnavailableError(cmd.slotId, 'LOCK_CONTENTION');
      case PgErrorCode.ExclusionViolation:
        return err.constraint === 'ex_appointments_patient_overlap'
          ? new PatientTimeConflictError()
          : new SlotUnavailableError(cmd.slotId, 'ALREADY_BOOKED');
      case PgErrorCode.UniqueViolation:
        // uq_appointments_active_slot (filet de sécurité) ou uq_appointments_idempotency
        // (rejeu, géré par recover()). Dans les deux cas : traitement "conflit".
        return new SlotUnavailableError(cmd.slotId, 'ALREADY_BOOKED');
      default:
        return null;
    }
  }

  private async assertNotHeldByAnotherPatient(cmd: BookCommand): Promise<void> {
    // Le secrétariat passe outre les pré-réservations mobiles (patient au guichet).
    if (cmd.source !== 'mobile') return;
    try {
      const holder = await this.deps.holds.getHolder(cmd.slotId);
      if (holder && holder.ownerId !== cmd.patientId) {
        throw new SlotUnavailableError(cmd.slotId, 'HELD_BY_OTHER').withAlternatives(
          await this.findAlternatives(cmd),
        );
      }
    } catch (err) {
      if (err instanceof DomainError) throw err;
      // Redis indisponible : on dégrade sans risque, PostgreSQL reste l'arbitre.
      this.deps.logger.warn({ err, slotId: cmd.slotId }, 'slot hold check skipped (redis unavailable)');
    }
  }

  private async releaseHoldQuietly(cmd: BookCommand): Promise<void> {
    if (!cmd.holdToken) return;
    try {
      await this.deps.holds.release(cmd.slotId, cmd.patientId, cmd.holdToken);
    } catch (err) {
      // Le TTL nettoiera de toute façon.
      this.deps.logger.warn({ err, slotId: cmd.slotId }, 'slot hold release failed');
    }
  }

  /** Créneaux libres les plus proches (dans le temps) de celui demandé, chez le même médecin. */
  async findAlternatives(cmd: Pick<BookCommand, 'slotId' | 'appointmentTypeId' | 'patientId' | 'source'>): Promise<SlotDto[]> {
    const { pool, repo, holds, config, logger } = this.deps;
    try {
      const [target, type] = await Promise.all([
        repo.findSlotById(pool, cmd.slotId),
        repo.findAppointmentType(pool, cmd.appointmentTypeId),
      ]);
      if (!target) return [];

      const onlineOnly = cmd.source === 'mobile';
      // On sur-échantillonne puis on retire les créneaux pré-réservés par d'autres.
      const candidates = await repo.findNearestAvailableSlots(pool, {
        doctorId: target.doctorId,
        around: target.startsAt,
        notBefore: onlineOnly ? this.earliestOnlineStart() : this.deps.clock.now(),
        minDurationMinutes: type?.durationMinutes ?? 0,
        onlineOnly,
        excludeSlotIds: [target.id],
        limit: config.alternativesCount * 3,
      });

      const heldIds = await holds
        .heldByOthers(candidates.map((s) => s.id), cmd.patientId)
        .catch(() => new Set<string>());

      return candidates
        .filter((s) => !heldIds.has(s.id))
        .slice(0, config.alternativesCount)
        .map(toSlotDto);
    } catch (err) {
      // Ne jamais masquer le vrai résultat (409) par une erreur annexe.
      logger.error({ err, slotId: cmd.slotId }, 'failed to compute alternatives');
      return [];
    }
  }

  private earliestOnlineStart(): Date {
    return new Date(this.deps.clock.now().getTime() + this.deps.config.minLeadTimeMinutes * 60_000);
  }
}

export function toSlotDto(slot: SlotRow): SlotDto {
  return {
    id: slot.id,
    doctorId: slot.doctorId,
    startsAt: slot.startsAt.toISOString(),
    endsAt: slot.endsAt.toISOString(),
  };
}
