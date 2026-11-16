/**
 * Activation d'un compte mobile pour un patient DÉJÀ connu du cabinet.
 * Le cabinet génère un code à usage unique ; le patient le saisit avec sa date de
 * naissance dans l'app, et retrouve tout son historique.
 */
import { z } from 'zod';
import { BirthDate, Email, IsoDateTime, Password } from '../primitives';

/** Alphabet sans caractères ambigus (pas de 0/O, 1/I/L) : lisible à l'oral et à l'écrit. */
export const INVITATION_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITATION_CODE_LENGTH = 8;
const CODE_PATTERN = new RegExp(`^[${INVITATION_ALPHABET}]{${INVITATION_CODE_LENGTH}}$`);

/** Accepte « k7qm-4xrp », « K7QM 4XRP »… et normalise en « K7QM4XRP ». */
export const InvitationCode = z
  .string()
  .max(32)
  .transform((v) => v.toUpperCase().replace(/[\s-]/g, ''))
  .pipe(z.string().regex(CODE_PATTERN, 'Code d’activation invalide'));

export const InvitationResponse = z.object({
  /** Affiché UNE seule fois : il n'est stocké que haché. Format XXXX-XXXX. */
  code: z.string(),
  expiresAt: IsoDateTime,
});
export type InvitationResponse = z.infer<typeof InvitationResponse>;

export const ClaimAccountRequest = z.object({
  code: InvitationCode,
  birthDate: BirthDate,
  email: Email,
  password: Password,
});
export type ClaimAccountRequest = z.infer<typeof ClaimAccountRequest>;
