import type { App } from '../../app';
import type { Container } from '../../container';
import { OutboxRelay } from './outbox.relay';
import { SocketIoPublisher } from './socket-io.publisher';

/** Assemble le relais outbox → Socket.io pour une application construite. */
export function createOutboxRelay(c: Container, app: App): OutboxRelay {
  const logger = c.logger.child({ module: 'outbox-relay' });
  return new OutboxRelay({
    tx: c.tx,
    outbox: c.repositories.outbox,
    publisher: new SocketIoPublisher(app.io, logger),
    logger,
    config: {
      intervalMs: c.env.OUTBOX_POLL_INTERVAL_MS,
      batchSize: c.env.OUTBOX_BATCH_SIZE,
      retentionDays: c.env.OUTBOX_RETENTION_DAYS,
      purgeEveryMs: 3_600_000,
    },
  });
}
