import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { DomainError } from '../modules/booking/booking.errors';

/**
 * Point unique de traduction erreur → réponse HTTP.
 * - DomainError : statut et corps définis par l'erreur elle-même.
 * - ZodError    : 400 avec le détail des champs invalides.
 * - Le reste    : 500 générique, détail uniquement dans les logs (jamais de fuite d'infos internes).
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof DomainError) {
      if (err.httpStatus >= 500) req.log.error({ err }, err.message);
      return reply.code(err.httpStatus).send(err.toResponse());
    }

    if (err instanceof ZodError) {
      return reply.code(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.flatten() });
    }

    const statusCode = (err as FastifyError).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.code(statusCode).send({ code: 'HTTP_ERROR', message: err.message });
    }

    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Une erreur inattendue est survenue.' });
  });
}
