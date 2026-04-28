# Cycle 4 Architecture Review — Handoff for ChatGPT

**Reviewer:** ChatGPT (adversarial)
**Author of this brief:** Claude (CampusOS implementer)
**Cycle under review:** Cycle 4 — HR & Workforce Core
**Branch:** `main`
**State at handoff:** Cycle 4 COMPLETE (Steps 0–10), Cycles 0–3 COMPLETE + reviewed + post-review fixes landed
**Verdict format requested:** same as Cycles 1–3 — `N PASS · N DEVIATION · N VIOLATION` with each item separately classified, plus a fix-priority order table.

You are doing a hostile architecture review of Cycle 4 the same way you did for Cycles 1–3. The Cycle 1 review caught 6 violations including a critical tenant-isolation race; the Cycle 2 review caught 2 BLOCKING issues (gradebook leak + at-most-once consumer); the Cycle 3 review caught 3 issues (consumer error swallowing, delivery worker SENT-as-in-flight, overly-broad `isManager()` scope). We expect the same standard here. Be specific — name the file, line, ADR, and minimum fix.

---

## Scope of this review

**In scope** — anything added or changed since `de55a78 feat(cycle4-step5): seed HR — positions, leave, certs, onboarding`. Concretely:

- 1 new tenant migration ladder: `011_hr_employees_and_positions.sql`, `012_hr_leave_management.sql`, `013_hr_certifications_and_training.sql`, `014_hr_onboarding.sql` — 17 new tenant tables (`hr_*`).
- 1 new module under `apps/api/src/hr/` — 6 services (`Employee`, `Position`, `EmployeeDocument`, `Leave`, `Certification`, `TrainingCompliance`), 1 Kafka consumer (`LeaveNotificationConsumer`), 5 controllers, 6 DTO files, 23 endpoints.
- Changes inside `apps/api/src/iam/actor-context.service.ts` — added `actor.employeeId` populated by a tenant-scoped lookup against `hr_employees.person_id`. `IamModule` now imports `TenantModule` so the IAM service can do the lookup.
- 12 service-layer call-site substitutions across `apps/api/src/{attendance,classroom,sis,announcements}/` — replacing `actor.personId` with `actor.employeeId` on the right side of every comparison against `teacher_employee_id` / `cls_grades.teacher_id` / `cls_lessons.teacher_id` / `cls_student_progress_notes.author_id`. Also two SQL join rewrites: `class.service.ts::loadTeachersForClasses` (now joins `sis_class_teachers → hr_employees → platform.iam_person`) and `audience-fan-out.worker.ts::audienceClass` (now joins `sis_class_teachers → hr_employees → platform.platform_users.account_id`).
- 1 new method rename: `class.service.ts::listForTeacherPerson` → `listForTeacherEmployee`. Controller call site (`class.controller.ts::my`) updated to resolve actor + pass `actor.employeeId`.
- 1 platform-seed extension: `seed.ts` now creates two new staff users `vp@demo.campusos.dev` (Linda Park, Vice Principal) and `counsellor@demo.campusos.dev` (Marcus Hayes, Counsellor) so the HR seed has 4 distinct school-employee `iam_person` rows to bridge.
- 1 IAM-seed extension: `seed-iam.ts` now grants `HR-001:read` + `HR-003:read+write` + `HR-004:read` to Teacher and Staff roles. The role-assignment block was rewritten from "if any assignments exist, skip" to "per-user lookup-or-create" so adding new users in later cycles doesn't require dropping existing rows.
- 1 new HR seed: `seed-hr.ts` (Step 0 + Step 5). Step 0 portion seeds 4 employee rows + runs the four bridge UPDATE statements. Step 5 portion layers 7 idempotent data sets (positions, leave types/balances/sample requests, certifications, training requirements + pre-computed compliance, document types, onboarding template + 8 tasks).
- 4 retroactive `COMMENT ON COLUMN` re-applications on the bridged columns (in `002_sis_academic_structure.sql`, `005_cls_lessons_and_assignments.sql`, `006_cls_submissions_and_grading.sql`) — comment text only, no DDL.
- Web surface: 7 new routes under `apps/web/src/app/(app)/{staff,leave,compliance}/`, 1 new hooks file `apps/web/src/hooks/use-hr.ts` (16 hooks), HR DTO surface in `apps/web/src/lib/types.ts`, 3 new launchpad tiles in `apps/web/src/components/shell/apps.tsx`.
- CAT script: `docs/cycle4-cat-script.md` — 13 scenarios (4 bridge-verification + 9 plan scenarios) verified live.

**Out of scope** (do not flag):

