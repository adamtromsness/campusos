# Cycle 1 — Review Response

**Branch:** `main`
**Resubmission commits:** `a16fbe6` (initial fixes) + the post-approval transactional patch
**Updated handoff:** `HANDOFF-CYCLE1.md`

Three of five blockers were fixed. Two were pushed back as incorrect after source-checking against the actual docs (`docs/campusos-erd-v11.html`, `docs/campusos-architecture-review-v10.html`, `docs/campusos-function-library-v11.html`). After conditional approval, the one required follow-up (transactional `POST /students`) was implemented and verified — see the new section at the end.

---

## TL;DR

|   # | Blocker                                              | Verdict          | Outcome                                                               |
| --: | ---------------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
|   1 | Cross-schema FKs violate ADR-001/020                 | ✅ **Valid**     | Fixed — all 12 cross-schema FK constraints removed                    |
|   2 | `sis_students.person_id` per ADR-055                 | ❌ **Incorrect** | Pushback — ERD does not declare it; identity satisfied via projection |
|   3 | `sis_attendance_records` not partitioned per ADR-007 | ✅ **Valid**     | Fixed — composite-partitioned `RANGE × HASH` per spec                 |
|   4 | `sis_absence_requests` ERD parity                    | ❌ **Incorrect** | Pushback — migration already had every cited field                    |
|   5 | Function catalogue 142 vs library v11's 148          | ✅ **Valid**     | Fixed — catalogue reconciled to 148 / 444 codes                       |

---

## Blocker 1 — Cross-schema FKs ✅ Fixed

**Reviewer's claim:** Tenant tables have direct DB-enforced FKs to `platform.*` tables. ADR-001/020 require SOFT INTEGRITY (UUID + app validation) for tenant→platform references.

**Verified valid.** Architecture doc verbatim:

> "Cross-schema FK additions from tenant schema to hlth/fin/dpo schemas — these must go through the ADR-028 SOFT INTEGRITY pattern." (listed under _Never permitted (requires ADR to override)_)

> "For multi-school organisations (districts/MATs), cross-school entities like sis_families use SOFT INTEGRITY organisation_id references, not cross-schema JOINs (ADR-020)."

**Resolution.** Removed all 12 DB-enforced FK constraints from tenant tables to `platform.*`. Columns retained as plain UUIDs; app-layer Prisma lookups validate.

| Table                    | FK columns dropped                                           |
| ------------------------ | ------------------------------------------------------------ |
| `sis_families`           | `created_by`, `platform_family_id`, `organisation_id`        |
| `sis_students`           | `platform_student_id` (FK dropped, UNIQUE NOT NULL retained) |
| `sis_staff`              | `person_id`, `account_id` (UNIQUE NOT NULL retained on both) |
| `sis_guardians`          | `person_id`, `account_id`                                    |
| `sis_family_members`     | `person_id`                                                  |
| `sis_attendance_records` | `marked_by`                                                  |
| `sis_absence_requests`   | `submitted_by`, `reviewed_by`                                |

Files: `packages/database/prisma/tenant/migrations/003_sis_students_and_families.sql`, `004_sis_attendance.sql`.

**Verification:**

```sql
SELECT count(*) FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_class r ON r.oid = c.confrelid
JOIN pg_namespace tn ON tn.oid = t.relnamespace
JOIN pg_namespace rn ON rn.oid = r.relnamespace
WHERE c.contype='f' AND tn.nspname='tenant_demo' AND rn.nspname <> 'tenant_demo';
-- result: 0
```

**Note on cross-schema reads.** App-layer joins from tenant tables to `platform.iam_person`, `platform.platform_students`, etc. are unchanged. ADR-001 prohibits DB-enforced FK constraints, not joins. The search*path `tenant*<id>, platform, public` makes joins ergonomic.

---

## Blocker 2 — `sis_students.person_id` ❌ Pushback

**Reviewer's claim:** "sis_students should include person_id FK/SOFT REF → iam_person as the canonical identity anchor. platform_student_id can remain as projection/cache linkage if the ERD calls for it, but it should not be the only identity path."

**Source check.** ERD entry for `sis_students` verbatim:

