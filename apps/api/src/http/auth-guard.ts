/**
 * Authentification et autorisation (RBAC).
 *
 *   onRequest: [app.authenticate, app.authorize('admin', 'secretary')]
 *
 * - `authenticate` : lit l'access token (cookie httpOnly, ou en-tête Bearer pour les
 *   outils), le vérifie, et applique la protection CSRF aux requêtes à effet de bord
 *   authentifiées par cookie.
 * - `authorize`    : refuse (403) si le rôle n'est pas dans la liste.
 */
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { Role } from '@cura/shared';
import { ForbiddenError, UnauthorizedError } from '../common/errors';
import { type AccessTokenService, type AuthPrincipal, safeEqual } from '../common/security/tokens';
import { COOKIE, CSRF_HEADER } from './cookies';

declare module 'fastify' {
  interface FastifyRequest {
    principal: AuthPrincipal | null;
  }
  interface FastifyInstance {
    authenticate: onRequestAsyncHookHandler;
    authorize: (...roles: Role[]) => onRequestAsyncHookHandler;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Double-submit : l'en-tête doit égaler le cookie. Un site tiers ne peut lire ni l'un ni l'autre. */
export function assertCsrf(req: FastifyRequest): void {
  if (SAFE_METHODS.has(req.method)) return;
  const cookie = req.cookies[COOKIE.csrf];
  const header = req.headers[CSRF_HEADER];
  if (!cookie || typeof header !== 'string' || !safeEqual(cookie, header)) {
    throw new ForbiddenError('Jeton CSRF manquant ou invalide');
  }
}

export function principalOf(req: FastifyRequest): AuthPrincipal {
  if (!req.principal) throw new UnauthorizedError();
  return req.principal;
}

export const authGuard = fp<{ tokens: AccessTokenService }>(
  async (app, { tokens }) => {
    app.decorateRequest('principal', null);

    app.decorate('authenticate', async (req: FastifyRequest, _reply: FastifyReply) => {
      const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
      const token = bearer ?? req.cookies[COOKIE.access];
      if (!token) throw new UnauthorizedError();

      const principal = tokens.verify(token);
      if (!principal) throw new UnauthorizedError('TOKEN_INVALID', 'Session expirée ou invalide');

      // Le navigateur envoie les cookies automatiquement → CSRF possible. Pas avec un Bearer.
      if (!bearer) assertCsrf(req);

      req.principal = principal;
      req.log = req.log.child({ userId: principal.sub, role: principal.role });
    });

    app.decorate('authorize', (...roles: Role[]) => async (req: FastifyRequest) => {
      const principal = principalOf(req);
      if (!roles.includes(principal.role)) {
        req.log.warn({ event: 'auth.forbidden', required: roles }, 'access denied');
        throw new ForbiddenError();
      }
    });
  },
  { name: 'auth-guard', dependencies: ['@fastify/cookie'] },
);
