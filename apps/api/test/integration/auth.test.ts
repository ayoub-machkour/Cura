import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COOKIE } from '../../src/http/cookies';
import { as, cookiesOf, createTestContext, login, PASSWORD, registerPatient, resetState, staffSession, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => resetState(ctx));

describe('inscription et connexion', () => {
  it('l’inscription crée le dossier patient + le compte et pose des cookies sécurisés', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'Amina@Cura.Test', password: PASSWORD, firstName: 'Amina', lastName: 'Benali', birthDate: '1992-03-14', phone: '+212600000001' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({ email: 'amina@cura.test', role: 'patient' });
    expect(body.user.patientId).toBeTruthy();
    expect(body).not.toHaveProperty('accessToken'); // jamais de jeton dans le corps

    const access = res.cookies.find((c) => c.name === COOKIE.access)!;
    const refresh = res.cookies.find((c) => c.name === COOKIE.refresh)!;
    const csrf = res.cookies.find((c) => c.name === COOKIE.csrf)!;
    expect(access).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api' });
    expect(refresh).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/v1/auth' });
    expect(csrf.httpOnly).toBeFalsy(); // lisible par le client (double-submit)
    expect(csrf.value).toBe(body.csrfToken);
  });

  it('refuse un email déjà utilisé (409)', async () => {
    await registerPatient(ctx.app, { email: 'dup@cura.test' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'DUP@cura.test', password: PASSWORD, firstName: 'X', lastName: 'Y', birthDate: '1990-01-01', phone: '+212600000002' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('EMAIL_TAKEN');
  });

  it('ne révèle pas si l’email existe (même réponse pour email inconnu et mauvais mot de passe)', async () => {
    await registerPatient(ctx.app, { email: 'known@cura.test' });
    const unknown = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'nobody@cura.test', password: 'whatever-123' } });
    const wrong = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'known@cura.test', password: 'wrong-password' } });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json().code).toBe(wrong.json().code);
    expect(unknown.json().message).toBe(wrong.json().message);
  });

  it('verrouille le compte après 5 échecs, même avec le bon mot de passe ensuite', async () => {
    await registerPatient(ctx.app, { email: 'brute@cura.test' });
    for (let i = 0; i < 5; i++) {
      await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'brute@cura.test', password: `bad-${i}` } });
    }
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'brute@cura.test', password: PASSWORD } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('ACCOUNT_LOCKED');
  });

  it('GET /auth/me renvoie l’utilisateur connecté ; 401 sans session', async () => {
    const s = await registerPatient(ctx.app);
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: as(s) });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(s.user.id);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
  });

  it('accepte aussi un Bearer token (outils, tests) sans exiger de CSRF', async () => {
    const s = await registerPatient(ctx.app);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${s.cookies[COOKIE.access]}` } });
    expect(res.statusCode).toBe(200);
  });

  it('rejette un access token falsifié', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('protection CSRF', () => {
  it('refuse une requête POST authentifiée par cookie sans en-tête CSRF', async () => {
    const s = await registerPatient(ctx.app);
    const { 'x-csrf-token': _omit, ...withoutCsrf } = as(s);
    const res = await ctx.app.inject({ method: 'PATCH', url: '/api/v1/patients/me', headers: withoutCsrf, payload: { phone: '+212611111111' } });
    expect(res.statusCode).toBe(403);
  });

  it('refuse un en-tête CSRF qui ne correspond pas au cookie', async () => {
    const s = await registerPatient(ctx.app);
    const res = await ctx.app.inject({ method: 'PATCH', url: '/api/v1/patients/me', headers: { ...as(s), 'x-csrf-token': 'forged' }, payload: { phone: '+212611111111' } });
    expect(res.statusCode).toBe(403);
  });

  it('les requêtes GET ne nécessitent pas de CSRF', async () => {
    const s = await registerPatient(ctx.app);
    const { 'x-csrf-token': _omit, ...withoutCsrf } = as(s);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/patients/me', headers: withoutCsrf })).statusCode).toBe(200);
  });
});

describe('refresh token', () => {
  const refresh = (s: { cookies: Record<string, string>; csrf: string }) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: as({ ...s, user: undefined as never }) });

  it('rotation : un nouveau refresh token est émis, l’ancien ne sert plus', async () => {
    const s = await registerPatient(ctx.app);
    const res = await refresh(s);
    expect(res.statusCode).toBe(200);
    const rotated = cookiesOf(res);
    expect(rotated[COOKIE.refresh]).toBeTruthy();
    expect(rotated[COOKIE.refresh]).not.toBe(s.cookies[COOKIE.refresh]);
    expect(rotated[COOKIE.access]).toBeTruthy();

    // Le nouveau jeton fonctionne.
    const next = { cookies: { ...s.cookies, ...rotated }, csrf: res.json().csrfToken };
    expect((await refresh(next)).statusCode).toBe(200);
  });

  it('réutiliser un jeton déjà tourné révoque toute la session (détection de vol)', async () => {
    const s = await registerPatient(ctx.app);
    const first = await refresh(s);
    const legit = { cookies: { ...s.cookies, ...cookiesOf(first) }, csrf: first.json().csrfToken };

    // On simule un attaquant qui rejoue l'ancien jeton après la fenêtre de grâce.
    await ctx.c.pool.query(`UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE revoked_reason = 'rotated'`);
    const replay = await refresh(s);
    expect(replay.statusCode).toBe(401);

    // Conséquence : le jeton légitime est révoqué lui aussi → l'utilisateur doit se reconnecter.
    expect((await refresh(legit)).statusCode).toBe(401);
    const { rows } = await ctx.c.pool.query(`SELECT count(*)::int AS n FROM refresh_tokens WHERE revoked_reason = 'reuse_detected'`);
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('exige le jeton CSRF', async () => {
    const s = await registerPatient(ctx.app);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: `${COOKIE.refresh}=${s.cookies[COOKIE.refresh]}; ${COOKIE.csrf}=${s.csrf}` } });
    expect(res.statusCode).toBe(403);
  });

  it('logout révoque la session et efface les cookies', async () => {
    const s = await registerPatient(ctx.app);
    const out = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: as(s) });
    expect(out.statusCode).toBe(204);
    expect(out.cookies.find((c) => c.name === COOKIE.refresh)?.value).toBe('');
    expect((await refresh(s)).statusCode).toBe(401);
  });
});

describe('cas limites de session', () => {
  it('un compte désactivé ne peut ni se connecter ni rafraîchir sa session', async () => {
    const s = await registerPatient(ctx.app, { email: 'off@cura.test' });
    await ctx.c.pool.query(`UPDATE users SET is_active = false WHERE email = 'off@cura.test'`);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'off@cura.test', password: PASSWORD } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_CREDENTIALS');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: as(s) })).statusCode).toBe(401);
  });

  it('refresh token expiré → 401 et cookies effacés', async () => {
    const s = await registerPatient(ctx.app);
    await ctx.c.pool.query(`UPDATE refresh_tokens SET created_at = now() - interval '40 days', expires_at = now() - interval '1 second'`);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: as(s) });
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === COOKIE.access)?.value).toBe('');
  });

  it('refresh sans cookie de refresh → 401 ; jeton inconnu → 401', async () => {
    const s = await registerPatient(ctx.app);
    const noRefresh = { cookie: `${COOKIE.csrf}=${s.csrf}`, 'x-csrf-token': s.csrf };
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: noRefresh })).statusCode).toBe(401);
    const forged = { cookie: `${COOKIE.refresh}=forged-token; ${COOKIE.csrf}=${s.csrf}`, 'x-csrf-token': s.csrf };
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: forged })).statusCode).toBe(401);
  });

  it('logout sans jeton CSRF → 403 ; logout sans session (avec CSRF) → 204 idempotent', async () => {
    const s = await registerPatient(ctx.app);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: as(s).cookie! } })).statusCode).toBe(403);
    const anonymous = { cookie: `${COOKIE.csrf}=abc`, 'x-csrf-token': 'abc' };
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: anonymous })).statusCode).toBe(204);
  });

  it('login : 400 si le corps est invalide', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'pas-un-email' } })).statusCode).toBe(400);
  });

  it('les paramètres de hachage obsolètes sont mis à niveau à la connexion', async () => {
    await registerPatient(ctx.app, { email: 'rehash@cura.test' });
    const strong = await createTestContext({}, { hasher: new (await import('../../src/common/security/password-hasher')).ScryptPasswordHasher({ N: 2 ** 11, r: 8, p: 1 }) });
    try {
      await login(strong.app, 'rehash@cura.test');
      const { rows } = await ctx.c.pool.query(`SELECT password_hash FROM users WHERE email = 'rehash@cura.test'`);
      expect(rows[0].password_hash).toMatch(/^scrypt\$2048\$/);
    } finally {
      await strong.close();
    }
  });
});

describe('comptes du personnel (RBAC)', () => {
  it('compte médecin : lié à un médecin existant, une seule fois', async () => {
    const admin = await staffSession(ctx, 'admin');
    const { rows } = await ctx.c.pool.query(
      `INSERT INTO doctors (first_name, last_name, specialty, registration_number) VALUES ('Karim', 'Alaoui', 'Cardiologie', 'MED-9') RETURNING id`,
    );
    const create = (email: string, doctorId: string) =>
      ctx.app.inject({ method: 'POST', url: '/api/v1/users', headers: as(admin), payload: { email, password: PASSWORD, role: 'doctor', doctorId } });

    const ok = await create('dr@cura.test', rows[0].id);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().doctorId).toBe(rows[0].id);

    const twice = await create('dr2@cura.test', rows[0].id);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe('DOCTOR_ALREADY_LINKED');

    const unknown = await create('dr3@cura.test', '3f1c2a6e-8b4d-4c1a-9e2f-1a2b3c4d5e6f');
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().code).toBe('DOCTOR_NOT_FOUND');

    const dupEmail = await create('dr@cura.test', rows[0].id);
    expect(dupEmail.statusCode).toBe(409);

    // Le médecin connecté accède aux dossiers patients.
    const doctor = await login(ctx.app, 'dr@cura.test');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/patients', headers: as(doctor) })).statusCode).toBe(200);
  });


  it('seul un admin peut créer un compte du personnel', async () => {
    const admin = await staffSession(ctx, 'admin');
    const secretary = await staffSession(ctx, 'secretary');
    const payload = { email: 'sec2@cura.test', password: PASSWORD, role: 'secretary' };

    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/users', headers: as(secretary), payload })).statusCode).toBe(403);
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/v1/users', headers: as(admin), payload });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ email: 'sec2@cura.test', role: 'secretary' });
    await expect(login(ctx.app, 'sec2@cura.test')).resolves.toBeTruthy();
  });
});
