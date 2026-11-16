/**
 * Transitions du parcours de visite. Rôles (moindre privilège) :
 *  - confirm  : patient (ses RDV), secrétariat, admin
 *  - check-in : secrétariat, admin, médecin (son agenda)
 *  - start / complete : médecin (son agenda), admin
 *  - no-show  : secrétariat, admin, médecin (son agenda)
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Role } from '@cura/shared';
import { AppointmentDto, AppointmentTransitionRequest, CreateWalkInRequest, ErrorResponse, IdParams } from '@cura/shared';
import { principalOf } from '../../http/auth-guard';
import type { VisitAction } from './visit-state-machine';
import type { VisitsService } from './visits.service';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse };

const ROUTES: { path: string; action: VisitAction; roles: Role[]; summary: string }[] = [
  { path: 'confirm', action: 'confirm', roles: ['patient', 'secretary', 'admin'], summary: 'Confirmer sa présence (rappel J-1 / H-2)' },
  { path: 'check-in', action: 'check_in', roles: ['secretary', 'admin', 'doctor'], summary: 'Enregistrer l’arrivée du patient (entrée en salle d’attente)' },
  { path: 'start', action: 'start', roles: ['doctor', 'admin'], summary: 'Appeler le patient : début de consultation' },
  { path: 'complete', action: 'complete', roles: ['doctor', 'admin'], summary: 'Terminer la consultation' },
  { path: 'no-show', action: 'no_show', roles: ['secretary', 'admin', 'doctor'], summary: 'Déclarer le patient absent' },
];

export const visitsRoutes =
  (service: VisitsService): FastifyPluginAsyncZod =>
  async (app) => {
    for (const route of ROUTES) {
      app.post(`/appointments/:id/${route.path}`, {
        onRequest: [app.authenticate, app.authorize(...route.roles)],
        schema: {
          tags: ['visits'],
          summary: route.summary,
          params: IdParams,
          body: AppointmentTransitionRequest.nullish(),
          response: { 200: AppointmentDto, ...errors },
        },
      }, async (req) => service.transition(req.params.id, route.action, principalOf(req), req.body?.expectedVersion));
    }
  };

/** Patient sans rendez-vous : secrétariat, admin, médecin (sa propre file). */
export const walkInRoutes =
  (service: VisitsService): FastifyPluginAsyncZod =>
  async (app) => {
    app.post('/walk-ins', {
      onRequest: [app.authenticate, app.authorize('secretary', 'admin', 'doctor')],
      schema: {
        tags: ['visits'],
        summary: 'Patient sans rendez-vous : entrée directe en salle d’attente',
        body: CreateWalkInRequest,
        response: { 201: AppointmentDto, ...errors },
      },
    }, async (req, reply) => reply.code(201).send(await service.registerWalkIn(req.body, principalOf(req))));
  };
