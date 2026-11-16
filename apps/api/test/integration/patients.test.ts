import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestContext, registerPatient, resetState, seedPatients, type Session, staffSession, type TestContext } from './helpers';

let ctx: TestContext;
let secretary: Session;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await resetState(ctx);
  secretary = await staffSession(ctx, 'secretary');
});

const newPatient = { firstName: 'Youssef', lastName: 'Haddad', birthDate: '1985-07-20', phone: '+212612345678', nationalId: 'AB123456' };

describe('dossiers patients (cabinet)', () => {
  it('crée, consulte et modifie un patient', async () => {
    const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/patients', headers: as(secretary), payload: newPatient });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const fetched = await ctx.app.inject({ method: 'GET', url: `/api/v1/patients/${id}`, headers: as(secretary) });
    expect(fetched.json()).toMatchObject({ firstName: 'Youssef', email: null });

    const patched = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/patients/${id}`, headers: as(secretary), payload: { email: 'Y@Cura.test' } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().email).toBe('y@cura.test');
  });

  it('409 si le numéro d’identité existe déjà', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/v1/patients', headers: as(secretary), payload: newPatient });
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/v1/patients', headers: as(secretary), payload: { ...newPatient, firstName: 'Autre' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('NATIONAL_ID_TAKEN');
  });

  it('PATCH vide → 400 ; patient inconnu → 404', async () => {
    const empty = await ctx.app.inject({ method: 'PATCH', url: '/api/v1/patients/3f1c2a6e-8b4d-4c1a-9e2f-1a2b3c4d5e6f', headers: as(secretary), payload: {} });
    expect(empty.statusCode).toBe(400);
    const missing = await ctx.app.inject({ method: 'GET', url: '/api/v1/patients/3f1c2a6e-8b4d-4c1a-9e2f-1a2b3c4d5e6f', headers: as(secretary) });
    expect(missing.statusCode).toBe(404);
  });
});

describe('pagination par curseur', () => {
  it('parcourt 45 patients par pages de 20 sans doublon ni oubli, dans l’ordre alphabétique', async () => {
    await seedPatients(ctx.c.pool, 45);
    const seen: string[] = [];
    const names: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = cursor ? `&cursor=${cursor}` : '';
      const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/patients?limit=20${qs}`, headers: as(secretary) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      seen.push(...body.data.map((p: { id: string }) => p.id));
      names.push(...body.data.map((p: { lastName: string }) => p.lastName.toLowerCase()));
      cursor = body.page.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(45);
    expect(new Set(seen).size).toBe(45);
    expect(names).toEqual([...names].sort());
  });

  it('recherche « contient », insensible à la casse, jokers neutralisés', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/v1/patients', headers: as(secretary), payload: newPatient });
    await ctx.app.inject({ method: 'POST', url: '/api/v1/patients', headers: as(secretary), payload: { ...newPatient, nationalId: 'CD999999', lastName: 'Benjelloun' } });

    const hit = await ctx.app.inject({ method: 'GET', url: '/api/v1/patients?q=hadd', headers: as(secretary) });
    expect(hit.json().data.map((p: { lastName: string }) => p.lastName)).toEqual(['Haddad']);

    const wildcard = await ctx.app.inject({ method: 'GET', url: '/api/v1/patients?q=%25%25', headers: as(secretary) });
    expect(wildcard.json().data).toHaveLength(0);
  });

  it('400 sur un curseur forgé', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/patients?cursor=forged', headers: as(secretary) });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_CURSOR');
  });
});

describe('espace patient', () => {
  it('le patient consulte et modifie SES coordonnées uniquement', async () => {
    const patient = await registerPatient(ctx.app);
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/patients/me', headers: as(patient) });
    expect(me.json().id).toBe(patient.user.patientId);

    const patched = await ctx.app.inject({ method: 'PATCH', url: '/api/v1/patients/me', headers: as(patient), payload: { phone: '+212698765432' } });
    expect(patched.json().phone).toBe('+212698765432');

    // Champ hors schéma (mass assignment) : ignoré par Zod → corps vide → 400. Le nom n'est jamais modifié.
    const sneaky = await ctx.app.inject({ method: 'PATCH', url: '/api/v1/patients/me', headers: as(patient), payload: { lastName: 'Hacker' } });
    expect(sneaky.statusCode).toBe(400);
  });
});
