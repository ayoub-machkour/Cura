/**
 * Toutes les règles métier de la réservation, des créneaux et de l'annulation, via HTTP.
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
let patient: Session;
let secretary: Session;
const UNKNOWN = '3f1c2a6e-8b4d-4c1a-9e2f-1a2b3c4d5e6f';

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await resetState(ctx);
  doctorId = await seedDoctor(ctx.c.pool);
  typeId = await seedAppointmentType(ctx.c.pool, 20);
  slots = await seedSlots(ctx.c.pool, doctorId, tomorrowAt10(), 6);
  [patient, secretary] = await Promise.all([registerPatient(ctx.app), staffSession(ctx, 'secretary')]);
});

const book = (s: Session, body: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/appointments',
    headers: as(s),
    payload: { appointmentTypeId: typeId, idempotencyKey: randomUUID(), ...body },
  });
const cancel = (s: Session, id: string, payload: object = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1/appointments/${id}/cancel`, headers: as(s), payload });
const get = (s: Session, url: string) => ctx.app.inject({ method: 'GET', url, headers: as(s) });
const sql = (text: string, params: unknown[] = []) => ctx.c.pool.query(text, params);

/** Créneau unique à `minutesFromNow` (négatif = passé), arrondi à la minute. */
async function slotAt(minutesFromNow: number, online = true): Promise<string> {
  const start = new Date(Math.floor((Date.now() + minutesFromNow * 60_000) / 60_000) * 60_000);
  const { rows } = await sql(
    `INSERT INTO slots (doctor_id, starts_at, ends_at, online_bookable) VALUES ($1, $2, $2::timestamptz + interval '20 minutes', $3) RETURNING id`,
    [doctorId, start, online],
  );
  return rows[0].id;
}

