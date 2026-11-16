/**
 * Comportement en cas de panne ou de contention : l'API doit échouer proprement,
 * sans divulguer de détail interne, et signaler son état aux sondes.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Migrator } from '../../src/infra/db/migrator';
import { TransactionManager } from '../../src/infra/db/transaction';
import { createTestContext, resetState, seedAppointmentType, seedDoctor, seedPatients, seedSlots, type TestContext, tomorrowAt10 } from './helpers';

describe('base de données indisponible', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    // Pool pointant vers un port fermé : toute requête échoue.
    const deadPool = new Pool({ connectionString: 'postgres://x:y@127.0.0.1:1/none_test', connectionTimeoutMillis: 300 });
    ctx = await createTestContext({}, { pool: deadPool });
  });
  afterAll(async () => ctx.close());

  it('500 générique, sans fuite de détail technique', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'a@cura.test', password: 'whatever-123' } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Une erreur inattendue est survenue.' });
    expect(res.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|postgres|stack/i);
    expect(res.json().requestId).toBeTruthy();
  });

  it('/health/ready → 503 « degraded », /health/live reste 200', async () => {
    const ready = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: 'degraded', checks: { database: { status: 'down' }, redis: { status: 'up' } } });
    expect((await ctx.app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });
});

describe('contention de verrou', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({ BOOKING_LOCK_TIMEOUT_MS: '200' });
    await resetState(ctx);
  });
  afterAll(async () => ctx.close());

  it('si le créneau reste verrouillé au-delà de lock_timeout : 409 LOCK_CONTENTION + alternatives, sans attente infinie', async () => {
    const doctorId = await seedDoctor(ctx.c.pool);
    const typeId = await seedAppointmentType(ctx.c.pool);
    const [slotId] = await seedSlots(ctx.c.pool, doctorId, tomorrowAt10(), 3);
    const [patientId] = await seedPatients(ctx.c.pool, 1);

    // Une autre transaction garde le verrou du créneau pendant 1,5 s.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const locker = new TransactionManager(ctx.c.pool).run(async (tx) => {
      await tx.query('SELECT id FROM slots WHERE id = $1 FOR UPDATE', [slotId]);
      await held;
    });
    await new Promise((r) => setTimeout(r, 50));

    const start = Date.now();
    const attempt = ctx.c.services.booking.book({ patientId: patientId!, slotId: slotId!, appointmentTypeId: typeId, idempotencyKey: randomUUID(), source: 'desk' });
    await expect(attempt).rejects.toMatchObject({ reason: 'LOCK_CONTENTION', alternatives: expect.arrayContaining([expect.objectContaining({ doctorId })]) });
    expect(Date.now() - start).toBeLessThan(1500);

    release();
    await locker;
  });
});

describe('migrator create', () => {
  it('crée la paire up/down numérotée à la suite, refuse un nom invalide', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cura-mig-'));
    try {
      const migrator = new Migrator(null as unknown as Pool, dir);
      await migrator.create('add_waiting_room');
      await migrator.create('add_invoices_view');
      expect((await readdir(dir)).sort()).toEqual([
        '0001_add_waiting_room.down.sql',
        '0001_add_waiting_room.up.sql',
        '0002_add_invoices_view.down.sql',
        '0002_add_invoices_view.up.sql',
      ]);
      await expect(migrator.create('Bad Name')).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
