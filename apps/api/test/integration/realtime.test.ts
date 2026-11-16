/**
 * Temps réel de bout en bout : vrai serveur HTTP, vraies connexions WebSocket,
 * adaptateur Redis réel, relais de l'outbox exécuté de façon déterministe (tick()).
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io as connectClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RealtimeEnvelope, RealtimeEnvelope as EnvelopeSchema, type SubscribeAck } from '@cura/shared';
import { AccessTokenService } from '../../src/common/security/tokens';
import { COOKIE } from '../../src/http/cookies';
import { createOutboxRelay } from '../../src/modules/realtime/create-relay';
import { OutboxRelay } from '../../src/modules/realtime/outbox.relay';
import type { OutboxRecord } from '../../src/modules/realtime/outbox.repository';
import {
  as,
  createTestContext,
  registerPatient,
  resetState,
  seedAppointmentType,
  seedDoctor,
  seedSlots,
  type Session,
  staffSession,
  type TestContext,
  tomorrowAt10,
} from './helpers';

const ALLOWED_ORIGIN = 'http://localhost:5173';
let ctx: TestContext;
let baseUrl: string;
let relay: OutboxRelay;
let doctorId: string;
let typeId: string;
let slots: string[];
const sockets: Socket[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
  relay = createOutboxRelay(ctx.c, ctx.app);
});
afterAll(async () => {
  sockets.forEach((s) => s.close());
  await ctx.close();
});
beforeEach(async () => {
  sockets.splice(0).forEach((s) => s.close());
  await resetState(ctx);
  doctorId = await seedDoctor(ctx.c.pool);
  typeId = await seedAppointmentType(ctx.c.pool);
  slots = await seedSlots(ctx.c.pool, doctorId, tomorrowAt10(), 4);
});

// --- utilitaires -------------------------------------------------------------------

function connect(opts: { session?: Session; token?: string; origin?: string } = {}): Promise<Socket> {
  const headers: Record<string, string> = { origin: opts.origin ?? ALLOWED_ORIGIN };
  if (opts.session) headers.cookie = `${COOKIE.access}=${opts.session.cookies[COOKIE.access]}`;
  const socket = connectClient(baseUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: headers,
    auth: opts.token ? { token: opts.token } : {},
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

/** Collecte les événements reçus par une connexion. */
function collect(socket: Socket): RealtimeEnvelope[] {
  const received: RealtimeEnvelope[] = [];
  socket.onAny((_type: string, payload: RealtimeEnvelope) => received.push(payload));
  return received;
}

const emitWithAck = (socket: Socket, event: 'subscribe' | 'unsubscribe' | 'watch_availability' | 'unwatch_availability', payload: unknown) =>
  socket.timeout(2000).emitWithAck(event, payload) as Promise<SubscribeAck>;

/** Relaie l'outbox puis laisse le temps aux messages de traverser Redis. */
async function flush(): Promise<void> {
  await relay.tick();
  await new Promise((r) => setTimeout(r, 150));
}

async function patientBooks(patient: Session, slotIndex: number): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/appointments',
    headers: as(patient),
    payload: { slotId: slots[slotIndex], appointmentTypeId: typeId, idempotencyKey: randomUUID() },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

// --- tests -------------------------------------------------------------------------

describe('authentification de la connexion', () => {
  it('refuse une connexion sans jeton ou avec un jeton falsifié', async () => {
    await expect(connect()).rejects.toThrow('UNAUTHORIZED');
    await expect(connect({ token: 'forged.jwt.token' })).rejects.toThrow('UNAUTHORIZED');
  });

  it('accepte le cookie httpOnly de session, ou un jeton explicite (client natif)', async () => {
    const patient = await registerPatient(ctx.app);
    await expect(connect({ session: patient })).resolves.toBeTruthy();
    await expect(connect({ token: patient.cookies[COOKIE.access] })).resolves.toBeTruthy();
  });

  it('refuse une Origin hors liste blanche, même avec un cookie valide (anti WebSocket hijacking)', async () => {
    const patient = await registerPatient(ctx.app);
    await expect(connect({ session: patient, origin: 'https://evil.example' })).rejects.toThrow();
  });

  it('déconnecte à l’expiration du jeton en prévenant le client', async () => {
    const patient = await registerPatient(ctx.app);
    const shortLived = new AccessTokenService({
      secret: ctx.c.env.JWT_ACCESS_SECRET,
      issuer: ctx.c.env.JWT_ISSUER,
      audience: ctx.c.env.JWT_AUDIENCE,
      ttlSeconds: 1,
    }).sign({ sub: patient.user.id, role: 'patient', pid: patient.user.patientId, did: null });

    const socket = await connect({ token: shortLived });
    const expired = new Promise<void>((resolve) => socket.once('session.expired', () => resolve()));
    const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    await expired;
    expect(await disconnected).toBe('io server disconnect');
  });
});

