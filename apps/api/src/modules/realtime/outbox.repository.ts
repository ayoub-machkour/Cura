import type { Pool } from 'pg';
import type { Db } from '../../infra/db/transaction';

export interface OutboxRecord {
  /** bigint sérialisé en chaîne (pas de perte de précision). */
  id: string;
  eventType: string;
  payload: unknown;
  createdAt: Date;
}

export class OutboxRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Réserve un lot d'événements non publiés. SKIP LOCKED : plusieurs instances de
   * l'API relaient en parallèle sans jamais traiter le même événement en même temps.
   */
  async claimBatch(limit: number, tx: Db): Promise<OutboxRecord[]> {
    const { rows } = await tx.query<OutboxRecord>(
      `SELECT id::text AS id, event_type AS "eventType", payload, created_at AS "createdAt"
         FROM outbox_events
        WHERE published_at IS NULL
        ORDER BY id
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return rows;
  }

  async markPublished(ids: string[], tx: Db): Promise<void> {
    await tx.query(`UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::bigint[])`, [ids]);
  }

  /** Supprime les événements publiés depuis plus de `days` jours, par lots (pas de verrou long). */
  async purgePublished(days: number, batchSize = 1000): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM outbox_events
        WHERE id IN (
          SELECT id FROM outbox_events
           WHERE published_at < now() - make_interval(days => $1)
           LIMIT $2
        )`,
      [days, batchSize],
    );
    return rowCount ?? 0;
  }

  async pendingCount(): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`);
    return rows[0]?.n ?? 0;
  }
}
