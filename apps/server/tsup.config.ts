import { defineConfig } from 'tsup';

/**
 * Bundles the server and the workspace packages into dist/. Third-party runtime dependencies
 * (fastify, pg, @electric-sql/pglite, ws, bcryptjs, jose, zod) stay external and are installed
 * from apps/server/package.json at deploy time (see the Dockerfile).
 */
export default defineConfig({
  entry: { main: 'src/main.ts', 'cli/migrate': 'src/cli/migrate.ts', 'cli/hash-password': 'src/cli/hash-password.ts', 'cli/backtest': 'src/cli/backtest.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@cryptoalgo\//],
  splitting: false,
  shims: false,
});
