/**
 * Profil médical déclaratif (antécédents, traitements en cours, allergies…).
 * Données de santé : accès restreint (patient et ses proches autorisés, personnel du cabinet),
 * modifications tracées (qui, quels champs, quand).
 */
import { z } from 'zod';
import { BLOOD_TYPES, LIMITS } from '../constraints';
import { IsoDateTime, PersonName, PhoneE164, safeText, Uuid } from '../primitives';

export const BloodType = z.enum(BLOOD_TYPES);

/** Liste de libellés courts, dédoublonnée sans tenir compte de la casse (la 1re saisie est conservée). */
export const MedicalList = z
  .array(safeText(LIMITS.medicalListItem.max).pipe(z.string().min(LIMITS.medicalListItem.min)))
  .max(LIMITS.medicalListMaxItems, `Maximum ${LIMITS.medicalListMaxItems} éléments`)
  .transform((items) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = item.toLocaleLowerCase('fr');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

export const UpdateMedicalProfileRequest = z
  .object({
    bloodType: BloodType.nullable().default(null),
    allergies: MedicalList.default([]),
    chronicConditions: MedicalList.default([]),
    currentMedications: MedicalList.default([]),
    pastSurgeries: MedicalList.default([]),
    emergencyContactName: PersonName.nullable().default(null),
    emergencyContactPhone: PhoneE164.nullable().default(null),
    notes: safeText(LIMITS.medicalNotes.max).nullable().default(null),
  })
  .refine((v) => (v.emergencyContactName === null) === (v.emergencyContactPhone === null), {
    error: 'Le nom et le téléphone du contact d’urgence vont ensemble',
    path: ['emergencyContactPhone'],
  });
export type UpdateMedicalProfileRequest = z.infer<typeof UpdateMedicalProfileRequest>;

export const MedicalProfileDto = z.object({
  patientId: Uuid,
  bloodType: BloodType.nullable(),
  allergies: z.array(z.string()),
  chronicConditions: z.array(z.string()),
  currentMedications: z.array(z.string()),
  pastSurgeries: z.array(z.string()),
  emergencyContactName: z.string().nullable(),
  emergencyContactPhone: z.string().nullable(),
  notes: z.string().nullable(),
  /** null tant que le profil n'a jamais été renseigné. */
  updatedAt: IsoDateTime.nullable(),
});
export type MedicalProfileDto = z.infer<typeof MedicalProfileDto>;
