/**
 * Profil médical déclaratif : antécédents, traitements en cours, allergies, contact d'urgence.
 * Accès : le patient (et les proches qui gèrent son dossier) et le personnel du cabinet.
 * Chaque modification est tracée (champs modifiés, auteur, date) ; les valeurs ne sont jamais loggées.
 */
import { isDeepStrictEqual } from 'node:util';
import type { MedicalProfileDto, UpdateMedicalProfileRequest } from '@cura/shared';
import { NotFoundError } from '../../common/errors';
import type { AuthPrincipal } from '../../common/security/tokens';
import type { TransactionManager } from '../../infra/db/transaction';
import type { AppLogger } from '../../infra/logger';
import type { PatientAccess } from '../family/patient-access';
import type { MedicalProfileRecord, MedicalRepository } from './medical.repository';

const FIELDS = [
  'bloodType',
  'allergies',
  'chronicConditions',
  'currentMedications',
  'pastSurgeries',
  'emergencyContactName',
  'emergencyContactPhone',
  'notes',
] as const satisfies readonly (keyof UpdateMedicalProfileRequest)[];

const EMPTY: Omit<MedicalProfileDto, 'patientId'> = {
  bloodType: null,
  allergies: [],
  chronicConditions: [],
  currentMedications: [],
  pastSurgeries: [],
  emergencyContactName: null,
  emergencyContactPhone: null,
  notes: null,
  updatedAt: null,
};

const toDto = (patientId: string, r: MedicalProfileRecord | null): MedicalProfileDto =>
  r ? { ...r, patientId, updatedAt: r.updatedAt.toISOString() } : { ...EMPTY, patientId };

interface Deps {
  tx: TransactionManager;
  repo: MedicalRepository;
  access: PatientAccess;
  logger: AppLogger;
}

export class MedicalService {
  constructor(private readonly deps: Deps) {}

  async get(patientId: string, principal: AuthPrincipal): Promise<MedicalProfileDto> {
    await this.assertAccess(patientId, principal);
    return toDto(patientId, await this.deps.repo.find(patientId));
  }

  /** Remplace le profil (les listes sont envoyées complètes : pas d'ambiguïté d'ajout/suppression). */
  async update(patientId: string, input: UpdateMedicalProfileRequest, principal: AuthPrincipal): Promise<MedicalProfileDto> {
    await this.assertAccess(patientId, principal);
    const { tx, repo, logger } = this.deps;

    const { saved, changed } = await tx.run(async (db) => {
      const before = toDto(patientId, await repo.find(patientId, db, true));
      const changedFields = FIELDS.filter((f) => !isDeepStrictEqual(before[f], input[f]));
      if (changedFields.length === 0) return { saved: before, changed: changedFields };
      const record = await repo.upsert(patientId, input, principal.sub, db);
      await repo.recordChange({ patientId, fields: changedFields, actorUserId: principal.sub, actorRole: principal.role }, db);
      return { saved: toDto(patientId, record), changed: changedFields };
    });

    if (changed.length > 0) {
      logger.info({ event: 'medical_profile.updated', patientId, fields: changed, actorId: principal.sub, role: principal.role }, 'medical profile updated');
    }
    return saved;
  }

  /** Hors périmètre → 404 : on ne révèle pas l'existence d'un dossier médical. */
  private async assertAccess(patientId: string, principal: AuthPrincipal): Promise<void> {
    const allowed = await this.deps.access.canAccessPatient(principal, patientId);
    if (!allowed || !(await this.deps.repo.patientExists(patientId))) throw new NotFoundError('Patient');
  }
}
