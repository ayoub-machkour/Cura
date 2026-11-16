import { z } from 'zod';
import { LIMITS, PATTERNS } from '../constraints';
import { page, PaginationQuery, PersonName, Uuid } from '../primitives';

/** Fuseau IANA (ex. Africa/Casablanca), vérifié par le runtime JS. */
export const Timezone = z
  .string()
  .max(LIMITS.timezone.max)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { error: 'Fuseau horaire IANA invalide' },
  );

export const CreateDoctorRequest = z.object({
  firstName: PersonName,
  lastName: PersonName,
  specialty: z
    .string()
    .trim()
    .min(LIMITS.specialty.min)
    .max(LIMITS.specialty.max)
    .regex(PATTERNS.personName.js, 'Caractères non autorisés'),
  registrationNumber: z
    .string()
    .trim()
    .min(LIMITS.registrationNumber.min)
    .max(LIMITS.registrationNumber.max)
    .regex(PATTERNS.registrationNumber.js),
  timezone: Timezone.default('UTC'),
});
export type CreateDoctorRequest = z.infer<typeof CreateDoctorRequest>;

export const DoctorDto = z.object({
  id: Uuid,
  firstName: z.string(),
  lastName: z.string(),
  specialty: z.string(),
  registrationNumber: z.string(),
  timezone: z.string(),
  isActive: z.boolean(),
});
export type DoctorDto = z.infer<typeof DoctorDto>;

export const ListDoctorsQuery = PaginationQuery;
export const DoctorPage = page(DoctorDto);
