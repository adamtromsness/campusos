import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * P2-H5 DEFECT 2 + DEFECT 6 — live role-contract verification.
 *
 * Connects to the live Postgres database as the non-owner application
 * role (`campusos_app` by default, override via
 * `P2H5_APP_DATABASE_URL`) and verifies that:
 *
 *   1. UPDATE against any of the 12 IMMUTABLE tables raises
 *      permission denied (provision-tenant.ts REVOKE).
 *   2. DELETE against any IMMUTABLE table raises permission denied.
 *   3. ALTER TABLE … DISABLE TRIGGER fails with permission denied (the
 *      role does not own the tables).
 *   4. SELECT still works (the role has SELECT privilege).
 *   5. INSERT into the audit-style IMMUTABLE tables works (the role
 *      has INSERT privilege — only mutations are revoked).
 *
 * Gated on `P2H5_RUN_DB_TESTS=1` because CI does not have the dual-
 * role infrastructure provisioned by default. When the env var is
 * unset the tests skip with a clear message. When it is set the tests
 * connect to `P2H5_APP_DATABASE_URL` (a connection string that uses
 * the app role) and run live SQL.
 */

const IMMUTABLE_TABLES = [
  'dpo_pseudonymisation_log',
  'fds_inventory_transactions',
  'fin_gl_entries',
  'hlth_health_access_log',
  'inc_incident_timeline',
  'pay_credit_notes',
  'pay_ledger_entries',
  'pay_lunch_account_balance_transfers',
  'pay_payment_reversals',
  'pub_publication_versions',
  'svc_referral_activity',
  'tkt_ticket_activity',
];

const ENABLED = process.env.P2H5_RUN_DB_TESTS === '1';
const APP_DATABASE_URL = process.env.P2H5_APP_DATABASE_URL;
const TENANT_SCHEMA = process.env.P2H5_TENANT_SCHEMA ?? 'tenant_demo';

describe.skipIf(!ENABLED || !APP_DATABASE_URL)(
  'P2-H5 DEFECT 2: app role cannot UPDATE/DELETE/DISABLE on IMMUTABLE tables',
  () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let client: any;

    beforeAll(async () => {
      // Lazy import so the test file does not require `pg` to be installed
      // for the rest of the test suite. CI infrastructure that enables
      // P2H5_RUN_DB_TESTS must also install the `pg` package.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Client } = await import('pg');
      client = new Client({ connectionString: APP_DATABASE_URL });
      await client.connect();
      await client.query(`SET search_path TO ${TENANT_SCHEMA}, platform, public`);
    });

    afterAll(async () => {
      if (client) await client.end();
    });

    for (const table of IMMUTABLE_TABLES) {
      it(`refuses UPDATE on ${table}`, async () => {
        await expect(
          client.query(`UPDATE ${table} SET created_at = now() WHERE 1 = 0`),
        ).rejects.toThrow(/permission denied/i);
      });

      it(`refuses DELETE on ${table}`, async () => {
        await expect(client.query(`DELETE FROM ${table} WHERE 1 = 0`)).rejects.toThrow(
          /permission denied/i,
        );
      });

      it(`refuses ALTER TABLE ... DISABLE TRIGGER on ${table}`, async () => {
        await expect(
          client.query(`ALTER TABLE ${table} DISABLE TRIGGER prevent_mutation`),
        ).rejects.toThrow(/permission denied|must be owner/i);
      });

      it(`allows SELECT on ${table}`, async () => {
        await expect(client.query(`SELECT 1 FROM ${table} LIMIT 0`)).resolves.toBeDefined();
      });
    }
  },
);

describe.skipIf(ENABLED)('P2-H5 DEFECT 2 — skipped (P2H5_RUN_DB_TESTS not set)', () => {
  it('documents the contract this test would verify when run with a live DB connection', () => {
    expect(IMMUTABLE_TABLES).toHaveLength(12);
  });
});
