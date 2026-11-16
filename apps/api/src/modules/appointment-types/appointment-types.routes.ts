import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  AppointmentTypeDto,
  AppointmentTypeList,
  CreateAppointmentTypeRequest,
  ErrorResponse,
  IdParams,
  ListAppointmentTypesQuery,
  UpdateAppointmentTypeRequest,
} from '@cura/shared';
import { principalOf } from '../../http/auth-guard';
import type { AppointmentTypesService } from './appointment-types.service';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse };

export const appointmentTypesRoutes =
  (service: AppointmentTypesService): FastifyPluginAsyncZod =>
  async (app) => {
    app.get('/appointment-types', {
      onRequest: [app.authenticate],
      schema: {
        tags: ['appointment-types'],
        summary: 'Soins et motifs (avec doctorId : ceux de ce médecin + les motifs communs)',
        querystring: ListAppointmentTypesQuery,
        response: { 200: AppointmentTypeList, ...errors },
      },
    }, async (req) => ({ data: await service.listFor(principalOf(req), req.query.doctorId) }));

    app.post('/appointment-types', {
      onRequest: [app.authenticate, app.authorize('admin', 'doctor')],
      schema: {
        tags: ['appointment-types'],
        summary: 'Créer un soin avec son prix (médecin : ses soins ; admin : tout)',
        body: CreateAppointmentTypeRequest,
        response: { 201: AppointmentTypeDto, ...errors },
      },
    }, async (req, reply) => reply.code(201).send(await service.create(req.body, principalOf(req))));

    app.patch('/appointment-types/:id', {
      onRequest: [app.authenticate, app.authorize('admin', 'doctor')],
      schema: {
        tags: ['appointment-types'],
        summary: 'Modifier un soin (médecin : ses soins ; admin : tout)',
        params: IdParams,
        body: UpdateAppointmentTypeRequest,
        response: { 200: AppointmentTypeDto, ...errors },
      },
    }, async (req) => service.update(req.params.id, req.body, principalOf(req)));
  };
