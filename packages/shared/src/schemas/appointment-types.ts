import { z } from 'zod';
import { LIMITS, PATTERNS } from '../constraints';
import { HexColor, PriceCents, safeText, Uuid } from '../primitives';

const Duration = z
  .number()
  .int()
  .min(LIMITS.appointmentDurationMinutes.min)
  .max(LIMITS.appointmentDurationMinutes.max)
  .refine((n) => n % LIMITS.appointmentDurationMinutes.step === 0, {
    error: `Durée multiple de ${LIMITS.appointmentDurationMinutes.step} minutes attendue`,
  });

export const CreateAppointmentTypeRequest = z.object({
  code: z.string().trim().toUpperCase().regex(PATTERNS.appointmentTypeCode.js, 'Code en MAJUSCULES, chiffres, _'),
  label: safeText(LIMITS.appointmentTypeLabel.max).pipe(z.string().min(LIMITS.appointmentTypeLabel.min)),
  durationMinutes: Duration,
  colorHex: HexColor,
  bookableOnline: z.boolean().default(true),
  defaultPriceCents: PriceCents.default(0),
});
export type CreateAppointmentTypeRequest = z.infer<typeof CreateAppointmentTypeRequest>;

export const UpdateAppointmentTypeRequest = z
  .object({
    label: safeText(LIMITS.appointmentTypeLabel.max).pipe(z.string().min(LIMITS.appointmentTypeLabel.min)),
    durationMinutes: Duration,
    colorHex: HexColor,
    bookableOnline: z.boolean(),
    defaultPriceCents: PriceCents,
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { error: 'Aucun champ à modifier' });
export type UpdateAppointmentTypeRequest = z.infer<typeof UpdateAppointmentTypeRequest>;

export const AppointmentTypeDto = z.object({
  id: Uuid,
  code: z.string(),
  label: z.string(),
  durationMinutes: z.number().int(),
  colorHex: z.string(),
  bookableOnline: z.boolean(),
  defaultPriceCents: z.number().int(),
  isActive: z.boolean(),
});
export type AppointmentTypeDto = z.infer<typeof AppointmentTypeDto>;

export const AppointmentTypeList = z.object({ data: z.array(AppointmentTypeDto) });
