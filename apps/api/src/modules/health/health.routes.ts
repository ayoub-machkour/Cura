/**
 * Sondes de santé (hors versioning, hors authentification, hors rate limit).
 * - /health/live  : le processus répond (liveness — redémarrer si KO).
 * - /health/ready : les dépendances répondent (readiness — retirer du load balancer si KO).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { z } from 'zod';

const CheckResult = z.object({ status: z.enum(['up', 'down']), latencyMs: z.number() });
const ReadyResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({ database: CheckResult, redis: CheckResult }),
});

async function probe(fn: () => Promise<unknown>, timeoutMs = 2000): Promise<z.infer<typeof CheckResult>> {
  const start = performance.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref()),
    ]);
    return { status: 'up', latencyMs: Math.round(performance.now() - start) };
  } catch {
    return { status: 'down', latencyMs: Math.round(performance.now() - start) };
  }
}

export const healthRoutes =
  (deps: { pool: Pool; redis: Redis }): FastifyPluginAsyncZod =>
  async (app) => {
    const config = { rateLimit: false as const };

    app.get('/health/live', {
      config,
      logLevel: 'warn', // pas de bruit dans les logs à chaque sonde
      schema: { tags: ['health'], security: [], response: { 200: z.object({ status: z.literal('ok'), uptimeSeconds: z.number() }) } },
    }, async () => ({ status: 'ok' as const, uptimeSeconds: Math.round(process.uptime()) }));

    app.get('/health/ready', {
      config,
      logLevel: 'warn',
      schema: { tags: ['health'], security: [], response: { 200: ReadyResponse, 503: ReadyResponse } },
    }, async (_req, reply) => {
      const [database, redis] = await Promise.all([
        probe(() => deps.pool.query('SELECT 1')),
        probe(() => deps.redis.ping()),
      ]);
      const ok = database.status === 'up' && redis.status === 'up';
      return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks: { database, redis } });
    });
  };
