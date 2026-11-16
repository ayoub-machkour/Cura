/**
 * Contrôleur HTTP des patients : schémas Zod (validation + documentation OpenAPI),
 * contrôle d'accès, puis délégation au service. Aucune logique métier ici.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  CreatePatientRequest,
  ErrorResponse,
  IdParams,
  ListPatientsQuery,
  PatientDto,
  PatientPage,
  STAFF_ROLES,
  UpdateMyProfileRequest,
  UpdatePatientRequest,
} from '@cura/shared';
import { ForbiddenError } from '../../common/errors';
import { principalOf } from '../../http/auth-guard';
import type { PatientsService } from './patients.service';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };

export const patientsRoutes =
  (service: PatientsService): FastifyPluginAsyncZod =>
  async (app) => {
    const staffOnly = { onRequest: [app.authenticate, app.authorize(...STAFF_ROLES)] };
    const patientOnly = { onRequest: [app.authenticate, app.authorize('patient')] };

    // --- Espace patient (app mobile) -------------------------------------------------
    app.get('/patients/me', {
      ...patientOnly,
      schema: { tags: ['patients'], summary: 'Mon dossier patient', response: { 200: PatientDto, ...errors } },
    }, async (req) => service.get(ownPatientId(req)));

    app.patch('/patients/me', {
      ...patientOnly,
      schema: { tags: ['patients'], summary: 'Modifier mes coordonnées', body: UpdateMyProfileRequest, response: { 200: PatientDto, ...errors } },
    }, async (req) => service.update(ownPatientId(req), req.body, principalOf(req).sub));

    // --- Espace cabinet ---------------------------------------------------------------
    app.get('/patients', {
      ...staffOnly,
      schema: {
        tags: ['patients'],
        summary: 'Lister / rechercher les patients (alphabétique, paginé)',
        querystring: ListPatientsQuery,
        response: { 200: PatientPage, ...errors },
      },
    }, async (req) => service.list(req.query));

    app.post('/patients', {
      ...staffOnly,
      schema: { tags: ['patients'], summary: 'Créer un dossier patient', body: CreatePatientRequest, response: { 201: PatientDto, ...errors } },
    }, async (req, reply) => reply.code(201).send(await service.create(req.body, principalOf(req).sub)));

    app.get('/patients/:id', {
      ...staffOnly,
      schema: { tags: ['patients'], summary: 'Consulter un dossier patient', params: IdParams, response: { 200: PatientDto, ...errors } },
    }, async (req) => service.get(req.params.id));

    app.patch('/patients/:id', {
      ...staffOnly,
      schema: { tags: ['patients'], summary: 'Modifier un dossier patient', params: IdParams, body: UpdatePatientRequest, response: { 200: PatientDto, ...errors } },
    }, async (req) => service.update(req.params.id, req.body, principalOf(req).sub));
  };

function ownPatientId(req: Parameters<typeof principalOf>[0]): string {
  const { pid } = principalOf(req);
  if (!pid) throw new ForbiddenError('Aucun dossier patient lié à ce compte');
  return pid;
}
