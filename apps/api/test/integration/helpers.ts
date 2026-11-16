import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { Pool } from 'pg';
import type { LightMyRequestResponse } from 'fastify';
import type { UserDto } from '@cura/shared';
import { type App, buildApp } from '../../src/app';
import { ScryptPasswordHasher } from '../../src/common/security/password-hasher';
import { loadEnv } from '../../src/config/env';
import { type Container, type ContainerOverrides, createContainer } from '../../src/container';
import { assertTestEnvironment } from './guard';

/** Paramètres scrypt allégés : les tests restent rapides, le format reste identique. */
export const FAST_HASHER = new ScryptPasswordHasher({ N: 2 ** 10, r: 8, p: 1 });
export const PASSWORD = 'Test-Password-2026!';

export interface TestContext {
  app: App;
  c: Container;
  close(): Promise<void>;
}

export async function createTestContext(
  envOverrides: Record<string, string> = {},
  overrides: ContainerOverrides = {},
): Promise<TestContext> {
  const raw = { ...process.env, ...envOverrides };
  assertTestEnvironment(raw);
  const env = loadEnv(raw);
  const c = createContainer(env, pino({ level: 'silent' }), { hasher: FAST_HASHER, ...overrides });
  const app = await buildApp(c);
  await app.ready();
  return {
    app,
    c,
    async close() {
      await app.close();
      await c.close();
    },
  };
}

export async function resetState(ctx: TestContext): Promise<void> {
  await ctx.c.pool.query(
    `TRUNCATE refresh_tokens, users, outbox_events, payments, invoice_items, invoices, invoice_counters,
              appointments, slots, appointment_types, patients, doctors RESTART IDENTITY CASCADE`,
  );
  await ctx.c.redis.flushdb(); // conteneur redis-test dédié
}

// --- Sessions -------------------------------------------------------------------

export interface Session {
  user: UserDto;
  csrf: string;
  cookies: Record<string, string>;
}

export function cookiesOf(res: LightMyRequestResponse): Record<string, string> {
  return Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
}

/** En-têtes d'une requête authentifiée par cookie (+ CSRF). */
export function as(session: Session): Record<string, string> {
  return {
    cookie: Object.entries(session.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; '),
    'x-csrf-token': session.csrf,
  };
}

export async function login(app: App, email: string, password = PASSWORD): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login ${email} → ${res.statusCode} ${res.body}`);
  const body = res.json<{ user: UserDto; csrfToken: string }>();
  return { user: body.user, csrf: body.csrfToken, cookies: cookiesOf(res) };
}

/** Crée un compte du personnel directement en base, puis ouvre une session. */
export async function staffSession(
  ctx: TestContext,
  role: 'admin' | 'secretary' | 'doctor',
  doctorId?: string,
): Promise<Session> {
  const email = `${role}-${randomUUID().slice(0, 8)}@cura.test`;
  await ctx.c.repositories.auth.createUser({
    email,
    passwordHash: await FAST_HASHER.hash(PASSWORD),
    role,
    doctorId: doctorId ?? null,
  });
  return login(ctx.app, email);
}

export async function registerPatient(app: App, overrides: Partial<Record<string, string>> = {}): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: `patient-${randomUUID().slice(0, 8)}@cura.test`,
      password: PASSWORD,
      firstName: 'Amina',
      lastName: 'Benali',
      birthDate: '1992-03-14',
      phone: '+212600000001',
      ...overrides,
    },
  });
  if (res.statusCode !== 201) throw new Error(`register → ${res.statusCode} ${res.body}`);
  const body = res.json<{ user: UserDto; csrfToken: string }>();
  return { user: body.user, csrf: body.csrfToken, cookies: cookiesOf(res) };
}

// --- Données de référence (SQL direct : rapide et indépendant de l'API) --------

export async function seedDoctor(pool: Pool, timezone = 'Africa/Casablanca'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO doctors (first_name, last_name, specialty, registration_number, timezone)
     VALUES ('Karim', 'Alaoui', 'Médecine générale', $1, $2) RETURNING id`,
    [`REG-${randomUUID().slice(0, 8)}`, timezone],
  );
  return rows[0]!.id;
}

export async function seedAppointmentType(pool: Pool, durationMinutes = 20): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO appointment_types (code, label, duration_minutes, color_hex)
     VALUES ($1, 'Consultation', $2, '#2563EB') RETURNING id`,
    [`C_${randomUUID().slice(0, 8).toUpperCase()}`, durationMinutes],
  );
  return rows[0]!.id;
}

/** Crée des créneaux de 20 min à partir de `start`. */
export async function seedSlots(pool: Pool, doctorId: string, start: Date, count: number, minutes = 20): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const s = new Date(start.getTime() + i * minutes * 60_000);
    const e = new Date(s.getTime() + minutes * 60_000);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO slots (doctor_id, starts_at, ends_at) VALUES ($1, $2, $3) RETURNING id`,
      [doctorId, s, e],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

export async function seedPatients(pool: Pool, count: number): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO patients (first_name, last_name, birth_date, phone)
     SELECT 'Patient', 'Nom' || chr(65 + g % 26) || chr(65 + (g / 26) % 26) || chr(65 + (g / 676) % 26),
            DATE '1990-01-01', '+2126000' || lpad(g::text, 5, '0')
       FROM generate_series(1, $1) g
     RETURNING id`,
    [count],
  );
  return rows.map((r) => r.id);
}

/** Demain 10:00 UTC (au-delà du délai de prévenance de 60 min). */
export const tomorrowAt10 = () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(10, 0, 0, 0);
  return d;
};
