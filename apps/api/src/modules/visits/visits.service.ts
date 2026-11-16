/**
 * Parcours de visite : confirmation, arrivée, début et fin de consultation, absence.
 * Chaque transition : verrou de ligne + contrôle de version + machine à états +
 * historique + événement outbox, dans UNE transaction.
 */
import type { AppointmentDto, CreateWalkInRequest } from '@cura/shared';
import type { Clock } from '../../common/clock';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError } from '../../common/errors';
import type { AuthPrincipal } from '../../common/security/tokens';
import type { TransactionManager } from '../../infra/db/transaction';
import type { AppLogger } from '../../infra/logger';
import type { AppointmentTypesRepository } from '../appointment-types/appointment-types.repository';
import type { BookingRepository, LockedAppointment } from '../booking/booking.repository';
import type { DoctorsRepository } from '../doctors/doctors.repository';
import { toAppointmentDto } from '../booking/booking.service';
import { checkTransition, TRANSITIONS, type VisitAction } from './visit-state-machine';

interface Deps {
  tx: TransactionManager;
  appointments: BookingRepository;
  doctors: DoctorsRepository;
  types: AppointmentTypesRepository;
  clock: Clock;
  logger: AppLogger;
}

/**
 * Périmètre de chaque rôle : un patient n'agit que sur SES rendez-vous, un médecin
 * sur ceux de SON agenda ; secrétariat et admin sur tous.
 * Hors périmètre → 404 (on ne révèle pas l'existence du rendez-vous).
 */
export function canActOn(principal: AuthPrincipal, appt: { patientId: string; doctorId: string }): boolean {
  switch (principal.role) {
    case 'patient':
      return principal.pid !== null && appt.patientId === principal.pid;
    case 'doctor':
      return principal.did !== null && appt.doctorId === principal.did;
    case 'secretary':
    case 'admin':
      return true;
  }
}

export class VisitsService {
  constructor(private readonly deps: Deps) {}

  async transition(appointmentId: string, action: VisitAction, principal: AuthPrincipal, expectedVersion?: number): Promise<AppointmentDto> {
    const { tx, appointments, clock, logger } = this.deps;
    const now = clock.now();

    const { before, after } = await tx.run(async (db) => {
      const appt = await appointments.lockForTransition(appointmentId, now, db);
      if (!appt || !canActOn(principal, appt)) throw new NotFoundError('Rendez-vous');

      this.assertVersion(appt, expectedVersion);
      const failure = checkTransition(action, { ...appt, now });
      if (failure) {
        throw failure.code === 'INVALID_TRANSITION'
          ? new ConflictError(failure.code, failure.message)
          : new BusinessRuleError(failure.code, failure.message);
      }

      const to = TRANSITIONS[action].to;
      const updated = await appointments.applyStatus(appt.id, to, now, db);
      await appointments.insertStatusChange({ appointmentId: appt.id, from: appt.status, to, actorUserId: principal.sub }, db);
      await appointments.insertOutboxEvent(
        {
          aggregateType: 'appointment',
          aggregateId: appt.id,
          eventType: 'appointment.status_changed',
          payload: { ...toAppointmentDto(updated), previousStatus: appt.status },
        },
        db,
      );
      return { before: appt, after: updated };
    });

    logger.info(
      { event: 'appointment.status_changed', appointmentId, from: before.status, to: after.status, actorId: principal.sub, role: principal.role },
      'appointment status changed',
    );
    return toAppointmentDto(after);
  }

  /**
   * Patient sans rendez-vous : la visite entre directement en salle d'attente (ordre d'arrivée).
   * Elle n'occupe pas l'agenda — c'est la file qui la gère.
   */
  async registerWalkIn(input: CreateWalkInRequest, principal: AuthPrincipal): Promise<AppointmentDto> {
    const { tx, appointments, clock, logger, doctors, types } = this.deps;
    if (principal.role === 'doctor' && principal.did !== input.doctorId) {
      throw new ForbiddenError('Un médecin n’enregistre des patients que dans sa propre file');
    }
    const now = clock.now();

    const created = await tx.run(async (db) => {
      if (!(await doctors.findById(input.doctorId, db))) throw new NotFoundError('Médecin');
      const type = await types.findById(input.appointmentTypeId, db);
      if (!type || !type.isActive) throw new NotFoundError('Motif');
      if (!(await appointments.lockPatient(input.patientId, db))) throw new NotFoundError('Patient');

      const visit = await appointments.insertWalkIn(
        {
          doctorId: input.doctorId,
          patientId: input.patientId,
          appointmentTypeId: type.id,
          arrivedAt: now,
          durationMinutes: type.durationMinutes,
          note: input.note,
        },
        db,
      );
      await appointments.insertStatusChange({ appointmentId: visit.id, from: null, to: 'checked_in', actorUserId: principal.sub }, db);
      await appointments.insertOutboxEvent(
        { aggregateType: 'appointment', aggregateId: visit.id, eventType: 'appointment.booked', payload: { ...toAppointmentDto(visit) } },
        db,
      );
      return visit;
    });

    logger.info({ event: 'visit.walk_in', appointmentId: created.id, doctorId: input.doctorId, actorId: principal.sub }, 'walk-in registered');
    return toAppointmentDto(created);
  }

  private assertVersion(appt: LockedAppointment, expectedVersion?: number): void {
    if (expectedVersion !== undefined && appt.version !== expectedVersion) {
      throw new ConflictError(
        'STALE_VERSION',
        'Ce rendez-vous a été modifié entre-temps. Rechargez la page pour voir son état actuel.',
      );
    }
  }
}