- Anything in Cycles 0–3 — already reviewed (Cycle 3 APPROVED at `592d366`). If you spot regressions to prior contracts caused by Cycle 4 changes, that **is** in scope; if you find a pre-existing issue in untouched code, please call it out separately and tag as "carry-over from Cycle N."
- The two Phase-2 carry-overs from Cycle 3's review: DLQ-row dashboard / alert wiring on `platform.platform_dlq_messages`, and persona walkthroughs / UI design guide. Both are explicitly Phase 2 work.
- Browser-driver e2e — Cycles 1–3 also deferred this; Cycle 4 ships a manual CAT (`docs/cycle4-cat-script.md`).
- The 30 ERD HR tables Cycle 4 deliberately deferred (Recruitment, Payroll, Benefits, Appraisals, Workers' Comp, etc.) — only the 17 in-scope tables are part of this review.
- `hr.leave.coverage_needed` consumer — Cycle 5 (Scheduling) lands the consumer; Cycle 4 publishes only.
- Year-start leave-balance accrual scheduled job — reserved for ops follow-up.
- 90/30/7-day `hr.certification.expiring` alert emit — the partial-index-backed read sweep is in place; the cron is reserved.
- Document upload pipeline (signed-URL S3 PUT) — schema + create-by-`s3Key` endpoint are in place; the actual presign + PUT flow is Phase-2 work.
- Emergency contact / work-authorisation / CPD completion API surfaces — schemas exist, no API yet.

---

## What to read (in order)

These four documents are the source of truth and should answer 90 % of "is X really designed this way?" questions:

1. **`CLAUDE.md`** — top-level project rules + project status. The Cycle 4 paragraph enumerates every step with a one-line outcome, including the bridge bug story and the seed-balance-vs-PENDING-request fix from Step 7. The "Conventions" + "Key Design Contracts" sections are the durable rules; if Cycle 4 violates one of them, that's a clear violation. The new "Staff identity" rule (Cycle 4 Step 0) replaces the old "Temporary HR-Employee Identity Mapping" bullet.
2. **`HANDOFF-CYCLE4.md`** — the running technical handoff. Step status table at the top; per-step sections (Step 0 through Step 10) describe migration shape, FKs, services, endpoints, row-level auth pattern, deviations, and known caveats. Mirrors the Cycle 3 handoff structure.
3. **`docs/cycle4-cat-script.md`** — the live-verified end-to-end walkthrough. 4 bridge-verification queries (Step 0 carry-over) + 9 plan scenarios. Captures real `curl` outputs, the Kafka envelope on the wire, the 3 IN_APP notifications enqueued + delivered, and 6 permission denial paths.
4. **`docs/campusos-cycle4-implementation-plan.html`** — the upstream plan you'd compare deviations against.

Authoritative ADR/ERD references the cycle is bound to (these are what the implementation MUST satisfy):

- `docs/campusos-erd-v11.html` — schema source of truth (M80 HR/Workforce, 48 tables; 17 in scope).
- `docs/campusos-architecture-review-v10.html` — sections 13 (modular monolith), 11 (events), and 9 (multi-tenancy) are the most relevant.
- `docs/campusos-function-library-v11.html` — HR-001 through HR-006 codes + their access tiers.

---

## Design contracts to verify (these are the hard rules)

These are the contracts Cycle 4 commits to. If any is broken anywhere in the cycle's surface, that's a violation. Cite the ADR and the file.

### 1. ADR-001 / ADR-020 / ADR-028 — soft cross-schema refs

Tenant tables MUST NOT have DB-enforced FK constraints to `platform.*`. UUID columns + app-layer Prisma validation only.

```sql
SELECT count(*) FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_class r ON r.oid = c.confrelid
  JOIN pg_namespace tn ON tn.oid = t.relnamespace
  JOIN pg_namespace rn ON rn.oid = r.relnamespace
WHERE c.contype='f' AND tn.nspname='tenant_demo' AND rn.nspname <> 'tenant_demo';
-- expected: 0
```

Cycle 4 declares 20 intra-tenant FKs across the 4 migrations and zero cross-schema FKs — verify both numbers. The 4 bridged columns (`sis_class_teachers.teacher_employee_id`, `cls_grades.teacher_id`, `cls_lessons.teacher_id`, `cls_student_progress_notes.author_id`) are intra-tenant tenant-tenant refs that we deliberately keep as **soft** refs even though both sides are in the tenant schema — see "Known scope decisions" below.

### 2. ADR-001 (REVIEW-CYCLE1 fix) — `SET LOCAL search_path` inside an interactive transaction

`TenantPrismaService.executeInTenantContext` and `executeInTenantTransaction` both wrap their callback in a Prisma `$transaction` and run `SET LOCAL search_path TO "tenant_X", platform, public`. SET LOCAL is mandatory; a session-level SET on a pooled client can leak between concurrent requests.

**Verify:** every HR service uses `executeInTenantContext` / `executeInTenantTransaction`. No raw `client.$queryRaw` / `client.$executeRaw` outside these helpers, and no manual `SET search_path` anywhere. The new `ActorContextService.resolveEmployeeId` lookup is the most subtle one — it runs inside `tenantPrisma.executeInTenantContext` per call. Verify the lookup is cheap enough (single-row PK lookup) that the per-request cost is negligible.

The `LeaveNotificationConsumer` runs OUTSIDE a request, like `GradebookSnapshotWorker` and the Cycle 3 notification consumers — verify it reconstructs tenant context via `runWithTenantContextAsync` (delegated through `processWithIdempotency` from `notification-consumer-base.ts`). The consumer's `loadSchoolAdminAccounts` SQL is admin-tier; verify it correctly hits `iam_effective_access_cache` and is row-scoped to the tenant's school+platform scope chain.

### 3. ADR-055 — `iam_person` is the canonical FK for human identity

`iam_person.id` is the single source of truth for human identity. `platform_users` is auth-only. `hr_employees.person_id` is the canonical bridge — UNIQUE so each `iam_person` has at most one employee row per tenant. Domain projections like `sis_staff` already exist; Cycle 4 adds `hr_employees` as the new staff projection.

**Verify:**

- `hr_employees.person_id UNIQUE` is enforced (DDL: `CONSTRAINT hr_employees_person_uq UNIQUE (person_id)`).
- `hr_employees.account_id UNIQUE` is enforced (the JWT-subject lookup hot path; multiple `platform_users` per `iam_person` is not allowed inside one tenant).
- The bridge UPDATE in `seed-hr.ts` is naturally idempotent — re-running the seed after a successful bridge produces 0 inserts and 0 row updates.
- The two SQL joins that flow through `hr_employees`:
  - `class.service.ts::loadTeachersForClasses` — `sis_class_teachers → hr_employees ON e.id = ct.teacher_employee_id → platform.iam_person ON ip.id = e.person_id`
  - `audience-fan-out.worker.ts::audienceClass` — `sis_class_teachers → hr_employees ON he.id = ct.teacher_employee_id` (selects `he.account_id` directly)

### 4. Bridge integrity — Cycle 2 DEVIATION 4 retired

The Cycle 2 review deferred the HR-Employee identity bridge as a DEVIATION; Step 0 of Cycle 4 retires it. After `seed-hr.ts` runs, every value in the four bridged columns must resolve to an `hr_employees.id`.

```sql
SELECT 'sis_class_teachers' AS table, count(*) AS orphans
  FROM tenant_demo.sis_class_teachers t
 WHERE NOT EXISTS (SELECT 1 FROM tenant_demo.hr_employees e WHERE e.id = t.teacher_employee_id)
UNION ALL SELECT 'cls_grades', count(*) FROM tenant_demo.cls_grades t
  WHERE t.teacher_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM tenant_demo.hr_employees e WHERE e.id = t.teacher_id)
UNION ALL SELECT 'cls_lessons', count(*) FROM tenant_demo.cls_lessons t
  WHERE t.teacher_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM tenant_demo.hr_employees e WHERE e.id = t.teacher_id)
UNION ALL SELECT 'cls_student_progress_notes', count(*) FROM tenant_demo.cls_student_progress_notes t
  WHERE NOT EXISTS (SELECT 1 FROM tenant_demo.hr_employees e WHERE e.id = t.author_id);
-- expected: 0 across all four rows
```

The CAT scenarios 0a–0d cover this. Verify on a freshly-provisioned `tenant_demo`.

### 5. Row-level authorisation — endpoint permission gates are the floor, not the ceiling

`@RequirePermission` is necessary but not sufficient. HR endpoints follow the same pattern as Cycles 1–2:

| Surface                                  | Gate           | Row-scope inside service                                                                      |
| ---------------------------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| `GET /employees`                         | `hr-001:read`  | None (public-ish directory; everyone with the code reads).                                    |
| `GET /employees/:id`                     | `hr-001:read`  | None — design choice; sensitive fields (docs, leave) are guarded by their own endpoints.      |
| `GET /employees/me`                      | `hr-001:read`  | `actor.employeeId` resolves the row — 404 if `null`.                                          |
| `POST /employees`                        | `hr-001:write` | Service-layer `actor.isSchoolAdmin` admin check.                                              |
| `PATCH /employees/:id`                   | `hr-001:write` | Same admin check.                                                                             |
| `GET /employees/:id/documents`           | `hr-001:read`  | Service-layer `assertCanAccess`: admin OR own.                                                |
| `POST /employees/:id/documents`          | `hr-001:write` | Same.                                                                                         |
| `DELETE /employees/:id/documents/:docId` | `hr-001:write` | Same; soft-archive, not hard-delete.                                                          |
| `POST /positions`                        | `hr-001:admin` | Service-layer admin check.                                                                    |
| `PATCH /positions/:id`                   | `hr-001:admin` | Same.                                                                                         |
| `POST /leave-requests`                   | `hr-003:write` | Caller must have `actor.employeeId` — 403 otherwise.                                          |
| `PATCH /leave-requests/:id/approve`      | `hr-003:write` | Service-layer admin check.                                                                    |
| `PATCH /leave-requests/:id/reject`       | `hr-003:write` | Same.                                                                                         |
| `PATCH /leave-requests/:id/cancel`       | `hr-003:write` | Owner OR admin.                                                                               |
| `GET /leave-requests`                    | `hr-003:read`  | Non-admin → own employee_id only (filter is silent — server-side).                            |
| `GET /leave-requests/:id`                | `hr-003:read`  | Non-admin → 404 if not owner.                                                                 |
| `GET /employees/:id/certifications`      | `hr-004:read`  | `assertCanAccess`: admin OR own.                                                              |
| `POST /employees/:id/certifications`     | `hr-004:write` | Same. NB: `hr-004:write` is admin-only per the Step 5 seed — Teacher/Staff hold only `:read`. |
| `PATCH /certifications/:id/verify`       | `hr-004:write` | Service-layer admin check.                                                                    |
| `GET /employees/:id/compliance`          | `hr-004:read`  | `assertCanAccess`: admin OR own.                                                              |
| `GET /compliance/dashboard`              | `hr-004:read`  | Service-layer admin check.                                                                    |
| `GET /certifications/expiring-soon`      | `hr-004:read`  | None (admin sweep — read-only and bounded by the partial index).                              |

Verify each endpoint applies its row-scope. The places to scrutinise hardest:

- `EmployeeDocumentService.assertCanAccess` — pattern: `if (actor.isSchoolAdmin) return; if (actor.employeeId === employeeId) return; throw ForbiddenException`. Same shape in `CertificationService.assertCanAccess`.
- `LeaveService.list` — non-admin always restricted to `WHERE lr.employee_id = $actor.employeeId`. CAT scenario 9a verifies a teacher passing `?employeeId=other` doesn't leak rows.
- `LeaveService.cancel` — cancel allows owner OR admin. The owner check uses `actor.employeeId !== existing.employee_id`; the admin check is `actor.isSchoolAdmin`. Verify the OR isn't accidentally an AND.
- `TrainingComplianceService.getForEmployee` — own-or-admin. `getDashboard` is admin-only at the service layer.

### 6. Admin status is tenant-scope-chain, not cross-scope

Use `permissionCheckService.hasAnyPermissionInTenant(accountId, schoolId, codes)` or read `actor.isSchoolAdmin` from `ActorContextService.resolveActor(...)`. NEVER scan `iam_effective_access_cache` across all scopes.

The previous `hasAnyPermissionAcrossScopes` was removed in REVIEW-CYCLE1. Verify no reintroduction. The `LeaveNotificationConsumer.loadSchoolAdminAccounts` SQL is the one HR-side site that reads the cache directly — verify its scope-chain predicate matches the existing `AbsenceRequestNotificationConsumer.loadSchoolAdminAccounts` shape exactly.

### 7. Frozen-tenant gate (ADR-031)

Every write through this module passes the existing `TenantGuard` frozen check. Reads continue to work even on a frozen tenant. The frozen gate is registered in `AppModule` as `APP_GUARD` and runs after Auth and before Permission. New controllers in this cycle inherit it automatically. Verify no controller bypasses the global guard chain.

### 8. UUIDv7 for all PKs (ADR-002)

`generateId()` from `@campusos/database` only. No `gen_random_uuid()` or `uuidv4()` in service code. (The seed and a few CAT cleanup queries use `gen_random_uuid()` — that's fine outside the request path.)

### 9. ADR-057 envelope on every emit

Every HR emit goes through `KafkaProducerService.emit(EmitOptions)` with `sourceModule: 'hr'`. Topics: `hr.leave.requested`, `hr.leave.approved`, `hr.leave.rejected`, `hr.leave.cancelled`, `hr.certification.verified` from the request path; `hr.leave.coverage_needed` republished by the consumer. All on the env-prefixed wire (`dev.hr.*`). The CAT scenario 4 captures the request envelope on the wire; scenario 6 captures the approve + coverage envelopes.

**Verify** every emit site sets `sourceModule: 'hr'` and that the consumer reads `event_id` + `tenant_id` off the envelope (not the legacy transport headers).

### 10. ADR-015 — DBS / regulated background-check handling

`hr_staff_certifications` stores only the reference number + verification status for DBS / background-check certs. The 10 `certification_type` enum values include `DBS_BASIC` and `DBS_ENHANCED`. The `document_s3_key` column points at a scanned cert PDF, never raw DBS data. Inline `COMMENT ON COLUMN` annotations make this rule discoverable from the live schema.

**Verify** the COMMENT text on `hr_staff_certifications.reference_number` and `hr_staff_certifications.document_s3_key` documents this rule. Verify the seed for Mitchell's `DBS_ENHANCED` cert stores `reference_number='DBS-001234567890'` and nothing more sensitive.

### 11. Schema-layer state-machine CHECKs

Cycle 4 leans on multi-column CHECK constraints to keep state in sync with timestamps:

- `hr_leave_requests_status_chk` — status enum.
- `hr_leave_requests_hr_initiated_chk` — `(is_hr_initiated, hr_initiated_by, hr_initiated_reason)` are all-set or all-null together (no partial state).
- `hr_leave_balances_{accrued,used,pending}_chk` — non-negative. **The cancel underflow path relies on these; if a service tries to subtract more than is in the column, the CHECK fires and the tx rolls back.**
- `hr_onboarding_checklists_started_chk` — `(status, started_at, completed_at)` lifecycle pinned.
- `hr_onboarding_tasks_completed_chk` — `completed_at` is set if and only if status ∈ {COMPLETED, SKIPPED}.

The Step 7 smoke caught a real seed bug because the `pending_chk` correctly fired on a cancel underflow. Verify the CHECKs are in place and the service code respects them.

### 12. Permission catalogue is reconciled

The catalogue is reconciled from `packages/database/data/permissions.json` by `seed-iam.ts`. Step 5 added HR-001/003/004 grants to Teacher and Staff. Cached counts after Step 5: Platform Admin 444, School Admin 444, Teacher 31, Student 15, Parent 11, Staff 10, plus 2 new accounts (vp@ + counsellor@) → Staff (10 perms each). Cache rebuilt to 7 account-scope pairs.

**Verify** the role-permission map matches HANDOFF-CYCLE4.md (Teacher + Staff: `hr-001:read`, `hr-003:read+write`, `hr-004:read`). `hr-004:write` is admin-only by design — every cert verify path is gated on it, not on `:read`. School Admin / Platform Admin keep full HR via `everyFunction`.

### 13. Idempotent migrations + `seed-hr.ts`

`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS … ; ADD CONSTRAINT …`. Re-running provision on an already-migrated tenant must be a no-op.

`seed-hr.ts` has 7 idempotent layers; each gates on its own row count. Re-running after a successful seed produces 0 inserts and 0 bridge updates. The bridge UPDATEs are naturally idempotent — they only match rows whose column still holds an `iam_person.id`; once bridged, the join finds nothing on a re-run.

### 14. Splitter `;`-in-string trap (carry-over from Cycle 3)

`provision-tenant.ts` splits SQL files on `;` regardless of quoting context — block comments, string literals, defaults. CHECK predicates and `COMMENT ON COLUMN` strings cannot contain `;`. The Step 1 commit message documents that this trap struck even on the migration's own block-comment header (the warning text contained a literal `` `;` ``). Verify no `;` anywhere in any string literal across migrations 011–014.

---

## Known scope decisions / accepted deviations — do not flag these

These are deliberate. If you think any of them is wrong, please call it out as a "deviation" not a "violation," and explain why you'd push back.

1. **Bridged columns stay as soft refs even though both sides are in the tenant schema.** `sis_class_teachers.teacher_employee_id` etc. could carry a DB-enforced FK to `hr_employees(id)` since both tables are tenant-scoped. We deliberately keep them soft because the Cycle 1 / Cycle 3 partitioned-parent precedent (`sis_attendance_evidence`, `msg_message_attachments`) is to denormalise + soft-ref, and a future expansion may partition `hr_employees` by `school_id` for multi-school instances. The bridge UPDATE inside one `executeInTenantTransaction` plus the orphan-check verification is the integrity guarantee.
2. **`admin@demo.campusos.dev` Platform Admin persona is NOT bridged to `hr_employees`.** It represents a system administrator, not a school employee. `actor.employeeId === null` for this persona; service code that depends on `employeeId` (e.g. grade write paths since the Step 0 substitution) returns 403 cleanly. This is the same shape as parents/students having no employee row. The CAT covers it implicitly — the Platform Admin doesn't drive any of the leave / cert flows.
3. **`hr-004:write` is admin-only at the seed.** Per the plan: "HR-004 (Certifications) read to Teacher/Staff. Full HR access to School Admin and Platform Admin." Teachers can read their own certs but cannot record new ones via the API — admins do. The service-layer `EmployeeDocumentService.assertCanAccess` allows owner-or-admin write, but the gate at the controller restricts non-admins anyway.
4. **`hr.leave.coverage_needed` is publish-only.** Cycle 5 Scheduling will land the consumer; the contract is publish-only for Cycle 4. Verify the envelope shape (CAT scenario 6) is forward-compatible.
5. **`hr.certification.expiring` cron-emit is deferred.** The partial-index-backed read (`/certifications/expiring-soon`) is in place; the scheduled job that walks the rows and emits per row at 90/30/7-day thresholds is reserved for ops follow-up.
6. **Year-start leave-balance accrual job is deferred.** The seed sets balances explicitly; the request path's `upsertBalance` helper materialises a balance row from the type's `accrual_rate` if one doesn't exist when an employee submits.
7. **`hr_emergency_contacts`, `hr_employee_documents`, `hr_cpd_requirements`, `hr_work_authorisation` are not seeded.** All four schemas exist; the seed deliberately leaves them empty so Step 8 + 9 UI flows can drive the create paths during operator walkthrough.
8. **The 5th position (Administrative Assistant) has no holder.** Tests the "position exists, no employee assigned" path that the staff directory needs to handle (it does — `position.service.ts::list` returns `activeAssignments=0` for the row).
9. **`hr_positions.department_id` is a soft FK to `sis_departments(id)` — deliberately unenforced.** SIS predates HR; coupling SIS-side delete behaviour to HR creates an unwelcome cross-module dependency. App-layer validates.
10. **No DB triggers anywhere.** Multi-column lifecycle CHECKs replace what would normally be a `BEFORE UPDATE` trigger.
11. **The `LeaveService.list` non-admin filter is silent (200, scoped) not 403.** A teacher passing `?employeeId=other` gets their own rows, not a 403, because the row-scope is the right contract for a benign read attempt. The actual approval _write_ path is the gated one.
12. **`/employees/:id` is open to anyone with `hr-001:read`.** Sensitive sub-resources (documents, certifications, compliance, leave) are guarded individually. If a future cycle wants to redact certain fields based on persona, that's a layer on `rowToDto`. The CAT verifies that a teacher viewing another employee's profile sees the directory-level info (scenario 1 + 2) but is blocked from documents (scenario 9c) and dashboard (9d).
13. **`hr_leave_balances.school_id` not denormalised.** Every read joins through `hr_employees.school_id` already; adding the column would just be a write-time consistency concern with no query benefit.
14. **No cross-tenant leave aggregation.** Each tenant maintains its own `hr_leave_*` rows; multi-school employees are not modelled (single-school-per-employee is the Phase 1 / Phase 3 contract).
15. **`hr_employee_documents.uploaded_by` is `actor.accountId`, not `actor.personId` or `actor.employeeId`.** Per ADR-055, audit identity columns capture the auth account.
16. **`/staff/[id]` Info tab visible to anyone with `hr-001:read`.** Other tabs gate on `useMyEmployee().data.id === id || hasAnyPermission(['sch-001:admin'])`. Server-side endpoints behind those tabs apply their own row-scope independently.
17. **No CSV export on the compliance dashboard.** Out of scope for the CAT.
18. **Approval queue Modal doesn't preview balance impact.** No `/leave/balances?employeeId=` endpoint yet (`/leave/me/balances` is calling-employee-only by design). Reserved for a Phase 2 polish pass.
19. **The Step 5 seed-balance-vs-PENDING-request inconsistency was caught by the Step 7 smoke and fixed in commit `70b6cf3`.** A fresh provision running the CAT today produces the right shape from the start. This is documented in the CAT script and HANDOFF-CYCLE4.md.

---

## Specific paths worth poking at

These are the spots most likely to harbour a real bug. Look at them first.

| File                                                                                                   | Why it's load-bearing                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/iam/actor-context.service.ts`                                                            | Step 0 added `employeeId` resolution. The lookup runs inside `tenantPrisma.executeInTenantContext` per request. Cost? Race? Caching? Verify it doesn't accidentally bypass tenant context.                                                                                                                                          |
| `apps/api/src/iam/iam.module.ts`                                                                       | New `imports: [TenantModule]` line. Potential circular-dependency risk if `TenantGuard` ever needs IAM. Verify.                                                                                                                                                                                                                     |
| `apps/api/src/hr/leave.service.ts::submit / approve / reject / cancel`                                 | All four lifecycle transitions run inside `executeInTenantTransaction`. The non-negative balance CHECKs from migration 012 are the schema-layer floor. Verify the SQL is correct: `pending = pending - $1, used = used + $1` for approve. Cancel must reverse the right column based on the _previous_ status, not the new status.  |
| `apps/api/src/hr/leave.service.ts::list`                                                               | Non-admin row-scope. CAT scenario 9a verifies, but try harder: what if a teacher passes `?employeeId=other&status=APPROVED`? What if they pass an `employeeId` that doesn't exist?                                                                                                                                                  |
| `apps/api/src/hr/employee-document.service.ts::assertCanAccess`                                        | Pattern: admin-or-own. Same shape repeated in `CertificationService.assertCanAccess` and `TrainingComplianceService.getForEmployee`. Verify all three.                                                                                                                                                                              |
| `apps/api/src/hr/leave-notification.consumer.ts`                                                       | New Kafka consumer. Reuses `unwrapEnvelope` + `processWithIdempotency` from Cycle 3. The `emitCoverageNeeded` republish runs only on `approved` — verify it queries `sis_class_teachers.teacher_employee_id = $1::uuid` with the right `employeeId` (not `personId`). The CAT scenario 6 verifies the envelope; verify the SQL too. |
| `apps/api/src/hr/leave-notification.consumer.ts::loadSchoolAdminAccounts`                              | Reads `iam_effective_access_cache` directly. Compare against the existing `absence-request-notification.consumer.ts::loadSchoolAdminAccounts` — should be byte-for-byte equivalent. Any divergence is suspicious.                                                                                                                   |
| `apps/api/src/hr/employee.service.ts::create / update`                                                 | Admin POST + PATCH. Verifies `personId` + `accountId` exist in `platform.iam_person` / `platform.platform_users`, and that `account.personId === body.personId`. Verify both checks in 1 call.                                                                                                                                      |
| `apps/api/src/hr/certification.service.ts::verify`                                                     | Admin-only. Emits `hr.certification.verified`. Verify `verified_by = actor.accountId` is captured in the row and emit payload.                                                                                                                                                                                                      |
| `apps/api/src/hr/training-compliance.service.ts::getDashboard`                                         | LEFT-joins the full ACTIVE employee roster against `hr_training_compliance` so employees with zero compliance rows still show up. Verify the query ordering and the per-employee aggregate counts (`compliantCount + amberCount + redCount === totalRequirements`).                                                                 |
| `packages/database/prisma/tenant/migrations/011_*.sql` and `012_*.sql` and `013_*.sql` and `014_*.sql` | 17 new tables; 20 intra-tenant FKs. Verify CASCADE rules: `hr_employees` deletes cascade through positions, contacts, documents, balances, requests, certs, compliance, work_auth, onboarding checklists. Cert delete sets compliance row's `linked_certification_id` to NULL (does not delete the row).                            |
| `packages/database/src/seed-hr.ts`                                                                     | Step 0 bridge UPDATEs + Step 5 layers. Each layer must gate on its own row count so re-running is a no-op. The Step 7 fix (Rivera PD `pending=1.0`) must be in `balanceFor`. Personal Leave balance must be `used=0 pending=0` (no Personal request seeded).                                                                        |
| `packages/database/src/seed-iam.ts`                                                                    | Role-assignment block rewrite — per-user lookup-or-create instead of "skip if any rows exist". Verify it doesn't re-create existing assignments or get tripped up by partial state.                                                                                                                                                 |
| `apps/web/src/components/shell/apps.tsx`                                                               | Three new tiles. Verify each gate (`hr-001:read` / `hr-003:read` / `sch-001:admin OR hr-004:admin`) returns the right tile set per persona. Parents/students must see no HR tiles.                                                                                                                                                  |
| `apps/web/src/app/(app)/leave/new/page.tsx`                                                            | The amber over-budget warning. Verify it doesn't block submission (the form still submits even if `daysRequested > available` — the admin can still approve).                                                                                                                                                                       |
| `apps/web/src/app/(app)/leave/approvals/page.tsx`                                                      | Modal-based Approve/Reject flow. Verify the Modal closes only after the mutation resolves and the toast fires after.                                                                                                                                                                                                                |

---

## What we'd love you to actively try to break

In Cycle 1 you found a real cross-tenant data leak. Cycle 2 you found a class-grade leak. Cycle 3 you found a notification-consumer error swallow + delivery worker SENT-as-in-flight + overly-broad `isManager()`. Some equivalents to try here:

1. **Cross-tenant leave coverage_needed pollution.** The `LeaveNotificationConsumer.emitCoverageNeeded` republishes with `tenantId` taken from the inbound envelope. If an attacker emits a forged `hr.leave.approved` to `dev.hr.leave.approved` with `tenant_id=other-school` but a `payload.employeeId` that exists only in `tenant_demo`, what happens? The `runWithTenantContextAsync` should pin to whatever `tenant_id` the envelope says — verify it doesn't accidentally resolve a same-id employee from the wrong tenant.
2. **Bridge UPDATE running twice across an in-flight write.** `seed-hr.ts` runs the bridge UPDATEs after the employee inserts. If the seed runs while the API is serving a write to one of the bridged columns (e.g. someone is recording attendance in another tab), is there a race where the UPDATE overwrites a fresh `iam_person.id` value with an old one? The seed runs in production via the deploy pipeline; the timing matters.
3. **Permission scoping on `hr-001:write`.** Teacher gets `hr-001:read` but not `hr-001:write` per the seed. What if a teacher hits `POST /employees/:id/documents` for their own employee row? They should be allowed (own profile), but the gate is `hr-001:write` which they don't hold. Resolution: the gate blocks them at the global guard, before the service-layer assertCanAccess runs. Verify this is intentional.
4. **Cancel underflow when the schema CHECK fires.** A teacher submits a 1-day Sick request, the row reaches PENDING with `pending=1`. The teacher cancels twice in rapid succession (UI double-click). The first cancel succeeds (`pending=0`); the second cancel hits the `LeaveService.cancel` `requireStatus=null` path which doesn't re-check status… or does it? Verify the second cancel either no-ops cleanly or returns a 400 ("already cancelled"). The CAT scenario 18 covers a single cancel; the double-cancel race is the interesting case.
5. **HR-Employee identity drift via `employeeId` caching.** `actor.employeeId` is computed once per request inside `resolveActor`. If an admin terminates an employee mid-session (`employment_status='TERMINATED'`), the next request the (terminated) employee makes gets `employeeId=null` — but a long-lived JWT keeps the user signed in. Verify the access denial happens on the `null employeeId` branch, not on a JWT validity check.
6. **Cross-employee compliance dashboard read.** A teacher hits `/employees/:other/compliance`. The service-layer `assertCanAccess` should 403. Try with a Platform Admin (no `employeeId`) viewing a real employee — should succeed via `actor.isSchoolAdmin`. Try with the Platform Admin's own personId as the path arg (they don't have an employee row) — should 404 from `getForEmployee`'s read.
7. **Coverage_needed for an employee with zero classes.** What happens when a non-teaching employee (Mitchell, Park, Hayes) has an `hr.leave.approved` event flow through? The `emitCoverageNeeded` query returns 0 classes; verify the consumer doesn't emit an empty envelope (it shouldn't — the consumer explicitly checks `classRows.length > 0` and returns early).
8. **Onboarding lifecycle CHECK violation via partial UPDATE.** A buggy service updates `hr_onboarding_checklists.status='COMPLETED'` without setting `completed_at`. The `started_chk` CHECK fires and the tx rolls back. Verify the schema-layer guard is the only thing holding this together (no service explicitly enforces it), so a careless future service can't bypass.
9. **DBS reference disclosure via `/employees/:id`.** Verify that the directory list and profile detail don't surface Mitchell's `DBS Enhanced` `reference_number` ("DBS-001234567890") in any unauthorised path. Per ADR-015 only the cert tab on the owner's profile (or admin) should show it.
10. **`hr.leave.coverage_needed` payload fan-out under load.** With Rivera teaching 6 classes, the payload is small. With a hypothetical employee teaching 100 classes, the inline `affectedClasses` array could grow Kafka-message-large. Verify there's no silent truncation; the contract should be document the upper bound or chunk the emit.
11. **Bridged-column orphan after a rapid `iam_person` deletion.** If `iam_person` is hard-deleted while `hr_employees.person_id` still points at it, what happens? Per ADR-001/020 the soft FK doesn't enforce; the join in `loadTeachersForClasses` returns no rows and the directory list silently drops that employee. Verify this is a documented behaviour, not a surprise.

