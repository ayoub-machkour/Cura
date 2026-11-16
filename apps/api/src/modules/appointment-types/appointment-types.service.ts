/**
 * Catalogue des soins / motifs. Le médecin gère SES soins et leurs prix ; l'admin gère tout,
 * y compris les motifs communs au cabinet (ex. « Première consultation »).
 */
import type { AppointmentTypeDto, CreateAppointmentTypeRequest, UpdateAppointmentTypeRequest } from '@cura/shared';
import { ForbiddenError, NotFoundError } from '../../common/errors';
import type { AuthPrincipal } from '../../common/security/tokens';
import type { AppLogger } from '../../infra/logger';
import type { AppointmentTypesRepository } from './appointment-types.repository';

export class AppointmentTypesService {
  constructor(
    private readonly repo: AppointmentTypesRepository,
    private readonly logger: AppLogger,
  ) {}

  async create(input: CreateAppointmentTypeRequest, principal: AuthPrincipal): Promise<AppointmentTypeDto> {
    let doctorId = input.doctorId ?? null;
    if (principal.role === 'doctor') {
      // Un médecin ne crée que SES soins (jamais un motif commun au cabinet).
      if (!principal.did) throw new ForbiddenError('Aucun médecin lié à ce compte');
      if (doctorId !== null && doctorId !== principal.did) throw new ForbiddenError('Vous ne pouvez gérer que vos propres soins');
      doctorId = principal.did;
    }
    const type = await this.repo.create({ ...input, doctorId });
    this.logger.info({ event: 'appointment_type.created', appointmentTypeId: type.id, doctorId, actorId: principal.sub }, 'appointment type created');
    return type;
  }

  async update(id: string, changes: UpdateAppointmentTypeRequest, principal: AuthPrincipal): Promise<AppointmentTypeDto> {
    const existing = await this.repo.findById(id);
    // Un médecin ne voit pas (404) les soins des autres ni les motifs communs, réservés à l'admin.
    if (!existing || (principal.role === 'doctor' && existing.doctorId !== principal.did)) throw new NotFoundError('Soin');
    const type = await this.repo.update(id, changes);
    if (!type) throw new NotFoundError('Soin');
    this.logger.info({ event: 'appointment_type.updated', appointmentTypeId: id, fields: Object.keys(changes), actorId: principal.sub }, 'appointment type updated');
    return type;
  }

  /** Un patient ne voit que les soins actifs réservables en ligne ; le personnel voit tout. */
  async listFor(principal: AuthPrincipal, doctorId?: string): Promise<AppointmentTypeDto[]> {
    const isPatient = principal.role === 'patient';
    return this.repo.list({ onlyActive: isPatient, onlyOnline: isPatient, doctorId });
  }
}
