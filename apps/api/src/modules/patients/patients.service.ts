import type {
  CreatePatientRequest,
  ListPatientsQuery,
  Page,
  PatientDto,
  UpdateMyProfileRequest,
  UpdatePatientRequest,
} from '@cura/shared';
import { NotFoundError } from '../../common/errors';
import { decodeCursor, NameIdCursor, toPage } from '../../common/pagination';
import type { AppLogger } from '../../infra/logger';
import type { PatientRecord, PatientsRepository } from './patients.repository';

export function toPatientDto(p: PatientRecord): PatientDto {
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    birthDate: p.birthDate,
    sex: p.sex,
    phone: p.phone,
    email: p.email,
    nationalId: p.nationalId,
    createdAt: p.createdAt.toISOString(),
  };
}

export class PatientsService {
  constructor(
    private readonly repo: PatientsRepository,
    private readonly logger: AppLogger,
  ) {}

  async create(input: CreatePatientRequest, actorId: string): Promise<PatientDto> {
    const patient = await this.repo.create(input);
    this.logger.info({ event: 'patient.created', patientId: patient.id, actorId }, 'patient created');
    return toPatientDto(patient);
  }

  async get(id: string): Promise<PatientDto> {
    const patient = await this.repo.findById(id);
    if (!patient) throw new NotFoundError('Patient');
    return toPatientDto(patient);
  }

  async update(id: string, changes: UpdatePatientRequest | UpdateMyProfileRequest, actorId: string): Promise<PatientDto> {
    const patient = await this.repo.update(id, changes);
    if (!patient) throw new NotFoundError('Patient');
    // On logge QUELS champs ont changé, jamais leurs valeurs (données personnelles).
    this.logger.info({ event: 'patient.updated', patientId: id, fields: Object.keys(changes), actorId }, 'patient updated');
    return toPatientDto(patient);
  }

  async list(query: ListPatientsQuery): Promise<Page<PatientDto>> {
    const after = decodeCursor(query.cursor, NameIdCursor);
    const rows = await this.repo.list({ limit: query.limit, after, search: query.q });
    return toPage(rows, query.limit, toPatientDto, (r) => [r.sortLast, r.sortFirst, r.id]);
  }
}
