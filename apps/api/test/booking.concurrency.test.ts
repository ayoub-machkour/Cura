/**
 * Test de concurrence RÉEL contre PostgreSQL (pas de mock de la base : c'est
 * précisément le comportement des verrous qu'on veut prouver).
 *
 * Prérequis : TEST_DATABASE_URL pointant sur une base de test vide.
 *   pnpm --filter @medcine/api test
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgBookingRepository } from '../src/modules/booking/booking.repository';
import { BookingService } from '../src/modules/booking/booking.service';
import { SlotUnavailableError } from '../src/modules/booking/booking.errors';
import type { SlotHoldStore } from '../src/modules/booking/booking.ports';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const CONTENDERS = 50;

/** Pas de Redis dans ce test : on prouve que PostgreSQL suffit à garantir l'unicité. */
const noHolds: SlotHoldStore = {
  acquire: async () => null,
  getHolder: async () => null,
  release: async () => {},
  heldByOthers: async () => new Set(),
};

describe.skipIf(!DATABASE_URL)('BookingService — concurrence', () => {
  let pool: Pool;
  let service: BookingService;
  let doctorId: string;
  let typeId: string;
  let targetSlotId: string;
  let patientIds: string[];

  const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 20 });
    const { rows } = await pool.query(`SELECT to_regclass('public.appointments') AS t`);
    if (!rows[0].t) {
      const sql = await readFile(resolve(__dirname, '../../../packages/db/migrations/0001_init.sql'), 'utf8');
      await pool.query(sql);
    }
    service = new BookingService({
      pool,
      repo: new PgBookingRepository(),
      holds: noHolds,
      clock: { now: () => new Date() },
      logger: { warn: () => {}, error: () => {} },
      config: { lockTimeoutMs: 5_000, minLeadTimeMinutes: 60, alternativesCount: 3 },
    });
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE outbox_events, payments, invoice_items, invoices, appointments, slots,
                appointment_types, patients, doctors RESTART IDENTITY CASCADE`,
    );

    doctorId = (await pool.query(
      `INSERT INTO doctors (first_name, last_name, specialty, registration_number)
       VALUES ('Test', 'Doctor', 'Généraliste', $1) RETURNING id`, [randomUUID()],
    )).rows[0].id;

    typeId = (await pool.query(
      `INSERT INTO appointment_types (code, label, duration_minutes, color_hex)
       VALUES ('CONSULT', 'Consultation', 20, '#2563EB') RETURNING id`,
    )).rows[0].id;

    // Créneau visé à J+1 10:00, et 4 alternatives autour.
    const base = hoursFromNow(24);
    const slotIds: string[] = [];
    for (const offsetMin of [0, -40, -20, 20, 40]) {
      const start = new Date(base.getTime() + offsetMin * 60_000);
      const end = new Date(start.getTime() + 20 * 60_000);
      const { rows } = await pool.query(
        `INSERT INTO slots (doctor_id, starts_at, ends_at) VALUES ($1, $2, $3) RETURNING id`,
        [doctorId, start, end],
      );
      slotIds.push(rows[0].id);
    }
    targetSlotId = slotIds[0]!;

    const { rows: patients } = await pool.query(
      `INSERT INTO patients (first_name, last_name, birth_date, phone_e164)
       SELECT 'P' || g, 'Test', DATE '1990-01-01', '+33600000' || lpad(g::text, 3, '0')
         FROM generate_series(1, $1) g
       RETURNING id`,
      [CONTENDERS],
    );
    patientIds = patients.map((p) => p.id);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it(`${CONTENDERS} patients réservent le même créneau au même instant → exactement 1 gagnant`, async () => {
    const results = await Promise.allSettled(
      patientIds.map((patientId) =>
        service.book({
          patientId,
          slotId: targetSlotId,
          appointmentTypeId: typeId,
          idempotencyKey: randomUUID(),
          source: 'mobile',
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(CONTENDERS - 1);

    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(SlotUnavailableError);
      const err = r.reason as SlotUnavailableError;
      expect(['ALREADY_BOOKED', 'LOCK_CONTENTION']).toContain(err.reason);
      // Les perdants reçoivent les alternatives, la plus proche en premier.
      expect(err.alternatives.length).toBeGreaterThan(0);
      expect(err.alternatives.map((a) => a.id)).not.toContain(targetSlotId);
    }

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM appointments WHERE slot_id = $1`, [targetSlotId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('le même patient qui envoie 10 fois la même requête (retry réseau) → 1 seul RDV, rejeux idempotents', async () => {
    const key = randomUUID();
    const patientId = patientIds[0]!;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.book({ patientId, slotId: targetSlotId, appointmentTypeId: typeId, idempotencyKey: key, source: 'mobile' }),
      ),
    );

    const ids = new Set(results.map((r) => r.appointment.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });

  it('les contraintes SQL bloquent une double réservation même en contournant le service', async () => {
    const { rows: [slot] } = await pool.query(`SELECT * FROM slots WHERE id = $1`, [targetSlotId]);
    const insert = (patientId: string) =>
      pool.query(
        `INSERT INTO appointments (doctor_id, patient_id, appointment_type_id, slot_id, starts_at, ends_at, source, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, 'desk', $7)`,
        [doctorId, patientId, typeId, slot.id, slot.starts_at, slot.ends_at, randomUUID()],
      );

    await insert(patientIds[0]!);
    await expect(insert(patientIds[1]!)).rejects.toMatchObject({ code: expect.stringMatching(/^(23505|23P01)$/) });
  });
});
