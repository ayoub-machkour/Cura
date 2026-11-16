import { createSigner } from 'fast-jwt';
import { describe, expect, it } from 'vitest';
import { ScryptPasswordHasher } from '../../src/common/security/password-hasher';
import { AccessTokenService, randomToken, safeEqual, sha256Hex } from '../../src/common/security/tokens';

const hasher = new ScryptPasswordHasher({ N: 2 ** 10, r: 8, p: 1 });
// Même expression que la contrainte SQL ck_users_password_hash.
const SQL_HASH_FORMAT = /^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;

describe('ScryptPasswordHasher', () => {
  it('vérifie le bon mot de passe et rejette les autres', async () => {
    const hash = await hasher.hash('Correct-Horse-Battery-1');
    expect(await hasher.verify('Correct-Horse-Battery-1', hash)).toBe(true);
    expect(await hasher.verify('correct-horse-battery-1', hash)).toBe(false);
  });

  it('produit un format accepté par la contrainte SQL, salé différemment à chaque fois', async () => {
    const [a, b] = await Promise.all([hasher.hash('same-password-123'), hasher.hash('same-password-123')]);
    expect(a).toMatch(SQL_HASH_FORMAT);
    expect(a).not.toBe(b);
  });

  it('rejette un hash malformé sans lever d’exception', async () => {
    expect(await hasher.verify('x', 'not-a-hash')).toBe(false);
  });

  it('signale les hash à re-calculer quand les paramètres sont durcis', async () => {
    const weak = await hasher.hash('password-1234');
    expect(new ScryptPasswordHasher({ N: 2 ** 12, r: 8, p: 1 }).needsRehash(weak)).toBe(true);
    expect(hasher.needsRehash(weak)).toBe(false);
  });
});

describe('AccessTokenService', () => {
  const config = { secret: 's'.repeat(40), issuer: 'cura-api', audience: 'cura-clients', ttlSeconds: 900 };
  const service = new AccessTokenService(config);
  const principal = { sub: '3f1c2a6e-8b4d-4c1a-9e2f-1a2b3c4d5e6f', role: 'secretary' as const, pid: null, did: null };

  it('signe puis vérifie un jeton', () => {
    expect(service.verify(service.sign(principal))).toEqual(principal);
  });

  it('rejette un jeton altéré', () => {
    const token = service.sign(principal);
    const [h, , s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...principal, role: 'admin' })).toString('base64url');
    expect(service.verify(`${h}.${forged}.${s}`)).toBeNull();
  });

  it('rejette un jeton signé avec un autre secret', () => {
    const other = new AccessTokenService({ ...config, secret: 'o'.repeat(40) });
    expect(service.verify(other.sign(principal))).toBeNull();
  });

  it('rejette un jeton non signé (alg: none)', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ ...principal, iss: 'cura-api', aud: 'cura-clients' })).toString('base64url');
    expect(service.verify(`${header}.${payload}.`)).toBeNull();
  });

  it('rejette un jeton d’un autre émetteur', () => {
    const sign = createSigner({ key: config.secret, iss: 'evil', aud: config.audience });
    expect(service.verify(sign({ ...principal }))).toBeNull();
  });

  it('rejette un jeton expiré', () => {
    const sign = createSigner({ key: config.secret, iss: config.issuer, aud: config.audience, expiresIn: 1, clockTimestamp: Date.now() - 60_000 });
    expect(service.verify(sign({ ...principal }))).toBeNull();
  });
});

describe('utilitaires de jetons', () => {
  it('génère des jetons aléatoires uniques', () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('empreinte SHA-256 hexadécimale (format de la colonne token_hash)', () => {
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('compare à temps constant', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
