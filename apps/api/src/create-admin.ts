/**
 * Crée le premier compte administrateur (amorçage d'une installation).
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... pnpm --filter @cura/api create-admin
 */
import { Pool } from 'pg';
import { z } from 'zod';
import { Email, Password } from '@cura/shared';
import { ScryptPasswordHasher } from './common/security/password-hasher';
import { EnvObject } from './config/env';
import { AuthRepository } from './modules/auth/auth.repository';

async function main(): Promise<void> {
  const env = EnvObject.pick({ DATABASE_URL: true, DATABASE_SSL: true })
    .extend({ ADMIN_EMAIL: Email, ADMIN_PASSWORD: Password })
    .parse(process.env);

  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1, ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined });
  try {
    const repo = new AuthRepository(pool);
    const user = await repo.createUser({
      email: env.ADMIN_EMAIL,
      passwordHash: await new ScryptPasswordHasher().hash(env.ADMIN_PASSWORD),
      role: 'admin',
    });
    console.log(`Administrateur créé : ${user.email} (${user.id})`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof z.ZodError) console.error(z.prettifyError(err));
  else console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
