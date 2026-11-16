/**
 * Logs structurés (pino), partagés par Fastify et par l'infrastructure.
 *
 * - JSON en production (exploitable par Loki / ELK / Datadog), lisible en dev (pino-pretty).
 * - Chaque log de requête porte le `reqId` : une requête se suit de bout en bout,
 *   et l'identifiant est renvoyé au client dans l'en-tête `x-request-id`.
 * - Données sensibles masquées : jetons, cookies, mots de passe.
 * - Les query strings ne sont pas loggées : elles peuvent contenir un nom de patient.
 */
import pino, { type Logger, type LoggerOptions } from 'pino';
import type { Env } from '../config/env';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.holdToken',
  '*.csrfToken',
];

interface SerializableRequest {
  method: string;
  url: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

export function buildLoggerOptions(env: Pick<Env, 'LOG_LEVEL' | 'LOG_PRETTY' | 'NODE_ENV'>): LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    base: { service: 'cura-api', env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      err: pino.stdSerializers.err,
      req(req: SerializableRequest) {
        return {
          method: req.method,
          url: req.url.split('?')[0],
          remoteAddress: req.ip,
          userAgent: req.headers['user-agent'],
        };
      },
      res(res: { statusCode: number }) {
        return { statusCode: res.statusCode };
      },
    },
    ...(env.LOG_PRETTY
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,env', singleLine: true },
          },
        }
      : {}),
  };
}

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'LOG_PRETTY' | 'NODE_ENV'>): Logger {
  return pino(buildLoggerOptions(env));
}

export type AppLogger = Logger;
