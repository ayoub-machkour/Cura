/**
 * Comptes famille : un titulaire (parent, enfant adulte…) gère les dossiers de ses proches.
 * Chaque personne garde SON dossier ; le titulaire réserve pour elle et reçoit les notifications.
 */
import { z } from 'zod';
import { FAMILY_RELATIONSHIPS } from '../constraints';
import { BirthDate, Email, PersonName, Uuid } from '../primitives';
import { InvitationCode } from './invitations';
import { PatientDto, Sex } from './patients';

export const FamilyRelationship = z.enum(FAMILY_RELATIONSHIPS);
export type FamilyRelationship = z.infer<typeof FamilyRelationship>;

/** Ajouter un proche INCONNU du cabinet (nouveau dossier, ex. nouveau-né). */
export const AddDependentRequest = z.object({
  firstName: PersonName,
  lastName: PersonName,
  birthDate: BirthDate,
  sex: Sex.optional(),
  relationship: FamilyRelationship,
});
export type AddDependentRequest = z.infer<typeof AddDependentRequest>;

/** Rattacher un proche DÉJÀ suivi au cabinet, avec le code remis au guichet. */
export const LinkDependentRequest = z.object({
  code: InvitationCode,
  birthDate: BirthDate,
  relationship: FamilyRelationship,
});
export type LinkDependentRequest = z.infer<typeof LinkDependentRequest>;

/** Rattachement fait au guichet (identité vérifiée en personne). */
export const LinkGuardianRequest = z.object({
  email: Email,
  relationship: FamilyRelationship,
});
export type LinkGuardianRequest = z.infer<typeof LinkGuardianRequest>;

export const FamilyMemberDto = z.object({
  patient: PatientDto,
  relationship: FamilyRelationship,
});
export type FamilyMemberDto = z.infer<typeof FamilyMemberDto>;

export const FamilyList = z.object({ data: z.array(FamilyMemberDto) });

export const DependentParams = z.object({ patientId: Uuid });
export const GuardianParams = z.object({ id: Uuid, userId: Uuid });
