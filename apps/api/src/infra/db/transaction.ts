import type { Pool, PoolClient } from 'pg';

/** Tout ce qui sait exécuter une requête : le pool (hors transaction) ou une connexion en transaction. */
export type Db = Pool | PoolClient;

export interface TransactionOptions {
  /** Durée max d'attente d'un verrou de ligne avant l'erreur 55P03 (lock_not_available). */
  lockTimeoutMs?: number;
}

/**
 * Unit of Work : la couche service délimite la transaction sans écrire de SQL.
 * COMMIT si `fn` réussit, ROLLBACK sinon ; connexion toujours rendue au pool
 * (et détruite si le ROLLBACK échoue, pour ne pas recycler une connexion corrompue).
 */
export class TransactionManager {
  constructor(private readonly pool: Pool) {}

  async run<T>(fn: (tx: PoolClient) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (options.lockTimeoutMs !== undefined) {
        // set_config(..., true) ≡ SET LOCAL, mais paramétrable (aucune interpolation SQL).
        await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${options.lockTimeoutMs}ms`]);
      }
      const result = await fn(client);
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
}

/** Codes SQLSTATE PostgreSQL. Utilisés UNIQUEMENT dans les repositories. */
export const PgErrorCode = {
  UniqueViolation: '23505',
  ForeignKeyViolation: '23503',
  CheckViolation: '23514',
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

export function isConstraintViolation(err: unknown, constraint: string): boolean {
  return isPgError(err) && err.constraint === constraint;
}
