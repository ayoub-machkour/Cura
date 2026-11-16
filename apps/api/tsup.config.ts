import { defineConfig } from 'tsup';

/**
 * Bundle de production : un fichier par point d'entrée.
 * @cura/shared (TypeScript source) est intégré au bundle ; les autres dépendances
 * restent externes (installées par `pnpm deploy --prod`).
 */
export default defineConfig({
  entry: {
    main: 'src/main.ts',
    migrate: 'src/migrate.ts',
    'create-admin': 'src/create-admin.ts',
  },
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: ['@cura/shared'],
});
