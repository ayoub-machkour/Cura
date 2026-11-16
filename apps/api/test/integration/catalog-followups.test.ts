/**
 * Soins par médecin (prix) et rendez-vous de contrôle fixés par le cabinet.
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
let drA: string;
let drB: string;
let doctorA: Session;
let doctorB: Session;
let admin: Session;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await resetState(ctx);
  drA = await seedDoctor(ctx.c.pool);
  drB = await seedDoctor(ctx.c.pool);
  [doctorA, doctorB, admin] = await Promise.all([staffSession(ctx, 'doctor', drA), staffSession(ctx, 'doctor', drB), staffSession(ctx, 'admin')]);
});

const createType = (s: Session, body: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/appointment-types',
    headers: as(s),
    payload: { code: 'DETARTRAGE', label: 'Détartrage', durationMinutes: 20, colorHex: '#16A34A', defaultPriceCents: 30000, ...body },
  });

describe('le médecin gère ses soins et leurs prix', () => {
  it('un médecin crée SES soins ; deux médecins peuvent avoir le même code avec des prix différents', async () => {
    const a = await createType(doctorA, {});
    const b = await createType(doctorB, { defaultPriceCents: 35000 });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ doctorId: drA, defaultPriceCents: 30000 });
    expect(b.json()).toMatchObject({ doctorId: drB, defaultPriceCents: 35000 });
    expect((await createType(doctorA, {})).json().code).toBe('CODE_TAKEN');
  });

  it('un médecin ne crée pas pour un confrère (403) et ne modifie ni ses soins ni les motifs communs (404)', async () => {
    expect((await createType(doctorA, { doctorId: drB })).statusCode).toBe(403);
    const ofB = (await createType(doctorB, {})).json().id;
    const common = (await createType(admin, { code: 'PREMIERE', label: 'Première consultation' })).json().id;
    for (const id of [ofB, common]) {
      expect((await ctx.app.inject({ method: 'PATCH', url: `/api/v1/appointment-types/${id}`, headers: as(doctorA), payload: { defaultPriceCents: 1 } })).statusCode).toBe(404);
    }
    const own = (await createType(doctorA, { code: 'OWN' })).json().id;
    const patched = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/appointment-types/${own}`, headers: as(doctorA), payload: { defaultPriceCents: 32000 } });
    expect(patched.json().defaultPriceCents).toBe(32000);
  });

  it('le patient voit, pour un médecin, ses soins + les motifs communs, avec les prix', async () => {
    await createType(admin, { code: 'PREMIERE', label: 'Première consultation', defaultPriceCents: 20000 });
    await createType(doctorA, {});
    await createType(doctorB, { code: 'AUTRE', label: 'Autre soin' });
    const patient = await registerPatient(ctx.app);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/appointment-types?doctorId=${drA}`, headers: as(patient) });
    expect(res.json().data.map((t: { label: string; defaultPriceCents: number }) => [t.label, t.defaultPriceCents])).toEqual([
      ['Première consultation', 20000],
      ['Détartrage', 30000],
    ]);
  });

  it('réserver un soin d’un autre médecin → 422 TYPE_NOT_OFFERED (réservation et walk-in)', async () => {
    const typeOfB = (await createType(doctorB, {})).json().id;
    const [slot] = await seedSlots(ctx.c.pool, drA, tomorrowAt10(), 1);
    const patient = await registerPatient(ctx.app);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/appointments', headers: as(patient), payload: { slotId: slot, appointmentTypeId: typeOfB, idempotencyKey: randomUUID() } });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('TYPE_NOT_OFFERED');

    const [patientId] = await seedPatients(ctx.c.pool, 1);
    const walkIn = await ctx.app.inject({ method: 'POST', url: '/api/v1/walk-ins', headers: as(admin), payload: { patientId, doctorId: drA, appointmentTypeId: typeOfB } });
    expect(walkIn.json().code).toBe('TYPE_NOT_OFFERED');
  });

  it('admin : soin pour un médecin inexistant → 422 ; secrétaire et patient → 403', async () => {
    expect((await createType(admin, { doctorId: randomUUID() })).json().code).toBe('DOCTOR_NOT_FOUND');
    expect((await createType(await staffSession(ctx, 'secretary'), {})).statusCode).toBe(403);
    expect((await createType(await registerPatient(ctx.app), {})).statusCode).toBe(403);
  });
});

describe('rendez-vous de contrôle fixé par le médecin', () => {
  async function completedVisit(patientId: string): Promise<string> {
    const typeId = await seedAppointmentType(ctx.c.pool);
    const { rows } = await ctx.c.pool.query(
      `INSERT INTO appointments (doctor_id, patient_id, appointment_type_id, starts_at, ends_at, source, idempotency_key,
                                 status, checked_in_at, consultation_started_at, completed_at)
       VALUES ($1, $2, $3, now() - interval '2 hours', now() - interval '100 minutes', 'desk', gen_random_uuid(),
               'completed', now() - interval '2 hours', now() - interval '2 hours', now() - interval '100 minutes')
       RETURNING id`,
      [drA, patientId, typeId],
    );
    return rows[0].id;
  }

  it('le médecin fixe le prochain RDV, rattaché à la visite d’origine ; le patient le voit', async () => {
    const patient = await registerPatient(ctx.app);
    const visit = await completedVisit(patient.user.patientId!);
    const typeId = await seedAppointmentType(ctx.c.pool);
    const [slot] = await seedSlots(ctx.c.pool, drA, new Date(Date.now() + 14 * 86_400_000), 1);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: as(doctorA),
      payload: { slotId: slot, appointmentTypeId: typeId, idempotencyKey: randomUUID(), patientId: patient.user.patientId, followUpOfId: visit },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ followUpOfId: visit, source: 'desk' });

    const mine = await ctx.app.inject({ method: 'GET', url: '/api/v1/appointments/me', headers: as(patient) });
    expect(mine.json().data[0].followUpOfId).toBe(visit);
  });

  it('contrôle rattaché à la visite d’un AUTRE patient, ou à une visite non réalisée → 422', async () => {
    const [p1, p2] = await seedPatients(ctx.c.pool, 2);
    const visitOfP1 = await completedVisit(p1!);
    const typeId = await seedAppointmentType(ctx.c.pool);
    const slotsA = await seedSlots(ctx.c.pool, drA, new Date(Date.now() + 14 * 86_400_000), 2);
    const followUp = (patientId: string, followUpOfId: string, slotId: string) =>
      ctx.app.inject({ method: 'POST', url: '/api/v1/appointments', headers: as(admin), payload: { slotId, appointmentTypeId: typeId, idempotencyKey: randomUUID(), patientId, followUpOfId } });

    expect((await followUp(p2!, visitOfP1, slotsA[0]!)).json().code).toBe('INVALID_FOLLOW_UP');
    const scheduled = (await followUp(p1!, visitOfP1, slotsA[0]!)).json().id; // contrôle valide
    expect((await followUp(p1!, scheduled, slotsA[1]!)).json().code).toBe('INVALID_FOLLOW_UP'); // pas encore réalisé
  });
});
