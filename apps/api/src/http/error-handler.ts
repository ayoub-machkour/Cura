/**
 * Point unique de traduction erreur → réponse HTTP. Format constant :
 *   { code, message, requestId, details? }
 *
 * - Erreurs de validation Zod → 400 avec le chemin de chaque champ invalide.
 * - Erreurs métier (DomainError) → statut et corps définis par l'erreur.
 * - Tout le reste → 500 générique : le détail part dans les logs, jamais au client.
 */
import type { FastifyError } from 'fastify';
import fp from 'fastify-plugin';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { DomainError } from '../common/errors';

export const errorHandling = fp(async (app) => {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const requestId = req.id;

    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Requête invalide',
        requestId,
        details: err.validation.map((v) => ({
          location: err.validationContext,
          path: v.instancePath.replace(/^\//, '').replaceAll('/', '.'),
          message: v.message,
        })),
      });
    }

    if (err instanceof DomainError) {
      const level = err.httpStatus >= 500 ? 'error' : 'info';
      req.log[level]({ event: 'request.domain_error', code: err.code, status: err.httpStatus }, err.message);
      return reply.code(err.httpStatus).send({ ...err.toResponse(), requestId });
    }

    if (isResponseSerializationError(err)) {
      // Le handler a produit une réponse non conforme à son schéma : bug serveur.
      req.log.error({ err, issues: err.cause.issues }, 'response serialization failed');
      return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Une erreur inattendue est survenue.', requestId });
    }

    const status = err.statusCode ?? 500;
    if (status === 429) {
      return reply.code(429).send({ code: 'RATE_LIMITED', message: err.message, requestId });
    }
    if (status < 500) {
      // Erreurs Fastify (JSON malformé, type de contenu non supporté, corps trop gros…).
      req.log.info({ event: 'request.client_error', fastifyCode: err.code, status }, err.message);
      return reply.code(status).send({ code: err.code ?? 'BAD_REQUEST', message: err.message, requestId });
    }

    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Une erreur inattendue est survenue.', requestId });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ code: 'ROUTE_NOT_FOUND', message: `Route ${req.method} ${req.url.split('?')[0]} introuvable`, requestId: req.id }),
  );
}, { name: 'error-handling' });