---

## Output we'd like

Same format as `REVIEW-CYCLE3-CHATGPT.md`:

1. **Verdict header** — `N PASS · N DEVIATION · N VIOLATION` and an overall accept / reject.
2. **Per violation** — title with priority, body explaining the issue, ADR violated, file path + line number, required fix, your own triage. Be specific enough that the fix can be implemented from the description alone.
3. **Per deviation** — a short "this is technically off-spec, but acceptable because X" entry. We'll consolidate and decide.
4. **Per pass** — one bullet each. Helps us know what NOT to second-guess in Cycle 5.
5. **Fix priority order table** — same shape as Cycle 3 (Priority / Violation / Risk / Effort).

When you submit, please save your output as `REVIEW-CYCLE4-CHATGPT.md` in the repo root. Cycle 3's review body was ~107 lines; Cycle 4 has more surface area (17 new tables + 23 endpoints + 1 consumer + 7 web routes + the bridge), so something in the 200–400-line range is probably right.

If you find nothing material, that's a fine outcome — say so. We'd rather you tell us "Cycle 4 is clean modulo deviations" than synthesise a violation to fill space.

The closeout SHA to anchor the review against is **`efbcb44`** (Step 10 — vertical-slice CAT). Cycle 4's first commit is **`4c9b489`** (Step 0 — HR-Employee identity migration). The 11-commit chain is: `4c9b489 → 510a4ea → 3c5f151 → 158caea → 4013e4c → de55a78 → 9a931f2 → 70b6cf3 → 162b594 → fe806b4 → efbcb44`.
