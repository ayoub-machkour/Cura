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