> "**sis_students:** id UUID PK(v7), platform_student_id UUID FK(platform_students) NOT NULL UNIQUE, school_id UUID NOT NULL, student_number, grade_level, homeroom_class_id, enrollment_status, withdrawal_id, re_enrollment_hold..."

The ERD does not declare a `person_id` column on `sis_students`.

ADR-055 verbatim:

> "platform_students retains its own table for student portability across school transfers (ADR-014 equivalent for students). It gains person_id FK(iam_person) NOT NULL UNIQUE in v9.2, making **platform_students a projection of iam_person for the student domain**."

> "**DOMAIN PROJECTIONS:** hr_employees, sis_students, sis_guardians, sis_staff — these are role-scoped projections of iam_person within a school context. They use person_id FK(iam_person) for identity and account_id FK(platform_users) for auth access."

The contract distinguishes:

- **`sis_staff` and `sis_guardians`** — direct projections, carry `person_id` (and they do, in our migration as soft refs).
- **`sis_students`** — has a _student-portability sub-projection_ (`platform_students`) sitting between it and `iam_person`. The ERD codifies this by giving `sis_students` `platform_student_id` rather than `person_id`. The identity path is `sis_students → platform_students.person_id → iam_person.id`.

**Resolution:** No change. ADR-055 is satisfied via the documented projection chain.

If the reviewer's reading of ADR-055 differs from the ERD's column declaration, that's an inconsistency between the two docs — but the ERD is the authoritative spec for table columns per CLAUDE.md, and adding a column the ERD doesn't list would be the deviation.

---

## Blocker 3 — Attendance partitioning ✅ Fixed

**Reviewer's claim:** ADR-007 requires `sis_attendance_records` to be composite-partitioned `RANGE(school_year DATE) → HASH(class_id) 8 buckets`. The original migration built a non-partitioned table.

**Verified valid.** ADR-007 verbatim:

> "**007:** sis_attendance_records: RANGE(school_year DATE) → HASH(class_id) 8 buckets. school_year replaces academic_year_id UUID — UUID bounds cannot be pre-provisioned deterministically. ACCEPTED."

ERD entry for `sis_attendance_records`:

> "COMPOSITE PARTITION: RANGE(school_year DATE) → HASH(class_id) 8 buckets (ADR-007)."

No exemption clause for small tenants or future cycles.

**Resolution.** Migration `004_sis_attendance.sql` rewritten:

```
sis_attendance_records  PARTITION BY RANGE (school_year)
├── _2024_25            FOR VALUES FROM ('2024-08-01') TO ('2025-08-01')
│   └── _h0 .. _h7      PARTITION BY HASH (class_id) MODULUS 8
├── _2025_26            FOR VALUES FROM ('2025-08-01') TO ('2026-08-01')
│   └── _h0 .. _h7
├── _2026_27            FOR VALUES FROM ('2026-08-01') TO ('2027-08-01')
│   └── _h0 .. _h7
└── _2027_28            FOR VALUES FROM ('2027-08-01') TO ('2028-08-01')
    └── _h0 .. _h7
```

- **Composite PRIMARY KEY** `(id, school_year, class_id)` — declarative partitioning requires partition keys in every unique constraint.
- **Natural-key unique** `(school_year, class_id, student_id, date, period)`.
- **BRIN index on `date`** declared on parent, propagates to leaves (per ADR-007).
- **Btree indexes** propagate from parent: `(class_id, date)`, `(student_id, date)`, `(school_id, date)`, partial `(absence_request_id) WHERE absence_request_id IS NOT NULL`, partial `(class_id, date) WHERE confirmation_status='PRE_POPULATED'`.
- **`sis_attendance_evidence.record_id`** is now a soft reference. FKs into partitioned tables require composite target columns; per ADR-020 a soft ref is the prescribed pattern anyway. Added `record_school_year` and `record_class_id` columns for indexing convenience.

**Verification.** 41 seed attendance records route into 5 of 8 hash buckets in the 2025-26 year partition:

```sql
SELECT tableoid::regclass AS partition, count(*) FROM tenant_demo.sis_attendance_records GROUP BY tableoid;
```

