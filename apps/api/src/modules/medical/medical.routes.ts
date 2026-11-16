import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorResponse, IdParams, MedicalProfileDto, UpdateMedicalProfileRequest } from '@cura/shared';
import { principalOf } from '../../http/auth-guard';
import type { MedicalService } from './medical.service';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse };

export const medicalRoutes =
  (service: MedicalService): FastifyPluginAsyncZod =>
  async (app) => {
    // Patient (son dossier et ceux de ses proches) et personnel du cabinet ; périmètre vérifié par le service.
    app.get('/patients/:id/medical-profile', {
      onRequest: [app.authenticate],
      schema: { tags: ['patients'], summary: 'Profil médical (antécédents, traitements, allergies…)', params: IdParams, response: { 200: MedicalProfileDto, ...errors } },
    }, async (req) => service.get(req.params.id, principalOf(req)));

    app.put('/patients/:id/medical-profile', {
      onRequest: [app.authenticate],
      schema: {
        tags: ['patients'],
        summary: 'Mettre à jour le profil médical (remplacement complet, modifications tracées)',
        params: IdParams,
        body: UpdateMedicalProfileRequest,
        response: { 200: MedicalProfileDto, ...errors },
      },
    }, async (req) => service.update(req.params.id, req.body, principalOf(req)));
  };
