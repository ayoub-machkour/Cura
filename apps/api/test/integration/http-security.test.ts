/**
 * Sécurité transverse : en-têtes, CORS, validation, erreurs, RBAC, health checks, OpenAPI, rate limiting.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestContext, registerPatient, resetState, staffSession, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => resetState(ctx));

describe('en-têtes de sécurité (helmet)', () => {
  it('pose les en-têtes protecteurs et ne divulgue pas la techno', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health/live' });
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('interdit la mise en cache des réponses de l’API (données de santé)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('CORS', () => {
  it('autorise une origine de la liste blanche, avec credentials', async () => {
    const res = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('n’autorise pas une origine inconnue', async () => {
    const res = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('corrélation des logs', () => {
  it('renvoie l’x-request-id fourni par Nginx', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health/live', headers: { 'x-request-id': 'nginx-req-12345678' } });
    expect(res.headers['x-request-id']).toBe('nginx-req-12345678');
  });

  it('génère un identifiant si l’en-tête est absent ou malformé', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health/live', headers: { 'x-request-id': '<script>' } });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('validation des entrées (Zod) et format d’erreur', () => {
  it('400 avec le détail de chaque champ invalide', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'not-an-email', password: 'short', firstName: 'A', lastName: 'B', birthDate: '1990-01-01', phone: '0600' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.requestId).toBeTruthy();
    const paths = body.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['email', 'password', 'phone']));
  });

  it('rejette une charge utile XSS dans un champ texte', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'x@cura.test', password: 'Valid-Password-1', firstName: '<img src=x onerror=alert(1)>', lastName: 'B', birthDate: '1990-01-01', phone: '+212600000000' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejette un paramètre de route non-UUID', async () => {
    const admin = await staffSession(ctx, 'admin');
    const res = await ctx.app.inject({ method: 'GET', url: "/api/v1/patients/1' OR '1'='1", headers: as(admin) });
    expect(res.statusCode).toBe(400);
  });

  it('rejette un JSON malformé et un type de contenu non supporté', async () => {
    const malformed = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"email":' });
    expect(malformed.statusCode).toBe(400);
    const xml = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/xml' }, payload: '<a/>' });
    expect(xml.statusCode).toBe(415);
  });

  it('corps vide avec content-type JSON (axios, fetch) : traité comme « pas de corps »', async () => {
    const patient = await registerPatient(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...as(patient), 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(204);
  });

  it('rejette la pollution de prototype (__proto__ / constructor) dans le JSON', async () => {
    for (const payload of ['{"email":"a@b.co","password":"x","__proto__":{"isAdmin":true}}', '{"constructor":{"prototype":{"isAdmin":true}}}']) {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload });
      expect(res.statusCode).toBe(400);
    }
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it('rejette un corps trop volumineux', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'a@b.co', password: 'x'.repeat(200_000) } });
    expect(res.statusCode).toBe(413);
  });

  it('GET /api/v1 décrit l’API (découverte)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Cura API', version: 'v1', docs: '/docs' });
  });

  it('404 JSON sur une route inconnue', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('ROUTE_NOT_FOUND');
  });
});

describe('RBAC', () => {
  it('un patient ne peut pas lister les patients du cabinet', async () => {
    const patient = await registerPatient(ctx.app);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/patients', headers: as(patient) });
    expect(res.statusCode).toBe(403);
  });

  it('un secrétaire ne peut pas créer de médecin (admin seulement)', async () => {
    const secretary = await staffSession(ctx, 'secretary');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/doctors',
      headers: as(secretary),
      payload: { firstName: 'A', lastName: 'B', specialty: 'Cardiologie', registrationNumber: 'REG-1' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('health checks', () => {
  it('/health/live répond sans dépendance', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('/health/ready vérifie PostgreSQL et Redis', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toMatchObject({ database: { status: 'up' }, redis: { status: 'up' } });
  });
});

describe('OpenAPI / Swagger', () => {
  it('expose une spécification générée depuis les schémas Zod', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/api/v1/auth/login', '/api/v1/appointments', '/api/v1/patients']));
    const body = spec.paths['/api/v1/auth/register'].post.requestBody.content['application/json'].schema;
    expect(body.properties.password.minLength).toBe(12);
  });

  it('sert l’interface Swagger UI avec sa propre CSP', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("object-src 'none'");
  });
});

describe('rate limiting', () => {
  it('429 au-delà de la limite stricte des routes d’authentification', async () => {
    const limited = await createTestContext({ RATE_LIMIT_AUTH_MAX: '3', REDIS_KEY_PREFIX: 'cura-test-rl:' });
    try {
      const attempt = () =>
        limited.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'x@cura.test', password: 'whatever-1' } });
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await attempt()).statusCode);
      expect(statuses).toEqual([401, 401, 401, 429]);
      const last = await attempt();
      expect(last.json().code).toBe('RATE_LIMITED');
      expect(last.headers['retry-after']).toBeDefined();
    } finally {
      await limited.close();
    }
  });
});
