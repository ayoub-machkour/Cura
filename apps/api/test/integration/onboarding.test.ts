/**
 * Activation du compte d'un patient déjà connu du cabinet (code d'invitation).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COOKIE } from '../../src/http/cookies';
import { as, cookiesOf, createTestContext, PASSWORD, registerPatient, resetState, type Session, staffSession, type TestContext } from './helpers';

let ctx: TestContext;
let secretary: Session;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await resetState(ctx);
  secretary = await staffSession(ctx, 'secretary');
});

const BIRTH_DATE = '1958-04-12';

/** Le secrétariat crée le dossier d'un patient sans smartphone. */
async function deskPatient(): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/patients',
    headers: as(secretary),
    payload: { firstName: 'Fatima', lastName: 'Zahra', birthDate: BIRTH_DATE, phone: '+212600000777' },
  });
  return res.json().id;
}
const invite = (patientId: string, s: Session = secretary) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1/patients/${patientId}/invitations`, headers: as(s) });
const claim = (body: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/claim',
    payload: { birthDate: BIRTH_DATE, email: `p-${randomUUID().slice(0, 8)}@cura.test`, password: PASSWORD, ...body },
  });

describe('le patient connu du cabinet active son compte et retrouve son historique', () => {
  it('scénario complet : dossier au guichet → visites → code → activation dans l’app', async () => {
    const patientId = await deskPatient();

    // Visite passée, enregistrée par le cabinet avant que le patient ait l'app.
    const { rows: [doctor] } = await ctx.c.pool.query(
      `INSERT INTO doctors (first_name, last_name, specialty, registration_number) VALUES ('Karim', 'Alaoui', 'Médecine', 'R-1') RETURNING id`,
    );
    const { rows: [type] } = await ctx.c.pool.query(
      `INSERT INTO appointment_types (code, label, duration_minutes, color_hex) VALUES ('C1', 'Consultation', 20, '#2563EB') RETURNING id`,
    );
    await ctx.c.pool.query(
      `INSERT INTO appointments (doctor_id, patient_id, appointment_type_id, starts_at, ends_at, source, idempotency_key,
                                 status, checked_in_at, consultation_started_at, completed_at)
       VALUES ($1, $2, $3, now() - interval '30 days', now() - interval '30 days' + interval '20 minutes', 'desk', gen_random_uuid(),
               'completed', now() - interval '30 days', now() - interval '30 days', now() - interval '30 days' + interval '20 minutes')`,
      [doctor.id, patientId, type.id],
    );

    const invitation = await invite(patientId);
    expect(invitation.statusCode).toBe(201);
    const { code, expiresAt } = invitation.json();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    // Saisie « humaine » : minuscules et espace acceptés.
    const res = await claim({ code: code.toLowerCase().replace('-', ' ') });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ role: 'patient', patientId });
    expect(res.cookies.find((c) => c.name === COOKIE.access)?.httpOnly).toBe(true);

    const session: Session = { user: res.json().user, csrf: res.json().csrfToken, cookies: cookiesOf(res) };
    const history = await ctx.app.inject({ method: 'GET', url: '/api/v1/appointments/me?scope=past', headers: as(session) });
    expect(history.json().data).toHaveLength(1);
    expect(history.json().data[0].status).toBe('completed');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/patients/me', headers: as(session) })).json().id).toBe(patientId);

    // Aucun doublon de dossier n'a été créé.
    expect((await ctx.c.pool.query(`SELECT count(*)::int AS n FROM patients`)).rows[0].n).toBe(1);
    // Le code n'est stocké qu'haché.
    const stored = await ctx.c.pool.query(`SELECT code_hash FROM patient_invitations`);
    expect(stored.rows[0].code_hash).not.toContain(code.replace('-', ''));
  });
});

describe('sécurité du code d’activation', () => {
  it('date de naissance erronée → 422 générique ; bloqué après 5 essais, même avec la bonne date', async () => {
    const { code } = (await invite(await deskPatient())).json();
    for (let i = 0; i < 5; i++) {
      const res = await claim({ code, birthDate: '1990-01-01' });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('INVALID_INVITATION');
    }
    expect((await claim({ code })).statusCode).toBe(422);
    expect((await ctx.c.pool.query(`SELECT failed_attempts FROM patient_invitations`)).rows[0].failed_attempts).toBe(5);
  });

  it('code inconnu et mauvaise date donnent EXACTEMENT la même réponse (pas d’énumération)', async () => {
    const { code } = (await invite(await deskPatient())).json();
    const unknown = await claim({ code: 'ABCD-EFGH' });
    const wrongDate = await claim({ code, birthDate: '1990-01-01' });
    expect(unknown.statusCode).toBe(wrongDate.statusCode);
    expect(unknown.json().message).toBe(wrongDate.json().message);
  });

  it('usage unique : le même code ne fonctionne qu’une fois', async () => {
    const { code } = (await invite(await deskPatient())).json();
    expect((await claim({ code })).statusCode).toBe(201);
    expect((await claim({ code })).statusCode).toBe(422);
  });

  it('code expiré → 422', async () => {
    const { code } = (await invite(await deskPatient())).json();
    await ctx.c.pool.query(`UPDATE patient_invitations SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day'`);
    expect((await claim({ code })).statusCode).toBe(422);
  });

  it('régénérer un code invalide le précédent', async () => {
    const patientId = await deskPatient();
    const first = (await invite(patientId)).json().code;
    const second = (await invite(patientId)).json().code;
    expect((await claim({ code: first })).statusCode).toBe(422);
    expect((await claim({ code: second })).statusCode).toBe(201);
  });

  it('deux activations simultanées du même code → une seule réussit', async () => {
    const { code } = (await invite(await deskPatient())).json();
    const results = await Promise.all([claim({ code }), claim({ code })]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 422]);
    expect((await ctx.c.pool.query(`SELECT count(*)::int AS n FROM users WHERE role = 'patient'`)).rows[0].n).toBe(1);
  });

  it('email déjà utilisé → 409, et le code reste utilisable avec un autre email', async () => {
    await registerPatient(ctx.app, { email: 'taken@cura.test' });
    const { code } = (await invite(await deskPatient())).json();
    const taken = await claim({ code, email: 'taken@cura.test' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().code).toBe('EMAIL_TAKEN');
    expect((await claim({ code })).statusCode).toBe(201);
  });

  it('400 sur un code mal formé ou un mot de passe trop court', async () => {
    expect((await claim({ code: 'O0I1-LLLL' })).statusCode).toBe(400); // caractères ambigus exclus
    expect((await claim({ code: 'ABCD-EFGH', password: 'short' })).statusCode).toBe(400);
  });
});

describe('génération du code (cabinet)', () => {
  it('409 si le patient a déjà un compte ; 404 si dossier inconnu ; 403 pour un patient', async () => {
    const patient = await registerPatient(ctx.app);
    const already = await invite(patient.user.patientId!);
    expect(already.statusCode).toBe(409);
    expect(already.json().code).toBe('PATIENT_ALREADY_HAS_ACCOUNT');
    expect((await invite(randomUUID())).statusCode).toBe(404);
    expect((await invite(await deskPatient(), patient)).statusCode).toBe(403);
  });

  it('les codes générés sont distincts et utilisent l’alphabet sans ambiguïté', async () => {
    const { generateInvitationCode } = await import('../../src/modules/onboarding/onboarding.service');
    const codes = new Set(Array.from({ length: 2000 }, generateInvitationCode));
    expect(codes.size).toBe(2000);
    for (const c of codes) expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });
});
