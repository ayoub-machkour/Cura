/**
 * Construction de l'application Fastify (sans démarrer le serveur) :
 * réutilisée telle quelle par les tests via `app.inject()`.
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Container } from './container';
import { authGuard } from './http/auth-guard';
import { errorHandling } from './http/error-handler';
import { security } from './http/security';
import { swaggerDocs } from './http/swagger';
import { appointmentTypesRoutes } from './modules/appointment-types/appointment-types.routes';
import { authRoutes } from './modules/auth/auth.routes';
import { bookingRoutes } from './modules/booking/booking.routes';
import { doctorsRoutes } from './modules/doctors/doctors.routes';
import { healthRoutes } from './modules/health/health.routes';
import { patientsRoutes } from './modules/patients/patients.routes';
import { slotsRoutes } from './modules/slots/slots.routes';

export const API_PREFIX = '/api/v1';

const ApiInfo = z.object({
  name: z.string(),
  version: z.string(),
  docs: z.string().nullable(),
  health: z.object({ live: z.string(), ready: z.string() }),
});
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

export async function buildApp(c: Container) {
  const { env } = c;

  const app = Fastify({
    loggerInstance: c.logger,
    // Corrélation : on réutilise l'x-request-id posé par Nginx (s'il est sain), sinon on en crée un.
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    },
    requestIdLogLabel: 'reqId',
    // IP client réelle derrière Nginx (rate limit, logs) : on ne fait confiance qu'aux N premiers sauts.
    trustProxy: (_address: string, hop: number) => hop < env.TRUST_PROXY_HOPS,
    bodyLimit: 100 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  // Toute route déclarant un schéma Zod est validée (entrée) et sérialisée (sortie) avec lui.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    if (req.url.startsWith(API_PREFIX)) reply.header('cache-control', 'no-store'); // données de santé : jamais en cache
  });

  await app.register(errorHandling);

  await app.register(security, { env, redis: c.redis });
  await app.register(authGuard, { tokens: c.accessTokens });
  if (env.SWAGGER_ENABLED) await app.register(swaggerDocs);

  await app.register(healthRoutes({ pool: c.pool, redis: c.redis }));

  // Versioning : toutes les routes métier sous /api/v1. Une v2 cohabitera sans casser les clients existants.
  const cookieConfig = { secure: env.COOKIE_SECURE, domain: env.COOKIE_DOMAIN };
  await app.register(
    async (v1) => {
      // Point d'entrée de découverte : GET /api/v1 indique où trouver la doc et les sondes.
      v1.withTypeProvider<ZodTypeProvider>().get('/', {
        schema: { tags: ['health'], summary: 'Informations sur l’API', security: [], response: { 200: ApiInfo } },
      }, async () => ({
        name: 'Cura API',
        version: 'v1',
        docs: env.SWAGGER_ENABLED ? '/docs' : null,
        health: { live: '/health/live', ready: '/health/ready' },
      }));

      await v1.register(authRoutes(c.services.auth, cookieConfig, env.RATE_LIMIT_AUTH_MAX));
      await v1.register(patientsRoutes(c.services.patients));
      await v1.register(doctorsRoutes(c.services.doctors));
      await v1.register(appointmentTypesRoutes(c.services.appointmentTypes));
      await v1.register(slotsRoutes(c.services.slots));
      await v1.register(bookingRoutes(c.services.booking));
    },
    { prefix: API_PREFIX },
  );

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
