# Migration Orchestration Standard

**Production-launch prerequisite.** Defines the procedure for evolving the
CampusOS schema across multiple tenants safely.

P2-H4 Step 4 deliverable. Closes Plan IMP-04 and GPT SCL-01 audit findings.

## Why this document exists

CampusOS uses **schema-per-tenant** isolation per ADR-001. A tenant
migration must apply the same DDL to every tenant schema — potentially
hundreds or thousands of schemas. Naive `psql` or Prisma execution
against every schema sequentially blocks for minutes per tenant and
provides no recovery story when one tenant errors mid-batch.

This document is the operational standard for:

- Authoring tenant migrations safely.
- Scheduling rollouts to limit blast radius.
- Recovering from partial failures.
- Verifying schema drift after every deploy.

## Tenant capacity per cluster

| Tier                     | Tenants per Postgres cluster (initial) | Schema count     |
| ------------------------ | -------------------------------------- | ---------------- |
| Production launch        | 50                                     | 50               |
| 12 months in             | 200                                    | 200              |
| Phase 3 horizontal split | 500+ (split across clusters)           | per cluster: 200 |

The migration runtime cost scales with tenant count. Above 50 tenants a
parallel orchestrator is required (Phase 3 ops); below 50, sequential
execution from `tools/provision-tenant.ts` is acceptable.

## Authoring a tenant migration

### File location + numbering

Tenant migrations live at:

```
packages/database/prisma/tenant/migrations/NNN_<short_name>.sql
```

`NNN` is sequential across all tenant migrations (P2-H3 finished at 178).
Never re-use a number; never reorder; never edit a previously-applied
migration in place. Production CI fails if `NNN` collides with a
historical migration.

### Splitter caveats

The naive splitter at `apps/database/src/provision-tenant.ts:65`
splits on `;` — function bodies that contain `;` outside the SQL
statement terminator will break. Use these patterns:

- Comment terminators: end every `COMMENT ON ... IS '...'` string at
  a clean `.` rather than `;`. The splitter will cut a mid-comment `;`.
