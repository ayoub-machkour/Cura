/**
 * Exécuté UNE fois avant les tests d'intégration :
 * 1. garde-fou : refuse de tourner sur une base qui n'est pas une base de test ;
 * 2. repart d'un schéma vide et applique toutes les migrations (teste aussi les migrations).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { Migrator } from '../../src/infra/db/migrator';
import { assertTestEnvironment } from './guard';

export default async function setup(): Promise<void> {
  const root = resolve(__dirname, '../../../..');
  const file = [resolve(root, '.env.test'), resolve(root, '.env.test.example')].find(existsSync);
  const env = { ...(file ? parse(readFileSync(file)) : {}), ...process.env } as Record<string, string>;
  assertTestEnvironment(env);

  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await new Migrator(pool, resolve(__dirname, '../../', env.MIGRATIONS_DIR ?? '../../packages/db/migrations')).up();
  } catch (err) {
    throw new Error(
      `Base de test injoignable ou migrations en échec. Lancez : docker compose up -d postgres-test redis-test\n${String(err)}`,
    );
  } finally {
    await pool.end();
  }
}
