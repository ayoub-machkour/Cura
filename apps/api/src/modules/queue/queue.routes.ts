import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorResponse, IdParams, QueueDto, QueuePositionDto, QueueQuery, STAFF_ROLES } from '@cura/shared';
import { principalOf } from '../../http/auth-guard';
import type { QueueService } from './queue.service';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse };

export const queueRoutes =
  (service: QueueService): FastifyPluginAsyncZod =>
  async (app) => {
    app.get('/queue', {
      onRequest: [app.authenticate, app.authorize(...STAFF_ROLES)],
      schema: {
        tags: ['visits'],
        summary: 'File d’attente du jour d’un médecin (consultation en cours, salle d’attente, attendus)',
        querystring: QueueQuery,
        response: { 200: QueueDto, ...errors },
      },
    }, async (req) => service.forDoctor(req.query.doctorId, principalOf(req)));

    app.get('/appointments/:id/queue-position', {
      onRequest: [app.authenticate],
      schema: {
        tags: ['visits'],
        summary: 'Place dans la file d’attente (patient : ses RDV uniquement)',
        params: IdParams,
        response: { 200: QueuePositionDto, ...errors },
      },
    }, async (req) => service.positionOf(req.params.id, principalOf(req)));
  };
