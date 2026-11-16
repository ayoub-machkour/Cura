/**
 * Construction de la file d'attente du jour (salle d'attente + attendus + consultation en cours).
 * Politique d'appel : premier arrivé, premier appelé (ordre de check-in).
 */
import type { QueueDto, QueueEntryDto, QueuePositionDto } from '@cura/shared';
import type { Clock } from '../../common/clock';
import { ForbiddenError, NotFoundError } from '../../common/errors';
import type { AuthPrincipal } from '../../common/security/tokens';
import type { PatientAccess } from '../family/patient-access';
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
  group: row.status === 'checked_in' ? waitingGroup(row, now) : null,
});

type WaitingGroup = 'due' | 'walk_in' | 'early';
const GROUP_RANK: Record<WaitingGroup, number> = { due: 0, walk_in: 1, early: 2 };

/**
 * Politique de la salle d'attente (pratique des cabinets) :
 *  1. patients sur RDV dont l'heure est arrivée, par heure de RDV ;
 *  2. patients sans RDV, par ordre d'arrivée : ils prennent les trous (absences, retards) ;
 *  3. patients arrivés en avance, qui attendent leur heure.
 * Le médecin reste libre d'appeler un autre patient : c'est un ordre conseillé.
 */
function waitingGroup(row: QueueRow, now: Date): WaitingGroup {
  if (row.slotId === null) return 'walk_in';
  return row.startsAt <= now ? 'due' : 'early';
}

/** Salle d'attente dans l'ordre d'appel conseillé (départage stable par id). */
function waitingOrder(rows: QueueRow[], now: Date): QueueRow[] {
  const key = (r: QueueRow) => (r.slotId === null ? r.checkedInAt! : r.startsAt).getTime();
  return rows
    .filter((r) => r.status === 'checked_in')
    .sort(
      (a, b) =>
        GROUP_RANK[waitingGroup(a, now)] - GROUP_RANK[waitingGroup(b, now)] ||
        key(a) - key(b) ||
        a.checkedInAt!.getTime() - b.checkedInAt!.getTime() ||
        a.appointmentId.localeCompare(b.appointmentId),
    );
}

export class QueueService {
  constructor(
    private readonly repo: QueueRepository,
    private readonly clock: Clock,
    private readonly access: PatientAccess,
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
      waiting: waitingOrder(rows, now).map((r, i) => toEntry(r, now, i + 1)),
      expected: rows.filter((r) => r.status === 'scheduled' || r.status === 'confirmed').map((r) => toEntry(r, now, null)),
    };
  }

  /** Place d'un patient dans la file (app mobile : « 2 patients avant vous »). */
  async positionOf(appointmentId: string, principal: AuthPrincipal): Promise<QueuePositionDto> {
    const owner = await this.repo.findAppointmentOwner(appointmentId);
    if (!owner || !(await this.access.canActOnAppointment(principal, owner))) throw new NotFoundError('Rendez-vous');

    let patientsAhead: number | null = null;
    if (owner.status === 'in_consultation') {
      patientsAhead = 0;
    } else if (owner.status === 'checked_in') {
      const now = this.clock.now();
      const waiting = waitingOrder(await this.repo.todayForDoctor(owner.doctorId, now), now);
      const index = waiting.findIndex((r) => r.appointmentId === appointmentId);
      patientsAhead = index >= 0 ? index : null;
    }
    return { appointmentId, status: owner.status, patientsAhead };
  }
}
