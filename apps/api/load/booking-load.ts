/**
 * Test de charge de la réservation — exécution : pnpm --filter @cura/api load:test
 *
 * Vrai serveur HTTP (port éphémère), vraie base de TEST (garde-fou _test), Redis de test.
 * Authentification par Bearer signé directement : on mesure la réservation, pas le hachage
 * des mots de passe. Trois scénarios :
 *   1. Ruée        : N patients se disputent M créneaux au même instant.
 *   2. Même client : chaque patient lance 5 réservations simultanées (limite de 3 RDV à venir).
 *   3. Montée en charge : charge mixte (lectures + réservations) à concurrence croissante.
 * Après chaque scénario, on vérifie les invariants en base (aucune double réservation).
 */
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import pino from 'pino';
import { buildApp } from '../src/app';
import { ScryptPasswordHasher } from '../src/common/security/password-hasher';
import { loadEnv } from '../src/config/env';
import { createContainer } from '../src/container';
import { assertTestEnvironment } from '../test/integration/guard';

// --- environnement de test -------------------------------------------------------
const root = resolve(__dirname, '../../..');
const envFile = [resolve(root, '.env.test'), resolve(root, '.env.test.example')].find(existsSync)!;
const rawEnv = { ...parse(readFileSync(envFile)), ...process.env } as Record<string, string>;
assertTestEnvironment(rawEnv);
const env = loadEnv(rawEnv);

// --- mesures -----------------------------------------------------------------------
interface Sample {
  ms: number;
  status: number;
}
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
function summarize(samples: Sample[], wallMs: number) {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const byStatus: Record<number, number> = {};
  for (const s of samples) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  return {
    requests: samples.length,
    rps: Math.round((samples.length / wallMs) * 1000),
    p50: Math.round(pct(ms, 50)),
    p95: Math.round(pct(ms, 95)),
    p99: Math.round(pct(ms, 99)),
    max: Math.round(ms.at(-1) ?? 0),
    statuses: byStatus,
    serverErrors: samples.filter((s) => s.status >= 500).length,
  };
}

/** Exécute `tasks` avec au plus `concurrency` requêtes en vol. */
async function runPool(tasks: (() => Promise<Sample>)[], concurrency: number): Promise<{ samples: Sample[]; wallMs: number }> {
  const samples: Sample[] = [];
  let next = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (next < tasks.length) samples.push(await tasks[next++]!());
    }),
  );
  return { samples, wallMs: performance.now() - start };
}

