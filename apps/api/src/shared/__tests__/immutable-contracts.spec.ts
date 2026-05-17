import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * P2-H4 Step 1 Tier 4 — IMMUTABLE contract regression.
 *
 * ADR-010 designates 12 tables as IMMUTABLE. They are append-only —
 * UPDATEs and DELETEs against any row are rejected by the DB trigger
 * `public.raise_immutable_violation()` attached by P2-H2 Step 3 in
 * tenant migration 177.
 *
 * This spec confirms:
 *
 *   1. All 12 tables are present in the trigger attachment list.
 *   2. The shared `raise_immutable_violation()` function is declared
 *      in the platform Prisma migration `20260516225445_p2h2_platform_schema_drift`.
 *   3. No service file under apps/api/src declares an UPDATE / DELETE
 *      statement against any of the 12 IMMUTABLE tables (the trigger
 *      catches direct-SQL writes; this regression catches accidental
 *      service-layer regressions before they ship).
 *
 * The runtime UPDATE/DELETE failure verification (attempt UPDATE →
 * SQLSTATE 23001) is a live integration test that requires a running
 * Postgres — covered by the manual smoke records in HANDOFF-P2H2.md
 * Step 3. Phase 3 ops wires a per-CI tenant + the live trigger test.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const TENANT_MIGRATION = join(
  REPO_ROOT,
  'packages',
  'database',
  'prisma',
  'tenant',
  'migrations',
  '177_p2h2_tenant_schema_drift_and_immutable_triggers.sql',
);
const PLATFORM_MIGRATION_DIR = join(
  REPO_ROOT,
  'packages',
  'database',
  'prisma',
  'platform',
  'migrations',
  '20260516225445_p2h2_platform_schema_drift',
);

const IMMUTABLE_TABLES = [
  'fin_gl_entries',
  'pay_credit_notes',
  'pay_payment_reversals',
  'pay_lunch_account_balance_transfers',
  'pay_ledger_entries',
  'fds_inventory_transactions',
  'pub_publication_versions',
  'svc_referral_activity',
  'tkt_ticket_activity',
  'hlth_health_access_log',
  'inc_incident_timeline',
  'dpo_pseudonymisation_log',
];

describe('P2-H4 Step 1 Tier 4 — IMMUTABLE contract', () => {
  describe('Every IMMUTABLE table has a prevent_mutation trigger in migration 177', () => {
    let migrationSrc: string;
    it('migration file is readable', () => {
      migrationSrc = readFileSync(TENANT_MIGRATION, 'utf8');
      expect(migrationSrc).toBeTruthy();
    });

    for (const table of IMMUTABLE_TABLES) {
      it(`${table} carries the prevent_mutation trigger`, () => {
        const src = readFileSync(TENANT_MIGRATION, 'utf8');
        const pattern = new RegExp(
          `CREATE TRIGGER prevent_mutation BEFORE UPDATE OR DELETE ON ${table}\\b[\\s\\S]*?EXECUTE FUNCTION public\\.raise_immutable_violation\\(\\)`,
          'i',
        );
        expect(pattern.test(src), `${table} missing trigger attachment in migration 177`).toBe(
          true,
        );
      });
    }
  });

  describe('The shared raise_immutable_violation() function is declared at the platform layer', () => {
    it('platform Prisma migration declares the function', () => {
      const sql = readFileSync(join(PLATFORM_MIGRATION_DIR, 'migration.sql'), 'utf8');
      expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.raise_immutable_violation/i);
    });

    it('function raises restrict_violation (SQLSTATE 23001) on UPDATE/DELETE', () => {
      const sql = readFileSync(join(PLATFORM_MIGRATION_DIR, 'migration.sql'), 'utf8');
      // SQLSTATE 23001 is restrict_violation. Postgres accepts either
      // the numeric code or the symbolic name in ERRCODE.
      expect(sql).toMatch(/ERRCODE\s*=\s*'(23001|restrict_violation)'/i);
    });
  });

  describe('No service file under apps/api/src writes UPDATE or DELETE against an IMMUTABLE table', () => {
    /**
     * This is the safety net — a service-layer regression on any
     * IMMUTABLE table would be caught by the trigger at runtime,
     * but having a CI gate is faster + cheaper than the integration
     * test loop.
     *
     * We use file-system grep across apps/api/src/**\/*.service.ts
     * looking for SQL strings of shape `UPDATE <table>` or
     * `DELETE FROM <table>`. False-positive note: the workers that
     * read-only-query an IMMUTABLE table for analytics are fine —
     * we filter to mutation strings only.
     */
    const { readdirSync, statSync } = require('fs');
    const API_SRC = join(REPO_ROOT, 'apps', 'api', 'src');

    function collectServiceFiles(): string[] {
      const out: string[] = [];
      function walk(dir: string) {
        const entries = readdirSync(dir);
        for (const e of entries) {
          const full = join(dir, e);
          const s = statSync(full);
          if (s.isDirectory()) {
            if (e === '__tests__' || e === 'node_modules' || e === 'dist' || e === 'coverage') {
              continue;
            }
            walk(full);
            continue;
          }
          if (e.endsWith('.service.ts') && !e.endsWith('.spec.ts')) out.push(full);
        }
      }
      walk(API_SRC);
      return out;
    }

    for (const table of IMMUTABLE_TABLES) {
      it(`no service writes UPDATE or DELETE to ${table}`, () => {
        const files = collectServiceFiles();
        const offenders: string[] = [];
        const updatePattern = new RegExp(`UPDATE\\s+${table}\\b`, 'i');
        const deletePattern = new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, 'i');
        for (const f of files) {
          const src = readFileSync(f, 'utf8');
          if (updatePattern.test(src) || deletePattern.test(src)) {
            offenders.push(f.substring(API_SRC.length + 1));
          }
        }
        expect(offenders, `${table} has writers: ${offenders.join(', ')}`).toEqual([]);
      });
    }
  });
});
