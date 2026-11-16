/**
 * Briques Zod réutilisables, construites à partir de `constraints.ts`.
 */
import { z } from 'zod';
import { LIMITS, PATTERNS } from './constraints';

export const Uuid = z.uuid();

export const IsoDateTime = z.iso.datetime({ offset: true });
export const IsoDate = z.iso.date();

/** Texte libre sûr : trim, longueur max, aucune balise HTML. */
export const safeText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !PATTERNS.noHtmlTag.js.test(v), { error: 'Les balises HTML ne sont pas autorisées' });

export const PersonName = z
  .string()
  .trim()
  .min(LIMITS.personName.min)
  .max(LIMITS.personName.max)
  .regex(PATTERNS.personName.js, 'Caractères non autorisés dans le nom');

export const PhoneE164 = z
  .string()
  .trim()
  .regex(PATTERNS.phoneE164.js, 'Numéro au format international attendu, ex. +212600000000');

export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .max(LIMITS.email.max)
  .regex(PATTERNS.email.js, 'Adresse email invalide');

export const Password = z
  .string()
  .min(LIMITS.password.min, `Au moins ${LIMITS.password.min} caractères`)
  .max(LIMITS.password.max);

export const BirthDate = IsoDate.refine((d) => d >= LIMITS.birthDateMin, { error: 'Date de naissance invalide' }).refine(
  (d) => d <= new Date().toISOString().slice(0, 10),
  { error: 'La date de naissance ne peut pas être dans le futur' },
);

export const NationalId = z
  .string()
  .trim()
  .min(LIMITS.nationalId.min)
  .max(LIMITS.nationalId.max)
  .regex(PATTERNS.nationalId.js);

export const HexColor = z.string().regex(PATTERNS.hexColor.js, 'Couleur hexadécimale attendue, ex. #2563EB');

export const PriceCents = z.number().int().min(LIMITS.priceCents.min).max(LIMITS.priceCents.max);

/** Paramètres de pagination par curseur (keyset). */
export const PaginationQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIMITS.pagination.maxLimit)
    .default(LIMITS.pagination.defaultLimit),
  cursor: z.string().max(512).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;

export const PageInfo = z.object({
  limit: z.number().int(),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export const page = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), page: PageInfo });
export type Page<T> = { data: T[]; page: z.infer<typeof PageInfo> };

export const ErrorResponse = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
  details: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const IdParams = z.object({ id: Uuid });