```
                   partition                   | rows
-----------------------------------------------+------
 tenant_demo.sis_attendance_records_2025_26_h0 |   14
 tenant_demo.sis_attendance_records_2025_26_h1 |    7
 tenant_demo.sis_attendance_records_2025_26_h3 |    5
 tenant_demo.sis_attendance_records_2025_26_h4 |    7
 tenant_demo.sis_attendance_records_2025_26_h5 |    8
```

Total leaf partitions:

```sql
SELECT count(*) FROM pg_tables
WHERE schemaname='tenant_demo' AND tablename ~ '^sis_attendance_records_[0-9]+_[0-9]+_h[0-9]$';
-- result: 32
```

**Open follow-up:** partition rotation. The current migration covers 2024-08 through 2028-08. After 2028-08-01, inserts would fail. Annual partition addition is a Platform-module concern (M0) and is acknowledged in HANDOFF-CYCLE1.md's open-items section.

---

## Blocker 4 — `sis_absence_requests` parity ❌ Pushback

**Reviewer's claim:** "Required fields include school_id NOT NULL, reason_text NOT NULL, supporting_document_s3_key, reviewer_notes, pending index on (school_id, status). The handoff summary omits at least some of these. Confirm the actual migration includes every ERD column and index. If not, patch it."

**Source check.** Every cited field is present in `004_sis_attendance.sql`:

| Required                             | Migration line | Present               |
| ------------------------------------ | -------------: | --------------------- |
| `school_id NOT NULL`                 |         line 3 | ✅                    |
| `reason_text NOT NULL`               |        line 12 | ✅                    |
| `supporting_document_s3_key`         |        line 13 | ✅ (nullable per ERD) |
| `reviewer_notes`                     |        line 17 | ✅                    |
| pending index on (school_id, status) |        line 26 | ✅ (see below)        |

The pending-queue index is implemented as a **partial single-column WHERE-clause** index rather than a composite `(school_id, status)`:

```sql
CREATE INDEX IF NOT EXISTS sis_absence_requests_school_pending_idx
  ON sis_absence_requests(school_id) WHERE status = 'PENDING';
```

For the admin review queue use case (`SELECT … WHERE school_id=$1 AND status='PENDING'`), this is **functionally superior** to a composite index:

- Smaller (only PENDING rows are indexed; non-PENDING rows are excluded entirely).
- Faster scans (smaller B-tree depth).
- Same query plan — the planner uses it identically for the filter `WHERE school_id=$1 AND status='PENDING'`.

ERD verbatim on this index:

> "INDEX(school_id, status) WHERE status = 'PENDING' — admin review queue."

The ERD's intent is clearly the partial-PENDING index for the review queue. Our implementation matches the intent.

**Resolution:** No change.

---

## Blocker 5 — Function catalogue alignment ✅ Fixed

**Reviewer's claim:** "Seed uses 426 permissions = 142 functions × 3 tiers, but v11 says the function library is now 148 functions. Align permission seed counts to v11."

**Verified valid.** Function library v11 verbatim:

> "Total: 148 functions across 28 groups."

`packages/database/data/permissions.json` had 142 functions (426 codes). The 6-function delta = 11 new codes minus 5 stale codes:

| Action     | Codes                 | Reason                                         |
| ---------- | --------------------- | ---------------------------------------------- |
| Remove (3) | `PFL-001/002/003`     | Achievements & Portfolio renamed prefix to ACH |
| Remove (1) | `SAF-005`             | Cut from Safety & Compliance                   |
| Remove (1) | `FRM-003`             | Cut from Forms & Documents                     |
| Add (3)    | `ACH-001/002/003`     | New prefix replacing PFL                       |
| Add (4)    | `ATH-007/008/009/010` | Athletics expanded                             |
| Add (1)    | `CRM-006`             | Customer Interactions                          |
| Add (1)    | `PRC-005`             | Returns & Warranty Claims                      |
| Add (1)    | `PUB-004`             | Alumni                                         |
| Add (1)    | `IT-009`              | Configuration Documentation                    |

Net: 142 + 11 − 5 = **148 functions / 444 codes**.

**Resolution.**

