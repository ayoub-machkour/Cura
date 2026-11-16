import { z } from 'zod';
import { LIMITS, PATTERNS } from '../constraints';
import { IsoDate, IsoDateTime, page, PaginationQuery, Uuid } from '../primitives';

export const SlotDto = z.object({
  id: Uuid,
  doctorId: Uuid,
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
});
export type SlotDto = z.infer<typeof SlotDto>;

export const SlotPage = page(SlotDto);

export const DoctorParams = z.object({ doctorId: Uuid });

export const ListAvailableSlotsQuery = PaginationQuery.extend({
  from: IsoDateTime,
  to: IsoDateTime,
  appointmentTypeId: Uuid.optional(),
}).refine((q) => q.from < q.to, { error: '`from` doit précéder `to`', path: ['to'] });
export type ListAvailableSlotsQuery = z.infer<typeof ListAvailableSlotsQuery>;

const LocalTime = z.string().regex(PATTERNS.localTime.js, 'Format HH:MM attendu');
const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Génère les créneaux d'un médecin sur une période, dans SON fuseau horaire. */
export const GenerateSlotsRequest = z
  .object({
    from: IsoDate,
    to: IsoDate,
    /** 1 = lundi … 7 = dimanche (ISO 8601). */
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    dayStart: LocalTime,
    dayEnd: LocalTime,
    slotMinutes: z.number().int().min(LIMITS.slotDurationMinutes.min).max(LIMITS.slotDurationMinutes.max),
    onlineBookable: z.boolean().default(true),
  })
  .refine((v) => v.from <= v.to, { error: '`from` doit précéder `to`', path: ['to'] })
  .refine(
    (v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= LIMITS.slotGenerationMaxDays,
    { error: `Période limitée à ${LIMITS.slotGenerationMaxDays} jours`, path: ['to'] },
  )
  .refine((v) => toMinutes(v.dayEnd) - toMinutes(v.dayStart) >= v.slotMinutes, {
    error: 'La plage horaire doit contenir au moins un créneau',
    path: ['dayEnd'],
  });
export type GenerateSlotsRequest = z.infer<typeof GenerateSlotsRequest>;

export const GenerateSlotsResponse = z.object({ created: z.number().int() });
