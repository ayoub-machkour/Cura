/**
 * Réservation : concurrence RÉELLE contre PostgreSQL + Redis, et parcours HTTP complets.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SlotUnavailableError } from '../../src/modules/booking/booking.errors';
import {
  as,
  createTestContext,
  registerPatient,
  resetState,
  seedAppointmentType,
  seedDoctor,
  seedPatients,
  seedSlots,
  staffSession,
  type TestContext,
  tomorrowAt10,
} from './helpers';

let ctx: TestContext;
let doctorId: string;
let typeId: string;
let slotIds: string[];

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await resetState(ctx);
  doctorId = await seedDoctor(ctx.c.pool);
  typeId = await seedAppointmentType(ctx.c.pool);
  slotIds = await seedSlots(ctx.c.pool, doctorId, tomorrowAt10(), 6); // 10:00 → 12:00
});

describe('concurrence', () => {
  it('50 patients réservent le même créneau au même instant → exactement 1 gagnant', async () => {
    const patients = await seedPatients(ctx.c.pool, 50);
    const target = slotIds[2]!;

    const results = await Promise.allSettled(
      patients.map((patientId) =>
        ctx.c.services.booking.book({ patientId, slotId: target, appointmentTypeId: typeId, idempotencyKey: randomUUID(), source: 'mobile' }),
      ),
    );

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(49);

    for (const r of lost) {
      expect(r.reason).toBeInstanceOf(SlotUnavailableError);
      const err = r.reason as SlotUnavailableError;
      expect(['ALREADY_BOOKED', 'LOCK_CONTENTION']).toContain(err.reason);
      expect(err.alternatives.length).toBeGreaterThan(0);
      expect(err.alternatives.map((a) => a.id)).not.toContain(target);
    }
    // Les alternatives sont les plus proches du créneau demandé (10:40) : 10:20 et 11:00.
    const first = (lost[0]!.reason as SlotUnavailableError).alternatives.slice(0, 2).map((a) => a.id).sort();
    expect(first).toEqual([slotIds[1], slotIds[3]].sort());

    const { rows } = await ctx.c.pool.query(`SELECT count(*)::int AS n FROM appointments WHERE slot_id = $1`, [target]);
    expect(rows[0].n).toBe(1);
  });

  it('10 envois simultanés de la MÊME requête (retry réseau) → 1 seul RDV, les autres sont des rejeux', async () => {
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ctx.c.services.booking.book({ patientId: patientId!, slotId: slotIds[0]!, appointmentTypeId: typeId, idempotencyKey: key, source: 'mobile' }),
      ),
    );
    expect(new Set(results.map((r) => r.appointment.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });

  it('les contraintes SQL bloquent une double réservation même en contournant le service', async () => {
    const [p1, p2] = await seedPatients(ctx.c.pool, 2);
    const insert = (patientId: string, slotId: string | null) =>
      ctx.c.pool.query(
        `INSERT INTO appointments (doctor_id, patient_id, appointment_type_id, slot_id, starts_at, ends_at, source, idempotency_key)
         SELECT doctor_id, $1, $2, $3, starts_at, ends_at, 'desk', gen_random_uuid() FROM slots WHERE id = $4`,
        [patientId, typeId, slotId, slotIds[0]],
      );
    await insert(p1!, slotIds[0]!);
    // Même créneau : rejeté par l'exclusion (chevauchement) ou l'index unique, selon celle évaluée en premier.
    await expect(insert(p2!, slotIds[0]!)).rejects.toMatchObject({ code: expect.stringMatching(/^(23505|23P01)$/) });
    await expect(insert(p2!, null)).rejects.toMatchObject({ code: '23P01' }); // walk-in qui chevauche
  });

  it('un patient ne peut pas avoir deux RDV qui se chevauchent (médecins différents)', async () => {
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    const otherDoctor = await seedDoctor(ctx.c.pool);
    const [otherSlot] = await seedSlots(ctx.c.pool, otherDoctor, tomorrowAt10(), 1);
    const book = (slotId: string) =>
      ctx.c.services.booking.book({ patientId: patientId!, slotId, appointmentTypeId: typeId, idempotencyKey: randomUUID(), source: 'desk' });

    await book(slotIds[0]!);
    await expect(book(otherSlot!)).rejects.toMatchObject({ code: 'PATIENT_TIME_CONFLICT' });
  });
});

describe('parcours HTTP patient', () => {
  it('réserve, voit son RDV, annule — le créneau redevient disponible', async () => {
    const patient = await registerPatient(ctx.app);
    const book = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: as(patient),
      payload: { slotId: slotIds[0], appointmentTypeId: typeId, idempotencyKey: randomUUID(), note: 'Douleur < 3 jours' },
    });
    expect(book.statusCode).toBe(201);
    const appointment = book.json();
    expect(appointment).toMatchObject({ patientId: patient.user.patientId, status: 'scheduled', source: 'mobile' });

    const mine = await ctx.app.inject({ method: 'GET', url: '/api/v1/appointments/me', headers: as(patient) });
    expect(mine.json().data.map((a: { id: string }) => a.id)).toEqual([appointment.id]);

    const cancel = await ctx.app.inject({ method: 'POST', url: `/api/v1/appointments/${appointment.id}/cancel`, headers: as(patient), payload: { reason: 'Empêchement' } });
    expect(cancel.json().status).toBe('cancelled');

    const other = await registerPatient(ctx.app);
    const rebook = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: as(other),
      payload: { slotId: slotIds[0], appointmentTypeId: typeId, idempotencyKey: randomUUID() },
    });
    expect(rebook.statusCode).toBe(201);
  });

  it('409 + alternatives quand le créneau est déjà pris', async () => {
    const a = await registerPatient(ctx.app);
    const b = await registerPatient(ctx.app);
    const payload = () => ({ slotId: slotIds[1], appointmentTypeId: typeId, idempotencyKey: randomUUID() });
    await ctx.app.inject({ method: 'POST', url: '/api/v1/appointments', headers: as(a), payload: payload() });

    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/appointments', headers: as(b), payload: payload() });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body).toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'ALREADY_BOOKED' });
    expect(body.alternatives.length).toBe(3);
  });

  it('pré-réservation Redis : un autre patient est refusé (HELD_BY_OTHER), le détenteur réserve', async () => {
    const holder = await registerPatient(ctx.app);
    const other = await registerPatient(ctx.app);

    const hold = await ctx.app.inject({ method: 'POST', url: `/api/v1/slots/${slotIds[3]}/hold`, headers: as(holder), payload: { appointmentTypeId: typeId } });
    expect(hold.statusCode).toBe(200);
    const { holdToken } = hold.json();

    const blocked = await ctx.app.inject({ method: 'POST', url: `/api/v1/slots/${slotIds[3]}/hold`, headers: as(other), payload: { appointmentTypeId: typeId } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().reason).toBe('HELD_BY_OTHER');

    const stolen = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: as(other),
      payload: { slotId: slotIds[3], appointmentTypeId: typeId, idempotencyKey: randomUUID() },
    });
    expect(stolen.statusCode).toBe(409);

    const booked = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: as(holder),
      payload: { slotId: slotIds[3], appointmentTypeId: typeId, idempotencyKey: randomUUID(), holdToken },
    });
    expect(booked.statusCode).toBe(201);
  });

  it('un patient ne peut pas annuler le RDV d’un autre (404, existence non révélée)', async () => {
    const a = await registerPatient(ctx.app);
    const b = await registerPatient(ctx.app);
    const booked = await ctx.app.inject({ method: 'POST', url: '/api/v1/appointments', headers: as(a), payload: { slotId: slotIds[0], appointmentTypeId: typeId, idempotencyKey: randomUUID() } });
    const res = await ctx.app.inject({ method: 'POST', url: `/api/v1/appointments/${booked.json().id}/cancel`, headers: as(b), payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('un patient ne peut pas réserver pour quelqu’un d’autre', async () => {
    const a = await registerPatient(ctx.app);
    const [victim] = await seedPatients(ctx.c.pool, 1);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/appointments', headers: as(a), payload: { slotId: slotIds[0], appointmentTypeId: typeId, idempotencyKey: randomUUID(), patientId: victim } });
    expect(res.statusCode).toBe(403);
  });
});

describe('créneaux et agenda (cabinet)', () => {
  it('génère des créneaux dans le fuseau du médecin, de façon idempotente', async () => {
    const admin = await staffSession(ctx, 'admin');
    const doctor = await seedDoctor(ctx.c.pool, 'Europe/Paris');
    // Du lundi 4 au dimanche 10 janvier 2027 : 5 jours ouvrés.
    const payload = { from: '2027-01-04', to: '2027-01-10', weekdays: [1, 2, 3, 4, 5], dayStart: '09:00', dayEnd: '12:00', slotMinutes: 30 };

    const first = await ctx.app.inject({ method: 'POST', url: `/api/v1/doctors/${doctor}/slots/generate`, headers: as(admin), payload });
    expect(first.statusCode).toBe(201);
    expect(first.json().created).toBe(5 * 6); // 5 jours × 6 créneaux de 30 min

    const again = await ctx.app.inject({ method: 'POST', url: `/api/v1/doctors/${doctor}/slots/generate`, headers: as(admin), payload });
    expect(again.json().created).toBe(0);

    // 09:00 à Paris en hiver (UTC+1) = 08:00 UTC.
    const { rows } = await ctx.c.pool.query(`SELECT min(starts_at) AS first FROM slots WHERE doctor_id = $1`, [doctor]);
    expect((rows[0].first as Date).toISOString()).toBe('2027-01-04T08:00:00.000Z');
  });

  it('les créneaux réservés disparaissent de la liste des disponibilités (paginée)', async () => {
    const patient = await registerPatient(ctx.app);
    await ctx.app.inject({ method: 'POST', url: '/api/v1/appointments', headers: as(patient), payload: { slotId: slotIds[0], appointmentTypeId: typeId, idempotencyKey: randomUUID() } });

    const from = new Date(Date.now()).toISOString();
    const to = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const page1 = await ctx.app.inject({ method: 'GET', url: `/api/v1/doctors/${doctorId}/slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=3`, headers: as(patient) });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.data).toHaveLength(3);
    expect(body1.data.map((s: { id: string }) => s.id)).not.toContain(slotIds[0]);

    const page2 = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/doctors/${doctorId}/slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=3&cursor=${body1.page.nextCursor}`,
      headers: as(patient),
    });
    expect(page2.json().data).toHaveLength(2);
    expect(page2.json().page.hasMore).toBe(false);
  });

  it('le secrétariat consulte l’agenda et réserve pour un patient', async () => {
    const secretary = await staffSession(ctx, 'secretary');
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    const book = await ctx.app.inject({ method: 'POST', url: '/api/v1/appointments', headers: as(secretary), payload: { slotId: slotIds[4], appointmentTypeId: typeId, idempotencyKey: randomUUID(), patientId } });
    expect(book.statusCode).toBe(201);
    expect(book.json().source).toBe('desk');

    const from = new Date().toISOString();
    const to = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const agenda = await ctx.app.inject({ method: 'GET', url: `/api/v1/appointments?doctorId=${doctorId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, headers: as(secretary) });
    expect(agenda.statusCode).toBe(200);
    expect(agenda.json().data).toHaveLength(1);
  });

  it('chaque réservation écrit un événement dans l’outbox (même transaction)', async () => {
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    await ctx.c.services.booking.book({ patientId: patientId!, slotId: slotIds[5]!, appointmentTypeId: typeId, idempotencyKey: randomUUID(), source: 'desk' });
    const { rows } = await ctx.c.pool.query(`SELECT event_type FROM outbox_events`);
    expect(rows.map((r) => r.event_type)).toEqual(['appointment.booked']);
  });
});
