import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';

// Load env from repo root (.env.local takes precedence). Vitest runs
// the integration suite from apps/api/, so `../..` resolves to the
// monorepo root.
dotenvConfig({
  path: [resolve(__dirname, '../../../../.env.local'), resolve(__dirname, '../../../../.env')],
});

import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'child_process';
import { ensurePlatformFixtures, assertPlatformFixtures } from './fixtures/platform';
import { ensureEmployeeFixtures, assertEmployeeFixtures } from './fixtures/employees';
import { ensureFinanceFixtures, assertFinanceFixtures } from './fixtures/finance';
import { TEST_SCHEMA } from './helpers/tenant-context';

/**
 * Production-grade safety: refuse to touch a DB that isn't a local dev
 * or test database. Mirrors the check in packages/database/src/db-reset.ts.
 *
 * The integration suite seeds platform.organisations + platform.schools +
 * platform.iam_person and provisions tenant_test if missing — none of
 * which should ever happen against a production or pilot DB.
 */
function ensureLocalDevDatabase(): void {
  const url = process.env.DATABASE_URL || '';
  const masked = url.replace(/:[^:@/]+@/, ':***@');
  const isLocal = /(localhost|127\.0\.0\.1)/.test(url);
  const hasDevOrTestSuffix = /_(dev|test)(\?|$)/.test(url);
  if (!isLocal || !hasDevOrTestSuffix) {
    throw new Error(
      'Integration tests refuse non-local DATABASE_URL.\n' +
        '  Got: ' +
        masked +
        '\n' +
        '  Allowed: localhost/127.0.0.1 with database name ending in _dev or _test.',
    );
  }
}

/**
 * If the test schema doesn't have procurement tables yet (the canonical
 * "is this schema provisioned" check), shell out to provision-tenant.ts
 * to migrate it. Idempotent — the migration runner uses CREATE TABLE
 * IF NOT EXISTS so re-runs are safe but slow; the to_regclass check
 * short-circuits on the common case.
 */
async function ensureTenantTestSchema(prisma: PrismaClient): Promise<void> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT to_regclass('${TEST_SCHEMA}.prc_procurement_settings')::text AS reg`,
  )) as Array<{ reg: string | null }>;
  if (rows[0]?.reg) {
    return;
  }

  console.log('[integration-setup] provisioning ' + TEST_SCHEMA + ' (one-time)...');
  const result = spawnSync(
    'pnpm',
    [
      '--filter',
      '@campusos/database',
      'exec',
      'tsx',
      'src/provision-tenant.ts',
      '--subdomain=test',
    ],
    { stdio: 'inherit', encoding: 'utf-8' },
  );
  if (result.status !== 0) {
    throw new Error(
      'Failed to provision ' +
        TEST_SCHEMA +
        '. Run `pnpm --filter @campusos/database exec tsx src/provision-tenant.ts --subdomain=test` manually to diagnose.',
    );
  }

  // Re-verify after provisioning
  const recheck = (await prisma.$queryRawUnsafe(
    `SELECT to_regclass('${TEST_SCHEMA}.prc_procurement_settings')::text AS reg`,
  )) as Array<{ reg: string | null }>;
  if (!recheck[0]?.reg) {
    throw new Error(
      'Provisioning reported success but ' +
        TEST_SCHEMA +
        '.prc_procurement_settings still does not exist.',
    );
  }
}

/**
 * Vitest globalSetup entrypoint. Runs once per `vitest run` (or watch
 * session start), before any test file is loaded. The returned function
 * runs at teardown — currently a no-op since the platform fixtures
 * remain across runs by design (they're test infrastructure).
 */
export default async function setup(): Promise<() => Promise<void>> {
  ensureLocalDevDatabase();

  const prisma = new PrismaClient();
  await prisma.$connect();

  try {
    await ensureTenantTestSchema(prisma);
    await ensurePlatformFixtures(prisma);
    await ensureEmployeeFixtures(prisma);
    await ensureFinanceFixtures(prisma);
    await assertPlatformFixtures(prisma);
    await assertEmployeeFixtures(prisma);
    await assertFinanceFixtures(prisma);
  } finally {
    await prisma.$disconnect();
  }

  return async function teardown() {
    // No-op. Platform + employee fixtures persist across runs by design
    // (they're stable test infrastructure). Procurement-table cleanup is
    // per-test via helpers/reset.ts.
  };
}
