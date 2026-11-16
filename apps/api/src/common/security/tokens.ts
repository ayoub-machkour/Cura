import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSigner, createVerifier } from 'fast-jwt';
import { z } from 'zod';
import { USER_ROLES } from '@cura/shared';

/** Jeton opaque cryptographiquement aléatoire (refresh token, CSRF, hold…). */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Empreinte stockée en base à la place du jeton lui-même. */
export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** Comparaison à temps constant (évite les attaques temporelles). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Identité portée par l'access token. */
export const AuthPrincipal = z.object({
  sub: z.uuid(),
  role: z.enum(USER_ROLES),
  pid: z.uuid().nullable(), // patient lié
  did: z.uuid().nullable(), // médecin lié
});
export type AuthPrincipal = z.infer<typeof AuthPrincipal>;

export interface AccessTokenConfig {
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

/**
 * Access token JWT HS256 de courte durée (15 min par défaut).
 * Algorithme FIXÉ à la vérification : pas d'attaque `alg: none` / confusion d'algorithme.
 */
export class AccessTokenService {
  private readonly signer;
  private readonly verifier;

  constructor(private readonly config: AccessTokenConfig) {
    this.signer = createSigner({
      key: config.secret,
      algorithm: 'HS256',
      iss: config.issuer,
      aud: config.audience,
      expiresIn: config.ttlSeconds * 1000,
    });
    this.verifier = createVerifier({
      key: config.secret,
      algorithms: ['HS256'],
      allowedIss: config.issuer,
      allowedAud: config.audience,
      cache: 1000,
    });
  }

  get ttlSeconds(): number {
    return this.config.ttlSeconds;
  }

  sign(principal: AuthPrincipal): string {
    return this.signer({ ...principal });
  }

  /** Retourne null si le jeton est invalide, expiré, ou si son contenu ne respecte pas le schéma. */
  verify(token: string): AuthPrincipal | null {
    return this.verifySession(token)?.principal ?? null;
  }

  /** Comme `verify`, avec la date d'expiration (connexions longues : WebSocket). */
  verifySession(token: string): { principal: AuthPrincipal; expiresAt: Date } | null {
    if (!token) return null;
    try {
      const payload = this.verifier(token) as Record<string, unknown>;
      const parsed = AuthPrincipal.safeParse(payload);
      if (!parsed.success || typeof payload.exp !== 'number') return null;
      return { principal: parsed.data, expiresAt: new Date(payload.exp * 1000) };
    } catch {
      return null;
    }
  }
}
