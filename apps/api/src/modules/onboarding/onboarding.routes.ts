import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AuthSessionResponse, ClaimAccountRequest, ErrorResponse, IdParams, InvitationResponse, STAFF_ROLES } from '@cura/shared';
import { principalOf } from '../../http/auth-guard';
import { type CookieConfig, setSessionCookies } from '../../http/cookies';
import type { OnboardingService } from './onboarding.service';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse, 429: ErrorResponse };

export const onboardingRoutes =
  (service: OnboardingService, cookies: CookieConfig, authRateLimit: number): FastifyPluginAsyncZod =>
  async (app) => {
    app.post('/patients/:id/invitations', {
      onRequest: [app.authenticate, app.authorize(...STAFF_ROLES)],
      schema: {
        tags: ['patients'],
        summary: 'Générer le code d’activation de l’app pour un patient (affiché une seule fois)',
        params: IdParams,
        response: { 201: InvitationResponse, ...errors },
      },
    }, async (req, reply) => reply.code(201).send(await service.createInvitation(req.params.id, principalOf(req).sub)));

    app.post('/auth/claim', {
      config: { rateLimit: { max: authRateLimit, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        summary: 'Activer son compte avec le code remis par le cabinet (retrouve tout son historique)',
        security: [],
        body: ClaimAccountRequest,
        response: { 201: AuthSessionResponse, ...errors },
      },
    }, async (req, reply) => {
      const session = await service.claim(req.body, { ip: req.ip, userAgent: req.headers['user-agent'] });
      setSessionCookies(reply, session, cookies);
      return reply.code(201).send({ user: session.user, csrfToken: session.csrfToken });
    });
  };
