/**
 * BookingService — réservation sûre en cas d'accès concurrents.
 *
 * ┌──────────────────────────── Stratégie à 3 niveaux ────────────────────────────┐
 * │ 1. Redis (UX)        Pré-réservation TTL posée à la SÉLECTION du créneau.     │
 * │                      Advisory : si Redis tombe, on continue sans.             │
 * │ 2. SELECT FOR UPDATE Sérialise les transactions qui visent le MÊME créneau.   │
 * │ 3. Contraintes SQL   EXCLUDE + UNIQUE partiel : même un bug applicatif ne     │
 * │                      peut pas produire de double réservation.                 │
 * └───────────────────────────────────────────────────────────────────────────────┘
 * En cas de collision : 409 + créneaux alternatifs les plus proches, calculés HORS
 * transaction pour ne jamais prolonger la détention du verrou.
 *
 * Ce service ne contient AUCUN SQL : il orchestre les repositories dans une transaction.
 */
import type {
  AppointmentDto,
  BookAppointmentRequest,
  ListAgendaQuery,
  ListMyAppointmentsQuery,
  Page,
  SlotDto,
  SlotHoldResponse,
} from '@cura/shared';
import type { Clock } from '../../common/clock';
import { BusinessRuleError, DomainError, ForbiddenError, NotFoundError } from '../../common/errors';
import { decodeCursor, TimeIdCursor, toPage } from '../../common/pagination';
import type { AuthPrincipal } from '../../common/security/tokens';
import type { TransactionManager } from '../../infra/db/transaction';
import type { AppLogger } from '../../infra/logger';
import type { AppointmentTypesRepository } from '../appointment-types/appointment-types.repository';
import type { SlotsRepository } from '../slots/slots.repository';
import { toSlotDto } from '../slots/slots.service';
import { DuplicateIdempotencyKeyError, PatientTimeConflictError, SlotUnavailableError } from './booking.errors';
import type { SlotHoldStore } from './booking.ports';
import type { AppointmentRecord, BookingRepository, BookingSourceValue } from './booking.repository';

export interface BookingConfig {
  lockTimeoutMs: number;
  minLeadMinutes: number;
  holdTtlSeconds: number;
  alternativesCount: number;
}

export interface BookCommand {
  patientId: string;
  slotId: string;
  appointmentTypeId: string;
  idempotencyKey: string;
  source: BookingSourceValue;
  holdToken?: string;
  note?: string;
  /** Utilisateur à l'origine de l'action (historique). Absent = action système. */
  actorUserId?: string;
}

export interface BookingResult {
  appointment: AppointmentDto;
  /** true si la requête rejoue une réservation déjà réussie (retry réseau, double tap). */
  replayed: boolean;
}

interface Deps {
  tx: TransactionManager;
  appointments: BookingRepository;
  slots: SlotsRepository;
  types: AppointmentTypesRepository;
  holds: SlotHoldStore;
  clock: Clock;
  logger: AppLogger;
  config: BookingConfig;
}

export const toAppointmentDto = (a: AppointmentRecord): AppointmentDto => ({
  id: a.id,
  doctorId: a.doctorId,
  patientId: a.patientId,
  appointmentTypeId: a.appointmentTypeId,
  slotId: a.slotId,
  startsAt: a.startsAt.toISOString(),
  endsAt: a.endsAt.toISOString(),
  status: a.status,
  source: a.source,
  version: a.version,
  checkedInAt: a.checkedInAt?.toISOString() ?? null,
  consultationStartedAt: a.consultationStartedAt?.toISOString() ?? null,
  completedAt: a.completedAt?.toISOString() ?? null,
});

const CANCELLABLE = new Set(['scheduled', 'confirmed']);

export class BookingService {
  constructor(private readonly deps: Deps) {}

