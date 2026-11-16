import { describe, expect, it } from 'vitest';
import { BadRequestError } from '../../src/common/errors';
import { decodeCursor, encodeCursor, TimeIdCursor, toPage } from '../../src/common/pagination';

const id = '3f1c2a6e-8b4d-4c1a-9e2f-1a2b3c4d5e6f';

describe('pagination par curseur', () => {
  it('encode puis décode un curseur (aller-retour)', () => {
    const cursor = encodeCursor(['2026-11-16T10:00:00.000Z', id]);
    expect(decodeCursor(cursor, TimeIdCursor)).toEqual(['2026-11-16T10:00:00.000Z', id]);
  });

  it('ignore un curseur absent', () => {
    expect(decodeCursor(undefined, TimeIdCursor)).toBeUndefined();
  });

  it.each([
    ['base64 invalide', '%%%'],
    ['JSON non conforme', encodeCursor(['pas-une-date', id])],
    ['injection SQL', encodeCursor(["2026-11-16T10:00:00Z'; DROP TABLE patients;--", id])],
  ])('rejette un curseur forgé (%s) avec une erreur 400', (_label, cursor) => {
    expect(() => decodeCursor(cursor, TimeIdCursor)).toThrow(BadRequestError);
  });

  it('détecte la page suivante grâce à la ligne supplémentaire', () => {
    const rows = [1, 2, 3].map((n) => ({ n, id }));
    const page = toPage(rows, 2, (r) => r.n, (r) => [r.n, r.id]);
    expect(page.data).toEqual([1, 2]);
    expect(page.page.hasMore).toBe(true);
    expect(page.page.nextCursor).toBe(encodeCursor([2, id]));
  });

  it('dernière page : pas de curseur suivant', () => {
    const page = toPage([{ n: 1, id }], 2, (r) => r.n, (r) => [r.n, r.id]);
    expect(page.page).toEqual({ limit: 2, hasMore: false, nextCursor: null });
  });
});
