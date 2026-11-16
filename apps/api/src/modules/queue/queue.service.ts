/**
 * Construction de la file d'attente du jour (salle d'attente + attendus + consultation en cours).
 * Politique d'appel : premier arrivé, premier appelé (ordre de check-in).
 */
import type { QueueDto, QueueEntryDto, QueuePositionDto } from '@cura/shared';
import type { Clock } from '../../common/clock';
import { ForbiddenError, NotFoundError } from '../../common/errors';
import type { AuthPrincipal } from '../../common/security/tokens';
import { canActOn } from '../visits/visits.service';
import type { QueueRepository, QueueRow } from './queue.repository';

const toEntry = (row: QueueRow, now: Date, position: number | null): QueueEntryDto => ({
  appointmentId: row.appointmentId,
  patientId: row.patientId,
  patientFirstName: row.patientFirstName,
  patientLastName: row.patientLastName,
  appointmentTypeId: row.appointmentTypeId,
  startsAt: row.startsAt.toISOString(),
  status: row.status,
  version: row.version,
  checkedInAt: row.checkedInAt?.toISOString() ?? null,
  consultationStartedAt: row.consultationStartedAt?.toISOString() ?? null,
  position,
  isLate: (row.status === 'scheduled' || row.status === 'confirmed') && row.startsAt < now,
  isWalkIn: row.slotId === null,
});

/** Salle d'attente triée par heure d'arrivée (départage stable par id). */
function waitingOrder(rows: QueueRow[]): QueueRow[] {
  return rows
    .filter((r) => r.status === 'checked_in')
    .sort((a, b) => a.checkedInAt!.getTime() - b.checkedInAt!.getTime() || a.appointmentId.localeCompare(b.appointmentId));
}

export class QueueService {
  constructor(
    private readonly repo: QueueRepository,
    private readonly clock: Clock,
  ) {}

  async forDoctor(doctorId: string, principal: AuthPrincipal): Promise<QueueDto> {
    // Un médecin ne consulte que SA file ; secrétariat et admin toutes.
    if (principal.role === 'doctor' && principal.did !== doctorId) throw new ForbiddenError('Vous ne pouvez consulter que votre propre file');

    const now = this.clock.now();
    const date = await this.repo.localDay(doctorId, now);
    if (!date) throw new NotFoundError('Médecin');

    const rows = await this.repo.todayForDoctor(doctorId, now);
    const current = rows.find((r) => r.status === 'in_consultation');
    return {
      doctorId,
      date,
      inConsultation: current ? toEntry(current, now, null) : null,
      waiting: waitingOrder(rows).map((r, i) => toEntry(r, now, i + 1)),
      expected: rows.filter((r) => r.status === 'scheduled' || r.status === 'confirmed').map((r) => toEntry(r, now, null)),
    };
  }

  /** Place d'un patient dans la file (app mobile : « 2 patients avant vous »). */
  async positionOf(appointmentId: string, principal: AuthPrincipal): Promise<QueuePositionDto> {
    const owner = await this.repo.findAppointmentOwner(appointmentId);
    if (!owner || !canActOn(principal, owner)) throw new NotFoundError('Rendez-vous');

    let patientsAhead: number | null = null;
    if (owner.status === 'in_consultation') {
      patientsAhead = 0;
    } else if (owner.status === 'checked_in') {
      const waiting = waitingOrder(await this.repo.todayForDoctor(owner.doctorId, this.clock.now()));
      const index = waiting.findIndex((r) => r.appointmentId === appointmentId);
      patientsAhead = index >= 0 ? index : null;
    }
    return { appointmentId, status: owner.status, patientsAhead };
  }
}
