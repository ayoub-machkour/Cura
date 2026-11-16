/**
 * Parcours de visite et file d'attente, avec une horloge FIXE : les règles « le jour même »,
 * « pas avant l'heure » et le tri de la file sont testés de façon déterministe.
 * Médecin à Paris, mardi 15 janvier 2030 (UTC+1). Créneaux de 10:00 à 11:20 heure de Paris.
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

const DAY_START = new Date('2030-01-15T09:00:00Z'); // 10:00 à Paris
let current = new Date('2030-01-15T08:30:00Z'); // 09:30 à Paris
const clock: Clock = { now: () => current };
const at = (iso: string) => {
  current = new Date(iso);
};

let ctx: TestContext;
let doctorId: string;
let otherDoctorId: string;
let typeId: string;
let slots: string[];
let secretary: Session;
let doctor: Session;
let otherDoctor: Session;
let admin: Session;

beforeAll(async () => {
  ctx = await createTestContext({}, { clock });
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  at('2030-01-15T08:30:00Z');
  await resetState(ctx);
  doctorId = await seedDoctor(ctx.c.pool, 'Europe/Paris');
  otherDoctorId = await seedDoctor(ctx.c.pool, 'Europe/Paris');
  typeId = await seedAppointmentType(ctx.c.pool);
  slots = await seedSlots(ctx.c.pool, doctorId, DAY_START, 4);
  [secretary, doctor, otherDoctor, admin] = await Promise.all([
    staffSession(ctx, 'secretary'),
    staffSession(ctx, 'doctor', doctorId),
    staffSession(ctx, 'doctor', otherDoctorId),
    staffSession(ctx, 'admin'),
  ]);
});

/** Réserve (secrétariat) le créneau `i` pour un nouveau patient ; retourne l'id du RDV. */
async function bookSlot(i: number, patientId?: string): Promise<string> {
  const pid = patientId ?? (await seedPatients(ctx.c.pool, 1))[0]!;
  const res = await ctx.c.services.booking.book({
    patientId: pid,
    slotId: slots[i]!,
    appointmentTypeId: typeId,
    idempotencyKey: randomUUID(),
    source: 'desk',
  });
  return res.appointment.id;
}

