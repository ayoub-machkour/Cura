/**
 * Référentiels : médecins et motifs de consultation — toutes les routes, tous les rôles.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestContext, registerPatient, resetState, type Session, staffSession, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Session;
let secretary: Session;
let patient: Session;

const UNKNOWN = '3f1c2a6e-8b4d-4c1a-9e2f-1a2b3c4d5e6f';
const doctorBody = { firstName: 'Karim', lastName: 'Alaoui', specialty: 'Cardiologie', registrationNumber: 'MED-001', timezone: 'Africa/Casablanca' };
const typeBody = { code: 'consult', label: 'Consultation', durationMinutes: 20, colorHex: '#2563EB', defaultPriceCents: 25000 };

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await resetState(ctx);
  [admin, secretary, patient] = await Promise.all([staffSession(ctx, 'admin'), staffSession(ctx, 'secretary'), registerPatient(ctx.app)]);
});

const post = (url: string, s: Session, payload: object) => ctx.app.inject({ method: 'POST', url, headers: as(s), payload });
const get = (url: string, s?: Session) => ctx.app.inject({ method: 'GET', url, headers: s ? as(s) : {} });
const patch = (url: string, s: Session, payload: object) => ctx.app.inject({ method: 'PATCH', url, headers: as(s), payload });

describe('POST /doctors', () => {
  it('201 pour un admin, fuseau par défaut UTC', async () => {
    const { timezone: _tz, ...withoutTz } = doctorBody;
    const res = await post('/api/v1/doctors', admin, withoutTz);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ lastName: 'Alaoui', timezone: 'UTC', isActive: true });
  });

  it('409 si le numéro d’inscription existe déjà', async () => {
    await post('/api/v1/doctors', admin, doctorBody);
    const res = await post('/api/v1/doctors', admin, { ...doctorBody, firstName: 'Autre' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('REGISTRATION_NUMBER_TAKEN');
  });

  it.each([
    ['fuseau inconnu', { timezone: 'Mars/Olympus' }],
    ['spécialité trop courte', { specialty: 'C' }],
    ['numéro d’inscription invalide', { registrationNumber: 'MED 001' }],
  ])('400 : %s', async (_label, override) => {
    expect((await post('/api/v1/doctors', admin, { ...doctorBody, ...override })).statusCode).toBe(400);
  });

  it('403 pour un secrétaire et un patient, 401 sans session', async () => {
    expect((await post('/api/v1/doctors', secretary, doctorBody)).statusCode).toBe(403);
    expect((await post('/api/v1/doctors', patient, doctorBody)).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/doctors', payload: doctorBody })).statusCode).toBe(401);
  });
});

describe('GET /doctors', () => {
  it('liste paginée des médecins actifs, accessible à tout utilisateur connecté', async () => {
    for (let i = 0; i < 3; i++) await post('/api/v1/doctors', admin, { ...doctorBody, lastName: `Médecin${'ABC'[i]}`, registrationNumber: `MED-00${i}` });
    await ctx.c.pool.query(`UPDATE doctors SET is_active = false WHERE last_name = 'MédecinC'`);

    const page1 = await get('/api/v1/doctors?limit=1', patient);
    expect(page1.statusCode).toBe(200);
    expect(page1.json().page.hasMore).toBe(true);
    const page2 = await get(`/api/v1/doctors?limit=1&cursor=${page1.json().page.nextCursor}`, patient);
    expect(page2.json().page.hasMore).toBe(false);
    expect([...page1.json().data, ...page2.json().data].map((d: { lastName: string }) => d.lastName)).toEqual(['MédecinA', 'MédecinB']);
  });

  it('401 sans session', async () => {
    expect((await get('/api/v1/doctors')).statusCode).toBe(401);
  });
});

describe('GET /doctors/:id', () => {
  it('200, puis 404 sur un id inconnu et 400 sur un id invalide', async () => {
    const id = (await post('/api/v1/doctors', admin, doctorBody)).json().id;
    expect((await get(`/api/v1/doctors/${id}`, patient)).json().registrationNumber).toBe('MED-001');
    expect((await get(`/api/v1/doctors/${UNKNOWN}`, patient)).statusCode).toBe(404);
    expect((await get('/api/v1/doctors/42', patient)).statusCode).toBe(400);
  });
});

describe('appointment-types', () => {
  it('POST 201 (admin) : code normalisé, valeurs par défaut appliquées', async () => {
    const res = await post('/api/v1/appointment-types', admin, typeBody);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ code: 'CONSULT', bookableOnline: true, isActive: true, defaultPriceCents: 25000 });
  });

  it('POST 409 sur un code existant, 400 sur une charge invalide, 403 hors admin', async () => {
    await post('/api/v1/appointment-types', admin, typeBody);
    const dup = await post('/api/v1/appointment-types', admin, { ...typeBody, label: 'Autre' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('CODE_TAKEN');
    expect((await post('/api/v1/appointment-types', admin, { ...typeBody, code: 'X2', label: '<b>gras</b>' })).statusCode).toBe(400);
    expect((await post('/api/v1/appointment-types', admin, { ...typeBody, code: 'X3', defaultPriceCents: -1 })).statusCode).toBe(400);
    expect((await post('/api/v1/appointment-types', secretary, { ...typeBody, code: 'X4' })).statusCode).toBe(403);
  });

  it('GET : le patient ne voit que les motifs actifs réservables en ligne, le personnel voit tout', async () => {
    await post('/api/v1/appointment-types', admin, typeBody);
    await post('/api/v1/appointment-types', admin, { ...typeBody, code: 'DESK_ONLY', label: 'Au cabinet', bookableOnline: false });
    const inactive = (await post('/api/v1/appointment-types', admin, { ...typeBody, code: 'OLD', label: 'Ancien' })).json().id;
    await patch(`/api/v1/appointment-types/${inactive}`, admin, { isActive: false });

    const forPatient = (await get('/api/v1/appointment-types', patient)).json().data.map((t: { code: string }) => t.code);
    const forStaff = (await get('/api/v1/appointment-types', secretary)).json().data.map((t: { code: string }) => t.code);
    expect(forPatient).toEqual(['CONSULT']);
    expect(forStaff.sort()).toEqual(['CONSULT', 'DESK_ONLY', 'OLD']);
  });

  it('PATCH : 200 (admin), 400 si vide, 404 si inconnu, 403 hors admin', async () => {
    const id = (await post('/api/v1/appointment-types', admin, typeBody)).json().id;
    const ok = await patch(`/api/v1/appointment-types/${id}`, admin, { label: 'Consultation longue', durationMinutes: 40 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ label: 'Consultation longue', durationMinutes: 40, code: 'CONSULT' });
    expect((await patch(`/api/v1/appointment-types/${id}`, admin, {})).statusCode).toBe(400);
    expect((await patch(`/api/v1/appointment-types/${UNKNOWN}`, admin, { label: 'X' })).statusCode).toBe(404);
    expect((await patch(`/api/v1/appointment-types/${id}`, secretary, { label: 'X' })).statusCode).toBe(403);
  });
});
