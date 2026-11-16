import type { CreateDoctorRequest, DoctorDto, Page, PaginationQuery } from '@cura/shared';
import { NotFoundError } from '../../common/errors';
import { decodeCursor, NameIdCursor, toPage } from '../../common/pagination';
import type { AppLogger } from '../../infra/logger';
import type { DoctorRecord, DoctorsRepository } from './doctors.repository';

const toDto = (d: DoctorRecord): DoctorDto => ({ ...d });

export class DoctorsService {
  constructor(
    private readonly repo: DoctorsRepository,
    private readonly logger: AppLogger,
  ) {}

  async create(input: CreateDoctorRequest, actorId: string): Promise<DoctorDto> {
    const doctor = await this.repo.create(input);
    this.logger.info({ event: 'doctor.created', doctorId: doctor.id, actorId }, 'doctor created');
    return toDto(doctor);
  }

  async get(id: string): Promise<DoctorDto> {
    const doctor = await this.repo.findById(id);
    if (!doctor) throw new NotFoundError('Médecin');
    return toDto(doctor);
  }

  async list(query: PaginationQuery): Promise<Page<DoctorDto>> {
    const rows = await this.repo.listActive(query.limit, decodeCursor(query.cursor, NameIdCursor));
    return toPage(rows, query.limit, ({ sortLast: _l, sortFirst: _f, ...d }) => toDto(d), (r) => [r.sortLast, r.sortFirst, r.id]);
  }
}
