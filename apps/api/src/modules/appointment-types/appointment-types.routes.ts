import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  AppointmentTypeDto,
  AppointmentTypeList,
  CreateAppointmentTypeRequest,
  ErrorResponse,
  IdParams,
  UpdateAppointmentTypeRequest,
} from '@cura/shared';
import { principalOf } from '../../http/auth-guard';
import type { AppointmentTypesService } from './appointment-types.service';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };

export const appointmentTypesRoutes =
  (service: AppointmentTypesService): FastifyPluginAsyncZod =>
  async (app) => {
    app.get('/appointment-types', {
      onRequest: [app.authenticate],
      schema: { tags: ['appointment-types'], summary: 'Motifs de consultation', response: { 200: AppointmentTypeList, ...errors } },
    }, async (req) => ({ data: await service.listFor(principalOf(req).role) }));

    app.post('/appointment-types', {
      onRequest: [app.authenticate, app.authorize('admin')],
      schema: { tags: ['appointment-types'], summary: 'Créer un motif (admin)', body: CreateAppointmentTypeRequest, response: { 201: AppointmentTypeDto, ...errors } },
    }, async (req, reply) => reply.code(201).send(await service.create(req.body, principalOf(req).sub)));

    app.patch('/appointment-types/:id', {
      onRequest: [app.authenticate, app.authorize('admin')],
      schema: { tags: ['appointment-types'], summary: 'Modifier un motif (admin)', params: IdParams, body: UpdateAppointmentTypeRequest, response: { 200: AppointmentTypeDto, ...errors } },
    }, async (req) => service.update(req.params.id, req.body, principalOf(req).sub));
  };
