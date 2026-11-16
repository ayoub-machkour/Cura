import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  DoctorParams,
  ErrorResponse,
  GenerateSlotsRequest,
  GenerateSlotsResponse,
  ListAvailableSlotsQuery,
  SlotPage,
} from '@cura/shared';
import { principalOf } from '../../http/auth-guard';
import type { SlotsService } from './slots.service';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse };

export const slotsRoutes =
  (service: SlotsService): FastifyPluginAsyncZod =>
  async (app) => {
    app.get('/doctors/:doctorId/slots', {
      onRequest: [app.authenticate],
      schema: {
        tags: ['slots'],
        summary: 'Créneaux disponibles d’un médecin (paginé)',
        params: DoctorParams,
        querystring: ListAvailableSlotsQuery,
        response: { 200: SlotPage, ...errors },
      },
    }, async (req) => service.listAvailable(req.params.doctorId, req.query, principalOf(req).role));

    app.post('/doctors/:doctorId/slots/generate', {
      onRequest: [app.authenticate, app.authorize('admin', 'secretary')],
      schema: {
        tags: ['slots'],
        summary: 'Générer les créneaux d’une période (idempotent)',
        params: DoctorParams,
        body: GenerateSlotsRequest,
        response: { 201: GenerateSlotsResponse, ...errors },
      },
    }, async (req, reply) => reply.code(201).send(await service.generate(req.params.doctorId, req.body, principalOf(req).sub)));
  };
