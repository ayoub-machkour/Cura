import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { CreateDoctorRequest, DoctorDto, DoctorPage, ErrorResponse, IdParams, ListDoctorsQuery } from '@cura/shared';
import { principalOf } from '../../http/auth-guard';
import type { DoctorsService } from './doctors.service';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };

export const doctorsRoutes =
  (service: DoctorsService): FastifyPluginAsyncZod =>
  async (app) => {
    app.get('/doctors', {
      onRequest: [app.authenticate],
      schema: { tags: ['doctors'], summary: 'Médecins actifs (paginé)', querystring: ListDoctorsQuery, response: { 200: DoctorPage, ...errors } },
    }, async (req) => service.list(req.query));

    app.get('/doctors/:id', {
      onRequest: [app.authenticate],
      schema: { tags: ['doctors'], summary: 'Détail d’un médecin', params: IdParams, response: { 200: DoctorDto, ...errors } },
    }, async (req) => service.get(req.params.id));

    app.post('/doctors', {
      onRequest: [app.authenticate, app.authorize('admin')],
      schema: { tags: ['doctors'], summary: 'Créer un médecin (admin)', body: CreateDoctorRequest, response: { 201: DoctorDto, ...errors } },
    }, async (req, reply) => reply.code(201).send(await service.create(req.body, principalOf(req).sub)));
  };