const act = (s: Session, id: string, action: string, body?: object) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1/appointments/${id}/${action}`, headers: as(s), ...(body ? { payload: body } : {}) });
const queue = (s: Session, doctor = doctorId) => ctx.app.inject({ method: 'GET', url: `/api/v1/queue?doctorId=${doctor}`, headers: as(s) });

describe('parcours complet', () => {
  it('arrivée → consultation → fin, avec horodatages, versions et historique', async () => {
    const id = await bookSlot(0);

    at('2030-01-15T08:50:00Z');
    const checkedIn = await act(secretary, id, 'check-in');
    expect(checkedIn.statusCode).toBe(200);
    expect(checkedIn.json()).toMatchObject({ status: 'checked_in', version: 2, checkedInAt: '2030-01-15T08:50:00.000Z' });

    at('2030-01-15T09:05:00Z');
    const started = await act(doctor, id, 'start');
    expect(started.json()).toMatchObject({ status: 'in_consultation', version: 3, consultationStartedAt: '2030-01-15T09:05:00.000Z' });

    at('2030-01-15T09:25:00Z');
    const done = await act(doctor, id, 'complete');
    expect(done.json()).toMatchObject({ status: 'completed', version: 4, completedAt: '2030-01-15T09:25:00.000Z' });

    const { rows } = await ctx.c.pool.query(
      `SELECT from_status, to_status, actor_user_id FROM appointment_status_changes WHERE appointment_id = $1 ORDER BY id`,
      [id],
    );
    expect(rows.map((r) => [r.from_status, r.to_status])).toEqual([
      [null, 'scheduled'],
      ['scheduled', 'checked_in'],
      ['checked_in', 'in_consultation'],
      ['in_consultation', 'completed'],
    ]);
    expect(rows[1].actor_user_id).toBe(secretary.user.id);
    expect(rows[2].actor_user_id).toBe(doctor.user.id);

    const events = await ctx.c.pool.query(`SELECT event_type, payload->>'previousStatus' AS prev FROM outbox_events ORDER BY id`);
    expect(events.rows.map((e) => [e.event_type, e.prev])).toEqual([
      ['appointment.booked', null],
      ['appointment.status_changed', 'scheduled'],
      ['appointment.status_changed', 'checked_in'],
      ['appointment.status_changed', 'in_consultation'],
    ]);
  });

  it('le patient confirme son RDV ; il ne peut pas confirmer celui d’un autre (404)', async () => {
    const patient = await registerPatient(ctx.app);
    const own = await bookSlot(0, patient.user.patientId!);
    const other = await bookSlot(1);
    expect((await act(patient, own, 'confirm')).json().status).toBe('confirmed');
    expect((await act(patient, other, 'confirm')).statusCode).toBe(404);
  });

  it('absence : refusée avant l’heure (422), acceptée après', async () => {
    const id = await bookSlot(0);
    const early = await act(secretary, id, 'no-show');
    expect(early.statusCode).toBe(422);
    expect(early.json().code).toBe('TOO_EARLY');
    at('2030-01-15T09:15:00Z');
    expect((await act(secretary, id, 'no-show')).json().status).toBe('no_show');
  });
});

describe('règles et refus', () => {
  it('transition impossible → 409 INVALID_TRANSITION (ex. terminer sans avoir commencé)', async () => {
    const id = await bookSlot(0);
    const res = await act(doctor, id, 'complete');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('INVALID_TRANSITION');
  });

  it('arrivée enregistrée la veille → 422 NOT_TODAY', async () => {
    const id = await bookSlot(0);
    at('2030-01-14T16:00:00Z');
    const res = await act(secretary, id, 'check-in');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('NOT_TODAY');
  });

  it('verrouillage optimiste : expectedVersion périmée → 409 STALE_VERSION, à jour → 200', async () => {
    const id = await bookSlot(0);
    const stale = await act(secretary, id, 'check-in', { expectedVersion: 7 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('STALE_VERSION');
    expect((await act(secretary, id, 'check-in', { expectedVersion: 1 })).statusCode).toBe(200);
  });

  it('deux secrétaires enregistrent la même arrivée en même temps → une seule réussit', async () => {
    const id = await bookSlot(0);
    const [a, b] = await Promise.all([act(secretary, id, 'check-in'), act(admin, id, 'check-in')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  it('un médecin ne reçoit qu’un patient à la fois (409 DOCTOR_BUSY), même en concurrence', async () => {
    const [x, y, z] = [await bookSlot(0), await bookSlot(1), await bookSlot(2)];
    for (const id of [x, y, z]) await act(secretary, id, 'check-in');

    const results = await Promise.all([act(doctor, x, 'start'), act(doctor, y, 'start')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().code).toBe('DOCTOR_BUSY');

    const { rows } = await ctx.c.pool.query(`SELECT count(*)::int AS n FROM appointments WHERE status = 'in_consultation'`);
    expect(rows[0].n).toBe(1);
    expect((await act(doctor, z, 'start')).statusCode).toBe(409);
  });

  it('périmètre : un médecin n’agit pas sur l’agenda d’un confrère (404)', async () => {
    const id = await bookSlot(0);
    await act(secretary, id, 'check-in');
    expect((await act(otherDoctor, id, 'start')).statusCode).toBe(404);
  });

  it('rôles : le secrétariat ne démarre pas une consultation, le patient n’enregistre pas son arrivée', async () => {
    const patient = await registerPatient(ctx.app);
    const id = await bookSlot(0, patient.user.patientId!);
    expect((await act(patient, id, 'check-in')).statusCode).toBe(403);
    await act(secretary, id, 'check-in');
    expect((await act(secretary, id, 'start')).statusCode).toBe(403);
    expect((await act(admin, id, 'start')).statusCode).toBe(200);
  });

  it('400 sur une version invalide ou un id non-UUID ; 404 sur un RDV inconnu', async () => {
    const id = await bookSlot(0);
    expect((await act(secretary, id, 'check-in', { expectedVersion: 0 })).statusCode).toBe(400);
    expect((await act(secretary, 'abc', 'check-in')).statusCode).toBe(400);
    expect((await act(secretary, randomUUID(), 'check-in')).statusCode).toBe(404);
  });

  it('un RDV en salle d’attente ne peut plus être annulé', async () => {
    const id = await bookSlot(0);
    await act(secretary, id, 'check-in');
    const res = await ctx.app.inject({ method: 'POST', url: `/api/v1/appointments/${id}/cancel`, headers: as(secretary) });
    expect(res.statusCode).toBe(422);
  });
});

describe('GET /queue', () => {
  it('consultation en cours, salle d’attente par ordre d’arrivée, attendus par heure (retards signalés)', async () => {
    const [a, b, c, d] = [await bookSlot(0), await bookSlot(1), await bookSlot(2), await bookSlot(3)];
    // b arrive avant a, a est appelé, d n'est pas encore là.
    at('2030-01-15T08:40:00Z');
    await act(secretary, b, 'check-in');
    at('2030-01-15T08:45:00Z');
    await act(secretary, c, 'check-in');
    at('2030-01-15T08:50:00Z');
    await act(secretary, a, 'check-in');
    at('2030-01-15T09:00:00Z');
    await act(doctor, a, 'start');
    at('2030-01-15T10:10:00Z'); // 11:10 à Paris : le RDV de d (11:00) est en retard

    const res = await queue(secretary);
    expect(res.statusCode).toBe(200);
    const q = res.json();
    expect(q.date).toBe('2030-01-15');
    expect(q.inConsultation.appointmentId).toBe(a);
    expect(q.waiting.map((e: { appointmentId: string; position: number }) => [e.appointmentId, e.position])).toEqual([
      [b, 1],
      [c, 2],
    ]);
    expect(q.expected).toHaveLength(1);
    expect(q.expected[0]).toMatchObject({ appointmentId: d, isLate: true, position: null });
    expect(q.waiting[0].patientLastName).toBeTruthy(); // le secrétariat voit les noms
  });

  it('n’inclut ni les RDV d’un autre jour, ni les annulés, ni ceux d’un autre médecin', async () => {
    const today = await bookSlot(0);
    const cancelled = await bookSlot(1);
    await ctx.c.services.booking.cancel(cancelled, { sub: admin.user.id, role: 'admin', pid: null, did: null });
    const [tomorrowSlot] = await seedSlots(ctx.c.pool, doctorId, new Date('2030-01-16T09:00:00Z'), 1);
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    await ctx.c.services.booking.book({ patientId: patientId!, slotId: tomorrowSlot!, appointmentTypeId: typeId, idempotencyKey: randomUUID(), source: 'desk' });

    const q = (await queue(secretary)).json();
    expect(q.expected.map((e: { appointmentId: string }) => e.appointmentId)).toEqual([today]);
    expect((await queue(secretary, otherDoctorId)).json().expected).toEqual([]);
  });

  it('RBAC : un médecin ne voit que SA file, un patient n’y a pas accès, médecin inconnu → 404', async () => {
    expect((await queue(doctor)).statusCode).toBe(200);
    expect((await queue(otherDoctor)).statusCode).toBe(403);
    expect((await queue(await registerPatient(ctx.app))).statusCode).toBe(403);
    expect((await queue(secretary, randomUUID())).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/queue', headers: as(secretary) })).statusCode).toBe(400);
  });
});

describe('GET /appointments/:id/queue-position', () => {
  it('le patient connaît le nombre de patients avant lui', async () => {
    const patient = await registerPatient(ctx.app);
    const first = await bookSlot(0);
    const mine = await bookSlot(1, patient.user.patientId!);
    const position = () => ctx.app.inject({ method: 'GET', url: `/api/v1/appointments/${mine}/queue-position`, headers: as(patient) });

    expect((await position()).json()).toMatchObject({ status: 'scheduled', patientsAhead: null });
    at('2030-01-15T08:40:00Z');
    await act(secretary, first, 'check-in');
    at('2030-01-15T08:45:00Z');
    await act(secretary, mine, 'check-in');
    expect((await position()).json().patientsAhead).toBe(1);
    await act(doctor, first, 'start');
    expect((await position()).json().patientsAhead).toBe(0);
  });

  it('un patient ne voit pas la position d’un autre (404)', async () => {
    const patient = await registerPatient(ctx.app);
    const other = await bookSlot(0);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/appointments/${other}/queue-position`, headers: as(patient) });
    expect(res.statusCode).toBe(404);
  });
});

