import { buildApp } from './app';
import { InvalidEnvError, loadEnv } from './config/env';
import { createContainer } from './container';
import { createLogger } from './infra/logger';
import { createOutboxRelay } from './modules/realtime/create-relay';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);
  const container = createContainer(env, logger);
  const app = await buildApp(container);
  const relay = createOutboxRelay(container, app);

  // Arrêt propre (docker stop, déploiement) : on finit les requêtes en cours, puis on ferme les connexions.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    try {
      await relay.stop(); // termine le lot en cours avant de fermer les connexions
      await app.close();
      await container.close();
      clearTimeout(force);
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection');
  });

  await app.listen({ host: env.HOST, port: env.PORT });
  relay.start();
}

main().catch((err: unknown) => {
  // Avant que le logger existe (ex. configuration invalide) : sortie lisible sur stderr.
  console.error(err instanceof InvalidEnvError ? err.message : err);
  process.exit(1);
});