  /** Traduit la requête HTTP + l'identité en commande métier (qui réserve pour qui). */
  commandFor(principal: AuthPrincipal, body: BookAppointmentRequest): BookCommand {
    const base = {
      slotId: body.slotId,
      appointmentTypeId: body.appointmentTypeId,
      idempotencyKey: body.idempotencyKey,
      holdToken: body.holdToken,
      note: body.note,
      actorUserId: principal.sub,
    };
    if (principal.role === 'patient') {
      if (!principal.pid) throw new ForbiddenError('Aucun dossier patient lié à ce compte');
      if (body.patientId && body.patientId !== principal.pid) {
        throw new ForbiddenError('Un patient ne peut réserver que pour lui-même');
      }
      return { ...base, patientId: principal.pid, source: 'mobile' };
    }
    if (!body.patientId) throw new BusinessRuleError('PATIENT_REQUIRED', 'patientId est requis pour une réservation par le cabinet');
    return { ...base, patientId: body.patientId, source: 'desk' };
  }

  async book(cmd: BookCommand): Promise<BookingResult> {
    const { tx, appointments, slots, types, config } = this.deps;

    // 0. Idempotence : le client a peut-être déjà réussi puis perdu la réponse.
    const previous = await appointments.findByIdempotencyKey(cmd.patientId, cmd.idempotencyKey);
    if (previous) return { appointment: toAppointmentDto(previous), replayed: true };

    // 1. Pré-contrôle Redis (rapide, sans toucher la base).
    await this.assertNotHeldByAnotherPatient(cmd);

    // 2. Transaction critique — la plus courte possible.
    try {
      const created = await tx.run(
        async (db) => {
          const slot = await slots.lockForBooking(cmd.slotId, db); // ⟵ point de sérialisation
          if (!slot) throw new NotFoundError('Créneau');
          if (slot.status !== 'open') throw new SlotUnavailableError(slot.id, 'BLOCKED');
          if (cmd.source === 'mobile') {
            if (!slot.onlineBookable) throw new SlotUnavailableError(slot.id, 'NOT_ONLINE_BOOKABLE');
            if (slot.startsAt < this.earliestOnlineStart()) throw new SlotUnavailableError(slot.id, 'TOO_LATE');
          }
          if (slot.startsAt <= this.deps.clock.now()) throw new SlotUnavailableError(slot.id, 'TOO_LATE');

          const type = await types.findById(cmd.appointmentTypeId, db);
          if (!type || !type.isActive) throw new NotFoundError('Motif');
          if (cmd.source === 'mobile' && !type.bookableOnline) {
            throw new BusinessRuleError('TYPE_NOT_BOOKABLE_ONLINE', 'Ce motif ne peut pas être réservé en ligne.');
          }
          const slotMinutes = (slot.endsAt.getTime() - slot.startsAt.getTime()) / 60_000;
          if (type.durationMinutes > slotMinutes) {
            throw new BusinessRuleError('TYPE_TOO_LONG', 'La durée de ce motif dépasse celle du créneau.');
          }

          // Verrou acquis : ce contrôle voit l'état réellement commité.
          if (await slots.hasActiveAppointment(slot.id, db)) throw new SlotUnavailableError(slot.id, 'ALREADY_BOOKED');

          const appointment = await appointments.insert(
            {
              doctorId: slot.doctorId,
              patientId: cmd.patientId,
              appointmentTypeId: type.id,
              slotId: slot.id,
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              source: cmd.source,
              idempotencyKey: cmd.idempotencyKey,
              note: cmd.note,
            },
            db,
          );
          await appointments.insertStatusChange(
            { appointmentId: appointment.id, from: null, to: appointment.status, actorUserId: cmd.actorUserId ?? null },
            db,
          );

          // Même transaction ⇒ l'événement existe si et seulement si le RDV existe.
          await appointments.insertOutboxEvent(
            {
              aggregateType: 'appointment',
              aggregateId: appointment.id,
              eventType: 'appointment.booked',
              payload: { ...toAppointmentDto(appointment) },
            },
            db,
          );
          return appointment;
        },
        { lockTimeoutMs: config.lockTimeoutMs },
      );

      await this.releaseHoldQuietly(cmd);
      this.deps.logger.info(
        { event: 'appointment.booked', appointmentId: created.id, slotId: cmd.slotId, source: cmd.source },
        'appointment booked',
      );
      return { appointment: toAppointmentDto(created), replayed: false };
    } catch (err) {
      return this.recover(err, cmd);
    }
  }

