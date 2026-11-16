/**
 * CLI de migration.
 *   migrate up              applique les migrations en attente
 *   migrate down [n]        annule les n dernières (défaut 1) — refusé en production
 *   migrate status          état de chaque migration
 *   migrate create <nom>    crée NNNN_nom.up.sql / .down.sql
 */
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { EnvObject } from './config/env';
import { Migrator } from './infra/db/migrator';

async function main(): Promise<void> {
  const [command = 'status', arg] = process.argv.slice(2);
  const env = EnvObject.pick({ NODE_ENV: true, MIGRATIONS_DIR: true }).parse(process.env);
  const dir = resolve(process.cwd(), env.MIGRATIONS_DIR);

  if (command === 'create') {
    if (!arg) throw new Error('Usage : migrate create <nom>');
    const files = await new Migrator(null as unknown as Pool, dir).create(arg);
    files.forEach((f) => console.log(`créé : ${f}`));
    return;
  }

  const { DATABASE_URL, DATABASE_SSL } = EnvObject.pick({ DATABASE_URL: true, DATABASE_SSL: true }).parse(process.env);
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, ssl: DATABASE_SSL ? { rejectUnauthorized: true } : undefined });
  const migrator = new Migrator(pool, dir, { info: (m) => console.log(m) });
  const database = new URL(DATABASE_URL).pathname.slice(1);

  try {
    switch (command) {
      case 'up': {
        const done = await migrator.up();
        console.log(done.length ? `${done.length} migration(s) appliquée(s) sur « ${database} »` : `« ${database} » est à jour`);
        break;
      }
      case 'down': {
        if (env.NODE_ENV === 'production') throw new Error('migrate down est interdit en production : écrivez une migration corrective.');
        const steps = arg ? Number(arg) : 1;
        if (!Number.isInteger(steps) || steps < 1) throw new Error('n doit être un entier ≥ 1');
        await migrator.down(steps);
        break;
      }
      case 'status':
        for (const m of await migrator.status()) console.log(`${m.applied ? '✔' : '·'} ${m.version}_${m.name}`);
        break;
      default:
        throw new Error(`Commande inconnue : ${command}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
