/**
 * Les tests vident les tables : ils ne doivent JAMAIS pouvoir viser la base de dev ou de prod.
 */
export function assertTestEnvironment(env: Record<string, string | undefined>): void {
  if (env.NODE_ENV !== 'test') {
    throw new Error(`Tests refusés : NODE_ENV=${env.NODE_ENV ?? '(vide)'} (attendu : test)`);
  }
  const dbName = env.DATABASE_URL ? new URL(env.DATABASE_URL).pathname.slice(1) : '';
  if (!dbName.endsWith('_test')) {
    throw new Error(`Tests refusés : la base « ${dbName} » n'est pas une base de test (suffixe _test requis)`);
  }
  if (!env.REDIS_KEY_PREFIX?.includes('test')) {
    throw new Error('Tests refusés : REDIS_KEY_PREFIX doit contenir « test »');
  }
}