describe('diffusion des événements', () => {
  it('le patient reçoit les événements de SES rendez-vous, et pas ceux des autres', async () => {
    const alice = await registerPatient(ctx.app);
    const bob = await registerPatient(ctx.app);
    const aliceEvents = collect(await connect({ session: alice }));
    const bobEvents = collect(await connect({ session: bob }));

    const id = await patientBooks(alice, 0);
    await flush();

    expect(aliceEvents.map((e) => [e.type, e.data.id])).toEqual([['appointment.booked', id]]);
    expect(bobEvents).toEqual([]);
    expect(EnvelopeSchema.safeParse(aliceEvents[0]).success).toBe(true);
  });

  it('le secrétariat s’abonne à l’agenda d’un médecin et suit la file en direct', async () => {
    const secretary = await staffSession(ctx, 'secretary');
    const socket = await connect({ session: secretary });
    const events = collect(socket);

    const before = await patientBooks(await registerPatient(ctx.app), 0);
    await flush();
    expect(events).toEqual([]); // pas encore abonné

    expect(await emitWithAck(socket, 'subscribe', { doctorId })).toEqual({ ok: true });
    const id = await patientBooks(await registerPatient(ctx.app), 1);
    await ctx.app.inject({ method: 'POST', url: `/api/v1/appointments/${before}/cancel`, headers: as(secretary) });
    await flush();

    expect(events.map((e) => [e.type, e.data.id])).toEqual([
      ['appointment.booked', id],
      ['appointment.cancelled', before],
    ]);
    expect(events[1]!.data.previousStatus).toBe('scheduled');
    expect(Number(events[1]!.id)).toBeGreaterThan(Number(events[0]!.id)); // identifiants croissants (déduplication)

    expect(await emitWithAck(socket, 'unsubscribe', { doctorId })).toEqual({ ok: true });
    await patientBooks(await registerPatient(ctx.app), 2);
    await flush();
    expect(events).toHaveLength(2);
  });

  it('le médecin est abonné d’office à SON agenda uniquement', async () => {
    const doctor = await staffSession(ctx, 'doctor', doctorId);
    const otherDoctorId = await seedDoctor(ctx.c.pool);
    const colleague = await staffSession(ctx, 'doctor', otherDoctorId);
    const mine = collect(await connect({ session: doctor }));
    const theirs = collect(await connect({ session: colleague }));

    await patientBooks(await registerPatient(ctx.app), 0);
    await flush();
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });
});

describe('famille et disponibilités en direct', () => {
  it('le papa reçoit les événements des RDV de son enfant', async () => {
    const papa = await registerPatient(ctx.app);
    const child = (
      await ctx.app.inject({ method: 'POST', url: '/api/v1/me/family', headers: as(papa), payload: { firstName: 'Yasmine', lastName: 'Amrani', birthDate: '2016-05-10', relationship: 'child' } })
    ).json().patient.id;
    const events = collect(await connect({ session: papa }));

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: as(papa),
      payload: { slotId: slots[0], appointmentTypeId: typeId, idempotencyKey: randomUUID(), patientId: child },
    });
    expect(res.statusCode).toBe(201);
    await flush();
    expect(events.map((e) => [e.type, e.data.patientId])).toEqual([['appointment.booked', child]]);
  });

  it('un patient qui regarde l’agenda voit un créneau se prendre puis se libérer (sans donnée personnelle)', async () => {
    const watcher = await registerPatient(ctx.app);
    const socket = await connect({ session: watcher });
    const availability: unknown[] = [];
    socket.on('slot.availability', (e: unknown) => availability.push(e));
    expect(await emitWithAck(socket, 'watch_availability', { doctorId })).toEqual({ ok: true });

    const booker = await registerPatient(ctx.app);
    const id = await patientBooks(booker, 1);
    await flush();
    await ctx.app.inject({ method: 'POST', url: `/api/v1/appointments/${id}/cancel`, headers: as(booker) });
    await flush();

    expect(availability).toEqual([
      { doctorId, slotId: slots[1], startsAt: expect.any(String), available: false },
      { doctorId, slotId: slots[1], startsAt: expect.any(String), available: true },
    ]);
    expect(JSON.stringify(availability)).not.toContain(booker.user.patientId!);
  });

  it('watch_availability : validation et limite par connexion', async () => {
    const socket = await connect({ session: await registerPatient(ctx.app) });
    expect(await emitWithAck(socket, 'watch_availability', { doctorId: 'x' })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    for (let i = 0; i < 20; i++) expect((await emitWithAck(socket, 'watch_availability', { doctorId: randomUUID() })).ok).toBe(true);
    expect(await emitWithAck(socket, 'watch_availability', { doctorId: randomUUID() })).toMatchObject({ ok: false, code: 'TOO_MANY_SUBSCRIPTIONS' });
  });
});

