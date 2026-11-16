import { Pool, types } from 'pg';
import type { AppLogger } from '../logger';
import type { Env } from '../../config/env';

// Les colonnes `date` (ex. date de naissance) restent des chaînes 'YYYY-MM-DD' :
// les convertir en Date JS introduirait des décalages de fuseau horaire.
types.setTypeParser(types.builtins.DATE, (v) => v);
// bigint (montants en centimes) → number. Sûr : bornés à 100 000 000 par les CHECK.
types.setTypeParser(types.builtins.INT8, (v) => Number(v));

export function createPool(env: Pick<Env, 'DATABASE_URL' | 'DATABASE_POOL_MAX' | 'DATABASE_SSL'>, logger: AppLogger): Pool {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Filet de sécurité global : aucune requête ne peut bloquer une connexion plus de 15 s.
    statement_timeout: 15_000,
    application_name: 'cura-api',
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
  });

  // Sans ce listener, une connexion inactive coupée par le serveur ferait crasher le process.
  pool.on('error', (err) => logger.error({ err }, 'postgres idle client error'));
  return pool;
}
