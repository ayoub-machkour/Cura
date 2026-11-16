/**
 * Validation des variables d'environnement au démarrage (fail fast).
 * Une variable manquante ou invalide arrête le processus avec un message clair,
 * plutôt qu'une erreur obscure au premier appel en production.
 */
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

export const EnvObject = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_PRETTY: booleanString.default(false),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    DATABASE_SSL: booleanString.default(false),
    MIGRATIONS_DIR: z.string().min(1).default('../../packages/db/migrations'),

    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    REDIS_KEY_PREFIX: z.string().regex(/^[a-z0-9:_-]+$/).default('cura:'),

    /** Secret HMAC des access tokens (HS256) : 32 caractères minimum. */
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ISSUER: z.string().default('cura-api'),
    JWT_AUDIENCE: z.string().default('cura-clients'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

    COOKIE_SECURE: booleanString.default(true),
    COOKIE_DOMAIN: z.string().optional(),

    CORS_ORIGINS: csv.pipe(z.array(z.url()).min(1)),
    /** Nombre de proxies de confiance devant l'API (Nginx = 1). */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(10),

    SWAGGER_ENABLED: booleanString.default(false),

    BOOKING_HOLD_TTL_SECONDS: z.coerce.number().int().min(30).max(1800).default(300),
    BOOKING_MIN_LEAD_MINUTES: z.coerce.number().int().min(0).max(10_080).default(60),
    BOOKING_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3000),
  });

/** Règles transverses (cohérence de la configuration de production). */
export const EnvSchema = EnvObject.superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (!env.COOKIE_SECURE) {
        ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'doit être true en production' });
      }
      if (env.SWAGGER_ENABLED) {
        ctx.addIssue({ code: 'custom', path: ['SWAGGER_ENABLED'], message: 'Swagger doit être désactivé en production' });
      }
      if (env.LOG_PRETTY) {
        ctx.addIssue({ code: 'custom', path: ['LOG_PRETTY'], message: 'logs JSON obligatoires en production' });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export class InvalidEnvError extends Error {
  constructor(readonly issues: string[]) {
    super(`Configuration invalide :\n  - ${issues.join('\n  - ')}`);
    this.name = 'InvalidEnvError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    // On n'affiche jamais la VALEUR (elle peut être un secret), seulement le nom et le problème.
    throw new InvalidEnvError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return result.data;
}
