import type { GenerateSlotsRequest, ListAvailableSlotsQuery, Page, Role, SlotDto } from '@cura/shared';
import { NotFoundError } from '../../common/errors';
import { decodeCursor, TimeIdCursor, toPage } from '../../common/pagination';
import type { Clock } from '../../common/clock';
import type { AppLogger } from '../../infra/logger';
import type { AppointmentTypesRepository } from '../appointment-types/appointment-types.repository';
import type { DoctorsRepository } from '../doctors/doctors.repository';
import type { SlotRecord, SlotsRepository } from './slots.repository';

export const toSlotDto = (s: SlotRecord): SlotDto => ({
  id: s.id,
  doctorId: s.doctorId,
  startsAt: s.startsAt.toISOString(),
  endsAt: s.endsAt.toISOString(),
});

export class SlotsService {
  constructor(
    private readonly deps: {
      slots: SlotsRepository;
      doctors: DoctorsRepository;
      types: AppointmentTypesRepository;
      clock: Clock;
      logger: AppLogger;
      minLeadMinutes: number;
    },
  ) {}

  /** Disponibilités réelles. Un patient ne voit que les créneaux réservables en ligne et après le délai de prévenance. */
  async listAvailable(doctorId: string, query: ListAvailableSlotsQuery, role: Role): Promise<Page<SlotDto>> {
    const { slots, doctors, types, clock, minLeadMinutes } = this.deps;
    if (!(await doctors.findById(doctorId))) throw new NotFoundError('Médecin');

    let minDuration = 0;
    if (query.appointmentTypeId) {
      const type = await types.findById(query.appointmentTypeId);
      if (!type) throw new NotFoundError('Motif');
      minDuration = type.durationMinutes;
    }

    const isPatient = role === 'patient';
    const earliest = isPatient ? new Date(clock.now().getTime() + minLeadMinutes * 60_000) : clock.now();
    const from = new Date(Math.max(Date.parse(query.from), earliest.getTime()));

    const rows = await slots.listAvailable({
      doctorId,
      from,
      to: new Date(query.to),
      onlineOnly: isPatient,
      minDurationMinutes: minDuration,
      limit: query.limit,
      after: decodeCursor(query.cursor, TimeIdCursor),
    });
    return toPage(rows, query.limit, toSlotDto, (r) => [r.startsAt.toISOString(), r.id]);
  }

  async generate(doctorId: string, input: GenerateSlotsRequest, actorId: string): Promise<{ created: number }> {
    const doctor = await this.deps.doctors.findById(doctorId);
    if (!doctor) throw new NotFoundError('Médecin');

    const created = await this.deps.slots.generate({ ...input, doctorId, timezone: doctor.timezone });
    this.deps.logger.info(
      { event: 'slots.generated', doctorId, from: input.from, to: input.to, created, actorId },
      'slots generated',
    );
    return { created };
  }
}
