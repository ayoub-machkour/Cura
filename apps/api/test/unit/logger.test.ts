import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildLoggerOptions } from '../../src/infra/logger';

/** Capture les lignes JSON produites par le logger configuré comme en production. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  const logger = pino(buildLoggerOptions({ LOG_LEVEL: 'info', LOG_PRETTY: false, NODE_ENV: 'production' }), stream);
  return { logger, lines };
}

describe('logger', () => {
  it('produit du JSON horodaté ISO avec le service et l’environnement', () => {
    const { logger, lines } = capture();
    logger.info({ event: 'appointment.booked' }, 'ok');
    expect(lines[0]).toMatchObject({ service: 'cura-api', env: 'production', event: 'appointment.booked', msg: 'ok' });
    expect(String(lines[0]!.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('masque mots de passe, jetons et cookies', () => {
    const { logger, lines } = capture();
    logger.info({
      body: { password: 'secret-pass', refreshToken: 'rt', holdToken: 'ht' },
      req: { headers: { authorization: 'Bearer abc', cookie: 'cura_at=abc' }, method: 'GET', url: '/x' },
    }, 'sensitive');
    const out = JSON.stringify(lines[0]);
    for (const secret of ['secret-pass', '"rt"', '"ht"', 'Bearer abc', 'cura_at=abc']) expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('ne journalise pas la query string (peut contenir un nom de patient)', () => {
    const { logger, lines } = capture();
    logger.info({ req: { method: 'GET', url: '/api/v1/patients?q=benali', headers: {} } }, 'incoming');
    expect((lines[0]!.req as { url: string }).url).toBe('/api/v1/patients');
  });
});
