import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AuthSessionResponse, CreateStaffUserRequest, ErrorResponse, LoginRequest, RegisterPatientRequest, UserDto } from '@cura/shared';
import { UnauthorizedError } from '../../common/errors';
import { assertCsrf, principalOf } from '../../http/auth-guard';
import { clearSessionCookies, COOKIE, type CookieConfig, setSessionCookies } from '../../http/cookies';
import type { AuthService, ClientContext } from './auth.service';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse, 429: ErrorResponse };

const clientContext = (req: FastifyRequest): ClientContext => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'],
});

export const authRoutes =
  (service: AuthService, cookies: CookieConfig, authRateLimit: number): FastifyPluginAsyncZod =>
  async (app) => {
    // Limite stricte sur les routes sensibles (force brute, création de comptes en masse).
    const strict = { rateLimit: { max: authRateLimit, timeWindow: '1 minute' } };

    app.post('/auth/register', {
      config: strict,
      schema: { tags: ['auth'], summary: 'Inscription patient (app mobile)', security: [], body: RegisterPatientRequest, response: { 201: AuthSessionResponse, ...errors } },
    }, async (req, reply) => {
      const session = await service.registerPatient(req.body, clientContext(req));
      setSessionCookies(reply, session, cookies);
      return reply.code(201).send({ user: session.user, csrfToken: session.csrfToken });
    });

    app.post('/auth/login', {
      config: strict,
      schema: { tags: ['auth'], summary: 'Connexion — pose les cookies de session', security: [], body: LoginRequest, response: { 200: AuthSessionResponse, ...errors } },
    }, async (req, reply) => {
      const session = await service.login(req.body.email, req.body.password, clientContext(req));
      setSessionCookies(reply, session, cookies);
      return { user: session.user, csrfToken: session.csrfToken };
    });

    app.post('/auth/refresh', {
      config: strict,
      schema: { tags: ['auth'], summary: 'Rotation du refresh token (cookie httpOnly)', response: { 200: AuthSessionResponse, ...errors } },
    }, async (req, reply) => {
      assertCsrf(req);
      const raw = req.cookies[COOKIE.refresh];
      if (!raw) throw new UnauthorizedError('INVALID_REFRESH_TOKEN', 'Session expirée, veuillez vous reconnecter');
      try {
        const session = await service.refresh(raw, clientContext(req));
        setSessionCookies(reply, session, cookies);
        return { user: session.user, csrfToken: session.csrfToken };
      } catch (err) {
        clearSessionCookies(reply, cookies);
        throw err;
      }
    });

    app.post('/auth/logout', {
      schema: { tags: ['auth'], summary: 'Déconnexion de cet appareil', response: { 204: z.null(), ...errors } },
    }, async (req, reply) => {
      assertCsrf(req);
      await service.logout(req.cookies[COOKIE.refresh], req.principal?.sub);
      clearSessionCookies(reply, cookies);
      return reply.code(204).send(null);
    });

    app.get('/auth/me', {
      onRequest: [app.authenticate],
      schema: { tags: ['auth'], summary: 'Utilisateur connecté', response: { 200: UserDto, ...errors } },
    }, async (req) => service.me(principalOf(req).sub));

    app.post('/users', {
      onRequest: [app.authenticate, app.authorize('admin')],
      schema: { tags: ['auth'], summary: 'Créer un compte du personnel (admin)', body: CreateStaffUserRequest, response: { 201: UserDto, ...errors } },
    }, async (req, reply) => reply.code(201).send(await service.createStaffUser(req.body, principalOf(req).sub)));
  };