describe('POST /appointments — règles métier', () => {
  it('404 : créneau inconnu, motif inconnu, motif désactivé', async () => {
    expect((await book(patient, { slotId: UNKNOWN })).statusCode).toBe(404);
    expect((await book(patient, { slotId: slots[0], appointmentTypeId: UNKNOWN })).statusCode).toBe(404);
    await sql(`UPDATE appointment_types SET is_active = false WHERE id = $1`, [typeId]);
    expect((await book(patient, { slotId: slots[0] })).statusCode).toBe(404);
  });

  it('409 BLOCKED : créneau fermé par le cabinet (et exclu des alternatives)', async () => {
    await sql(`UPDATE slots SET status = 'blocked' WHERE id = ANY($1)`, [[slots[0], slots[1]]]);
    const res = await book(patient, { slotId: slots[0] });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('BLOCKED');
    expect(res.json().alternatives.map((a: { id: string }) => a.id)).not.toContain(slots[1]);
  });

  it('créneau réservé au cabinet : refusé au patient (409), accepté au secrétariat (201)', async () => {
    const deskOnly = await slotAt(26 * 60, false);
    const res = await book(patient, { slotId: deskOnly });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('NOT_ONLINE_BOOKABLE');
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    expect((await book(secretary, { slotId: deskOnly, patientId })).statusCode).toBe(201);
  });

  it('motif non réservable en ligne : 422 pour le patient, 201 pour le secrétariat', async () => {
    await sql(`UPDATE appointment_types SET bookable_online = false WHERE id = $1`, [typeId]);
    const res = await book(patient, { slotId: slots[0] });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('TYPE_NOT_BOOKABLE_ONLINE');
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    expect((await book(secretary, { slotId: slots[0], patientId })).statusCode).toBe(201);
  });

  it('422 TYPE_TOO_LONG : motif de 60 min sur un créneau de 20 min', async () => {
    const longType = await seedAppointmentType(ctx.c.pool, 60);
    const res = await book(patient, { slotId: slots[0], appointmentTypeId: longType });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('TYPE_TOO_LONG');
  });

  it('délai de prévenance : créneau dans 30 min refusé au patient (TOO_LATE), accepté au secrétariat', async () => {
    const soon = await slotAt(30);
    const res = await book(patient, { slotId: soon });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('TOO_LATE');
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    expect((await book(secretary, { slotId: soon, patientId })).statusCode).toBe(201);
  });

  it('créneau passé : refusé à tous (TOO_LATE)', async () => {
    const past = await slotAt(-120);
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    const res = await book(secretary, { slotId: past, patientId });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('TOO_LATE');
  });

  it('422 PATIENT_REQUIRED : le secrétariat doit préciser le patient', async () => {
    const res = await book(secretary, { slotId: slots[0] });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('PATIENT_REQUIRED');
  });

  it('idempotence via HTTP : même clé → 201 puis 200 avec le même RDV', async () => {
    const key = randomUUID();
    const first = await book(patient, { slotId: slots[0], idempotencyKey: key });
    const replay = await book(patient, { slotId: slots[0], idempotencyKey: key });
    expect([first.statusCode, replay.statusCode]).toEqual([201, 200]);
    expect(replay.json().id).toBe(first.json().id);
  });

  it('409 PATIENT_TIME_CONFLICT : même patient, même heure, autre médecin', async () => {
    await book(patient, { slotId: slots[0] });
    const otherDoctor = await seedDoctor(ctx.c.pool);
    const [otherSlot] = await seedSlots(ctx.c.pool, otherDoctor, tomorrowAt10(), 1);
    const res = await book(patient, { slotId: otherSlot });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PATIENT_TIME_CONFLICT');
  });

  it('400 : note contenant du HTML, champ manquant, UUID invalide', async () => {
    expect((await book(patient, { slotId: slots[0], note: '<script>x</script>' })).statusCode).toBe(400);
    expect((await book(patient, { slotId: slots[0], idempotencyKey: undefined })).statusCode).toBe(400);
    expect((await book(patient, { slotId: 'abc' })).statusCode).toBe(400);
  });

  it('401 sans session', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/appointments', payload: { slotId: slots[0], appointmentTypeId: typeId, idempotencyKey: randomUUID() } });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /appointments/:id/cancel', () => {
  it('le secrétariat annule le RDV d’un patient ; une 2e annulation → 422', async () => {
    const id = (await book(patient, { slotId: slots[0] })).json().id;
    const res = await cancel(secretary, id, { reason: 'Médecin absent' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');
    const again = await cancel(secretary, id);
    expect(again.statusCode).toBe(422);
    expect(again.json().code).toBe('NOT_CANCELLABLE');
  });

  it('un patient ne peut pas annuler un RDV passé (422)', async () => {
    const past = await slotAt(-120);
    const { rows } = await sql(
      `INSERT INTO appointments (doctor_id, patient_id, appointment_type_id, slot_id, starts_at, ends_at, source, idempotency_key)
       SELECT doctor_id, $1, $2, id, starts_at, ends_at, 'desk', gen_random_uuid() FROM slots WHERE id = $3 RETURNING id`,
      [patient.user.patientId, typeId, past],
    );
    const res = await cancel(patient, rows[0].id);
    expect(res.statusCode).toBe(422);
  });

  it('404 sur un RDV inconnu, 400 sur un motif contenant du HTML', async () => {
    expect((await cancel(patient, UNKNOWN)).statusCode).toBe(404);
    const id = (await book(patient, { slotId: slots[0] })).json().id;
    expect((await cancel(patient, id, { reason: '<img src=x>' })).statusCode).toBe(400);
  });

  it('l’annulation écrit un événement dans l’outbox', async () => {
    const id = (await book(patient, { slotId: slots[0] })).json().id;
    await cancel(patient, id);
    const { rows } = await sql(`SELECT event_type FROM outbox_events ORDER BY id`);
    expect(rows.map((r) => r.event_type)).toEqual(['appointment.booked', 'appointment.cancelled']);
  });
});

describe('GET /appointments/me et /appointments (agenda)', () => {
  it('scope=past ne renvoie que les RDV passés, scope=upcoming les autres', async () => {
    await book(patient, { slotId: slots[0] });
    const past = await slotAt(-24 * 60);
    await sql(
      `INSERT INTO appointments (doctor_id, patient_id, appointment_type_id, slot_id, starts_at, ends_at, source, idempotency_key, status,
                                checked_in_at, consultation_started_at, completed_at)
       SELECT doctor_id, $1, $2, id, starts_at, ends_at, 'desk', gen_random_uuid(), 'completed',
              starts_at - interval '5 minutes', starts_at, ends_at
         FROM slots WHERE id = $3`,
      [patient.user.patientId, typeId, past],
    );
    const upcoming = (await get(patient, '/api/v1/appointments/me')).json().data;
    const history = (await get(patient, '/api/v1/appointments/me?scope=past')).json().data;
    expect(upcoming.map((a: { slotId: string }) => a.slotId)).toEqual([slots[0]]);
    expect(history.map((a: { status: string }) => a.status)).toEqual(['completed']);
  });

  it('RBAC : le personnel n’a pas de « mes RDV », le patient n’a pas accès à l’agenda', async () => {
    expect((await get(secretary, '/api/v1/appointments/me')).statusCode).toBe(403);
    const range = `from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 86_400_000 * 3).toISOString())}`;
    expect((await get(patient, `/api/v1/appointments?doctorId=${doctorId}&${range}`)).statusCode).toBe(403);
  });

  it('agenda : 400 sans doctorId ou avec une période inversée ; pagination', async () => {
    const now = Date.now();
    const iso = (t: number) => encodeURIComponent(new Date(t).toISOString());
    expect((await get(secretary, `/api/v1/appointments?from=${iso(now)}&to=${iso(now + 1e8)}`)).statusCode).toBe(400);
    expect((await get(secretary, `/api/v1/appointments?doctorId=${doctorId}&from=${iso(now + 1e8)}&to=${iso(now)}`)).statusCode).toBe(400);

    const patients = await seedPatients(ctx.c.pool, 3);
    for (let i = 0; i < 3; i++) await book(secretary, { slotId: slots[i], patientId: patients[i] });
    const url = `/api/v1/appointments?doctorId=${doctorId}&from=${iso(now)}&to=${iso(now + 3 * 86_400_000)}&limit=2`;
    const p1 = (await get(secretary, url)).json();
    const p2 = (await get(secretary, `${url}&cursor=${p1.page.nextCursor}`)).json();
    expect(p1.data).toHaveLength(2);
    expect(p2.data).toHaveLength(1);
    expect(p2.page.hasMore).toBe(false);
  });
});

describe('POST /slots/:slotId/hold', () => {
  it('404 créneau inconnu, 403 pour le personnel, re-sélection par le même patient → même jeton', async () => {
    const hold = (s: Session, slotId: string) =>
      ctx.app.inject({ method: 'POST', url: `/api/v1/slots/${slotId}/hold`, headers: as(s), payload: { appointmentTypeId: typeId } });
    expect((await hold(patient, UNKNOWN)).statusCode).toBe(404);
    expect((await hold(secretary, slots[0]!)).statusCode).toBe(403);
    const first = await hold(patient, slots[0]!);
    const again = await hold(patient, slots[0]!);
    expect(again.statusCode).toBe(200);
    expect(again.json().holdToken).toBe(first.json().holdToken);
  });

  it('le secrétariat passe outre une pré-réservation mobile (patient au guichet)', async () => {
    await ctx.app.inject({ method: 'POST', url: `/api/v1/slots/${slots[0]}/hold`, headers: as(patient), payload: { appointmentTypeId: typeId } });
    const [patientId] = await seedPatients(ctx.c.pool, 1);
    expect((await book(secretary, { slotId: slots[0], patientId })).statusCode).toBe(201);
  });
});

describe('GET /doctors/:doctorId/slots', () => {
  const range = () => `from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3 * 86_400_000).toISOString())}`;
  const ids = async (s: Session, extra = '') =>
    (await get(s, `/api/v1/doctors/${doctorId}/slots?${range()}${extra}`)).json().data.map((x: { id: string }) => x.id);

  it('le patient ne voit ni les créneaux trop proches, ni ceux réservés au cabinet, ni les créneaux bloqués', async () => {
    const soon = await slotAt(30);
    const deskOnly = await slotAt(26 * 60, false);
    await sql(`UPDATE slots SET status = 'blocked' WHERE id = $1`, [slots[5]]);

    const forPatient = await ids(patient);
    expect(forPatient).not.toContain(soon);
    expect(forPatient).not.toContain(deskOnly);
    expect(forPatient).not.toContain(slots[5]);

    const forStaff = await ids(secretary);
    expect(forStaff).toEqual(expect.arrayContaining([soon, deskOnly]));
    expect(forStaff).not.toContain(slots[5]);
  });

  it('filtre par motif : un motif de 40 min exclut les créneaux de 20 min', async () => {
    const longType = await seedAppointmentType(ctx.c.pool, 40);
    expect(await ids(patient, `&appointmentTypeId=${longType}`)).toEqual([]);
    expect(await ids(patient, `&appointmentTypeId=${typeId}`)).toHaveLength(6);
  });

  it('404 médecin ou motif inconnu, 400 période inversée', async () => {
    expect((await get(patient, `/api/v1/doctors/${UNKNOWN}/slots?${range()}`)).statusCode).toBe(404);
    expect((await get(patient, `/api/v1/doctors/${doctorId}/slots?${range()}&appointmentTypeId=${UNKNOWN}`)).statusCode).toBe(404);
    const inverted = `from=${encodeURIComponent(new Date(Date.now() + 1e8).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`;
    expect((await get(patient, `/api/v1/doctors/${doctorId}/slots?${inverted}`)).statusCode).toBe(400);
  });
});

describe('POST /doctors/:doctorId/slots/generate', () => {
  const body = { from: '2027-01-04', to: '2027-01-05', weekdays: [1, 2], dayStart: '09:00', dayEnd: '10:00', slotMinutes: 20 };
  const generate = (s: Session, id: string, payload: object = body) =>
    ctx.app.inject({ method: 'POST', url: `/api/v1/doctors/${id}/slots/generate`, headers: as(s), payload });

  it('201 pour le secrétariat, 403 pour un patient, 404 médecin inconnu, 400 charge invalide', async () => {
    expect((await generate(secretary, doctorId)).json().created).toBe(6);
    expect((await generate(patient, doctorId)).statusCode).toBe(403);
    expect((await generate(secretary, UNKNOWN)).statusCode).toBe(404);
    expect((await generate(secretary, doctorId, { ...body, weekdays: [8] })).statusCode).toBe(400);
  });

  it('une plage non multiple de la durée ne déborde pas (09:00-10:00 par 25 min → 2 créneaux/jour)', async () => {
    const paris = await seedDoctor(ctx.c.pool, 'Europe/Paris');
    expect((await generate(secretary, paris, { ...body, slotMinutes: 25 })).json().created).toBe(4);
    const { rows } = await sql(`SELECT max(ends_at) AS last FROM slots WHERE doctor_id = $1`, [paris]);
    expect((rows[0].last as Date).toISOString()).toBe('2027-01-05T08:50:00.000Z'); // 09:50 à Paris (UTC+1 en hiver)
  });
});
