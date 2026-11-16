import { z } from 'zod';
import { LIMITS, SEXES } from '../constraints';
import { BirthDate, Email, IsoDateTime, NationalId, page, PaginationQuery, PersonName, PhoneE164, Uuid } from '../primitives';

export const Sex = z.enum(SEXES);

export const CreatePatientRequest = z.object({
  firstName: PersonName,
  lastName: PersonName,
  birthDate: BirthDate,
  sex: Sex.optional(),
  phone: PhoneE164,
  email: Email.optional(),
  nationalId: NationalId.optional(),
});
export type CreatePatientRequest = z.infer<typeof CreatePatientRequest>;

/** PATCH : au moins un champ. `null` efface un champ optionnel. */
export const UpdatePatientRequest = z
  .object({
    firstName: PersonName,
    lastName: PersonName,
    birthDate: BirthDate,
    sex: Sex.nullable(),
    phone: PhoneE164,
    email: Email.nullable(),
    nationalId: NationalId.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { error: 'Aucun champ à modifier' });
export type UpdatePatientRequest = z.infer<typeof UpdatePatientRequest>;

/** Ce qu'un patient peut modifier lui-même depuis l'app. */
export const UpdateMyProfileRequest = z
  .object({ phone: PhoneE164, email: Email.nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { error: 'Aucun champ à modifier' });
export type UpdateMyProfileRequest = z.infer<typeof UpdateMyProfileRequest>;

export const ListPatientsQuery = PaginationQuery.extend({
  q: z.string().trim().min(LIMITS.searchQuery.min).max(LIMITS.searchQuery.max).optional(),
});
export type ListPatientsQuery = z.infer<typeof ListPatientsQuery>;

export const PatientDto = z.object({
  id: Uuid,
  firstName: z.string(),
  lastName: z.string(),
  birthDate: z.string(),
  sex: Sex.nullable(),
  phone: z.string(),
  email: z.string().nullable(),
  nationalId: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type PatientDto = z.infer<typeof PatientDto>;

export const PatientPage = page(PatientDto);
