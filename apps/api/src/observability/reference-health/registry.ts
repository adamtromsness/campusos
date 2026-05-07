/**
 * REVIEW-FINAL P4 — Soft-FK reference registry.
 *
 * Per ADR-001/020/028, tenant tables MUST NOT carry DB-enforced FKs to
 * platform.* tables. Cross-schema soft refs (UUID columns + app-layer
 * validation) are the canonical pattern. The registry below is the
 * authoritative list of soft refs the
 * `ReferenceHealthScannerWorker` periodically scans for orphans.
 *
 * Each entry asserts: rows in `source.${sourceTable}.${sourceColumn}`
 * (filtered by `where`) should resolve to a row in
 * `target.${targetTable}.${targetColumn}`. The scanner counts source
 * rows whose value does NOT exist in target and writes one
 * `platform_reference_health` row per scan + entry.
 *
 * Adding a new soft-FK pattern: append an entry below. No schema
 * change, no service change. The worker's next poll picks it up.
 *
 * Each tenant-table source is scanned per tenant (the worker enters
 * tenant context for each row in `platform.schools` and applies the
 * scan to that tenant's schema).
 */

export interface SoftFkEntry {
  /** Friendly identifier for logs + metrics. */
  name: string;
  /**
   * Whether the source table lives in a per-tenant schema (TENANT)
   * or in the platform schema (PLATFORM). The worker iterates active
   * tenants for TENANT entries and scans once for PLATFORM entries.
   */
  scope: 'TENANT' | 'PLATFORM';
  sourceTable: string;
  sourceColumn: string;
  /** Optional WHERE filter on the source. e.g. `is_active = true`. */
  where?: string;
  /** Target schema. `platform` for cross-schema soft refs. */
  targetSchema: 'platform' | 'tenant';
  targetTable: string;
  /** Target column. Defaults to `id`. */
  targetColumn?: string;
}

/**
 * Initial registry covering the highest-volume cross-schema soft FKs
 * across the codebase. Per CLAUDE.md "Soft cross-schema refs (ADR-001/
 * 020/028)" these are the columns most likely to silently orphan
 * when a parent platform row is removed.
 *
 * The registry is intentionally not exhaustive — adding all ~150
 * documented soft refs at once is a separate cleanup task. This first
 * cut covers the highest-blast-radius patterns (auth identity,
 * household identity, invoicing).
 */
export const SOFT_FK_REGISTRY: ReadonlyArray<SoftFkEntry> = [
  // hr_employees → platform.iam_person identity bridge.
  {
    name: 'hr_employees.person_id → platform.iam_person',
    scope: 'TENANT',
    sourceTable: 'hr_employees',
    sourceColumn: 'person_id',
    targetSchema: 'platform',
    targetTable: 'iam_person',
  },
  // hr_employees → platform.platform_users portal account bridge.
  {
    name: 'hr_employees.account_id → platform.platform_users',
    scope: 'TENANT',
    sourceTable: 'hr_employees',
    sourceColumn: 'account_id',
    where: 'account_id IS NOT NULL',
    targetSchema: 'platform',
    targetTable: 'platform_users',
  },
  // sis_guardians → platform.iam_person.
  {
    name: 'sis_guardians.person_id → platform.iam_person',
    scope: 'TENANT',
    sourceTable: 'sis_guardians',
    sourceColumn: 'person_id',
    targetSchema: 'platform',
    targetTable: 'iam_person',
  },
  // sis_students → platform.platform_students transitive bridge.
  {
    name: 'sis_students.platform_student_id → platform.platform_students',
    scope: 'TENANT',
    sourceTable: 'sis_students',
    sourceColumn: 'platform_student_id',
    targetSchema: 'platform',
    targetTable: 'platform_students',
  },
  // tkt_tickets requesters (universal soft ref).
  {
    name: 'tkt_tickets.requester_id → platform.platform_users',
    scope: 'TENANT',
    sourceTable: 'tkt_tickets',
    sourceColumn: 'requester_id',
    targetSchema: 'platform',
    targetTable: 'platform_users',
  },
  // mtg_meetings.organiser_id → platform.platform_users.
  {
    name: 'mtg_meetings.organiser_id → platform.platform_users',
    scope: 'TENANT',
    sourceTable: 'mtg_meetings',
    sourceColumn: 'organiser_id',
    targetSchema: 'platform',
    targetTable: 'platform_users',
  },
  // pay_family_accounts.account_holder_id — the billing keystone.
  {
    name: 'pay_family_accounts.account_holder_id → platform.iam_person',
    scope: 'TENANT',
    sourceTable: 'pay_family_accounts',
    sourceColumn: 'account_holder_id',
    targetSchema: 'platform',
    targetTable: 'iam_person',
  },
];
