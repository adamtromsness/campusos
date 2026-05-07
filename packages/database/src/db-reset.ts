import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { execSync } from 'child_process';
import { resolve } from 'path';
import { getPlatformClient, executePlatformSQL, disconnectAll } from './client';

/**
 * db-reset — drop, recreate, migrate, seed in one command.
 *
 * The full reset path:
 *   1. Drop every `tenant_*` schema we can find (CASCADE).
 *   2. Drop the platform schema (CASCADE).
 *   3. Recreate platform schema empty.
 *   4. `prisma migrate deploy` — apply every platform migration to
 *      the fresh schema.
 *   5. `seed-all.ts` — run the full demo-data orchestrator (which
 *      provisions tenant_demo via `seed.ts` step 1 and then layers
 *      every domain seed in order).
 *
 * The drop-first ordering matters: tenant schemas must drop BEFORE
 * the platform schema because their soft cross-schema refs survive
 * a platform-only drop and would dangle.
 *
 * Refuses to run when DATABASE_URL points at anything that doesn't
 * look like a local dev database. Production-grade safety: a
 * destructive script must NEVER be one keystroke away from wiping a
 * pilot tenant. The check looks for `localhost`, `127.0.0.1`, or a
 * `_dev` / `_test` suffix in the database name.
 *
 * Usage:
 *   pnpm db:reset                       (from repo root)
 *   pnpm --filter @campusos/database db:reset
 */
async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL || '';
  if (!isLocalDevDatabase(dbUrl)) {
    console.error('db:reset refuses to run against this DATABASE_URL.');
    console.error('  Reset is only allowed against localhost/127.0.0.1 hosts');
    console.error('  with a database name suffix of _dev or _test.');
    console.error('  Got: ' + maskUrl(dbUrl));
    process.exit(1);
  }

  console.log('CampusOS — db:reset (drop + recreate + migrate + seed)');
  console.log('  target: ' + maskUrl(dbUrl));
  console.log('');

  // ── 1. Discover and drop every tenant_* schema ────────────────
  const platformClient = getPlatformClient();
  const tenantSchemas = (await platformClient.$queryRawUnsafe(
    `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant\\_%' ESCAPE '\\'`,
  )) as Array<{ schema_name: string }>;

  if (tenantSchemas.length === 0) {
    console.log('  No tenant schemas to drop.');
  } else {
    for (const row of tenantSchemas) {
      const name = row.schema_name;
      // Defence-in-depth — only drop names that match the tenant_ prefix.
      if (!/^tenant_[a-z0-9_]+$/.test(name)) {
        console.warn('  Skipping schema ' + name + ' (does not match tenant_ pattern)');
        continue;
      }
      await executePlatformSQL('DROP SCHEMA "' + name + '" CASCADE');
      console.log('  Dropped schema ' + name);
    }
  }

  // ── 2. Drop platform schema ───────────────────────────────────
  await executePlatformSQL('DROP SCHEMA IF EXISTS "platform" CASCADE');
  console.log('  Dropped schema platform');

  // ── 3. Recreate platform schema empty ─────────────────────────
  await executePlatformSQL('CREATE SCHEMA "platform"');
  console.log('  Created schema platform');

  // Disconnect the platform client before the child processes run —
  // they open their own clients via Prisma.
  await disconnectAll();
  console.log('');

  const packageRoot = resolve(__dirname, '..');

  // ── 4. Prisma migrate deploy (platform) ───────────────────────
  console.log('▶ prisma migrate deploy (platform)');
  execSync('npx prisma migrate deploy --schema=prisma/platform/schema.prisma', {
    cwd: packageRoot,
    stdio: 'inherit',
    env: process.env,
  });
  console.log('');

  // ── 5. Full demo seed (provisions tenant_demo + all domain data)
  console.log('▶ seed-all (provisions tenant_demo + every domain seed)');
  execSync('tsx src/seed-all.ts', {
    cwd: packageRoot,
    stdio: 'inherit',
    env: process.env,
  });

  console.log('');
  console.log('db:reset complete — fresh demo state ready.');
}

/**
 * A DATABASE_URL is considered a local dev target when:
 *   - host is localhost OR 127.0.0.1, AND
 *   - database name ends in _dev or _test, OR
 *   - URL does not parse to a remote host (defensive fallback).
 *
 * Anything pointing at a remote AWS/Stripe/etc. host is rejected.
 */
function isLocalDevDatabase(url: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0') {
    return false;
  }
  // Database name is the path segment after the leading slash.
  const dbName = (parsed.pathname || '').replace(/^\//, '').toLowerCase();
  if (!dbName) return false;
  return dbName.endsWith('_dev') || dbName.endsWith('_test') || dbName === 'campusos_dev';
}

function maskUrl(url: string): string {
  // Hide password component for log lines.
  return url.replace(/:[^:@/]+@/, ':***@');
}

main().catch((e: unknown) => {
  console.error('db:reset failed:', e);
  disconnectAll().finally(() => process.exit(1));
});
