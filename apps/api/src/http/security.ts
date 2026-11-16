/**
 * Durcissement HTTP : en-têtes de sécurité (helmet), CORS strict, cookies, limitation de débit.
 */
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fp from 'fastify-plugin';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env';
import { CSRF_HEADER } from './cookies';

export interface SecurityOptions {
  env: Pick<Env, 'CORS_ORIGINS' | 'RATE_LIMIT_MAX' | 'NODE_ENV'>;
  redis: Redis;
}

export const security = fp<SecurityOptions>(
  async (app, { env, redis }) => {
    // En-têtes : CSP stricte (l'API ne sert que du JSON), HSTS, nosniff, frameguard, referrer-policy…
    await app.register(helmet, {
      global: true,
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
    });

    // CORS : liste blanche explicite (jamais "*" avec credentials).
    const allowed = new Set(env.CORS_ORIGINS);
    await app.register(cors, {
      origin: (origin, cb) => {
        // Requêtes sans Origin (app mobile native, curl, health checks) : pas concernées par CORS.
        if (!origin || allowed.has(origin)) return cb(null, true);
        cb(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['content-type', 'authorization', 'x-request-id', CSRF_HEADER],
      exposedHeaders: ['x-request-id', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
      maxAge: 600,
    });

    await app.register(cookie, { hook: 'onRequest' });

    // Limitation de débit partagée entre instances via Redis (par IP réelle, cf. trustProxy).
    await app.register(rateLimit, {
      global: true,
      max: env.RATE_LIMIT_MAX,
      timeWindow: '1 minute',
      redis,
      nameSpace: 'rl:',
      skipOnError: true, // Redis indisponible : on ne bloque pas tout le cabinet
      errorResponseBuilder: (_req, ctx) => ({
        statusCode: 429,
        code: 'RATE_LIMITED',
        message: `Trop de requêtes. Réessayez dans ${Math.ceil(ctx.ttl / 1000)} s.`,
      }),
    });
  },
  { name: 'security' },
);
