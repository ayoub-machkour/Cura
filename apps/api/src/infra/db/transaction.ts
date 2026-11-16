import type { Pool, PoolClient } from 'pg';

/** Connexion engagée dans une transaction. Marquage nominal pour éviter de passer un Pool par erreur. */
export type Tx = PoolClient & { readonly __brand: 'Tx' };

/** Tout ce qui sait exécuter une requête (lecture hors transaction possible). */
export type Queryable = Pool | PoolClient;

export interface TransactionOptions {
  /** Durée max d'attente d'un verrou de ligne avant l'erreur 55P03 (lock_not_available). */
  lockTimeoutMs?: number;
  /** Garde-fou contre une requête anormalement longue. */
  statementTimeoutMs?: number;
}

/**
 * Exécute `fn` dans une transaction READ COMMITTED.
 * COMMIT si `fn` réussit, ROLLBACK sinon ; la connexion est toujours rendue au pool
 * (et détruite si le ROLLBACK lui-même échoue, pour ne pas recycler une connexion corrompue).
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = await pool.connect();
  let releaseError: Error | undefined;

  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    // set_config(..., is_local = true) ≡ SET LOCAL, mais paramétrable (pas d'interpolation SQL).
    if (options.lockTimeoutMs !== undefined) {
      await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${options.lockTimeoutMs}ms`]);
    }
    if (options.statementTimeoutMs !== undefined) {
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [`${options.statementTimeoutMs}ms`]);
    }

    const result = await fn(client as Tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      releaseError = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(releaseError);
  }
}

/** Codes SQLSTATE PostgreSQL utilisés par la couche domaine. */
export const PgErrorCode = {
  UniqueViolation: '23505',
  ExclusionViolation: '23P01',
  LockNotAvailable: '55P03',
} as const;

export interface PgError extends Error {
  code: string;
  constraint?: string;
}

export function isPgError(err: unknown): err is PgError {
  return err instanceof Error && typeof (err as Partial<PgError>).code === 'string';
}
