/**
 * Relais de l'outbox transactionnel → diffusion temps réel.
 *
 * Garanties :
 * - « au moins une fois » : un événement est marqué publié dans la MÊME transaction
 *   que sa lecture ; si le COMMIT échoue après l'émission, il sera ré-émis (les
 *   clients dédupliquent par `id`). Aucun événement n'est perdu.
 * - multi-instance : FOR UPDATE SKIP LOCKED répartit les lots sans doublon concurrent.
 * - un événement invalide est journalisé puis écarté : il ne bloque jamais la file.
 */
import type { TransactionManager } from '../../infra/db/transaction';
import type { AppLogger } from '../../infra/logger';
import type { OutboxRecord, OutboxRepository } from './outbox.repository';

export interface EventPublisher {
  /** Doit être synchrone et ne pas lever pour un événement valide. Retourne false si l'événement est écarté. */
  publish(event: OutboxRecord): boolean;
}

export interface OutboxRelayConfig {
  intervalMs: number;
  batchSize: number;
  retentionDays: number;
  /** Fréquence de la purge des événements publiés. */
  purgeEveryMs: number;
}

const ERROR_BACKOFF_MS = 5_000;

export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private lastPurge = 0;

  constructor(
    private readonly deps: {
      tx: TransactionManager;
      outbox: OutboxRepository;
      publisher: EventPublisher;
      logger: AppLogger;
      config: OutboxRelayConfig;
    },
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.deps.logger.info({ intervalMs: this.deps.config.intervalMs }, 'outbox relay started');
    this.schedule(0);
  }

  /** Arrêt propre : attend la fin du lot en cours. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
    this.deps.logger.info('outbox relay stopped');
  }

  /** Traite un lot. Public pour les tests (exécution déterministe). Retourne le nombre d'événements traités. */
  async tick(): Promise<number> {
    const { tx, outbox, publisher, logger, config } = this.deps;
    return tx.run(async (db) => {
      const events = await outbox.claimBatch(config.batchSize, db);
      if (events.length === 0) return 0;

      for (const event of events) {
        let delivered = false;
        try {
          delivered = publisher.publish(event);
        } catch (err) {
          logger.error({ err, eventId: event.id, eventType: event.eventType }, 'outbox event publish threw — dropped');
        }
        if (!delivered) logger.error({ eventId: event.id, eventType: event.eventType }, 'outbox event not delivered — dropped');
      }
      await outbox.markPublished(events.map((e) => e.id), db);
      logger.debug({ count: events.length, lastId: events.at(-1)!.id }, 'outbox batch relayed');
      return events.length;
    });
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.loop();
    }, delayMs);
  }

  private async loop(): Promise<void> {
    const { config, logger } = this.deps;
    try {
      const processed = await this.tick();
      await this.maybePurge();
      // Lot plein : il reste probablement des événements → on enchaîne sans attendre.
      this.schedule(processed === config.batchSize ? 0 : config.intervalMs);
    } catch (err) {
      logger.error({ err }, 'outbox relay tick failed — retrying');
      this.schedule(ERROR_BACKOFF_MS);
    }
  }

  private async maybePurge(): Promise<void> {
    const { config, outbox, logger } = this.deps;
    if (Date.now() - this.lastPurge < config.purgeEveryMs) return;
    this.lastPurge = Date.now();
    const purged = await outbox.purgePublished(config.retentionDays);
    if (purged > 0) logger.info({ purged }, 'published outbox events purged');
  }
}
