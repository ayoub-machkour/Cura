/**
 * Documentation OpenAPI générée à partir des schémas Zod des routes (aucune
 * duplication : la doc ne peut pas diverger de la validation réelle).
 * UI interactive sur /docs — désactivée en production.
 */
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fp from 'fastify-plugin';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { COOKIE, CSRF_HEADER } from './cookies';

export const swaggerDocs = fp(
  async (app) => {
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'Cura API',
          version: '1.0.0',
          description:
            'API du cabinet médical Cura.\n\n' +
            '**Authentification** : `POST /api/v1/auth/login` pose les cookies httpOnly. ' +
            'Pour les requêtes POST/PATCH, copiez `csrfToken` de la réponse dans le champ `csrf` (bouton Authorize).',
        },
        servers: [{ url: '/' }],
        tags: [
          { name: 'auth', description: 'Session, refresh token, comptes' },
          { name: 'patients' },
          { name: 'doctors' },
          { name: 'appointment-types' },
          { name: 'slots' },
          { name: 'appointments' },
          { name: 'health' },
        ],
        components: {
          securitySchemes: {
            cookieAuth: { type: 'apiKey', in: 'cookie', name: COOKIE.access },
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            csrf: { type: 'apiKey', in: 'header', name: CSRF_HEADER },
          },
        },
        security: [{ cookieAuth: [], csrf: [] }, { bearerAuth: [] }],
      },
      transform: jsonSchemaTransform,
    });

    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { persistAuthorization: true, displayRequestDuration: true, withCredentials: true },
      // Swagger UI a besoin de ses propres scripts/styles : CSP dédiée à ces pages uniquement.
      staticCSP: true,
    });
  },
  { name: 'swagger-docs' },
);
