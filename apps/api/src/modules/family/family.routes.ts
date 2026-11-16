import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AddDependentRequest,
  DependentParams,
  ErrorResponse,
  FamilyList,
  FamilyMemberDto,
  GuardianParams,
  IdParams,
  LinkDependentRequest,
  LinkGuardianRequest,
  STAFF_ROLES,
} from '@cura/shared';
import { principalOf } from '../../http/auth-guard';
import type { OnboardingService } from '../onboarding/onboarding.service';
import type { FamilyService } from './family.service';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse };

export const familyRoutes =
  (family: FamilyService, onboarding: OnboardingService): FastifyPluginAsyncZod =>
  async (app) => {
    const patientOnly = { onRequest: [app.authenticate, app.authorize('patient')] };

    app.get('/me/family', {
      ...patientOnly,
      schema: { tags: ['family'], summary: 'Mes proches (dossiers gérés par mon compte)', response: { 200: FamilyList, ...errors } },
    }, async (req) => ({ data: await family.list(principalOf(req)) }));

    app.post('/me/family', {
      ...patientOnly,
      schema: { tags: ['family'], summary: 'Ajouter un proche inconnu du cabinet (nouveau dossier)', body: AddDependentRequest, response: { 201: FamilyMemberDto, ...errors } },
    }, async (req, reply) => reply.code(201).send(await family.addDependent(principalOf(req), req.body)));

    app.post('/me/family/link', {
      ...patientOnly,
      schema: {
        tags: ['family'],
        summary: 'Rattacher un proche déjà suivi au cabinet (code remis au guichet + sa date de naissance)',
        body: LinkDependentRequest,
        response: { 201: FamilyMemberDto, ...errors },
      },
    }, async (req, reply) => reply.code(201).send(await onboarding.linkDependent(principalOf(req), req.body)));

    app.delete('/me/family/:patientId', {
      ...patientOnly,
      schema: { tags: ['family'], summary: 'Retirer un proche de mon compte (son dossier est conservé)', params: DependentParams, response: { 204: z.null(), ...errors } },
    }, async (req, reply) => {
      await family.removeDependent(principalOf(req), req.params.patientId);
      return reply.code(204).send(null);
    });

    // --- Guichet ----------------------------------------------------------------------
    app.post('/patients/:id/guardians', {
      onRequest: [app.authenticate, app.authorize(...STAFF_ROLES)],
      schema: {
        tags: ['family'],
        summary: 'Rattacher ce dossier au compte famille d’un proche (identité vérifiée au guichet)',
        params: IdParams,
        body: LinkGuardianRequest,
        response: { 204: z.null(), ...errors },
      },
    }, async (req, reply) => {
      await family.linkGuardian(req.params.id, req.body, principalOf(req));
      return reply.code(204).send(null);
    });

    app.delete('/patients/:id/guardians/:userId', {
      onRequest: [app.authenticate, app.authorize(...STAFF_ROLES)],
      schema: { tags: ['family'], summary: 'Retirer un rattachement famille', params: GuardianParams, response: { 204: z.null(), ...errors } },
    }, async (req, reply) => {
      await family.unlinkGuardian(req.params.id, req.params.userId, principalOf(req));
      return reply.code(204).send(null);
    });
  };
