import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    environment: 'node',
    // Spec files live under test/unit/ (test strategy keeps src/ free of
    // *.spec.ts files). Integration specs live under test/integration/
    // and run via vitest.integration.config.ts — exclude here to avoid
    // double-discovery.
    include: ['test/unit/**/*.spec.ts'],
    exclude: ['test/integration/**', 'node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['**/*.module.ts', '**/dto/**', '**/*.dto.ts', '**/*.spec.ts', '**/main.ts'],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@modules': path.resolve(__dirname, './src/modules'),
      '@shared': path.resolve(__dirname, './src/shared'),
    },
  },
});
