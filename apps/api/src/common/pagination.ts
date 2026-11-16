/**
 * Pagination par curseur (keyset).
 *
 * Pourquoi pas OFFSET ? `OFFSET 10000` oblige PostgreSQL à lire puis jeter 10 000
 * lignes, et une insertion pendant la navigation décale les pages (doublons/oublis).
 * Le keyset reprend après la dernière clé vue : coût constant, résultats stables.
 *
 * Le curseur est opaque pour le client (base64url d'un tuple JSON) et REVALIDÉ
 * par Zod au décodage : un curseur forgé ne peut rien injecter.
 */
import { z } from 'zod';
import type { Page } from '@cura/shared';
import { BadRequestError } from './errors';

export function encodeCursor(values: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

export function decodeCursor<T extends z.ZodType>(cursor: string | undefined, schema: T): z.infer<T> | undefined {
  if (cursor === undefined) return undefined;
  try {
    const raw: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
  } catch {
    /* fallthrough */
  }
  throw new BadRequestError('INVALID_CURSOR', 'Curseur de pagination invalide');
}

/**
 * Les repositories demandent `limit + 1` lignes : la ligne en trop indique
 * qu'une page suivante existe, sans COUNT(*) coûteux.
 */
export function toPage<Row, Dto>(
  rows: Row[],
  limit: number,
  toDto: (row: Row) => Dto,
  cursorOf: (row: Row) => (string | number)[],
): Page<Dto> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    data: pageRows.map(toDto),
    page: { limit, hasMore, nextCursor: hasMore && last ? encodeCursor(cursorOf(last)) : null },
  };
}

/** Curseurs typiques. */
export const TimeIdCursor = z.tuple([z.iso.datetime({ offset: true }), z.uuid()]);
export const NameIdCursor = z.tuple([z.string().max(100), z.string().max(100), z.uuid()]);
