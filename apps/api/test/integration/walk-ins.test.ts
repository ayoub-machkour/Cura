/**
 * Patients sans rendez-vous (walk-in), avec horloge fixe.
 * Médecin à Paris, mardi 15 janvier 2030 (UTC+1).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '../../src/common/clock';
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
} from './helpers';

let current = new Date('2030-01-15T09:00:00Z'); // 10:00 à Paris
const clock: Clock = { now: () => current };
const at = (iso: string) => {
  current = new Date(iso);
};

let ctx: TestContext;
let doctorId: string;
let typeId: string;
let secretary: Session;
let doctor: Session;

beforeAll(async () => {
  ctx = await createTestContext({}, { clock });
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  at('2030-01-15T09:00:00Z');
  await resetState(ctx);
  doctorId = await seedDoctor(ctx.c.pool, 'Europe/Paris');
  typeId = await seedAppointmentType(ctx.c.pool, 20);
  [secretary, doctor] = await Promise.all([staffSession(ctx, 'secretary'), staffSession(ctx, 'doctor', doctorId)]);
});

const walkIn = (s: Session, body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/walk-ins', headers: as(s), payload: { doctorId, appointmentTypeId: typeId, ...body } });
const queue = () => ctx.app.inject({ method: 'GET', url: `/api/v1/queue?doctorId=${doctorId}`, headers: as(secretary) });

describe('POST /walk-ins', () => {
  it('le patient entre directement en salle d’attente, sans créneau', async () => {
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    const res = await walkIn(secretary, { patientId, note: 'Fièvre depuis hier' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'checked_in', slotId: null, checkedInAt: '2030-01-15T09:00:00.000Z', source: 'desk' });

    const q = (await queue()).json();
    expect(q.waiting).toHaveLength(1);
    expect(q.waiting[0]).toMatchObject({ patientId, isWalkIn: true, position: 1 });

    const history = await ctx.c.pool.query(`SELECT from_status, to_status FROM appointment_status_changes`);
    expect(history.rows).toEqual([{ from_status: null, to_status: 'checked_in' }]);
  });

  it('pratique du cabinet : RDV arrivés à l’heure d’abord, walk-ins dans les trous, arrivés en avance ensuite', async () => {
    // RDV à 10:00 et à 11:00 (heure de Paris).
    const [slotDue, slotLater] = [
      ...(await seedSlots(ctx.c.pool, doctorId, new Date('2030-01-15T09:00:00Z'), 1)),
      ...(await seedSlots(ctx.c.pool, doctorId, new Date('2030-01-15T10:00:00Z'), 1)),
    ];
    const [due, early, walker] = await seedPatients(ctx.c.pool, 3);
    at('2030-01-15T07:00:00Z'); // réservés à l'avance
    const bookedDue = await ctx.c.services.booking.book({ patientId: due!, slotId: slotDue!, appointmentTypeId: typeId, idempotencyKey: randomUUID(), source: 'desk' });
    const bookedEarly = await ctx.c.services.booking.book({ patientId: early!, slotId: slotLater!, appointmentTypeId: typeId, idempotencyKey: randomUUID(), source: 'desk' });

    // Ordre d'ARRIVÉE : RDV de 11:00 (très en avance), puis le walk-in, puis le RDV de 10:00.
    at('2030-01-15T08:40:00Z');
    await ctx.app.inject({ method: 'POST', url: `/api/v1/appointments/${bookedEarly.appointment.id}/check-in`, headers: as(secretary) });
    at('2030-01-15T08:50:00Z');
    await walkIn(secretary, { patientId: walker });
    at('2030-01-15T08:58:00Z');
    await ctx.app.inject({ method: 'POST', url: `/api/v1/appointments/${bookedDue.appointment.id}/check-in`, headers: as(secretary) });

    at('2030-01-15T09:05:00Z'); // 10:05 à Paris : le RDV de 10:00 est dû, celui de 11:00 pas encore
    const waiting = (await queue()).json().waiting;
    expect(waiting.map((e: { patientId: string; group: string; position: number }) => [e.patientId, e.group, e.position])).toEqual([
      [due, 'due', 1],
      [walker, 'walk_in', 2],
      [early, 'early', 3],
    ]);

    // À 11:05, le patient de 11:00 devient prioritaire sur le walk-in.
    at('2030-01-15T10:05:00Z');
    const later = (await queue()).json().waiting;
    expect(later.map((e: { patientId: string; group: string }) => [e.patientId, e.group])).toEqual([
      [due, 'due'],
      [early, 'due'],
      [walker, 'walk_in'],
    ]);
  });

  it('n’occupe pas l’agenda : un walk-in arrivé à 10:00 (20 min) ne bloque pas le créneau de 10:10', async () => {
    const [slot] = await seedSlots(ctx.c.pool, doctorId, new Date('2030-01-15T09:10:00Z'), 1);
    const [a, b] = await seedPatients(ctx.c.pool, 2);
    expect((await walkIn(secretary, { patientId: a })).statusCode).toBe(201);
    const booked = await ctx.c.services.booking.book({ patientId: b!, slotId: slot!, appointmentTypeId: typeId, idempotencyKey: randomUUID(), source: 'desk' });
    expect(booked.appointment.status).toBe('scheduled');
  });

  it('un patient n’est qu’une fois en file : double clic simultané → 201 + 409', async () => {
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    const results = await Promise.all([walkIn(secretary, { patientId }), walkIn(secretary, { patientId })]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().code).toBe('PATIENT_ALREADY_IN_QUEUE');
  });

  it('un patient déjà arrivé pour son RDV ne peut pas être ajouté en walk-in', async () => {
    const [slot] = await seedSlots(ctx.c.pool, doctorId, new Date('2030-01-15T09:00:00Z'), 1);
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    at('2030-01-15T08:00:00Z');
    const booked = await ctx.c.services.booking.book({ patientId: patientId!, slotId: slot!, appointmentTypeId: typeId, idempotencyKey: randomUUID(), source: 'desk' });
    at('2030-01-15T08:55:00Z');
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/appointments/${booked.appointment.id}/check-in`, headers: as(secretary) })).statusCode).toBe(200);
    const res = await walkIn(secretary, { patientId });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PATIENT_ALREADY_IN_QUEUE');
  });

  it('parcours complet du walk-in, puis nouvelle visite possible', async () => {
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    const id = (await walkIn(secretary, { patientId })).json().id;
    for (const action of ['start', 'complete']) {
      const res = await ctx.app.inject({ method: 'POST', url: `/api/v1/appointments/${id}/${action}`, headers: as(doctor) });
      expect(res.statusCode).toBe(200);
    }
    at('2030-01-15T14:00:00Z'); // revient l'après-midi
    expect((await walkIn(secretary, { patientId })).statusCode).toBe(201);
  });

  it('patient reparti avant d’être reçu : le secrétariat clôture, il peut revenir plus tard', async () => {
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    const id = (await walkIn(secretary, { patientId })).json().id;
    const cancel = await ctx.app.inject({ method: 'POST', url: `/api/v1/appointments/${id}/cancel`, headers: as(secretary), payload: { reason: 'Reparti' } });
    expect(cancel.json().status).toBe('cancelled');
    expect((await queue()).json().waiting).toEqual([]);
    expect((await walkIn(secretary, { patientId })).statusCode).toBe(201);
  });

  it('404 : patient, médecin ou motif inconnu ; motif désactivé', async () => {
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    expect((await walkIn(secretary, { patientId: randomUUID() })).statusCode).toBe(404);
    expect((await walkIn(secretary, { patientId, doctorId: randomUUID() })).statusCode).toBe(404);
    expect((await walkIn(secretary, { patientId, appointmentTypeId: randomUUID() })).statusCode).toBe(404);
    await ctx.c.pool.query(`UPDATE appointment_types SET is_active = false`);
    expect((await walkIn(secretary, { patientId })).statusCode).toBe(404);
  });

  it('rôles : le médecin dans SA file uniquement, le patient jamais', async () => {
    const [p1, p2] = await seedPatients(ctx.c.pool, 2);
    expect((await walkIn(doctor, { patientId: p1 })).statusCode).toBe(201);
    const otherDoctor = await seedDoctor(ctx.c.pool, 'Europe/Paris');
    expect((await walkIn(doctor, { patientId: p2, doctorId: otherDoctor })).statusCode).toBe(403);
    expect((await walkIn(await registerPatient(ctx.app), { patientId: p2 })).statusCode).toBe(403);
  });

  it('400 : note contenant du HTML, champs manquants', async () => {
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    expect((await walkIn(secretary, { patientId, note: '<script>x</script>' })).statusCode).toBe(400);
    expect((await walkIn(secretary, {})).statusCode).toBe(400);
  });
});
