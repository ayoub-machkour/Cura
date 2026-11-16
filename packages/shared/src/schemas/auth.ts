import { z } from 'zod';
import { USER_ROLES } from '../constraints';
import { BirthDate, Email, Password, PersonName, PhoneE164, Uuid } from '../primitives';

export const UserRole = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof UserRole>;

export const LoginRequest = z.object({
  email: Email,
  // Pas de règle de complexité au login : on ne révèle rien sur la politique.
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** Inscription d'un patient depuis l'app mobile. */
export const RegisterPatientRequest = z.object({
  email: Email,
  password: Password,
  firstName: PersonName,
  lastName: PersonName,
  birthDate: BirthDate,
  phone: PhoneE164,
});
export type RegisterPatientRequest = z.infer<typeof RegisterPatientRequest>;

/** Création d'un compte du personnel (admin uniquement). */
export const CreateStaffUserRequest = z
  .object({
    email: Email,
    password: Password,
    role: z.enum(['admin', 'doctor', 'secretary']),
    doctorId: Uuid.optional(),
  })
  .refine((v) => (v.role === 'doctor') === (v.doctorId !== undefined), {
    error: 'doctorId est requis pour le rôle doctor, et interdit pour les autres rôles',
    path: ['doctorId'],
  });
export type CreateStaffUserRequest = z.infer<typeof CreateStaffUserRequest>;

export const UserDto = z.object({
  id: Uuid,
  email: z.string(),
  role: UserRole,
  patientId: Uuid.nullable(),
  doctorId: Uuid.nullable(),
});
export type UserDto = z.infer<typeof UserDto>;

/** Le jeton CSRF est aussi renvoyé dans le corps pour les clients qui ne lisent pas les cookies (Swagger). */
export const AuthSessionResponse = z.object({
  user: UserDto,
  csrfToken: z.string(),
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponse>;
