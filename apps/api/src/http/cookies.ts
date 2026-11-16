/**
 * Cookies de session.
 *
 * - access token  : httpOnly (inaccessible au JavaScript → protégé contre le vol par XSS), 15 min.
 * - refresh token : httpOnly, limité au chemin /api/v1/auth (n'est envoyé QUE pour rafraîchir/déconnecter).
 * - csrf token    : lisible par le JS (double-submit) ; le client le renvoie dans l'en-tête x-csrf-token.
 * Tous en SameSite=Strict et Secure (HTTPS) hors développement.
 */
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply } from 'fastify';
import type { Session } from '../modules/auth/auth.service';

export const COOKIE = {
  access: 'cura_at',
  refresh: 'cura_rt',
  csrf: 'cura_csrf',
} as const;

export const CSRF_HEADER = 'x-csrf-token';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export interface CookieConfig {
  secure: boolean;
  domain?: string;
}

const base = (cfg: CookieConfig): CookieSerializeOptions => ({
  secure: cfg.secure,
  sameSite: 'strict',
  domain: cfg.domain,
});

export function setSessionCookies(reply: FastifyReply, session: Session, cfg: CookieConfig): void {
  reply
    .setCookie(COOKIE.access, session.accessToken, {
      ...base(cfg),
      httpOnly: true,
      path: '/api',
      maxAge: session.accessTokenTtlSeconds,
    })
    .setCookie(COOKIE.refresh, session.refreshToken, {
      ...base(cfg),
      httpOnly: true,
      path: REFRESH_COOKIE_PATH,
      expires: session.refreshExpiresAt,
    })
    .setCookie(COOKIE.csrf, session.csrfToken, {
      ...base(cfg),
      httpOnly: false,
      path: '/',
      expires: session.refreshExpiresAt,
    });
}

export function clearSessionCookies(reply: FastifyReply, cfg: CookieConfig): void {
  reply
    .clearCookie(COOKIE.access, { ...base(cfg), path: '/api' })
    .clearCookie(COOKIE.refresh, { ...base(cfg), path: REFRESH_COOKIE_PATH })
    .clearCookie(COOKIE.csrf, { ...base(cfg), path: '/' });
}
