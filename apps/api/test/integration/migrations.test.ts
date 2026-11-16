import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Migrator } from '../../src/infra/db/migrator';

const MIGRATIONS = resolve(__dirname, '../../../../packages/db/migrations');
let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
});
afterAll(async () => pool.end());

describe('migrations', () => {
  it('toutes les migrations sont appliquées sur la base de test', async () => {
    const status = await new Migrator(pool, MIGRATIONS).status();
    expect(status.length).toBeGreaterThan(0);
    expect(status.every((m) => m.applied)).toBe(true);
  });

  it('chaque migration a son script de retour arrière', async () => {
    const files = await readdir(MIGRATIONS);
    const ups = files.filter((f) => f.endsWith('.up.sql'));
    for (const up of ups) expect(files).toContain(up.replace('.up.sql', '.down.sql'));
  });

  it('down puis up : la dernière migration est réversible', async () => {
    const migrator = new Migrator(pool, MIGRATIONS);
    const [undone] = await migrator.down(1);
    expect(undone).toBeDefined();
    expect((await migrator.status()).find((m) => m.version === undone)?.applied).toBe(false);
    expect(await migrator.up()).toEqual([undone]);
  });

  it('refuse d’exécuter si une migration appliquée a été modifiée', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cura-migrations-'));
    try {
      await cp(MIGRATIONS, dir, { recursive: true });
      const first = (await readdir(dir)).find((f) => f.endsWith('.up.sql'))!;
      await writeFile(join(dir, first), '-- modifié après coup\nSELECT 1;');
      await expect(new Migrator(pool, dir).up()).rejects.toThrow(/modifiée après application/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
