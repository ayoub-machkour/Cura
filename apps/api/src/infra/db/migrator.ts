/**
 * Migrateur SQL minimaliste et prévisible.
 *
 * Fichiers : NNNN_nom.up.sql (+ NNNN_nom.down.sql pour revenir en arrière).
 * - Chaque migration s'exécute dans SA transaction (tout ou rien).
 * - Un verrou consultatif empêche deux migrateurs concurrents (2 conteneurs au déploiement).
 * - Une somme de contrôle détecte toute modification d'une migration DÉJÀ appliquée :
 *   on ne réécrit pas l'histoire, on ajoute une nouvelle migration.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;
const LOCK_KEY = 727_001; // identifiant arbitraire du verrou consultatif

export interface MigrationFile {
  version: string;
  name: string;
  upPath: string;
  downPath?: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationLogger {
  info(msg: string): void;
}

/** Les fins de ligne sont normalisées : un checkout Windows (CRLF) ne change pas la somme. */
export const checksumOf = (sql: string) => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

export class Migrator {
  constructor(
    private readonly pool: Pool,
    private readonly dir: string,
    private readonly log: MigrationLogger = { info: () => {} },
  ) {}

  async listFiles(): Promise<MigrationFile[]> {
    const byVersion = new Map<string, MigrationFile>();
    for (const file of (await readdir(this.dir)).sort()) {
      const m = FILE_RE.exec(file);
      if (!m) continue;
      const [, version, name, direction] = m as unknown as [string, string, string, 'up' | 'down'];
      const entry = byVersion.get(version) ?? { version, name, upPath: '' };
      if (entry.name !== name) throw new Error(`Migration ${version}: noms up/down différents (${entry.name} ≠ ${name})`);
      if (direction === 'up') entry.upPath = join(this.dir, file);
      else entry.downPath = join(this.dir, file);
      byVersion.set(version, entry);
    }
    const files = [...byVersion.values()].sort((a, b) => a.version.localeCompare(b.version));
    for (const f of files) if (!f.upPath) throw new Error(`Migration ${f.version}_${f.name}: fichier .up.sql manquant`);
    return files;
  }

  async applied(client: Pool | PoolClient = this.pool): Promise<AppliedMigration[]> {
    await this.ensureTable(client);
    const { rows } = await client.query<AppliedMigration>(
      `SELECT version, name, checksum, applied_at AS "appliedAt" FROM schema_migrations ORDER BY version`,
    );
    return rows;
  }

  /** Applique toutes les migrations en attente. Retourne les versions appliquées. */
  async up(): Promise<string[]> {
    return this.withLock(async (client) => {
      const files = await this.listFiles();
      const applied = new Map((await this.applied(client)).map((m) => [m.version, m]));
      const done: string[] = [];

      for (const file of files) {
        const sql = await readFile(file.upPath, 'utf8');
        const existing = applied.get(file.version);
        if (existing) {
          if (existing.checksum !== checksumOf(sql)) {
            throw new Error(
              `La migration ${file.version}_${file.name} a été modifiée après application. ` +
                `Créez une nouvelle migration au lieu de modifier celle-ci.`,
            );
          }
          continue;
        }
        await this.inTransaction(client, async () => {
          await client.query(sql);
          await client.query(`INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`, [
            file.version,
            file.name,
            checksumOf(sql),
          ]);
        });
        this.log.info(`↑ ${file.version}_${file.name}`);
        done.push(file.version);
      }
      return done;
    });
  }

  /** Annule les `steps` dernières migrations. */
  async down(steps = 1): Promise<string[]> {
    return this.withLock(async (client) => {
      const files = new Map((await this.listFiles()).map((f) => [f.version, f]));
      const applied = (await this.applied(client)).reverse().slice(0, steps);
      const undone: string[] = [];

      for (const m of applied) {
        const file = files.get(m.version);
        if (!file?.downPath) throw new Error(`Migration ${m.version}_${m.name}: pas de fichier .down.sql`);
        const sql = await readFile(file.downPath, 'utf8');
        await this.inTransaction(client, async () => {
          await client.query(sql);
          await client.query(`DELETE FROM schema_migrations WHERE version = $1`, [m.version]);
        });
        this.log.info(`↓ ${m.version}_${m.name}`);
        undone.push(m.version);
      }
      return undone;
    });
  }

  async status(): Promise<{ version: string; name: string; applied: boolean }[]> {
    const applied = new Set((await this.applied()).map((m) => m.version));
    return (await this.listFiles()).map((f) => ({ version: f.version, name: f.name, applied: applied.has(f.version) }));
  }

  /** Crée la paire de fichiers de la prochaine migration. */
  async create(name: string): Promise<string[]> {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error('Nom de migration : minuscules, chiffres et _ uniquement');
    const files = await this.listFiles();
    const next = String(Number(files.at(-1)?.version ?? '0') + 1).padStart(4, '0');
    const up = join(this.dir, `${next}_${name}.up.sql`);
    const down = join(this.dir, `${next}_${name}.down.sql`);
    await writeFile(up, `-- ${next} — ${name}\n-- Pensez à refléter toute nouvelle règle dans packages/shared/src/constraints.ts\n\n`, { flag: 'wx' });
    await writeFile(down, `-- Annule ${next}_${name}\n\n`, { flag: 'wx' });
    return [up, down];
  }

  private async ensureTable(client: Pool | PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text        PRIMARY KEY,
        name       text        NOT NULL,
        checksum   char(64)    NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
  }

  private async withLock<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
      try {
        return await fn(client);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }

  private async inTransaction(client: PoolClient, fn: () => Promise<void>): Promise<void> {
    await client.query('BEGIN');
    try {
      await fn();
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
}