- Functions: put `CREATE FUNCTION` blocks in the **platform** Prisma
  migration (which uses Prisma migrate's dollar-quoted parsing), not
  the tenant SQL splitter. Tenant SQL may only `CREATE TRIGGER ...
EXECUTE FUNCTION public.<fn>(...)`.

### Idempotency

Every tenant migration must be idempotent — `provision-tenant.ts`
applies the full migration chain on every provision and on every
re-run. Use:

- `CREATE TABLE IF NOT EXISTS ...`
- `CREATE INDEX IF NOT EXISTS ...`
- `ALTER TABLE IF EXISTS ... ADD COLUMN IF NOT EXISTS ...`
- `DROP CONSTRAINT IF EXISTS ... ; ADD CONSTRAINT ...` for CHECK changes.
- No `INSERT INTO ... VALUES (...)` for seed data — seeds belong in
  `packages/database/src/seed-*.ts` files which are idempotent on
  gate-row presence.

### No destructive DDL

- No `DROP TABLE`.
- No `DROP COLUMN`.
- No `DROP CONSTRAINT` without an `ADD CONSTRAINT` follow-on.
- No `TRUNCATE`.

Schema evolution follows **expand / contract**:

1. **Expand** — add the new column nullable, add the new table, add a
   compatibility shim if needed.
2. **Backfill** — populate the new column from existing data via a
   service-layer worker (see Phase 3 ops for the standard `data-migration`
   worker pattern).
3. **Contract** — once every tenant has been backfilled, a follow-up
   tenant migration tightens the constraint (e.g. `ALTER TABLE ... ALTER
COLUMN ... SET NOT NULL`).

Removing a column is a three-migration sequence: stop writing → ship
the next release → drop the column. Production schemas have never run
the `DROP COLUMN` step yet; the expectation is that columns persist
indefinitely.

## Online index creation

Tenant migrations are **applied while the tenant is live** (the
`is_frozen` flag is reserved for cross-tenant ops events, not for
per-tenant migration windows). Use `CREATE INDEX CONCURRENTLY` for any
index on a populated table to avoid blocking writers:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_table_col
  ON table_name (col);
```

Constraints (CHECK, UNIQUE) cannot be added concurrently. Strategy:

1. Add the column nullable + CHECK that allows NULL.
2. Backfill.
3. Tighten the CHECK in a follow-up migration.

## Rollout sequencing

### Step 1 — Canary tenant

Apply the migration to `tenant_test` and `tenant_demo` first. Verify:

```bash
pnpm --filter @campusos/database provision --subdomain=test
pnpm --filter @campusos/database provision --subdomain=demo
```

Then run the test suite (`pnpm --filter @campusos/api test`) against
`tenant_test` and the smoke flow against `tenant_demo`. If anything
fails, the migration goes back to the author before any production
tenant runs it.

### Step 2 — Production canary

Pick 2 small production tenants (lowest student count, lowest
historical data volume). Apply the migration. Wait 1 hour. Verify:

- No new entries in `platform.platform_dlq_messages` for those tenants.
- `rpt_gl_reconciliation` (where applicable) is `CLEAN` after the next
  run.
- API error rate (per tenant) within historical baseline.
- No `platform_schema_drift_alerts` row for those tenants.

### Step 3 — Batch rollout

If canary is clean, batch the remaining production tenants in waves of 10. Wait 15 minutes between waves. Track per-tenant migration status in
a `migration_status` table on the platform schema:

```sql
CREATE TABLE IF NOT EXISTS platform.platform_migration_status (
  id UUID PRIMARY KEY,
  tenant_schema TEXT NOT NULL,
  migration_filename TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'IN_PROGRESS', 'APPLIED', 'FAILED')),
  applied_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_message TEXT,
  UNIQUE (tenant_schema, migration_filename)
);
```

The orchestrator reads this table to:

- Skip tenants that already have `APPLIED` status (resumable across
  restarts).
- Pause if any tenant lands `FAILED`.

Phase 3 ops will ship this orchestrator + the table. For Phase 2,
`provision-tenant.ts` walks all schemas sequentially without resumability;
acceptable below 50 tenants.

### Step 4 — Schema drift verification

After every deploy that ships a tenant migration:

```bash
pnpm --filter @campusos/database exec tsx tools/schema-drift-check.ts
```

This tool (Phase 3 ops; documented here) computes a hash of each
tenant's schema (table list + column list + constraint list) and
compares to the hash that the Prisma schema would produce. Any
discrepancy lands a row in `platform.platform_schema_drift_alerts`
which the on-call dashboard surfaces.

## is_frozen gate

The `platform.schools.is_frozen` flag has two purposes:

1. **Audit/billing freeze** — the school's data is read-only because
   a payment dispute or contract change is in progress.
2. **Schema DDL window** — the orchestrator flips `is_frozen=true`
   on the tenant during a backfill that mutates a large fraction of
   rows in a write-heavy table.

The `TenantGuard` (`apps/api/src/tenant/tenant.guard.ts`) refuses **all
writes** when `is_frozen=true` regardless of permission. Reads
continue to work. The frozen status is logged on the audit trail.

Use `is_frozen` sparingly — every minute frozen is downtime for the
school's UX. Prefer non-frozen backfills with batched UPDATEs of 1000
rows per commit.

## Failure rollback procedure

If a tenant migration fails on a single tenant:

1. The orchestrator (or `provision-tenant.ts`) leaves the tenant in
   the state Postgres returned — the failed statement is rolled back
   by the transaction, but any preceding statements in the migration
   that ran in their own transaction may have committed.
2. Inspect the error:
   ```sql
   SELECT * FROM platform.platform_migration_status
   WHERE tenant_schema = 'tenant_<x>' AND migration_filename = 'NNN_...sql';
   ```
3. Decide:
   - **Re-runnable**: the migration is idempotent (it should be) — retry
     via `provision-tenant.ts`.
   - **Conflict**: the failure is a real schema conflict — write a
     `NNN+1_correction.sql` migration that handles both the conflict
     state and the clean state via `IF EXISTS` / `IF NOT EXISTS`.

Do not edit the failed migration in place if any tenant has already
applied it cleanly.

If a global migration is fundamentally broken (e.g. wrong default value
that has now corrupted thousands of rows across hundreds of tenants),
the only recovery is a **forward fix**: ship a follow-up migration that
re-derives the correct state from operational data. Do not attempt to
restore a Postgres snapshot — this loses every customer transaction
since the snapshot.

## Communication template

Before any tenant migration goes to production:

- **T - 72 hours**: Engineering Lead + DPO sign-off on the migration
  file. Recorded in PR review.
- **T - 24 hours**: status post in the on-call channel naming the
  expected window and the canary tenants.
- **T - 0**: orchestrator starts; status post per wave.
- **T + 1 hour after final wave**: status post confirming clean. If
  any tenant is in `FAILED` state, list it + open an incident.

## Cross-references

- ADR-001 — Schema-per-tenant.
- ADR-024 — Partition management registry (`partition_mgmt_health`).
- ADR-031 — `is_frozen` semantics.
- `docs/retention-pseudonymisation-matrix.md` — retention worker
  scheduling.
- `docs/campusos-hardening-cycles.html` — P2-H2 schema drift fixes that
  established the schema drift alert framework.
