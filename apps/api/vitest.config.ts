import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/** Variables de test : .env.test si présent, sinon le modèle versionné (valeurs factices). */
function loadTestEnv(): Record<string, string> {
  const root = resolve(__dirname, '../..');
  const file = [resolve(root, '.env.test'), resolve(root, '.env.test.example')].find(existsSync);
  return file ? parse(readFileSync(file)) : {};
}

const env = loadTestEnv();

export default defineConfig({
  test: {
    env,
    // Une seule base de test partagée : les fichiers s'exécutent l'un après l'autre.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Points d'entrée CLI (démarrage du process) : vérifiés par le smoke test Docker, pas par les tests.
      exclude: ['src/main.ts', 'src/migrate.ts', 'src/create-admin.ts'],
      reporter: ['text-summary', 'text'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
