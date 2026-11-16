import { Redis } from 'ioredis';
import type { AppLogger } from './logger';
import type { Env } from '../config/env';

export function createRedis(env: Pick<Env, 'REDIS_URL' | 'REDIS_KEY_PREFIX'>, logger: AppLogger): Redis {
  const redis = new Redis(env.REDIS_URL, {
    keyPrefix: env.REDIS_KEY_PREFIX,
    // Échec rapide : une commande ne reste pas en file indéfiniment si Redis tombe.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    connectTimeout: 5_000,
    lazyConnect: false,
  });
  redis.on('error', (err) => logger.warn({ err: { message: err.message } }, 'redis error'));
  redis.on('ready', () => logger.info('redis ready'));
  return redis;
}
