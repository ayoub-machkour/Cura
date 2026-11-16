/**
 * Profil médical déclaratif : accès, validation, traçabilité, invariants en base.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestContext, registerPatient, resetState, type Session, staffSession, type TestContext } from './helpers';

let ctx: TestContext;
let patient: Session;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await resetState(ctx);
  patient = await registerPatient(ctx.app);
});

const profile = {
  bloodType: 'O+',
  allergies: ['Pénicilline', 'Arachides'],
  chronicConditions: ['Diabète de type 2'],
  currentMedications: ['Metformine 850 mg, 2×/jour'],
  pastSurgeries: [],
  emergencyContactName: 'Youssef Amrani',
  emergencyContactPhone: '+212611223344',
  notes: 'Glycémie < 1,26 g/L à jeun selon dernier bilan',
};
const url = (patientId: string) => `/api/v1/patients/${patientId}/medical-profile`;
const put = (s: Session, patientId: string, body: object) => ctx.app.inject({ method: 'PUT', url: url(patientId), headers: as(s), payload: body });
const get = (s: Session, patientId: string) => ctx.app.inject({ method: 'GET', url: url(patientId), headers: as(s) });

describe('le patient renseigne son profil médical', () => {
  it('profil vide par défaut, puis enregistrement (doublons retirés, texte « < » accepté)', async () => {
    const empty = (await get(patient, patient.user.patientId!)).json();
    expect(empty).toMatchObject({ allergies: [], bloodType: null, updatedAt: null });

    const res = await put(patient, patient.user.patientId!, { ...profile, allergies: ['Pénicilline', 'pénicilline', 'Arachides'] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ bloodType: 'O+', allergies: ['Pénicilline', 'Arachides'], notes: profile.notes });
    expect(res.json().updatedAt).toBeTruthy();
  });

  it('chaque modification est tracée (champs, auteur, rôle) ; un envoi identique ne crée pas de trace', async () => {
    const pid = patient.user.patientId!;
    await put(patient, pid, profile);
    await put(patient, pid, profile);
    await put(patient, pid, { ...profile, currentMedications: [] });
    const { rows } = await ctx.c.pool.query(`SELECT fields, actor_user_id, actor_role FROM patient_medical_profile_changes ORDER BY id`);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ fields: ['currentMedications'], actor_user_id: patient.user.id, actor_role: 'patient' });
    await expect(ctx.c.pool.query(`DELETE FROM patient_medical_profile_changes`)).rejects.toMatchObject({ code: '23514' });
  });
});

describe('accès', () => {
  it('le parent gère le profil de son enfant ; un autre patient ne le voit pas (404)', async () => {
    const child = (
      await ctx.app.inject({ method: 'POST', url: '/api/v1/me/family', headers: as(patient), payload: { firstName: 'Adam', lastName: 'Amrani', birthDate: '2019-09-02', relationship: 'child' } })
    ).json().patient.id;
    expect((await put(patient, child, { ...profile, allergies: ['Lait'] })).statusCode).toBe(200);
    const stranger = await registerPatient(ctx.app);
    expect((await get(stranger, child)).statusCode).toBe(404);
    expect((await put(stranger, child, profile)).statusCode).toBe(404);
  });

  it('le médecin et la secrétaire consultent et complètent le profil', async () => {
    const pid = patient.user.patientId!;
    await put(patient, pid, profile);
    const doctor = await staffSession(ctx, 'doctor', (await ctx.c.pool.query(
      `INSERT INTO doctors (first_name, last_name, specialty, registration_number) VALUES ('K', 'A', 'Médecine', 'R-M1') RETURNING id`,
    )).rows[0].id);
    const secretary = await staffSession(ctx, 'secretary');
    expect((await get(secretary, pid)).json().allergies).toEqual(['Pénicilline', 'Arachides']);
    expect((await put(doctor, pid, { ...profile, pastSurgeries: ['Appendicectomie (2015)'] })).statusCode).toBe(200);
    const { rows } = await ctx.c.pool.query(`SELECT actor_role FROM patient_medical_profile_changes ORDER BY id DESC LIMIT 1`);
    expect(rows[0].actor_role).toBe('doctor');
  });

  it('dossier inconnu → 404 ; sans session → 401', async () => {
    const secretary = await staffSession(ctx, 'secretary');
    expect((await get(secretary, '3f1c2a6e-8b4d-4c1a-9e2f-1a2b3c4d5e6f')).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: url(patient.user.patientId!) })).statusCode).toBe(401);
  });
});

describe('validation (Zod) et invariants (PostgreSQL)', () => {
  it.each([
    ['allergie contenant du HTML', { allergies: ['<script>alert(1)</script>'] }],
    ['31 allergies', { allergies: Array.from({ length: 31 }, (_, i) => `Allergie ${i}`) }],
    ['libellé de 121 caractères', { chronicConditions: ['a'.repeat(121)] }],
    ['contact d’urgence sans téléphone', { emergencyContactPhone: null }],
    ['groupe sanguin inconnu', { bloodType: 'Z+' }],
    ['téléphone invalide', { emergencyContactPhone: '0611223344' }],
  ])('400 : %s', async (_label, override) => {
    expect((await put(patient, patient.user.patientId!, { ...profile, ...override })).statusCode).toBe(400);
  });

  it('la base refuse aussi une liste non conforme écrite en contournant l’API', async () => {
    await expect(
      ctx.c.pool.query(`INSERT INTO patient_medical_profiles (patient_id, allergies) VALUES ($1, ARRAY['<b>x</b>'])`, [patient.user.patientId]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ck_profile_allergies' });
    await expect(
      ctx.c.pool.query(`INSERT INTO patient_medical_profiles (patient_id, allergies) VALUES ($1, ARRAY[' espaces '])`, [patient.user.patientId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('les valeurs médicales ne sont jamais écrites dans les logs', async () => {
    const lines: string[] = [];
    const original = ctx.c.logger.info.bind(ctx.c.logger);
    // Le logger de test est silencieux : on vérifie le CONTENU de ce que le service lui transmet.
    const spy = (obj: unknown, msg?: string) => {
      lines.push(JSON.stringify(obj) + (msg ?? ''));
    };
    (ctx.c.services.medical as unknown as { deps: { logger: { info: typeof spy } } }).deps.logger.info = spy;
    try {
      await put(patient, patient.user.patientId!, profile);
    } finally {
      (ctx.c.services.medical as unknown as { deps: { logger: { info: unknown } } }).deps.logger.info = original;
    }
    const joined = lines.join('\n');
    expect(joined).toContain('medical_profile.updated');
    for (const secret of ['Pénicilline', 'Diabète', 'Metformine', '+212611223344']) expect(joined).not.toContain(secret);
  });
});