  /** Pré-réservation posée quand le patient touche un créneau dans l'app. */
  async hold(slotId: string, appointmentTypeId: string, patientId: string): Promise<SlotHoldResponse> {
    const slot = await this.deps.slots.findById(slotId);
    if (!slot) throw new NotFoundError('Créneau');
    const hold = await this.deps.holds.acquire(slotId, patientId, this.deps.config.holdTtlSeconds * 1000);
    if (!hold) {
      const alternatives = await this.findAlternatives({ slotId, appointmentTypeId, patientId, source: 'mobile' });
      throw new SlotUnavailableError(slotId, 'HELD_BY_OTHER', alternatives);
    }
    return { slotId, holdToken: hold.token, expiresAt: hold.expiresAt.toISOString() };
  }

  async cancel(appointmentId: string, principal: AuthPrincipal, reason?: string): Promise<AppointmentDto> {
    const { tx, appointments, clock, logger } = this.deps;
    const cancelled = await tx.run(async (db) => {
      const appt = await appointments.lockById(appointmentId, db);
      // Un patient qui vise le RDV d'un autre reçoit 404 (pas 403) : on ne révèle pas son existence.
      if (!appt || (principal.role === 'patient' && appt.patientId !== principal.pid)) throw new NotFoundError('Rendez-vous');
      if (!CANCELLABLE.has(appt.status)) {
        throw new BusinessRuleError('NOT_CANCELLABLE', `Un rendez-vous au statut « ${appt.status} » ne peut pas être annulé`);
      }
      if (principal.role === 'patient' && appt.startsAt <= clock.now()) {
        throw new BusinessRuleError('NOT_CANCELLABLE', 'Un rendez-vous passé ne peut pas être annulé');
      }
      const updated = await appointments.markCancelled(appt.id, reason ?? null, db);
      await appointments.insertStatusChange(
        { appointmentId: appt.id, from: appt.status, to: 'cancelled', actorUserId: principal.sub },
        db,
      );
      await appointments.insertOutboxEvent(
        {
          aggregateType: 'appointment',
          aggregateId: updated.id,
          eventType: 'appointment.cancelled',
          payload: { ...toAppointmentDto(updated), previousStatus: appt.status },
        },
        db,
      );
      return updated;
    });
    logger.info({ event: 'appointment.cancelled', appointmentId, actorId: principal.sub, role: principal.role }, 'appointment cancelled');
    return toAppointmentDto(cancelled);
  }

  async listMine(patientId: string, query: ListMyAppointmentsQuery): Promise<Page<AppointmentDto>> {
    const rows = await this.deps.appointments.listForPatient({
      patientId,
      scope: query.scope,
      now: this.deps.clock.now(),
      limit: query.limit,
      after: decodeCursor(query.cursor, TimeIdCursor),
    });
    return toPage(rows, query.limit, toAppointmentDto, (r) => [r.startsAt.toISOString(), r.id]);
  }

  async listAgenda(query: ListAgendaQuery): Promise<Page<AppointmentDto>> {
    const rows = await this.deps.appointments.listForDoctor({
      doctorId: query.doctorId,
      from: new Date(query.from),
      to: new Date(query.to),
      limit: query.limit,
      after: decodeCursor(query.cursor, TimeIdCursor),
    });
    return toPage(rows, query.limit, toAppointmentDto, (r) => [r.startsAt.toISOString(), r.id]);
  }

