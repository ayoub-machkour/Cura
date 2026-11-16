import type { AppointmentTypeDto, CreateAppointmentTypeRequest, Role, UpdateAppointmentTypeRequest } from '@cura/shared';
import { NotFoundError } from '../../common/errors';
import type { AppLogger } from '../../infra/logger';
import type { AppointmentTypesRepository } from './appointment-types.repository';

export class AppointmentTypesService {
  constructor(
    private readonly repo: AppointmentTypesRepository,
    private readonly logger: AppLogger,
  ) {}

  async create(input: CreateAppointmentTypeRequest, actorId: string): Promise<AppointmentTypeDto> {
    const type = await this.repo.create(input);
    this.logger.info({ event: 'appointment_type.created', appointmentTypeId: type.id, actorId }, 'appointment type created');
    return type;
  }

  async update(id: string, changes: UpdateAppointmentTypeRequest, actorId: string): Promise<AppointmentTypeDto> {
    const type = await this.repo.update(id, changes);
    if (!type) throw new NotFoundError('Motif');
    this.logger.info({ event: 'appointment_type.updated', appointmentTypeId: id, fields: Object.keys(changes), actorId }, 'appointment type updated');
    return type;
  }

  /** Un patient ne voit que les motifs actifs réservables en ligne ; le personnel voit tout. */
  async listFor(role: Role): Promise<AppointmentTypeDto[]> {
    const isPatient = role === 'patient';
    return this.repo.list({ onlyActive: isPatient, onlyOnline: isPatient });
  }
}