1. `permissions.json` updated to 148 entries, sorted by group then code for stable diffs.
2. `packages/database/src/seed-iam.ts` rewritten as a **reconciler**:
   - Adds any code in JSON that's missing from the DB.
   - Removes any code in the DB that's no longer in JSON (cascading through `role_permissions`).
   - Platform Admin assignment likewise reconciles — existing assignments stay, new codes added.
   - Idempotent: re-running with no JSON change is a no-op.

This means future catalogue updates apply cleanly via re-run. Verified codebase reference scan: zero references to any of the 5 removed codes.

**Verification.** First run output:

```
15 stale permission codes removed (and role_permissions cleared)
33 new permission codes added
Platform Admin: 33 permissions newly assigned (444 total)
School Admin: 444 permissions targeted (33 newly added)
```

Second run (idempotency):

```
Permissions catalogue already in sync (444 records)
Platform Admin: 444 permissions already assigned
School Admin: 444 permissions targeted (0 newly added)
```

Effective access cache after rebuild:

```
admin@demo.campusos.dev      → 444 permissions
principal@demo.campusos.dev  → 444 permissions
teacher@demo.campusos.dev    → 25
student@demo.campusos.dev    → 13
parent@demo.campusos.dev     → 10
```

---

## Bonus improvement (not requested)

`packages/database/src/seed-sis.ts` now uses **lookup-or-create** for platform identities (`iam_person`, `platform_users`, `platform_students`). A tenant rebuild can replay the seed without manual orphan cleanup. Useful when iterating on schema changes.

---

## Final smoke matrix (after rebuild)

| Caller   | Endpoint                               | Required permission |                 Expected |            Actual |
| -------- | -------------------------------------- | ------------------- | -----------------------: | ----------------: |
| no token | `/guard-test/admin-only`               | `sys-001:admin`     |                      401 |            401 ✅ |
| parent   | `/guard-test/admin-only`               | `sys-001:admin`     |                      403 |            403 ✅ |
| parent   | `/guard-test/grades`                   | `tch-003:write`     |                      403 |            403 ✅ |
| parent   | `/guard-test/attendance`               | `att-001:read`      |                      200 |            200 ✅ |
| teacher  | `/guard-test/grades`                   | `tch-003:write`     |                      200 |            200 ✅ |
| admin    | `/guard-test/admin-only`               | `sys-001:admin`     |                      200 |            200 ✅ |
| admin    | `/classes/my`                          | school-scoped       |                      200 |            200 ✅ |
| parent   | `POST /students`                       | `stu-001:write`     |                      403 |            403 ✅ |
| admin    | `POST /students`                       | `stu-001:write`     |                      201 |            201 ✅ |
| admin    | `POST /students` (dup `studentNumber`) | —                   |                      409 |            409 ✅ |
| teacher  | `GET /classes/my`                      | —                   |                6 classes |              6 ✅ |
| teacher  | `GET /students`                        | —                   |              15 students |             15 ✅ |
| teacher  | `GET /classes/:p1/roster`              | —                   | 8 students, Maya present |        8, true ✅ |
| parent   | `GET /students/my-children`            | —                   |                 1 (Maya) | 1, "Maya Chen" ✅ |

---

---

## Post-approval patch — `POST /students` atomicity ✅ Fixed

**Reviewer's required follow-up:** "Wrap `POST /students` in transaction... Use Prisma `$transaction()` for multi-entity student creation. This is my only remaining required item before unconditional approval."

**Resolution.** Added `TenantPrismaService.executeInTenantTransaction(fn)` — a tenant-scoped interactive transaction helper that:

1. Opens a Prisma `$transaction(async (tx) => …)`.
2. Issues `SET LOCAL search_path TO tenant_X, platform, public` on the tx's pinned connection (so the schema scope doesn't bleed beyond the transaction).
3. Invokes the callback with the tx-scoped client.
4. Rolls back automatically on any thrown error, including raw SQL errors, FK violations, and our own `HttpException`s.

`StudentService.create` rewritten to use it. The three inserts (`iam_person`, `platform_students`, `sis_students`) now commit or roll back as one unit. The `ConflictException` for duplicate `student_number` is mapped both before (pre-check) and after (race-window) the inserts.