describe('abonnements : validation et autorisations', () => {
  it('payload invalide → VALIDATION_ERROR ; patient → FORBIDDEN ; médecin sur un confrère → FORBIDDEN', async () => {
    const secretary = await connect({ session: await staffSession(ctx, 'secretary') });
    expect(await emitWithAck(secretary, 'subscribe', { doctorId: 'nope' })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(await emitWithAck(secretary, 'subscribe', 'garbage')).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

    const patient = await connect({ session: await registerPatient(ctx.app) });
    expect(await emitWithAck(patient, 'subscribe', { doctorId })).toMatchObject({ ok: false, code: 'FORBIDDEN' });

    const doctor = await connect({ session: await staffSession(ctx, 'doctor', doctorId) });
    expect(await emitWithAck(doctor, 'subscribe', { doctorId: randomUUID() })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await emitWithAck(doctor, 'subscribe', { doctorId })).toEqual({ ok: true });
  });

  it('limite le nombre d’agendas suivis par connexion', async () => {
    const admin = await connect({ session: await staffSession(ctx, 'admin') });
    for (let i = 0; i < 50; i++) expect((await emitWithAck(admin, 'subscribe', { doctorId: randomUUID() })).ok).toBe(true);
    expect(await emitWithAck(admin, 'subscribe', { doctorId: randomUUID() })).toMatchObject({ ok: false, code: 'TOO_MANY_SUBSCRIPTIONS' });
  });
});

describe('relais de l’outbox', () => {
  const fakeRelay = (published: string[], fail?: (e: OutboxRecord) => boolean) =>
    new OutboxRelay({
      tx: ctx.c.tx,
      outbox: ctx.c.repositories.outbox,
      publisher: {
        publish: (e) => {
          if (fail?.(e)) return false;
          published.push(e.id);
          return true;
        },
      },
      logger: ctx.c.logger,
      config: { intervalMs: 50, batchSize: 5, retentionDays: 7, purgeEveryMs: 3_600_000 },
    });

  async function seedEvents(n: number): Promise<void> {
    await ctx.c.pool.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       SELECT 'appointment', gen_random_uuid(), 'appointment.booked', '{}'::jsonb FROM generate_series(1, $1)`,
      [n],
    );
  }

  it('deux instances en parallèle : chaque événement est relayé exactement une fois', async () => {
    await seedEvents(40);
    const published: string[] = [];
    const a = fakeRelay(published);
    const b = fakeRelay(published);
    for (let i = 0; i < 6; i++) await Promise.all([a.tick(), b.tick()]);

    expect(published).toHaveLength(40);
    expect(new Set(published).size).toBe(40);
    expect(await ctx.c.repositories.outbox.pendingCount()).toBe(0);
  });

  it('un événement invalide est écarté sans bloquer les suivants', async () => {
    await seedEvents(3);
    const published: string[] = [];
    let first = true;
    await fakeRelay(published, () => {
      const drop = first;
      first = false;
      return drop;
    }).tick();
    expect(published).toHaveLength(2);
    expect(await ctx.c.repositories.outbox.pendingCount()).toBe(0);
  });

  it('le publisher réel rejette un contenu non conforme au contrat', async () => {
    await seedEvents(1); // payload '{}' : pas un AppointmentDto
    const secretary = await connect({ session: await staffSession(ctx, 'secretary') });
    const events = collect(secretary);
    await flush();
    expect(events).toEqual([]);
    expect(await ctx.c.repositories.outbox.pendingCount()).toBe(0);
  });

  it('purge les événements publiés au-delà de la rétention, jamais ceux en attente', async () => {
    await seedEvents(3);
    await ctx.c.pool.query(`UPDATE outbox_events SET published_at = now() - interval '10 days' WHERE id IN (SELECT id FROM outbox_events ORDER BY id LIMIT 2)`);
    expect(await ctx.c.repositories.outbox.purgePublished(7)).toBe(2);
    expect(await ctx.c.repositories.outbox.pendingCount()).toBe(1);
  });

  it('en fonctionnement continu (start/stop), les événements arrivent sans intervention', async () => {
    const patient = await registerPatient(ctx.app);
    const events = collect(await connect({ session: patient }));
    const realtime = createOutboxRelay(ctx.c, ctx.app);
    realtime.start();
    try {
      await patientBooks(patient, 0);
      const deadline = Date.now() + 3000;
      while (events.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(events.map((e) => e.type)).toEqual(['appointment.booked']);
    } finally {
      await realtime.stop();
    }
  });
});
