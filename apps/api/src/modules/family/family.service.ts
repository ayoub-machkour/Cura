/**
 * Comptes famille : un titulaire gère les dossiers de ses proches (enfants, parent âgé…).
 * Chaque proche garde SON dossier médical et son historique.
 */
import { type AddDependentRequest, type FamilyMemberDto, LIMITS, type LinkGuardianRequest } from '@cura/shared';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../common/errors';
import type { AuthPrincipal } from '../../common/security/tokens';
import type { TransactionManager } from '../../infra/db/transaction';
import type { AppLogger } from '../../infra/logger';
import type { AuthRepository } from '../auth/auth.repository';
import type { PatientsRepository } from '../patients/patients.repository';
import { toPatientDto } from '../patients/patients.service';
import type { FamilyRepository } from './family.repository';

export const tooManyDependents = () =>
  new BusinessRuleError('FAMILY_LIMIT_REACHED', `Un compte peut gérer au maximum ${LIMITS.maxDependents} proches. Contactez le cabinet.`);

export const cannotLinkSelf = () =>
  new BusinessRuleError('CANNOT_LINK_SELF', 'Ce dossier est déjà le vôtre : inutile de l’ajouter à votre famille.');

interface Deps {
  tx: TransactionManager;
  family: FamilyRepository;
  patients: PatientsRepository;
  users: AuthRepository;
  logger: AppLogger;
}

export class FamilyService {
  constructor(private readonly deps: Deps) {}

  async list(principal: AuthPrincipal): Promise<FamilyMemberDto[]> {
    const rows = await this.deps.family.listDependents(principal.sub);
    return rows.map(({ relationship, ...patient }) => ({ patient: toPatientDto(patient), relationship }));
  }

  /** Ajoute un proche inconnu du cabinet (nouveau dossier), ex. un nouveau-né. */
  async addDependent(principal: AuthPrincipal, input: AddDependentRequest): Promise<FamilyMemberDto> {
    const { tx, family, patients, logger } = this.deps;
    const guardianPatientId = ownPatientId(principal);

    const created = await tx.run(async (db) => {
      if ((await family.lockGuardianAndCount(principal.sub, db)) >= LIMITS.maxDependents) throw tooManyDependents();
      const guardian = await patients.findById(guardianPatientId, db);
      if (!guardian) throw new NotFoundError('Dossier patient');

      // Le téléphone du titulaire sert de contact (un enfant n'a pas toujours de numéro).
      const patient = await patients.create(
        { firstName: input.firstName, lastName: input.lastName, birthDate: input.birthDate, sex: input.sex ?? null, phone: guardian.phone },
        db,
      );
      await family.link({ userId: principal.sub, patientId: patient.id, relationship: input.relationship, createdBy: principal.sub }, db);
      return patient;
    });

    logger.info({ event: 'family.dependent_added', userId: principal.sub, patientId: created.id }, 'dependent added');
    return { patient: toPatientDto(created), relationship: input.relationship };
  }

  async removeDependent(principal: AuthPrincipal, patientId: string): Promise<void> {
    if (!(await this.deps.family.unlink(principal.sub, patientId))) throw new NotFoundError('Proche');
    this.deps.logger.info({ event: 'family.dependent_removed', userId: principal.sub, patientId }, 'dependent removed');
  }

  /** Au guichet : rattache un dossier au compte d'un titulaire dont l'identité a été vérifiée en personne. */
  async linkGuardian(patientId: string, input: LinkGuardianRequest, actor: AuthPrincipal): Promise<void> {
    const { tx, family, patients, users, logger } = this.deps;
    await tx.run(async (db) => {
      if (!(await patients.findById(patientId, db))) throw new NotFoundError('Patient');
      const guardian = await users.findUserByEmail(input.email, db);
      if (!guardian || !guardian.isActive) throw new NotFoundError('Compte');
      if (guardian.role !== 'patient') {
        throw new BusinessRuleError('GUARDIAN_MUST_BE_PATIENT_ACCOUNT', 'Seul un compte patient de l’application peut gérer une famille');
      }
      if (guardian.patientId === patientId) throw cannotLinkSelf();
      if ((await family.lockGuardianAndCount(guardian.id, db)) >= LIMITS.maxDependents) throw tooManyDependents();
      await family.link({ userId: guardian.id, patientId, relationship: input.relationship, createdBy: actor.sub }, db);
      logger.info({ event: 'family.guardian_linked', patientId, guardianId: guardian.id, actorId: actor.sub }, 'guardian linked');
    });
  }

  async unlinkGuardian(patientId: string, userId: string, actor: AuthPrincipal): Promise<void> {
    if (!(await this.deps.family.unlink(userId, patientId))) throw new NotFoundError('Rattachement');
    this.deps.logger.info({ event: 'family.guardian_unlinked', patientId, guardianId: userId, actorId: actor.sub }, 'guardian unlinked');
  }
}

export function ownPatientId(principal: AuthPrincipal): string {
  if (!principal.pid) throw new ForbiddenError('Aucun dossier patient lié à ce compte');
  return principal.pid;
}