async function main(): Promise<void> {
  const c = createContainer(env, pino({ level: 'silent' }), { hasher: new ScryptPasswordHasher({ N: 2 ** 10, r: 8, p: 1 }) });
  const app = await buildApp(c);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1`;
  const pool = c.pool;

  // Saturation du pool PostgreSQL : nombre max de requêtes en attente d'une connexion.
  let maxWaiting = 0;
  const sampler = setInterval(() => (maxWaiting = Math.max(maxWaiting, pool.waitingCount)), 10);

  const request = async (method: string, path: string, token: string, body?: unknown): Promise<Sample> => {
    const t0 = performance.now();
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    await res.arrayBuffer();
    return { ms: performance.now() - t0, status: res.status };
  };

  async function reset() {
    await pool.query(
      `TRUNCATE appointment_status_changes, refresh_tokens, users, outbox_events, payments, invoice_items, invoices,
                invoice_counters, appointments, slots, appointment_types, patients, doctors RESTART IDENTITY CASCADE`,
    );
    await c.redis.flushdb();
  }
  async function seed(slotCount: number, patientCount: number) {
    await reset();
    const { rows: [doctor] } = await pool.query(
      `INSERT INTO doctors (first_name, last_name, specialty, registration_number) VALUES ('Karim', 'Alaoui', 'Médecine', 'LOAD-1') RETURNING id`,
    );
    const { rows: [type] } = await pool.query(
      `INSERT INTO appointment_types (code, label, duration_minutes, color_hex) VALUES ('LOAD', 'Consultation', 15, '#2563EB') RETURNING id`,
    );
    const { rows: slots } = await pool.query<{ id: string }>(
      `INSERT INTO slots (doctor_id, starts_at, ends_at)
       SELECT $1, date_trunc('day', now()) + interval '2 days' + make_interval(mins => 15 * g),
                  date_trunc('day', now()) + interval '2 days' + make_interval(mins => 15 * (g + 1))
         FROM generate_series(0, $2 - 1) g RETURNING id`,
      [doctor.id, slotCount],
    );
    const { rows: patients } = await pool.query<{ id: string }>(
      `INSERT INTO patients (first_name, last_name, birth_date, phone)
       SELECT 'Patient', 'Charge', DATE '1990-01-01', '+21260' || lpad(g::text, 7, '0') FROM generate_series(1, $1) g RETURNING id`,
      [patientCount],
    );
    // Vrais comptes (l'historique exige un auteur existant) ; hash factice au bon format : pas de connexion par mot de passe ici.
    const { rows: users } = await pool.query<{ id: string; patientId: string }>(
      `INSERT INTO users (email, password_hash, role, patient_id)
       SELECT 'load-' || p.id || '@cura.test', 'scrypt$1024$8$1$c2FsdA$aGFzaA', 'patient', p.id FROM unnest($1::uuid[]) AS p(id)
       RETURNING id, patient_id AS "patientId"`,
      [patients.map((p) => p.id)],
    );
    const tokens = users.map((u) => c.accessTokens.sign({ sub: u.id, role: 'patient', pid: u.patientId, did: null }));
    return { doctorId: doctor.id as string, typeId: type.id as string, slots: slots.map((s) => s.id), tokens };
  }
  const doubleBookings = async () =>
    (await pool.query(`SELECT count(*)::int AS n FROM (SELECT slot_id FROM appointments WHERE status <> 'cancelled' GROUP BY slot_id HAVING count(*) > 1) d`)).rows[0].n as number;

  const report: Record<string, unknown> = {};

  // --- 1. Ruée : 200 patients, 20 créneaux, tout en même temps ---------------------
  {
    const { typeId, slots, tokens } = await seed(20, 200);
    maxWaiting = 0;
    const tasks = tokens.map((token, i) => () =>
      request('POST', '/appointments', token, { slotId: slots[i % 20], appointmentTypeId: typeId, idempotencyKey: randomUUID() }),
    );
    const { samples, wallMs } = await runPool(tasks, tasks.length);
    report['1. Ruée (200 patients → 20 créneaux, simultané)'] = {
      ...summarize(samples, wallMs),
      maxPoolWaiting: maxWaiting,
      doubleBookings: await doubleBookings(),
    };
  }

  // --- 2. Même client × 5 : 50 patients lancent chacun 5 réservations simultanées --
  {
    const { typeId, slots, tokens } = await seed(250, 50);
    maxWaiting = 0;
    const tasks = tokens.flatMap((token, p) =>
      [0, 1, 2, 3, 4].map((k) => () =>
        request('POST', '/appointments', token, { slotId: slots[p * 5 + k], appointmentTypeId: typeId, idempotencyKey: randomUUID() }),
      ),
    );
    const { samples, wallMs } = await runPool(tasks, tasks.length);
    const perPatient = (await pool.query(`SELECT max(n)::int AS max, min(n)::int AS min FROM (SELECT count(*) n FROM appointments GROUP BY patient_id) x`)).rows[0];
    report['2. Même client × 5 (50 patients × 5 réservations simultanées)'] = {
      ...summarize(samples, wallMs),
      maxPoolWaiting: maxWaiting,
      rdvParPatient: `${perPatient.min}–${perPatient.max} (limite 3)`,
      doubleBookings: await doubleBookings(),
    };
  }

  // --- 3. Montée en charge : 70 % lecture créneaux, 20 % mes RDV, 10 % réservation --
  {
    const { doctorId, typeId, slots, tokens } = await seed(3000, 600);
    const from = encodeURIComponent(new Date().toISOString());
    const to = encodeURIComponent(new Date(Date.now() + 7 * 86_400_000).toISOString());
    const levels = [1, 5, 10, 25, 50, 100];
    const rows: Record<string, unknown> = {};
    let patientCursor = 0;
    for (const concurrency of levels) {
      maxWaiting = 0;
      const tasks = Array.from({ length: 600 }, (_, i) => {
        const token = tokens[patientCursor++ % tokens.length]!;
        const roll = i % 10;
        if (roll < 7) return () => request('GET', `/doctors/${doctorId}/slots?from=${from}&to=${to}&limit=20`, token);
        if (roll < 9) return () => request('GET', '/appointments/me', token);
        return () =>
          request('POST', '/appointments', token, {
            slotId: slots[Math.floor(Math.random() * slots.length)],
            appointmentTypeId: typeId,
            idempotencyKey: randomUUID(),
          });
      });
      const { samples, wallMs } = await runPool(tasks, concurrency);
      const s = summarize(samples, wallMs);
      rows[`concurrence ${String(concurrency).padStart(3)}`] = {
        'req/s': s.rps,
        'p50 ms': s.p50,
        'p95 ms': s.p95,
        'p99 ms': s.p99,
        'max ms': s.max,
        '5xx': s.serverErrors,
        'attente pool max': maxWaiting,
      };
    }
    report['3. Montée en charge (600 requêtes par palier, charge mixte)'] = rows;
    report['3. invariant'] = { doubleBookings: await doubleBookings() };
  }

  clearInterval(sampler);
  await app.close();
  await c.close();

  for (const [title, value] of Object.entries(report)) {
    console.log(`\n=== ${title}`);
    if (title.startsWith('3. Montée')) console.table(value);
    else console.log(value);
  }
  const failures = JSON.stringify(report).match(/"(serverErrors|5xx|doubleBookings)":([1-9]\d*)/g);
  if (failures) {
    console.error('\nÉCHEC : erreurs serveur ou doubles réservations détectées', failures);
    process.exitCode = 1;
  } else {
    console.log('\nOK : aucune erreur serveur, aucune double réservation.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