describe('invariants en base (migration 0003)', () => {
  const insert = (status: string, extra: string) =>
    ctx.c.pool.query(
      `INSERT INTO appointments (doctor_id, patient_id, appointment_type_id, starts_at, ends_at, source, idempotency_key, status ${extra ? ',' + extra.split('=')[0] : ''})
       SELECT $1, p.id, $2, '2031-01-01 10:00Z', '2031-01-01 10:20Z', 'desk', gen_random_uuid(), $3::appointment_status ${extra ? ',' + extra.split('=')[1] : ''}
         FROM patients p LIMIT 1`,
      [doctorId, typeId, status],
    );

  it('refuse un statut sans l’horodatage qui le justifie', async () => {
    await seedPatients(ctx.c.pool, 1);
    await expect(insert('completed', '')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('no_show', '')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('in_consultation', `checked_in_at='2031-01-01 09:55Z'`)).rejects.toMatchObject({ code: '23514' });
  });

  it('refuse une chronologie impossible (consultation avant l’arrivée)', async () => {
    const id = await bookSlot(0);
    await expect(
      ctx.c.pool.query(
        `UPDATE appointments SET status = 'in_consultation', checked_in_at = '2030-01-15 09:00Z', consultation_started_at = '2030-01-15 08:00Z' WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ck_appointments_chronology' });
  });

  it('l’historique des statuts est en ajout seul', async () => {
    await bookSlot(0);
    await expect(ctx.c.pool.query(`UPDATE appointment_status_changes SET to_status = 'completed'`)).rejects.toMatchObject({ code: '23514' });
    await expect(ctx.c.pool.query(`DELETE FROM appointment_status_changes`)).rejects.toMatchObject({ code: '23514' });
  });
});