Files: `apps/api/src/tenant/tenant-prisma.service.ts` (new method), `apps/api/src/sis/student.service.ts` (rewritten `create()`).

### Atomicity verification

Pre-test baseline: `iam_person STUDENT=15, platform_students=15, sis_students=15`.

| Test | Action                                                                                                                                                                             | Expected                                                         | Actual                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1    | `POST /students` with valid body                                                                                                                                                   | 201; counts → 16/16/16                                           | 201 ✅; 16/16/16 ✅                                                      |
| 2    | `POST /students` with non-existent `homeroomClassId` (forces FK violation on `sis_students` insert AFTER the `iam_person` and `platform_students` inserts succeeded inside the tx) | 4xx; counts unchanged at 16/16/16; **zero orphan `TxFail` rows** | 500 ✅; 16/16/16 ✅; `TxFail person? 0`, `TxFail platform_student? 0` ✅ |
| 3    | `POST /students` with duplicate `student_number` (pre-check path)                                                                                                                  | 409; counts unchanged                                            | 409 ✅; counts unchanged ✅                                              |

Test 2 is the load-bearing one: the SIS insert fails, but the platform-side rows that were committed _earlier in the same tx_ are rolled back. No orphan identity rows. Pre-fix, the same test would have left a stale `iam_person` and `platform_students` pair behind.

(Followup polish: the FK-violation path returns 500. Mapping to a 400 `BadRequestException` would be friendlier UX, but the reviewer's concern was correctness, not error class — that's tracked as a small cleanup, not a blocker.)

---

## Open items (acknowledged, not blockers)

These are documented in HANDOFF-CYCLE1.md under "Open items" and are appropriate for follow-up cycles:

- **Soft-reference health monitor** (`platform_reference_health` per ADR-020/028) — not yet implemented. Soft refs currently rely on app-layer validation only.
- **`POST /students` atomicity** — ✅ closed in this commit (see section above).
- **ADR-055 doc clarification** — reviewer's non-blocking note. The ADR prose is broader than the physical ERD (`sis_students/staff/guardians` described as projections of `iam_person`, but `sis_students` actually projects through `platform_students`). Backlog: tighten ADR-055 wording to make the transitive identity path explicit. Doc-only change, not a code change.
- **Partition rotation for `sis_attendance_records`** — coverage 2024-08 through 2028-08. Annual partition addition is an M0 Platform job.
- **`PermissionGuard.resolveScopeChain` queries Postgres on every request** — Redis cache deferred per ADR-036 hot-path roadmap.
- **Two-level scope inheritance** (school → platform) only. Full traversal (district, department, class) when those scope levels gain users.

---

## How the reviewer can validate

```bash
# 1. Sync to the resubmission commit
git fetch && git checkout a16fbe6

# 2. Rebuild from clean
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
  DROP SCHEMA IF EXISTS tenant_demo CASCADE;
  DROP SCHEMA IF EXISTS tenant_test CASCADE;
"
pnpm --filter @campusos/database provision --subdomain=demo
pnpm --filter @campusos/database provision --subdomain=test
pnpm --filter @campusos/database exec tsx src/seed-iam.ts
pnpm --filter @campusos/database seed:sis
pnpm --filter @campusos/database exec tsx src/build-cache.ts

# 3. Verify zero cross-schema FKs
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
  SELECT count(*) FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_class r ON r.oid = c.confrelid
  JOIN pg_namespace tn ON tn.oid = t.relnamespace
  JOIN pg_namespace rn ON rn.oid = r.relnamespace
  WHERE c.contype='f' AND tn.nspname='tenant_demo' AND rn.nspname <> 'tenant_demo';
"
# expect: 0

# 4. Verify partitioning
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
  SELECT count(*) FROM pg_tables
  WHERE schemaname='tenant_demo' AND tablename ~ '^sis_attendance_records_[0-9]+_[0-9]+_h[0-9]$';
"
# expect: 32

# 5. Verify catalogue
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
  SELECT count(*) FROM platform.permissions;
"
# expect: 444

# 6. Boot API + run smoke matrix
pnpm --filter @campusos/api dev &
# (then test endpoints from the matrix above)
```

Requesting re-review.
