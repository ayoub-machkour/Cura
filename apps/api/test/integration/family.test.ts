/**
 * Comptes famille : un papa gère les RDV de ses deux enfants, et d'autres scénarios réels.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  as,
  createTestContext,
  registerPatient,
  resetState,
  seedAppointmentType,
  seedDoctor,
  seedPatients,
  seedSlots,
  type Session,
  staffSession,
  type TestContext,
  tomorrowAt10,
} from './helpers';

let ctx: TestContext;
let doctorId: string;
let typeId: string;
let slots: string[];
let papa: Session;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await resetState(ctx);
  doctorId = await seedDoctor(ctx.c.pool);
  typeId = await seedAppointmentType(ctx.c.pool);
  slots = await seedSlots(ctx.c.pool, doctorId, tomorrowAt10(), 8);
  papa = await registerPatient(ctx.app, { firstName: 'Youssef', lastName: 'Amrani', phone: '+212611223344' });
});

const addChild = (firstName: string, birthDate = '2016-05-10', s: Session = papa) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/me/family', headers: as(s), payload: { firstName, lastName: 'Amrani', birthDate, relationship: 'child' } });
const book = (s: Session, slotId: string, patientId?: string, extra: Record<string, unknown> = {}) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/appointments',
    headers: as(s),
    payload: { slotId, appointmentTypeId: typeId, idempotencyKey: randomUUID(), ...(patientId ? { patientId } : {}), ...extra },
  });

describe('un papa gère les rendez-vous de ses deux enfants', () => {
  it('ajoute ses enfants, réserve un créneau pour chacun, voit tous les RDV de la famille', async () => {
    const yasmine = (await addChild('Yasmine', '2016-05-10')).json();
    const adam = (await addChild('Adam', '2019-09-02')).json();
    expect(yasmine).toMatchObject({ relationship: 'child', patient: { firstName: 'Yasmine', phone: '+212611223344' } });

    const family = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/family', headers: as(papa) });
    expect(family.json().data.map((m: { patient: { firstName: string } }) => m.patient.firstName)).toEqual(['Yasmine', 'Adam']);

    // Deux réservations simultanées, une par enfant.
    const [r1, r2] = await Promise.all([book(papa, slots[0]!, yasmine.patient.id), book(papa, slots[1]!, adam.patient.id)]);
    expect([r1.statusCode, r2.statusCode]).toEqual([201, 201]);
    expect(r1.json().patientId).toBe(yasmine.patient.id);
    await book(papa, slots[2]!); // pour lui-même

    const all = await ctx.app.inject({ method: 'GET', url: '/api/v1/appointments/me', headers: as(papa) });
    expect(all.json().data).toHaveLength(3);
    const onlyAdam = await ctx.app.inject({ method: 'GET', url: `/api/v1/appointments/me?patientId=${adam.patient.id}`, headers: as(papa) });
    expect(onlyAdam.json().data.map((a: { patientId: string }) => a.patientId)).toEqual([adam.patient.id]);
  });

  it('le même enfant sur deux créneaux qui se chevauchent → refus avec SON prénom', async () => {
    const yasmine = (await addChild('Yasmine')).json();
    const otherDoctor = await seedDoctor(ctx.c.pool);
    const [sameTime] = await seedSlots(ctx.c.pool, otherDoctor, tomorrowAt10(), 1);
    expect((await book(papa, slots[0]!, yasmine.patient.id)).statusCode).toBe(201);

    const res = await book(papa, sameTime!, yasmine.patient.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PATIENT_TIME_CONFLICT');
    expect(res.json().message).toContain('Yasmine a déjà un rendez-vous sur cet horaire');
  });

  it('deux enfants sur le MÊME créneau → le second reçoit des alternatives', async () => {
    const yasmine = (await addChild('Yasmine')).json();
    const adam = (await addChild('Adam', '2019-09-02')).json();
    expect((await book(papa, slots[0]!, yasmine.patient.id)).statusCode).toBe(201);
    const res = await book(papa, slots[0]!, adam.patient.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'ALREADY_BOOKED' });
    expect(res.json().alternatives.length).toBeGreaterThan(0);
  });

  it('la limite de RDV à venir s’applique par enfant, avec un message nominatif', async () => {
    const yasmine = (await addChild('Yasmine')).json();
    for (const i of [0, 1, 2]) expect((await book(papa, slots[i]!, yasmine.patient.id)).statusCode).toBe(201);
    const res = await book(papa, slots[3]!, yasmine.patient.id);
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain('Yasmine a déjà 3 rendez-vous à venir');
    expect((await book(papa, slots[3]!)).statusCode).toBe(201); // le papa, lui, peut encore réserver
  });

  it('pré-réservation par le papa puis réservation pour son enfant avec le même jeton', async () => {
    const yasmine = (await addChild('Yasmine')).json();
    const hold = await ctx.app.inject({ method: 'POST', url: `/api/v1/slots/${slots[0]}/hold`, headers: as(papa), payload: { appointmentTypeId: typeId } });
    const res = await book(papa, slots[0]!, yasmine.patient.id, { holdToken: hold.json().holdToken });
    expect(res.statusCode).toBe(201);
  });

  it('le papa annule le RDV de son enfant ; une autre famille ne le peut pas (404)', async () => {
    const yasmine = (await addChild('Yasmine')).json();
    const id = (await book(papa, slots[0]!, yasmine.patient.id)).json().id;
    const stranger = await registerPatient(ctx.app);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/appointments/${id}/cancel`, headers: as(stranger) })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/appointments/${id}/cancel`, headers: as(papa) })).json().status).toBe('cancelled');
  });
});

describe('refus et messages clairs', () => {
  it('réserver pour une personne qui n’est pas de la famille → 403 explicite', async () => {
    const [stranger] = await seedPatients(ctx.c.pool, 1);
    const res = await book(papa, slots[0]!, stranger);
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('proche ajouté à votre famille');
  });

  it('un patient ne voit pas les RDV d’un dossier qui n’est pas le sien (404)', async () => {
    const [stranger] = await seedPatients(ctx.c.pool, 1);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/appointments/me?patientId=${stranger}`, headers: as(papa) });
    expect(res.statusCode).toBe(404);
  });

  it('maximum 10 proches par compte', async () => {
    for (let i = 0; i < 10; i++) expect((await addChild(`Enfant${'ABCDEFGHIJ'[i]}`)).statusCode).toBe(201);
    const res = await addChild('Onzieme');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('FAMILY_LIMIT_REACHED');
  });

  it('retirer un proche : son dossier est conservé, mais le papa ne peut plus réserver pour lui', async () => {
    const yasmine = (await addChild('Yasmine')).json();
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/me/family/${yasmine.patient.id}`, headers: as(papa) });
    expect(del.statusCode).toBe(204);
    expect((await book(papa, slots[0]!, yasmine.patient.id)).statusCode).toBe(403);
    expect((await ctx.c.pool.query(`SELECT count(*)::int AS n FROM patients WHERE id = $1`, [yasmine.patient.id])).rows[0].n).toBe(1);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/v1/me/family/${yasmine.patient.id}`, headers: as(papa) })).statusCode).toBe(404);
  });

  it('400 sur un lien de parenté inconnu ou un nom invalide ; 403 pour le personnel', async () => {
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/v1/me/family', headers: as(papa), payload: { firstName: 'A', lastName: 'B', birthDate: '2016-01-01', relationship: 'cousin' } });
    expect(bad.statusCode).toBe(400);
    expect((await addChild('R2D2')).statusCode).toBe(400);
    expect((await addChild('Yasmine', '2016-01-01', await staffSession(ctx, 'secretary'))).statusCode).toBe(403);
  });
});

describe('rattacher un proche déjà suivi au cabinet', () => {
  const GRANDMA_BIRTH = '1948-02-20';
  async function grandmaWithCode(): Promise<{ id: string; code: string }> {
    const secretary = await staffSession(ctx, 'secretary');
    const id = (
      await ctx.app.inject({ method: 'POST', url: '/api/v1/patients', headers: as(secretary), payload: { firstName: 'Fatima', lastName: 'Amrani', birthDate: GRANDMA_BIRTH, phone: '+212600000999' } })
    ).json().id;
    const code = (await ctx.app.inject({ method: 'POST', url: `/api/v1/patients/${id}/invitations`, headers: as(secretary) })).json().code;
    return { id, code };
  }
  const link = (body: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/api/v1/me/family/link', headers: as(papa), payload: { relationship: 'parent', ...body } });

  it('avec le code du guichet + sa date de naissance : son historique devient visible', async () => {
    const grandma = await grandmaWithCode();
    const res = await link({ code: grandma.code, birthDate: GRANDMA_BIRTH });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ relationship: 'parent', patient: { id: grandma.id, firstName: 'Fatima' } });
    expect((await book(papa, slots[0]!, grandma.id)).statusCode).toBe(201);
  });

  it('mauvaise date de naissance → 422 générique ; code déjà utilisé → 422', async () => {
    const grandma = await grandmaWithCode();
    expect((await link({ code: grandma.code, birthDate: '1950-01-01' })).json().code).toBe('INVALID_INVITATION');
    expect((await link({ code: grandma.code, birthDate: GRANDMA_BIRTH })).statusCode).toBe(201);
    expect((await link({ code: grandma.code, birthDate: GRANDMA_BIRTH })).statusCode).toBe(422);
  });

  it('déjà rattachée → 409 ; son propre dossier → 422 CANNOT_LINK_SELF', async () => {
    const secretary = await staffSession(ctx, 'secretary');
    const grandma = await grandmaWithCode();
    await link({ code: grandma.code, birthDate: GRANDMA_BIRTH });
    const again = (await ctx.app.inject({ method: 'POST', url: `/api/v1/patients/${grandma.id}/invitations`, headers: as(secretary) })).json().code;
    expect((await link({ code: again, birthDate: GRANDMA_BIRTH })).json().code).toBe('ALREADY_LINKED');

    const own = (await ctx.app.inject({ method: 'POST', url: `/api/v1/patients/${papa.user.patientId}/invitations`, headers: as(secretary) })).json().code;
    const self = await link({ code: own, birthDate: '1992-03-14' });
    expect(self.statusCode).toBe(422);
    expect(self.json().code).toBe('CANNOT_LINK_SELF');
  });
});

describe('rattachement au guichet (personnel)', () => {
  it('la secrétaire rattache un dossier au compte du papa par son email', async () => {
    const secretary = await staffSession(ctx, 'secretary');
    const [child] = await seedPatients(ctx.c.pool, 1);
    const linkRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/patients/${child}/guardians`,
      headers: as(secretary),
      payload: { email: papa.user.email, relationship: 'child' },
    });
    expect(linkRes.statusCode).toBe(204);
    expect((await book(papa, slots[0]!, child)).statusCode).toBe(201);

    const unlink = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/patients/${child}/guardians/${papa.user.id}`, headers: as(secretary) });
    expect(unlink.statusCode).toBe(204);
    expect((await book(papa, slots[1]!, child)).statusCode).toBe(403);
  });

  it('email inconnu → 404 ; compte du personnel → 422 ; son propre dossier → 422 ; patient → 403', async () => {
    const secretary = await staffSession(ctx, 'secretary');
    const [child] = await seedPatients(ctx.c.pool, 1);
    const linkTo = (patientId: string, email: string, s: Session = secretary) =>
      ctx.app.inject({ method: 'POST', url: `/api/v1/patients/${patientId}/guardians`, headers: as(s), payload: { email, relationship: 'child' } });
    expect((await linkTo(child!, 'nobody@cura.test')).statusCode).toBe(404);
    expect((await linkTo(child!, secretary.user.email)).json().code).toBe('GUARDIAN_MUST_BE_PATIENT_ACCOUNT');
    expect((await linkTo(papa.user.patientId!, papa.user.email)).json().code).toBe('CANNOT_LINK_SELF');
    expect((await linkTo(child!, papa.user.email, papa)).statusCode).toBe(403);
  });
});
