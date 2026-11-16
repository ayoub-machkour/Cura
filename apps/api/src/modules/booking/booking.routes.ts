import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  AppointmentDto,
  AppointmentPage,
  BookAppointmentRequest,
  CancelAppointmentRequest,
  ErrorResponse,
  HoldSlotRequest,
  IdParams,
  ListAgendaQuery,
  ListMyAppointmentsQuery,
  SlotHoldResponse,
  SlotParams,
  SlotUnavailableResponse,
  STAFF_ROLES,
} from '@cura/shared';
import { ForbiddenError } from '../../common/errors';
import { principalOf } from '../../http/auth-guard';
import type { BookingService } from './booking.service';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 422: ErrorResponse };

export const bookingRoutes =
  (service: BookingService): FastifyPluginAsyncZod =>
  async (app) => {
    app.post('/slots/:slotId/hold', {
      onRequest: [app.authenticate, app.authorize('patient')],
      schema: {
        tags: ['appointments'],
        summary: 'Pré-réserver un créneau pendant la saisie (TTL)',
        params: SlotParams,
        body: HoldSlotRequest,
        response: { 200: SlotHoldResponse, 409: SlotUnavailableResponse, ...errors },
      },
    }, async (req) => {
      const { pid } = principalOf(req);
      if (!pid) throw new ForbiddenError('Aucun dossier patient lié à ce compte');
      return service.hold(req.params.slotId, req.body.appointmentTypeId, pid);
    });

    app.post('/appointments', {
      onRequest: [app.authenticate, app.authorize('patient', 'secretary', 'admin', 'doctor')],
      schema: {
        tags: ['appointments'],
        summary: 'Réserver un créneau (201 créé · 200 rejeu idempotent · 409 + alternatives)',
        body: BookAppointmentRequest,
        response: { 200: AppointmentDto, 201: AppointmentDto, 409: SlotUnavailableResponse.or(ErrorResponse), ...errors },
      },
    }, async (req, reply) => {
      const result = await service.book(service.commandFor(principalOf(req), req.body));
      return reply.code(result.replayed ? 200 : 201).send(result.appointment);
    });

    app.post('/appointments/:id/cancel', {
      onRequest: [app.authenticate],
      schema: {
        tags: ['appointments'],
        summary: 'Annuler un rendez-vous',
        params: IdParams,
        body: CancelAppointmentRequest.nullish(),
        response: { 200: AppointmentDto, ...errors },
      },
    }, async (req) => service.cancel(req.params.id, principalOf(req), req.body?.reason));

    app.get('/appointments/me', {
      onRequest: [app.authenticate, app.authorize('patient')],
      schema: {
        tags: ['appointments'],
        summary: 'Mes rendez-vous (à venir / passés, paginé)',
        querystring: ListMyAppointmentsQuery,
        response: { 200: AppointmentPage, ...errors },
      },
    }, async (req) => {
      const { pid } = principalOf(req);
      if (!pid) throw new ForbiddenError('Aucun dossier patient lié à ce compte');
      return service.listMine(pid, req.query);
    });

    app.get('/appointments', {
      onRequest: [app.authenticate, app.authorize(...STAFF_ROLES)],
      schema: {
        tags: ['appointments'],
        summary: 'Agenda d’un médecin sur une période (paginé)',
        querystring: ListAgendaQuery,
        response: { 200: AppointmentPage, ...errors },
      },
    }, async (req) => service.listAgenda(req.query));
  };
