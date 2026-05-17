import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest config for DATABASE-BACKED integration tests. Separate from
 * `vitest.config.ts` (unit tests) so:
 *
 *   - Dev can run `pnpm test` without a live Postgres.
 *   - CI runs both `test` and `test:integration` as separate jobs.
 *   - The unit test glob (`src/**\/*.spec.ts` via the unit config's
 *     `root: './src'`) doesn't accidentally pick up integration specs.
 *
 * Per the design doc:
 *   D1 — schema lifecycle: tenant_test, provisioned once by setup.ts
 *   D2 — isolation: serial execution via single-fork pool; per-test
 *        truncate via helpers/reset.ts
 *   D5 — opt-in: `test:integration` script (added to package.json)
 *   D6 — file naming: `.spec.ts` under test/integration/
 *
 * No coverage thresholds in Loop 2 — the trivial spec exercises a tiny
 * surface area; coverage assertions land once the full procurement
 * test suite exists (Loops 3-5).
 */
export default defineConfig({
  test: {
    globals: true,
    root: '.',
    environment: 'node',
    include: ['test/integration/**/*.spec.ts'],
    globalSetup: './test/integration/setup.ts',
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true, // D2 — tests share tenant_test, must serialise
      },
    },
    testTimeout: 30_000, // DB round trips are slower than unit tests
    hookTimeout: 60_000, // First-run setup may shell out to provision-tenant
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Match the unit suite's exclude so module coverage compares cleanly
      // (DTOs are class-validator decorators, *.module.ts is NestJS DI wiring;
      // neither carries executable business logic worth measuring).
      exclude: [
        '**/*.module.ts',
        '**/dto/**',
        '**/*.dto.ts',
        '**/*.spec.ts',
        '**/main.ts',
        'test/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