  /**
   * Traduit un échec en résultat métier :
   * - rejeu concurrent de la même requête → on renvoie le RDV existant ;
   * - toute SlotUnavailableError est enrichie avec les alternatives.
   */
  private async recover(err: unknown, cmd: BookCommand): Promise<BookingResult> {
    const isConflict =
      err instanceof SlotUnavailableError || err instanceof PatientTimeConflictError || err instanceof DuplicateIdempotencyKeyError;
    if (!isConflict) throw err;

    // Double tap avec la même clé : la 1re requête a gagné, la 2e a buté sur le verrou
    // ou la contrainte. Ce n'est pas un conflit, c'est un rejeu.
    const replay = await this.deps.appointments.findByIdempotencyKey(cmd.patientId, cmd.idempotencyKey);
    if (replay) return { appointment: toAppointmentDto(replay), replayed: true };

    if (err instanceof SlotUnavailableError) {
      this.deps.logger.info({ event: 'appointment.conflict', slotId: cmd.slotId, reason: err.reason }, 'booking conflict');
      throw err.withAlternatives(await this.findAlternatives(cmd));
    }
    throw err;
  }

  private async assertNotHeldByAnotherPatient(cmd: BookCommand): Promise<void> {
    // Le secrétariat passe outre les pré-réservations mobiles (patient au guichet).
    if (cmd.source !== 'mobile') return;
    try {
      const holder = await this.deps.holds.getHolder(cmd.slotId);
      if (holder && holder.ownerId !== cmd.patientId) {
        throw new SlotUnavailableError(cmd.slotId, 'HELD_BY_OTHER').withAlternatives(await this.findAlternatives(cmd));
      }
    } catch (err) {
      if (err instanceof DomainError) throw err;
      // Redis indisponible : dégradation sans risque, PostgreSQL reste l'arbitre.
      this.deps.logger.warn({ err, slotId: cmd.slotId }, 'slot hold check skipped (redis unavailable)');
    }
  }

  private async releaseHoldQuietly(cmd: BookCommand): Promise<void> {
    if (!cmd.holdToken) return;
    try {
      await this.deps.holds.release(cmd.slotId, cmd.patientId, cmd.holdToken);
    } catch (err) {
      this.deps.logger.warn({ err, slotId: cmd.slotId }, 'slot hold release failed (TTL will clean up)');
    }
  }

  /** Créneaux libres les plus proches de celui demandé, chez le même médecin. */
  async findAlternatives(cmd: Pick<BookCommand, 'slotId' | 'appointmentTypeId' | 'patientId' | 'source'>): Promise<SlotDto[]> {
    const { slots, types, holds, config, logger, clock } = this.deps;
    try {
      const [target, type] = await Promise.all([slots.findById(cmd.slotId), types.findById(cmd.appointmentTypeId)]);
      if (!target) return [];

      const onlineOnly = cmd.source === 'mobile';
      const candidates = await slots.findNearestAvailable({
        doctorId: target.doctorId,
        around: target.startsAt,
        notBefore: onlineOnly ? this.earliestOnlineStart() : clock.now(),
        minDurationMinutes: type?.durationMinutes ?? 0,
        onlineOnly,
        excludeSlotIds: [target.id],
        limit: config.alternativesCount * 3, // sur-échantillonnage, puis filtre des créneaux pré-réservés
      });
      const heldIds = await holds.heldByOthers(candidates.map((s) => s.id), cmd.patientId).catch(() => new Set<string>());

      return candidates.filter((s) => !heldIds.has(s.id)).slice(0, config.alternativesCount).map(toSlotDto);
    } catch (err) {
      // Ne jamais masquer le vrai résultat (409) par une erreur annexe.
      logger.error({ err, slotId: cmd.slotId }, 'failed to compute alternatives');
      return [];
    }
  }

  private earliestOnlineStart(): Date {
    return new Date(this.deps.clock.now().getTime() + this.deps.config.minLeadMinutes * 60_000);
  }
}
