/**
 * TEST DE CONTRAT Zod ⇄ PostgreSQL.
 * Pour chaque règle de packages/shared/src/constraints.ts : Zod ET la base doivent
 * rendre le même verdict. Si quelqu'un modifie une règle d'un seul côté, ce test échoue.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { CreateAppointmentTypeRequest, CreateDoctorRequest, CreatePatientRequest, Email, NationalId, PersonName, PhoneE164, safeText } from '@cura/shared';
import { createTestContext, resetState, seedDoctor, type TestContext } from './helpers';

let ctx: TestContext;
let pool: Pool;
beforeAll(async () => {
  ctx = await createTestContext();
  pool = ctx.c.pool;
});
afterAll(async () => ctx.close());
beforeEach(async () => resetState(ctx));

async function dbAccepts(sql: string, params: unknown[]): Promise<boolean> {
  try {
    await pool.query(sql, params);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23514' || code === '22001' || code === '22P02' || code === '22007' || code === '22008') return false;
    throw err;
  }
}

const zodAccepts = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

/** Insère un patient en ne faisant varier qu'un champ. */
const insertPatient = (field: string, value: unknown) => {
  const row: Record<string, unknown> = { first_name: 'Test', last_name: 'Patient', birth_date: '1990-01-01', phone: '+212600000000', [field]: value };
  const cols = Object.keys(row);
  return dbAccepts(`INSERT INTO patients (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
};

describe.each([
  // [libellé, schéma Zod, colonne SQL, valeur, verdict attendu]
  ['nom simple', PersonName, 'last_name', 'Benali', true],
  ['nom accentué', PersonName, 'last_name', 'Éloïse', true],
  ['nom avec chiffre', PersonName, 'last_name', 'R2D2', false],
  ['nom avec chevron', PersonName, 'last_name', 'a<b', false],
  ['nom 100 caractères', PersonName, 'last_name', 'a'.repeat(100), true],
  ['nom 101 caractères', PersonName, 'last_name', 'a'.repeat(101), false],
  ['nom caractère de contrôle', PersonName, 'last_name', 'ab\u0007c', false],
  ['téléphone E.164', PhoneE164, 'phone', '+212600000000', true],
  ['téléphone national', PhoneE164, 'phone', '0600000000', false],
  ['téléphone trop long', PhoneE164, 'phone', '+1234567890123456', false],
  ['email valide', Email, 'email', 'a@b.co', true],
  ['email sans domaine', Email, 'email', 'a@b', false],
  ['email 255 caractères', Email, 'email', `${'a'.repeat(249)}@b.com`, false],
  ['identité valide', NationalId, 'national_id', 'AB-1234', true],
  ['identité trop courte', NationalId, 'national_id', 'AB1', false],
  ['identité caractère interdit', NationalId, 'national_id', 'AB 1234', false],
] as const)('patients · %s', (_label, schema, column, value, expected) => {
  it(`Zod et PostgreSQL ${expected ? 'acceptent' : 'rejettent'}`, async () => {
    expect(zodAccepts(schema, value)).toBe(expected);
    expect(await insertPatient(column, value)).toBe(expected);
  });
});

describe('patients · date de naissance', () => {
  it.each([
    ['1900-01-01', true],
    ['1899-12-31', false],
  ])('%s', async (birthDate, expected) => {
    const base = { firstName: 'A', lastName: 'B', phone: '+212600000000' };
    expect(zodAccepts(CreatePatientRequest, { ...base, birthDate })).toBe(expected);
    expect(await insertPatient('birth_date', birthDate)).toBe(expected);
  });
});

describe('texte libre anti-XSS (domaine safe_text)', () => {
  const insertNote = async (note: string) => {
    const doctorId = await seedDoctor(pool);
    const { rows } = await pool.query(
      `INSERT INTO appointment_types (code, label, duration_minutes, color_hex) VALUES ('NOTE_' || upper(substr(md5(random()::text), 1, 6)), 'X', 20, '#000000') RETURNING id`,
    );
    const { rows: p } = await pool.query(`INSERT INTO patients (first_name, last_name, birth_date, phone) VALUES ('A','B','1990-01-01','+212600000000') RETURNING id`);
    return dbAccepts(
      // Visite walk-in valide (sans créneau, déjà arrivée) : seule la note varie.
      `INSERT INTO appointments (doctor_id, patient_id, appointment_type_id, starts_at, ends_at, source, idempotency_key, note,
                                status, checked_in_at)
       VALUES ($1, $2, $3, now(), now() + interval '20 minutes', 'desk', gen_random_uuid(), $4, 'checked_in', now())`,
      [doctorId, p[0].id, rows[0].id, note],
    );
  };

  it.each([
    ['Tension < 12', true],
    ['<script>alert(1)</script>', false],
    ['</b>', false],
    ['<!-- x -->', false],
    ['a'.repeat(500), true],
    ['a'.repeat(501), false],
  ])('« %s »', async (note, expected) => {
    expect(zodAccepts(safeText(500), note)).toBe(expected);
    expect(await insertNote(note)).toBe(expected);
  });
});

describe('médecins et motifs', () => {
  const doctor = { firstName: 'A', lastName: 'B', specialty: 'Cardiologie', registrationNumber: 'REG-001', timezone: 'UTC' };
  const insertDoctor = (registration: string, specialty = 'Cardiologie') =>
    dbAccepts(`INSERT INTO doctors (first_name, last_name, specialty, registration_number) VALUES ('A', 'B', $1, $2)`, [specialty, registration]);

  it.each([
    ['REG-001', true],
    ['RE', false],
    ['REG 001', false],
    ['RPPS/123', true],
  ])('numéro d’inscription « %s »', async (registrationNumber, expected) => {
    expect(zodAccepts(CreateDoctorRequest, { ...doctor, registrationNumber })).toBe(expected);
    expect(await insertDoctor(registrationNumber)).toBe(expected);
  });

  const type = { code: 'CONSULT', label: 'Consultation', durationMinutes: 20, colorHex: '#2563EB' };
  const insertType = (t: typeof type) =>
    dbAccepts(`INSERT INTO appointment_types (code, label, duration_minutes, color_hex) VALUES ($1, $2, $3, $4)`, [t.code, t.label, t.durationMinutes, t.colorHex]);

  it.each([
    ['valide', type, true],
    ['durée 22 min', { ...type, code: 'D22', durationMinutes: 22 }, false],
    ['durée 245 min', { ...type, code: 'D245', durationMinutes: 245 }, false],
    ['couleur invalide', { ...type, code: 'COL', colorHex: 'blue' }, false],
    ['code minuscule', { ...type, code: 'consult_x' }, true], // Zod normalise en majuscules ; la base n'accepte que la forme normalisée
  ])('motif · %s', async (_label, t, expected) => {
    expect(zodAccepts(CreateAppointmentTypeRequest, t)).toBe(expected);
    const normalized = expected ? CreateAppointmentTypeRequest.parse(t) : t;
    expect(await insertType({ ...t, code: normalized.code })).toBe(expected);
  });
});

describe('invariants propres à la base', () => {
  it('un créneau ne peut pas durer moins de 5 minutes ni chevaucher un autre', async () => {
    const doctorId = await seedDoctor(pool);
    expect(await dbAccepts(`INSERT INTO slots (doctor_id, starts_at, ends_at) VALUES ($1, '2030-01-01 10:00Z', '2030-01-01 10:04Z')`, [doctorId])).toBe(false);
    await pool.query(`INSERT INTO slots (doctor_id, starts_at, ends_at) VALUES ($1, '2030-01-01 10:00Z', '2030-01-01 10:20Z')`, [doctorId]);
    await expect(pool.query(`INSERT INTO slots (doctor_id, starts_at, ends_at) VALUES ($1, '2030-01-01 10:10Z', '2030-01-01 10:30Z')`, [doctorId])).rejects.toMatchObject({
      code: '23P01',
    });
  });

  it('le rôle d’un compte détermine exactement ses liens (patient ↔ patient_id)', async () => {
    const hash = 'scrypt$1024$8$1$c2FsdA$aGFzaA';
    expect(await dbAccepts(`INSERT INTO users (email, password_hash, role) VALUES ('p@cura.test', $1, 'patient')`, [hash])).toBe(false);
    expect(await dbAccepts(`INSERT INTO users (email, password_hash, role) VALUES ('a@cura.test', $1, 'admin')`, [hash])).toBe(true);
    expect(await dbAccepts(`INSERT INTO users (email, password_hash, role) VALUES ('x@cura.test', 'plaintext', 'admin')`, [])).toBe(false);
  });
});
