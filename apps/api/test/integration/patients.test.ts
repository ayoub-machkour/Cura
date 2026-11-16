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

describe('RBAC et validation des routes patients', () => {
  it('un patient ne peut ni consulter, ni créer, ni modifier un dossier par son id', async () => {
    const patient = await registerPatient(ctx.app);
    const id = patient.user.patientId!;
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/patients/${id}`, headers: as(patient) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'PATCH', url: `/api/v1/patients/${id}`, headers: as(patient), payload: { lastName: 'X' } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/patients', headers: as(patient), payload: newPatient })).statusCode).toBe(403);
  });

  it('le personnel n’a pas d’espace « me » patient', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/patients/me', headers: as(secretary) })).statusCode).toBe(403);
  });

  it('400 sur une création invalide (téléphone, date future, sexe inconnu)', async () => {
    for (const override of [{ phone: '0612345678' }, { birthDate: '2999-01-01' }, { sex: 'Z' }]) {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/patients', headers: as(secretary), payload: { ...newPatient, ...override } });
      expect(res.statusCode).toBe(400);
    }
  });

  it('PATCH null efface un champ optionnel ; conflit de numéro d’identité → 409', async () => {
    const a = (await ctx.app.inject({ method: 'POST', url: '/api/v1/patients', headers: as(secretary), payload: newPatient })).json();
    const b = (await ctx.app.inject({ method: 'POST', url: '/api/v1/patients', headers: as(secretary), payload: { ...newPatient, nationalId: 'ZZ999999' } })).json();
    const cleared = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/patients/${a.id}`, headers: as(secretary), payload: { nationalId: null } });
    expect(cleared.json().nationalId).toBeNull();
    const conflict = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/patients/${b.id}`, headers: as(secretary), payload: { nationalId: 'AB123456', sex: 'F' } });
    expect(conflict.statusCode).toBe(200); // AB123456 libéré par le PATCH précédent
    const dup = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/patients/${a.id}`, headers: as(secretary), payload: { nationalId: 'AB123456' } });
    expect(dup.statusCode).toBe(409);
  });

  it('PATCH sur un patient inconnu → 404', async () => {
    const res = await ctx.app.inject({ method: 'PATCH', url: '/api/v1/patients/3f1c2a6e-8b4d-4c1a-9e2f-1a2b3c4d5e6f', headers: as(secretary), payload: { phone: '+212600000000' } });
    expect(res.statusCode).toBe(404);
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
