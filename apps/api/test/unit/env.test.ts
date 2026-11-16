import { describe, expect, it } from 'vitest';
import { InvalidEnvError, loadEnv } from '../../src/config/env';

const valid = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://u:p@localhost:5432/cura_dev',
  REDIS_URL: 'redis://:p@localhost:6379/0',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  CORS_ORIGINS: 'http://localhost:5173, http://localhost:8081',
};

describe('loadEnv', () => {
  it('accepte une configuration valide et applique les valeurs par défaut', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:8081']);
    expect(env.COOKIE_SECURE).toBe(true);
    expect(env.SWAGGER_ENABLED).toBe(false);
  });

  it('rejette un secret JWT trop court sans jamais afficher sa valeur', () => {
    const secret = 'short-secret-value';
    const err = (() => {
      try {
        loadEnv({ ...valid, JWT_ACCESS_SECRET: secret });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidEnvError);
    expect((err as Error).message).toContain('JWT_ACCESS_SECRET');
    expect((err as Error).message).not.toContain(secret);
  });

  it('rejette une URL de base de données non PostgreSQL', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: 'mysql://u:p@localhost/db' })).toThrow(/DATABASE_URL/);
  });

  it('liste toutes les variables manquantes en une fois', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL[\s\S]*JWT_ACCESS_SECRET/);
  });

  it('impose les règles de production (cookies Secure, pas de Swagger)', () => {
    expect(() =>
      loadEnv({ ...valid, NODE_ENV: 'production', COOKIE_SECURE: 'false', SWAGGER_ENABLED: 'true' }),
    ).toThrow(/COOKIE_SECURE[\s\S]*SWAGGER_ENABLED/);
  });
});
