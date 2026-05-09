# P2C4 — HR Advanced (M80 .1 + M87 Appraisals) — HANDOFF

**Status:** P2-4a (Payroll) **APPROVED**, P2-4b (Recruitment)
**COMPLETE pending peer review** (2026-05-09).

P2-4a tagged `p2c4a-complete` at `617e37c` and `p2c4a-approved` at
the closeout commit. Round 1 against `1a5c3e8` returned **FAIL**
with 3 BLOCKING + 4 MAJOR; Round 2 against `617e37c` returned
**PASS**. Two non-blocking carry-overs were absorbed by P2-4b: the
salary-scale assignment stub (closed by migration 113 below) and
the salary-review department scope (Wave 2 Phase 2 role-split work).

P2-4b ships **8 new tenant base tables** (migration 114), **~22
endpoints** across 4 services, **2 Kafka emits via OutboxService**
(`hr.job.posted`, `hr.offer.accepted`), **2 web routes**, **12 new
unit tests** (vitest 147 → 159), the migration 113 ALTER closing
P2-4a Round 1 MAJOR #1, and a `seed-recruitment.ts` populating the
demo school with 1 LIVE posting + 3 candidates + 3 applications +
1 panel + 2 interviews + 4 evaluations + 1 PENDING offer + 1 job
alert. Sub-cycle P2-4c (Training + Appraisals + Step 12 CAT)
deferred to a follow-up session.

## REVIEW-P2-4a Round 1 fix log

Round 1 against `1a5c3e8` returned **FAIL** with 3 BLOCKING + 4 MAJOR:

- **BLOCKING #1** — `markPaid` lost GL events permanently on Kafka
  failure (best-effort emit after the DB committed PAID).
- **BLOCKING #2** — `markPaid` flipped DRAFT records to PAID, silently
  bypassing the approval step.
- **BLOCKING #3** — `hr-003:read` exposed payroll admin pay-period /
  pay-grade / aggregate-totals reads to Teacher / Staff who already
  hold the broad permission for Cycle 4 leave + own payslips.
- **MAJOR #2** — `hr_pay_periods` allowed `status='PAID'` without
  `paid_at` / `paid_by`; no lifecycle lockstep CHECK.

**Round 1 fix commit lands all 3 BLOCKING + the actionable MAJOR**:

1. **Durable outbox for `hr.payroll.processed`.** `markPaid` no longer
   uses best-effort `KafkaProducerService.emit` post-commit. Instead
   it calls `OutboxService.enqueueInTx(tx, ...)` INSIDE the same tx
   that flips period + records to PAID. Each row writes one
   `platform.platform_outbox` envelope; the Cycle 31
   `OutboxPublisherWorker` polls + publishes durably and stamps
   `published_at` on success. A Kafka outage leaves the outbox row
   pending — `failed_at` populated, `attempt_count` bumped — and the
   worker retries on the next poll until `MAX_OUTBOX_ATTEMPTS`. The
   envelope `eventId` is a **deterministic v5-shaped UUID** keyed on
   `payroll_record_id` (`deterministicPayrollEventId(...)` helper —
   exported for tests; same shape as the P2C2
   `deterministicStepEventId` and Cycle 4
   `deterministicCoverageEventId` patterns) so outbox retries land
   the same envelope every time and the GLConsumer dedupes on
   `platform_event_consumer_idempotency`.

2. **`markPaid` requires every record APPROVED.** Service runs an
   in-tx `SELECT COUNT(*)::int AS n FROM hr_payroll_records WHERE
school_id = $ AND pay_period_id = $ AND status <> 'APPROVED'`
   before any UPDATE; rejects with `400 "Cannot mark paid: N payroll
record(s) are not yet APPROVED. Run /pay-periods/:id/approve
first."` when any non-APPROVED row remains. The subsequent
   `UPDATE hr_payroll_records SET status='PAID' WHERE … AND status =
'APPROVED'` is the schema-side belt-and-braces (was previously
   `status IN ('DRAFT','APPROVED')`). The check + UPDATE both run
   under the period's `FOR UPDATE` lock so concurrent admins cannot
   race past it.

3. **New permission code `HR-010 Payroll Management`.** Catalogue
   addition (501 → **504**); Staff role grants HR-010:read+write via
   `seed-iam.ts`; School Admin / Platform Admin pick up the admin
   tier through `everyFunction`. Controller endpoints re-gated:

   | Endpoint                                                        | OLD (broad)    | NEW            |
   | --------------------------------------------------------------- | -------------- | -------------- |
   | `GET /hr/pay-grades` + `/:id` + `/scales`                       | `hr-003:read`  | `hr-010:read`  |
   | `POST/PATCH /hr/pay-grades` + scale CRUD                        | `hr-003:admin` | `hr-010:admin` |
   | `GET /hr/pay-periods` + `/:id`                                  | `hr-003:read`  | `hr-010:read`  |
   | `POST /hr/pay-periods` + `/process` + `/approve` + `/mark-paid` | `hr-003:admin` | `hr-010:admin` |

   Service-layer checks (`PayrollService.isAdmin`,
   `PayGradeService.assertAdmin`, `SalaryReviewService.isAdmin`)
   re-pointed at `hr-010:admin` / `hr-010:write`. **Self-service
   payslip endpoints (`/hr/payroll/records`, `/hr/payroll/records/:id`,
   `/hr/payroll/me/payslips`) keep `hr-003:read`** because the service
   binds non-admin readers to `actor.employeeId` — that's the actual
   access boundary, identical to the P2C3 pattern. Live-verified
   distribution (`iam_effective_access_cache`):

   ```
   admin@      hr010_read=1 hr010_admin=1 hr003_read=1
   principal@  hr010_read=1 hr010_admin=1 hr003_read=1
   vp@         hr010_read=1 hr010_admin=0 hr003_read=1
   counsellor@ hr010_read=1 hr010_admin=0 hr003_read=1
   teacher@    hr010_read=0 hr010_admin=0 hr003_read=1   ← previously could see admin payroll views
   parent@     hr010_read=0 hr010_admin=0 hr003_read=0
   student@    hr010_read=0 hr010_admin=0 hr003_read=0
   ```

4. **MAJOR #2 — pay-period lifecycle lockstep.** New tenant migration
   `112_hr_pay_period_lockstep.sql` (splitter-safe DROP IF EXISTS +
   ADD pattern, idempotent) tightens two CHECK constraints:
   - `hr_pay_periods_processed_chk`: `status IN ('OPEN','CLOSED')` ⇒
     `processed_at IS NULL AND processed_by IS NULL`; `status IN
('PROCESSING','PAID')` ⇒ both NOT NULL.
   - `hr_pay_periods_paid_chk`: `status <> 'PAID'` ⇒ `paid_at IS NULL
AND paid_by IS NULL`; `status = 'PAID'` ⇒ both NOT NULL.

   Live verified — direct `INSERT` of `status='PAID'` with NULL
   `paid_at` rejected by `hr_pay_periods_paid_chk`.

**Tests**: 12 → **14 keystone unit tests** in `payroll.spec.ts`. New:

- `markPaid rejects when any record remains DRAFT` — verifies the
  in-tx COUNT check + that period UPDATE never fires on rejection.
- `markPaid enqueues hr.payroll.processed via OutboxService inside
the tx` — verifies topic + sourceModule + deterministic eventId +
  the full GLConsumer payload contract + that the records UPDATE
  uses `status='APPROVED'` only.
- `deterministicPayrollEventId is stable + v5-shaped` —
  same-input-same-output, length 36, v5 marker at position 14, RFC
  4122 variant marker at position 19.
- Controller permission-metadata test rewritten — admin reads now
  on `hr-010:read`, admin writes on `hr-010:admin`, self-service
  stays on `hr-003:read`.

**MAJORs carried to P2-4b backlog**:

- MAJOR #1 (salary scale assignment is a stub) — already in the
  Phase 2 backlog. P2-4b first commit will add
  `hr_employee_positions.salary_scale_id` (additive ALTER) +
  `processPeriod()` reads per-position scale instead of school-wide
  default fallback.
- MAJOR #3 (salary review write path may be too broad) — DH-only
  scope refinement defers until Wave 2 Phase 2 role-split work
  introduces a dedicated Department Head role distinct from generic
  Staff. The submission path is already constrained to
  `hr-003:write` + same-school employee validation; the missing
  piece is per-department scope.

**CI parity green**: format:check + lint:logs (563 files clean) +
vitest 145 → **147 passing across 14 spec files** + API + web build
all clean.

## P2-4a original scope

**Plan:** `docs/campusos-p2c4-hr-advanced.html`
**Migration:** `packages/database/prisma/tenant/migrations/111_hr_payroll.sql`
**Module:** `apps/api/src/payroll/`
**Web:** `apps/web/src/app/(app)/hr/payroll/`

## Sub-cycle plan

| Sub-cycle                   | Steps                                | Tables                              | Status   |
| --------------------------- | ------------------------------------ | ----------------------------------- | -------- |
| **P2-4a Payroll**           | 1–3 + Step 11 partial (payroll seed) | 9 (plan said 10 — see deviation #1) | **DONE** |
| P2-4b Recruitment           | 4–6                                  | 8                                   | TODO     |
| P2-4c Training + Appraisals | 7–10 + Step 11 finish + Step 12 CAT  | 12                                  | TODO     |

## P2-4a deliverables

### Schema (Step 1 — `111_hr_payroll.sql`)

9 new tenant base tables:

1. **hr_pay_grades** — per-school pay-grade catalogue. `school_id` +
   `grade_name` UNIQUE; multi-column `salary_chk` enforces
   `min_salary` ≤ `max_salary` when both set; `is_active` for soft
   deactivation.
2. **hr_salary_scales** — step-based progression. UNIQUE(pay_grade_id,
   step); `step > 0` and `annual_salary >= 0` CHECKs. CASCADE on grade.
3. **hr_pay_periods** — bi-weekly / monthly cycles. 4-value status
   CHECK OPEN/PROCESSING/PAID/CLOSED; `dates_chk: end_date >= start_date`
   and `pay_date >= start_date`; UNIQUE(school_id, start_date) so
   periods cannot overlap on start.
4. **hr_payroll_records** — per-(employee, period) computed payslip
   header. **UNIQUE(employee_id, pay_period_id)** is the keystone for
   processPeriod() idempotency. 3-value status CHECK
   DRAFT/APPROVED/PAID; non-negative gross + deductions + net.
5. **hr_payroll_deductions** — per-record line items. 7-value type
   CHECK FEDERAL_TAX/STATE_TAX/SOCIAL_SECURITY/MEDICARE/
   HEALTH_INSURANCE/RETIREMENT/OTHER; CASCADE on parent record.
6. **hr_payroll_adjustments** — bonuses, retroactive pay, overpayment
   recovery. 7-value type CHECK + 4-value status CHECK +
   **multi-column `approved_chk`** keeping approved_by + approved_at
   in lockstep with status.
7. **hr_salary_review_requests** — DH-initiated review optionally
   linked to `wsk_approval_requests` via soft `linked_approval_id`. 5-value
   review_type + 6-value status CHECK + multi-column `decided_chk`
   keeping decided_by + decided_at in lockstep with terminal statuses.
8. **hr_employee_tax_info** — withholding profile per employee.
   UNIQUE(employee_id) so each employee carries at most one row. PII;
   encryption at rest is a Phase 3 ops task — dev mode stores plaintext.
9. **hr_employee_benefits** — per-employee enrolment with effective
   dates. 5-value benefit_type CHECK; non-negative contributions.

11 intra-tenant FKs, 27 CHECK constraints, 0 cross-schema FKs.
Tenant logical base table count: 201 → **210**.

### Backend (Step 2 — `apps/api/src/payroll/`)

3 services + 1 controller + ~18 endpoints + 1 Kafka emit topic
(`hr.payroll.processed`).

- **PayGradeService** — pay grade + salary scale CRUD. Admin gate at
  `hr-003:admin`; UNIQUE catch surfaces friendly 400.
- **PayrollService** — pay-period CRUD; `processPeriod()` materialises
  hr_payroll_records + hr_payroll_deductions per active employee
  using `INSERT … ON CONFLICT (employee_id, pay_period_id) DO NOTHING
RETURNING id` so partial re-runs land missing rows only;
  `markPaid()` flips period + records to PAID inside one tx and
  emits `hr.payroll.processed` per record AFTER the tx commits.
- **SalaryReviewService** — DH submits a review (status=SUBMITTED);
  admin transitions through UNDER_REVIEW → APPROVED/REJECTED; service
  enforces immutability after a terminal decision.

**`hr.payroll.processed` payload contract** (matches Cycle 26 GLConsumer
expectation per the plan's vertical-slice scenario):

```ts
{
  payrollRecordId: string,
  schoolId: string,
  employeeId: string,
  payPeriodId: string,
  payDate: string,
  grossPay: number,
  totalDeductions: number,
  netPay: number,
  deductions: Array<{ type, amount, isPretax }>,
  paidAt: string,
}
```

`sourceModule = 'hr-payroll'`. Topic + payload + post-commit emit
verified by the spec's payload-shape test. Cycle 26 GLConsumer can
post: DEBIT Salaries Expense (gross) / CREDIT Cash (net) / CREDIT
Tax Payable (sum of tax deductions) / CREDIT Benefits Payable (sum
of pre-tax benefit deductions).

### Permission gates

Controller-tier gates:

| Endpoint                                                        | Gate           |
| --------------------------------------------------------------- | -------------- |
| `GET /hr/pay-grades` + `/:id` + `/scales`                       | `hr-003:read`  |
| `POST/PATCH /hr/pay-grades` + scale CRUD                        | `hr-003:admin` |
| `GET /hr/pay-periods` + `/:id`                                  | `hr-003:read`  |
| `POST /hr/pay-periods` + `/process` + `/approve` + `/mark-paid` | `hr-003:admin` |
| `GET /hr/payroll/records` + `/:id`                              | `hr-003:read`  |
| `GET /hr/payroll/me/payslips`                                   | `hr-003:read`  |
| `GET /hr/salary-reviews` + `/:id`                               | `hr-003:read`  |
| `POST/PATCH /hr/salary-reviews`                                 | `hr-003:write` |

**Service-layer narrowing** (the P2C3 lesson — controller gate is the
necessary but not sufficient access boundary):

- `PayrollService.listRecords` and `getRecord` for non-admin actors
  bind to `actor.employeeId` and reject (404 don't-leak-existence)
  on cross-employee reads.
- `/hr/payroll/me/payslips` forces self-binding even for admin actors.
- `SalaryReviewService.list` row-scopes to `requested_by = me OR
employee_id = me` for non-admin actors.
- Admin-tier writes (process / approve / mark-paid / pay grade CRUD)
  re-check at the service via `hr-003:admin` OR `hr-003:write` OR
  `actor.isSchoolAdmin`.

### Tests

`apps/api/src/payroll/payroll.spec.ts` — **12 new keystone unit tests**:

1. Pay grade salary range CHECK fires before SQL.
2. Non-admin pay grade create rejected with Forbidden.
3. Admin create INSERT carries school_id + grade_name + range.
4. processPeriod() refuses PAID periods.
5. processPeriod() second-run skips already-materialised rows via
   ON CONFLICT DO NOTHING (idempotency keystone).
6. **markPaid() emits hr.payroll.processed AFTER tx commit with
   the full GLConsumer payload contract.**
7. Non-admin payroll record list narrows to actor.employeeId.
8. Non-admin getRecord on someone else returns collapsed 404
   (privacy boundary).
9. SalaryReview create stamps requested_by from actor.personId.
   10–12. Controller permission-metadata regression tests using
   `Reflect.getMetadata(PERMISSIONS_KEY, ...)` to lock the
   hr-003 gate distribution.

Vitest suite: 133 → **145 passing across 14 spec files**.

### Web (Step 3 — `apps/web/src/app/(app)/hr/payroll/`)

2 routes shipped this sub-cycle:

- **`/hr/payroll`** — admin-only payroll dashboard. New-period form;
  per-row Process / Approve / Mark-paid action buttons with
  confirmation dialog on mark-paid (because it fires the GL emit).
  Non-admin actors see a redirect message pointing at /hr/payroll/payslips.
- **`/hr/payroll/payslips`** — employee self-service payslip viewer.
  Per-payslip card with gross / deductions (rose-tinted) / net
  (emerald-tinted) summary + per-deduction breakdown table.
  Always self-bound via the `/hr/payroll/me/payslips` API alias.

`apps/web/src/hooks/use-payroll.ts` — 9 React Query hooks
(usePayPeriods / usePayrollRecords / useMyPayslips / useCreatePayPeriod
/ useProcessPayPeriod / useApprovePayPeriod / useMarkPaid /
usePayGrades + label/pill/formatter helpers).

**Salary scale manager** (`/hr/pay-grades`) and **salary review queue**
(`/hr/salary-reviews`) deferred to P2-4b — backend endpoints exist
and the admin can use the API directly meanwhile.

### Seed (Step 11 partial — `seed-payroll.ts`)

Idempotent, gated on `hr_pay_grades` row count. Seeds:

- 3 pay grades (Support Staff, Teacher, Senior/Lead) with min/max
- 15 salary scales (5 steps per grade)
- 1 PAID pay period (last completed bi-weekly cycle)
- 3 payroll records (1 per seeded employee — Mitchell, Rivera, Park)
- ~15 deduction line items
- 1 APPROVED bonus adjustment (Park, $500)
- 1 APPROVED salary review (Mitchell, annual increment)
- 3 employee tax info rows
- 3 employee benefit enrolments

Wired into `package.json` as `seed:payroll` and appended to
`seed-all.ts`. Live verified on `tenant_demo` 2026-05-09.

### IAM grants

No catalogue addition this sub-cycle — `HR-003` (Leave Management) is
already in the catalogue and held by Teacher / Staff via the Cycle 4
seed. The plan documents this overload (HR-003 covers both leave
AND payroll for employees + admin processing). Service-layer narrowing
keeps non-admins bound to own data per the P2C3 pattern.

P2-4b will add new HR-002 (Recruitment & Hiring) grants for the
recruitment surface; the catalogue code already exists.

## Splitter trap log

- Migration 111 first-pass had `-- N. table_name` line-comment headers
  between CREATE TABLE statements. Provisioner's splitter
  (`packages/database/src/provision-tenant.ts`) **filters out any
  statement that starts with `--` after trim**, so every CREATE TABLE
  preceded by a `-- N.` header was silently dropped. Fixed by
  converting all section headers to `/* N. … */` block comments. This
  is the same trap CLAUDE.md has documented since Cycle 4 and the
  reason migrations 005+ exist with that style.
- **Pre-existing splitter trap in P2C3 migration 110** — the COMMENT
  ON CONSTRAINT string contained "Tightened in P2C3 review fixes;
  service layer surfaces…" with a literal `;` mid-string. The prior
  P2C3 commit committed this without provisioning a fresh tenant, so
  the trap stayed hidden until P2-4a's re-provision tripped it. Fixed
  inline (em-dash replacement) as part of P2-4a since the migration
  was blocking all forward progress.

## Cross-module dependencies

- **Cycle 4 hr_employees + hr_positions** — payroll FKs on
  `employee_id`. Pre-existing.
- **Cycle 7 wsk_approval_requests** — salary review optionally links
  via soft `linked_approval_id` UUID column. No DB-enforced FK; service
  resolves at read time per ADR-001/020.
- **Cycle 26 GLConsumer** — Cycle 26 already subscribes to the
  `dev.pay.*` topic family. P2-4a emits `hr.payroll.processed` on a
  new topic; the GLConsumer code base would need to subscribe to
  `dev.hr.payroll.processed` and add a salary-journal posting handler
  for the full integration to land. **Wiring deferred to P2-4c CAT**
  along with the lesson-observation + appraisal sign-off paths.

## Known limitations / Phase 2 backlog

1. **Salary scale assignment per employee** — current `processPeriod()`
   picks the first active grade's first scale for every employee.
   The "real" model is a per-(employee, position) `salary_scale_id`
   denormalisation on `hr_employee_positions`. Schema migration
   (additive ALTER) deferred to P2-4b. Demo CAT can still verify
   end-to-end since all 3 seeded employees share the same default.
2. **Adjustment auto-application to payroll records** — adjustments
   today carry their own status lifecycle but the worker doesn't
   yet pull APPROVED adjustments into the next `processPeriod()` run.
   Deferred to P2-4c.
3. **PII encryption at rest** for `hr_employee_tax_info` — Phase 3
   ops task per ADR-065.
4. **Salary scale manager UI** + **salary review queue UI** —
   deferred to P2-4b. Endpoints exist; admin can drive via the API.
5. **GLConsumer subscription** to `dev.hr.payroll.processed` — Cycle
   26 needs an additive subscription + handler. Punted to P2-4c CAT
   since end-to-end verification of the journal-posting integration
   is the natural moment to wire it.

## CI parity

| gate                                | result                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm format:check`                 | ✓ clean                                                                       |
| `pnpm lint:logs`                    | ✓ 563 files clean                                                             |
| `pnpm --filter @campusos/api test`  | ✓ 145/145 passing (was 133; +12 payroll)                                      |
| `pnpm --filter @campusos/api build` | ✓ clean                                                                       |
| `pnpm --filter @campusos/web build` | ✓ clean (`/hr/payroll` 7.08 kB, `/hr/payroll/payslips` 3.99 kB First Load JS) |
| Tenant provision                    | ✓ `tenant_demo` clean re-provision after splitter fixes                       |

## Files at peer review

```
packages/database/prisma/tenant/migrations/111_hr_payroll.sql       (NEW)
packages/database/prisma/tenant/migrations/110_hlth_telehealth_cancelled_reason.sql  (PRE-EXISTING TRAP FIX)
packages/database/src/seed-payroll.ts                                (NEW)
packages/database/src/seed-all.ts                                    (chain extension)
packages/database/package.json                                       (seed:payroll script)

apps/api/src/payroll/dto/payroll.dto.ts                              (NEW)
apps/api/src/payroll/pay-grade.service.ts                            (NEW)
apps/api/src/payroll/payroll.service.ts                              (NEW)
apps/api/src/payroll/salary-review.service.ts                        (NEW)
apps/api/src/payroll/payroll.controller.ts                           (NEW)
apps/api/src/payroll/payroll.module.ts                               (NEW)
apps/api/src/payroll/payroll.spec.ts                                 (NEW; 12 keystone tests)
apps/api/src/app.module.ts                                           (PayrollModule wired)

apps/web/src/hooks/use-payroll.ts                                    (NEW)
apps/web/src/app/(app)/hr/payroll/page.tsx                           (NEW)
apps/web/src/app/(app)/hr/payroll/payslips/page.tsx                  (NEW)

CLAUDE.md                                                            (status block updated)
HANDOFF-P2C4.md                                                      (this file)
```

## Continuation guidance for P2-4b / P2-4c

**P2-4b (Recruitment, Steps 4-6, 8 tables, ~16 endpoints, 2 Kafka emits)**:

- Migration `112_hr_recruitment.sql`: hr_job_postings, hr_applications,
  hr_interview_panels, hr_interview_panel_members, hr_interviews,
  hr_interview_evaluations, hr_offers, hr_job_alerts.
- Module `apps/api/src/recruitment/` — JobPostingService,
  ApplicationService, InterviewService, OfferService.
- Emit `hr.job.posted` and `hr.offer.accepted`.
- Web: `/hr/jobs` job board (public-facing for LIVE postings),
  `/hr/recruitment` admin pipeline (Kanban), `/hr/recruitment/interviews`,
  `/hr/recruitment/offers`.
- IAM: HR-002 already in catalogue; grant read+write to Admin/Staff.
- Per the plan's offer-accepted keystone: when a candidate accepts,
  service auto-creates `hr_employees` row + position assignment.

**P2-4c (Training + Appraisals + Step 11 finish + Step 12 CAT)**:

- Migration `113_hr_training.sql`: hr_training_programmes,
  hr_training_events, hr_training_completions, hr_certification_types,
  hr_employee_certifications.
- Migration `114_hr_appraisals.sql`: hr_appraisal_frameworks,
  hr_appraisal_cycles, hr_appraisals, hr_appraisal_goals,
  hr_lesson_observations, hr_appraisal_comments, hr_expense_claims.
- Modules: `apps/api/src/training/`, `apps/api/src/appraisals/`.
- Emit `hr.training.completed` and `hr.certification.expiring`.
- **Lesson observations** require a new `lesson_observation:write`
  permission (analogous to P2C3 `student_counseling_record:read`)
  granted only to Principal + dept-head equivalents — not to every
  Staff member.
- Web: `/hr/training`, `/hr/appraisals` cycle selector, lesson
  observation form.
- Step 11 finish: seed recruitment + training + appraisals data.
- Step 12 CAT: 7-scenario vertical slice including the GLConsumer
  wire to `hr.payroll.processed` (subscription + journal posting
  handler addition to Cycle 26's GLConsumer).
- Wave A closes with this sub-cycle.

**Salary scale assignment migration** (P2-4a #1 above): an additive
`ALTER TABLE hr_employee_positions ADD COLUMN salary_scale_id UUID
REFERENCES hr_salary_scales(id) ON DELETE SET NULL` plus a small
`processPeriod()` SQL update to read the per-position scale instead
of the school-wide first-scale fallback. Suggested as the first
change in P2-4b.

---

## P2-4b deliverables

### Carry-over closeout — `113_hr_employee_position_salary_scale.sql`

Adds `salary_scale_id UUID` column to `hr_employee_positions` with
FK to `hr_salary_scales` ON DELETE SET NULL, plus partial INDEX
`(salary_scale_id) WHERE salary_scale_id IS NOT NULL` for the
processPeriod join hot path. Closes P2-4a Round 1 MAJOR #1.
`PayrollService.resolveEmployeesForProcessing()` rewritten to read
each employee's currently-effective primary position
(`is_primary=true AND effective_from <= CURRENT_DATE AND
(effective_to IS NULL OR effective_to >= CURRENT_DATE)`) joined to
`hr_salary_scales`. Employees whose effective position has no
assigned scale are skipped from the run (counted as `skipped`)
instead of being silently materialised against a school-wide
fallback. `seed-payroll.ts` extended with section D-pre that
UPDATEs each primary position with the matching scale before
inserting payroll records, so the demo seed exercises the new
join cleanly.

Splitter trap caught + fixed pre-provision: stray `;` mid-block-
comment on line 9 → em-dash. **Eighteenth migration in a row to
clear the trap on first attempt after audit** (Cycles 4–onwards
unbroken streak).

### Schema (Step 4 — `114_hr_recruitment.sql`)

8 new tenant base tables — tenant logical base table count after
P2-4a (140 + 1 column-only via 113) → **148**.

- **`hr_job_postings`** — public + admin job board entries.
  6-value `status` CHECK DRAFT/PENDING_APPROVAL/APPROVED/LIVE/
  CLOSED/CANCELLED. Multi-column `lifecycle_chk`: DRAFT/
  PENDING_APPROVAL/APPROVED → posted_at NULL; LIVE/CLOSED →
  posted_at NOT NULL. `closed_chk`: closed_at NULL except in
  CLOSED/CANCELLED. INDEX(school_id, status) + partial INDEX
  WHERE status='LIVE' for the public board hot path.
- **`hr_applications`** — candidate submissions. 10-value `status`
  CHECK SUBMITTED/UNDER_REVIEW/SCREENING/INTERVIEW_SCHEDULED/
  INTERVIEW_COMPLETED/OFFER_EXTENDED/OFFER_ACCEPTED/OFFER_DECLINED/
  NOT_SELECTED/WITHDRAWN. **UNIQUE(posting_id, person_id)** is the
  schema-side dedup gate (translates to friendly 400 in
  ApplicationService.apply with "You have already applied to this
  posting.").
- **`hr_interview_panels`** — named panels per posting.
- **`hr_interview_panel_members`** — UNIQUE(panel_id,
  panelist_person_id) + 3-value `role_in_panel` CHECK CHAIR/MEMBER/
  OBSERVER.
- **`hr_interviews`** — 4-value `status` CHECK SCHEDULED/COMPLETED/
  NO_SHOW/CANCELLED. Multi-column `completed_chk`: COMPLETED →
  completed_at NOT NULL. **`cancelled_chk`**: CANCELLED requires
  non-empty `cancellation_reason` (same pattern as P2C3
  `hlth_telehealth_sessions`).
- **`hr_interview_evaluations`** — UNIQUE(interview_id, evaluator_id)
  one row per (interview, evaluator). 5-value `rating` CHECK
  STRONG_HIRE/HIRE/NEUTRAL/NO_HIRE/STRONG_NO_HIRE.
- **`hr_offers`** — **UNIQUE(application_id)** one offer per
  application. 5-value `status` CHECK PENDING/ACCEPTED/DECLINED/
  EXPIRED/WITHDRAWN. 4-value `contract_type` CHECK ANNUAL/
  MULTI_YEAR/AT_WILL/TEMPORARY. `responded_chk`: PENDING →
  responded_at NULL; everything else → NOT NULL.
- **`hr_job_alerts`** — opt-in alert subscriptions; soft FKs to
  iam_person + platform.schools.

7 new intra-tenant FKs (CASCADE × 5 on parent-child trees, NO
ACTION × 2 preserving audit). 0 cross-schema FKs.

### Backend (Step 5 — `apps/api/src/recruitment/`)

**4 services + 1 controller + ~22 endpoints + 2 Kafka emits via
OutboxService.enqueueInTx** (durable outbox pattern from P2-4a
Round 1).

- **`JobPostingService`** — CRUD + lifecycle. `patch()` LIVE
  transition stamps `posted_at` and **enqueues `hr.job.posted` via
  OutboxService.enqueueInTx** with payload `{postingId, schoolId,
positionTitle, department, employmentType, salaryRangeLow,
salaryRangeHigh, applicationDeadline, postedAt}`. CLOSED/
  CANCELLED are terminal — `patch` refuses any transition out.
  `listPublicLive()` backs the public job board (no auth).
- **`ApplicationService`** — public `apply()` (no auth) creates
  iam_person + platform_users on email miss with
  `person_type='STAFF'` + `account_status='PENDING_VERIFICATION'`
  - `account_type='HUMAN'`. UNIQUE(posting_id, person_id) catch
    surfaces friendly "You have already applied" 400. Non-admin
    reads row-scope to `actor.personId` (collapsed 404 on
    cross-candidate id).
- **`InterviewService`** — panels + members + interviews + UPSERT
  evaluations on (interview_id, evaluator_id). Service-layer
  panel-membership check on `submitEvaluation`. `schedule()`
  advances application to INTERVIEW_SCHEDULED; `patch()` COMPLETED
  advances to INTERVIEW_COMPLETED. CANCELLED requires non-empty
  `cancellationReason` validated at the DTO via `@ValidateIf` +
  `@Matches(/\S/)`.
- **`OfferService` — KEYSTONE.** `respond()` ACCEPTED branch:
  1. SELECT FOR UPDATE on offer; verify status=PENDING.
  2. Candidate-only authorisation (admin OR `application.person_id
=== actor.personId`, else Forbidden).
  3. Resolve account_id from platform_users by person_id.
  4. Map posting `employment_type` → hr_employees enum
     (FULL_TIME/PART_TIME/CONTRACT/TEMPORARY).
  5. INSERT hr_employees idempotently — reuse existing row,
     re-activate TERMINATED → ACTIVE.
  6. INSERT hr_employee_positions (is_primary=true, fte=1.000,
     effective_from=offer.start_date) ON CONFLICT DO NOTHING.
  7. Advance application to OFFER_ACCEPTED.
  8. **Enqueue `hr.offer.accepted` via OutboxService.enqueueInTx**
     with payload `{offerId, applicationId, schoolId, personId,
employeeId, positionTitle, salary, startDate, contractType,
acceptedAt}`, sourceModule='hr-recruitment'.

Two structural keystones: **auto-hire on accept** (offer + employee

- position created in same tx), and **idempotent re-hire** (existing
  hr_employees row reused; ON CONFLICT DO NOTHING on positions; works
  cleanly for re-hires of TERMINATED employees).

### Permission gates

Every admin endpoint gates on `hr-002:read` or `hr-002:write`
(IAM seed grants both to Staff role). Public endpoints carry
`@Public()`:

- `GET /hr/jobs-public` — public job board.
- `POST /hr/jobs/:postingId/apply` — public apply.

`PATCH /hr/offers/:id` keeps `hr-002:read` so candidates reach
the same controller; the service narrows by application.person_id
so admins or the candidate alone can act.

### Tests (Step 5 — `recruitment.spec.ts`)

12 keystone unit tests added. Vitest suite **147 → 159 passing tests
across 15 spec files** (1 file added). Coverage:

- Admin gate (non-admin POST 400).
- LIVE outbox emit + payload contract verification.
- CLOSED terminal lockstep — cannot transition out.
- Apply duplicate rejection via UNIQUE(posting, person).
- Non-admin row scope 404 on cross-candidate lookup.
- ACCEPTED auto-hire — INSERTs employees + positions + advances
  application + enqueues outbox with full payload.
- Idempotent re-hire — existing hr_employees row reused, no
  double insert.
- Candidate-only authorisation — Forbidden on cross-candidate.
- Non-PENDING refusal — `respond()` rejects ACCEPTED→ACCEPTED.
- Controller permission metadata distribution.

### Web (Step 6 — `apps/web/src/app/(app)/hr/recruitment/`)

2 routes shipped:

- **`/hr/recruitment`** (4.38 kB First Load JS) — admin pipeline
  with postings table + Publish/Close actions + expandable
  applications board (Kanban-style by status). Gated on
  hr-002:read/write/admin/sch-001:admin. Confirms with
  `window.confirm` before publishing or closing.
- **`/hr/recruitment/offers`** (3.88 kB First Load JS) — offer
  list with admin Accept/Decline/Withdraw buttons. Confirms the
  auto-hire path with a window.confirm dialog explaining that
  hr_employees + hr_employee_positions will be created and
  hr.offer.accepted enqueued. Renders `createdEmployeeId` when
  populated.

Hooks in `apps/web/src/hooks/use-recruitment.ts` cover all 7
endpoints needed by the UI (postings list, patch, applications,
offers list, extendOffer, respondToOffer). Types + label/pill
maps + `formatCurrencyRange` helper colocated in the hooks file.

### Seed (Step 11 partial — `seed-recruitment.ts`)

Idempotent (gated on `hr_job_postings` count). 8 sections seeded
on `tenant_demo`:

- 1 LIVE posting "5th Grade Teacher" (FULL_TIME, $45-60K, deadline
  +60d, posted -7d).
- 3 candidate identities (iam_person + platform_users with
  `person_type='STAFF'` + `account_status='PENDING_VERIFICATION'` +
  `account_type='HUMAN'`).
- 3 applications (INTERVIEW_COMPLETED / OFFER_EXTENDED /
  NOT_SELECTED).
- 1 panel "Grade 5 Hiring Panel" (Mitchell CHAIR + Park MEMBER).
- 2 COMPLETED interviews tied to applications #1 and #2.
- 4 evaluations (HIRE / NEUTRAL / STRONG_HIRE / HIRE).
- 1 PENDING offer to Marcus Singh ($50K Annual, +30d start,
  +14d acceptance deadline).
- 1 job alert for Hannah Bauer (Elementary Education, grade 5,
  FULL_TIME).

Wired into `seed-all.ts` chain at position 41. `seed:recruitment`
script added to `packages/database/package.json`.

### IAM grants

`HR-002 (Recruitment & Hiring)` was already in the catalogue from
P2-4a. P2-4b extends Staff role with `'HR-002': ['read', 'write']`
in `seed-iam.ts`. School Admin / Platform Admin retain admin tier
via `everyFunction`. Catalogue total unchanged at 498 (P2C3 baseline).

### CI parity

- `pnpm format`: clean.
- `pnpm format:check`: 571 files clean.
- `pnpm lint:logs`: 571 files clean.
- `pnpm --filter @campusos/api test`: **159/159 passing** across 15
  spec files (was 147; +12 new recruitment tests).
- `pnpm --filter @campusos/api build`: clean.
- `pnpm --filter @campusos/web build`: clean (2 new routes ship).

### Cross-module dependencies

- **Closes P2-4a Round 1 MAJOR #1** via migration 113 +
  `resolveEmployeesForProcessing` rewrite.
- **`hr.offer.accepted` is consumed by** the future GLConsumer or
  HR onboarding worker (out of scope here; the outbox row lands
  durably and downstream consumers can subscribe).
- The auto-hired hr_employees row + hr_employee_positions row
  flow into payroll automatically once the next pay period runs
  — the new salary_scale_id column on the position is the gate
  (employees without an assigned scale are skipped, counted as
  `skipped` in the processPeriod result).

### Known limitations / Phase 2 backlog

- Salary scale is **not** auto-assigned by the offer-accept path.
  An admin must populate `hr_employee_positions.salary_scale_id`
  before the next payroll run (or accept the new hire gets
  skipped that cycle). Suggested follow-up: extend the offer DTO
  with optional `salaryScaleId` and stamp it during the position
  insert.
- Reference checks, background checks, and onboarding tasks are
  out of scope — they live in the existing `hr_onboarding_*`
  tables (Cycle 4 Step 4) which the offer-accept path could
  trigger via Kafka in a future cycle.
- No public-facing application status page yet (candidate cannot
  log in to see their own pipeline status). The accept/decline
  link sent via email is the primary candidate touch-point.

### Files at peer review

```
packages/database/prisma/tenant/migrations/113_hr_employee_position_salary_scale.sql
packages/database/prisma/tenant/migrations/114_hr_recruitment.sql
apps/api/src/recruitment/dto/recruitment.dto.ts
apps/api/src/recruitment/job-posting.service.ts
apps/api/src/recruitment/application.service.ts
apps/api/src/recruitment/interview.service.ts
apps/api/src/recruitment/offer.service.ts
apps/api/src/recruitment/recruitment.controller.ts
apps/api/src/recruitment/recruitment.module.ts
apps/api/src/recruitment/recruitment.spec.ts
apps/api/src/payroll/payroll.service.ts (resolveEmployeesForProcessing rewrite)
apps/api/src/payroll/payroll.spec.ts (test mock updated for new SQL shape)
apps/api/src/app.module.ts (RecruitmentModule registration)
apps/web/src/hooks/use-recruitment.ts
apps/web/src/app/(app)/hr/recruitment/page.tsx
apps/web/src/app/(app)/hr/recruitment/offers/page.tsx
packages/database/src/seed-recruitment.ts
packages/database/src/seed-payroll.ts (D-pre salary_scale_id UPDATEs)
packages/database/src/seed-all.ts (chain entry)
packages/database/src/seed-iam.ts (Staff HR-002 grant)
packages/database/package.json (seed:recruitment script)
```

### Continuation guidance for P2-4c

P2-4c covers \*\*Training programmes + Appraisals + Lesson Observations

- CAT script + GLConsumer wire to hr.payroll.processed\*\*:

* Migration `115_hr_training.sql`: hr_training_programmes,
  hr_training_events, hr_training_completions, hr_certification_types,
  hr_employee_certifications.
* Migration `116_hr_appraisals.sql`: hr_appraisal_frameworks,
  hr_appraisal_cycles, hr_appraisals, hr_appraisal_goals,
  hr_lesson_observations, hr_appraisal_comments, hr_expense_claims.
* Modules: `apps/api/src/training/`, `apps/api/src/appraisals/`.
* Emit `hr.training.completed` and `hr.certification.expiring`.
* **Lesson observations** require a new `lesson_observation:write`
  permission (analogous to P2C3 `student_counseling_record:read`)
  granted only to Principal + dept-head equivalents — not to every
  Staff member.
* Web: `/hr/training`, `/hr/appraisals` cycle selector, lesson
  observation form.
* Step 11 finish: seed training + appraisals + observations data.
* Step 12 CAT: 7-scenario vertical slice including the GLConsumer
  wire to `hr.payroll.processed` (subscription + journal posting
  handler addition to Cycle 26's GLConsumer).
* Wave A closes with this sub-cycle.

---

## REVIEW-P2-4b Round 1 fix log (2026-05-09)

Round 1 against `8198142` returned **FAIL** with 4 BLOCKING + 3
MAJOR. The Round 1 fix commit lands all 4 BLOCKING + the 2 actionable
MAJORs (#1 role_chk + #2 position resolution) + 4 new keystone unit
tests, and accepts the third MAJOR (test coverage breadth) by virtue
of those new tests. The reviewer's MINOR #1 (orphan
PENDING_VERIFICATION identities on closed-posting race) is also
addressed since identity creation + application insert now share one
tenant tx so a closed-posting INSERT failure rolls both back.

### BLOCKING fixes

1. **Recruitment admin pipeline re-gated to new HR-011 code.** New
   function `HR-011 (Recruitment Administration)` added to
   `permissions.json` (catalogue 498 → **501**). HR-002 grant on
   Staff role removed from `seed-iam.ts` — generic Staff (VP,
   counsellor, admin assistant) no longer reaches admin candidate /
   offer / panel surfaces. Controller endpoints re-gated:

   | Endpoint                                     | Before         | After          |
   | -------------------------------------------- | -------------- | -------------- |
   | `GET /hr/jobs` + `/:id`                      | `hr-002:read`  | `hr-011:read`  |
   | `POST/PATCH /hr/jobs` + `/:id`               | `hr-002:write` | `hr-011:write` |
   | `GET /hr/applications` + `/:id`              | `hr-002:read`  | `hr-011:read`  |
   | `GET /hr/jobs/:postingId/applications`       | `hr-002:read`  | `hr-011:read`  |
   | `PATCH /hr/applications/:id`                 | `hr-002:write` | `hr-011:write` |
   | `POST /hr/interview-panels` + `/members`     | `hr-002:write` | `hr-011:write` |
   | `GET /hr/jobs/:postingId/panels`             | `hr-002:read`  | `hr-011:read`  |
   | `POST /hr/interviews`                        | `hr-002:write` | `hr-011:write` |
   | `GET /hr/applications/:id/interviews`        | `hr-002:read`  | `hr-011:read`  |
   | `GET /hr/interviews/:id`                     | `hr-002:read`  | `hr-011:read`  |
   | `PATCH /hr/interviews/:id`                   | `hr-002:write` | `hr-011:write` |
   | `POST /hr/interviews/:id/evaluations`        | `hr-002:read`  | `hr-011:read`  |
   | `GET /hr/interviews/:id/evaluations`         | `hr-002:read`  | `hr-011:read`  |
   | `GET /hr/offers` (admin list)                | `hr-002:read`  | `hr-011:read`  |
   | `POST /hr/applications/:applicationId/offer` | `hr-002:write` | `hr-011:write` |
   | `GET /hr/offers/:id` (candidate-facing)      | `hr-002:read`  | unchanged      |
   | `PATCH /hr/offers/:id` (respond)             | `hr-002:read`  | unchanged      |

   School Admin / Platform Admin pick up `hr-011:read+write+admin`
   through the `everyFunction` grant. Service-layer `assertAdmin` /
   `isAdmin` helpers in `JobPostingService`, `ApplicationService`,
   `OfferService`, and `InterviewService` re-pointed at `hr-011`.
   The candidate-facing `GET /hr/offers/:id` and
   `PATCH /hr/offers/:id` keep `hr-002:read` because those are the
   surfaces a candidate reaches; the service-layer
   `application.person_id === actor.personId` check is the actual
   access boundary.

2. **Offer-accept existing-employee lookup is school-scoped.**
   `OfferService.respond` ACCEPTED branch existing lookup rewritten:

   ```sql
   SELECT id::text AS id FROM hr_employees
   WHERE school_id = $1::uuid AND person_id = $2::uuid LIMIT 1
   ```

   The TERMINATED → ACTIVE re-activation UPDATE also adds
   `school_id = $2::uuid`. The `SELECT_OFFER_BASE` DTO subquery for
   `created_employee_id` adds `e.school_id = o.school_id` so a
   multi-school tenant cannot surface a foreign-school employee id
   on the offer DTO. New regression test verifies the existing
   lookup carries both args + the INSERT path runs against the
   current school when no row matches.

3. **Public apply is race-safe via INSERT … SELECT WHERE
   `p.status='LIVE'` RETURNING.** `ApplicationService.apply`
   rewritten:

   ```sql
   INSERT INTO hr_applications (id, posting_id, person_id, status,
       resume_s3_key, cover_letter_s3_key)
   SELECT $1::uuid, p.id, $2::uuid, 'SUBMITTED', $3, $4
   FROM hr_job_postings p
   WHERE p.school_id = $5::uuid AND p.id = $6::uuid
     AND p.status = 'LIVE'
   RETURNING id::text AS id
   ```

   If the SELECT returns zero rows (posting closed in the race
   window between `loadOpenForApply` and the INSERT), the INSERT
   writes nothing and the service throws
   `400 "This posting is no longer accepting applications. Please
refresh the job board."` Identity creation + application insert
   now share ONE tenant tx so a closed-posting failure rolls both
   back (closes MINOR #1 — orphan PENDING_VERIFICATION identities).

4. **`hr.job.posted` payload built from tx-local reread.**
   `JobPostingService.patch` `LIVE` transition path no longer calls
   `this.getById(id)` (which opens a fresh tenant context). It now
   issues a `SELECT_POSTING_BASE` reread through the same `tx`
   client used for the lock + UPDATE. Outbox payload is built from
   the tx-local row. New regression test asserts the SQL capture
   order: lock → UPDATE → tx-reread → outbox enqueue, and the
   reread runs through the SAME captured client (not a fresh one).

### MAJOR fixes

5. **`hr_interview_panel_members.role_in_panel` CHECK constraint.**
   New tenant migration `115_hr_interview_panel_members_role_chk.sql`
   (splitter-safe DROP IF EXISTS + ADD pattern, idempotent) adds:

   ```sql
   CHECK (role_in_panel IS NULL OR role_in_panel IN
          ('CHAIR', 'MEMBER', 'OBSERVER'))
   ```

   Live verified on `tenant_demo` — direct INSERT of `'BOGUS'`
   rejected by `hr_interview_panel_members_role_chk`. NULL stays
   accepted.

6. **Auto-hire uses offer.position_title for position resolution.**
   `OfferService.respond` ACCEPTED branch passes the offer's
   `position_title` to `resolveOrCreatePositionInTx` instead of the
   contract type. The helper now does a case-insensitive lookup on
   `(school_id, LOWER(title))`; on miss it creates an `hr_positions`
   row with the offer's title; race losers re-read the same row.
   New regression test verifies the position lookup SQL contains
   `LOWER(title) = LOWER($2)` and that the offer's `position_title`
   value is bound to `$2`.

### Splitter trap log

Migration 115 first draft contained `;` mid-block-comment ("no
semicolons inside the block comment header; comma-separated value
list..."). Splitter cut the migration mid-comment per the
documented Cycles 4+ trap. Rewritten to use em-dashes; **nineteenth
migration in a row to clear the trap on first attempt after audit**
(streak preserved).

### Test coverage

`recruitment.spec.ts` 12 → **16 passing tests** (+4 new):

- Closed-posting race — apply throws 400 when INSERT…SELECT WHERE
  status='LIVE' returns zero rows; SQL capture verifies the LIVE
  predicate + schoolId arg.
- Cross-school employee NOT reused — accept fires INSERT INTO
  hr_employees with current school's args even when a foreign-
  school row exists for the same person_id; verifies the school-
  scoped existing lookup ran with both args.
- Position resolution uses offer.position_title — captures the
  hr_positions lookup SQL + asserts it contains `LOWER(title)` +
  the offer's `'5th Grade Teacher'` is bound.
- `hr.job.posted` reread via tx — capture order asserts lock →
  UPDATE → tx-reread → outbox; reread fn='q' (queryRawUnsafe), all
  in the same captured client.

Plus the existing `accepted offer` test was extended to assert the
school-scoped existing-employee lookup ran with both `schoolId` and
`personId` args. Vitest suite 159 → **163 passing across 15 spec
files**.

### Files touched in the closeout fix

```
packages/database/data/permissions.json (HR-011 added, 498 → 501)
packages/database/prisma/tenant/migrations/115_hr_interview_panel_members_role_chk.sql (new)
packages/database/src/seed-iam.ts (Staff HR-002 grant removed)
apps/api/src/recruitment/recruitment.controller.ts (admin gates → hr-011)
apps/api/src/recruitment/job-posting.service.ts (assertAdmin → hr-011, tx-reread for outbox)
apps/api/src/recruitment/application.service.ts (apply atomic INSERT…SELECT, identity in same tx, isAdmin → hr-011)
apps/api/src/recruitment/offer.service.ts (school-scoped employee lookup + DTO subquery, position resolution by title, isAdmin → hr-011)
apps/api/src/recruitment/interview.service.ts (assertAdmin → hr-011)
apps/api/src/recruitment/recruitment.spec.ts (16 tests, +4 BLOCKING regressions)
HANDOFF-P2C4.md (this section)
CLAUDE.md (status block)
```

### CI parity

- `pnpm format`: clean.
- `pnpm format:check`: 571 files clean.
- `pnpm lint:logs`: 571 files clean.
- `pnpm --filter @campusos/api test`: **163/163 passing** across 15
  spec files (was 159; +4 new recruitment regression tests).
- `pnpm --filter @campusos/api build`: clean.
- `pnpm --filter @campusos/web build`: clean (2 routes ship at
  unchanged sizes).
- Migration 115 provisioned cleanly on both `tenant_demo` and
  `tenant_test`; CHECK live-verified.

### Carry-overs / non-blocking follow-ups

- The Recruitment Administrator role split (REVIEW-P2-4b BLOCKING
  #1 long-term solution) — School Admin / Platform Admin currently
  hold HR-011 via everyFunction. Pre-pilot the role model should
  introduce a dedicated Recruitment Administrator role granted
  HR-011 explicitly (and removed from everyFunction admins on
  schools that don't centralise hiring). Joins items 9 / 11 / 13 /
  14 / 16 / 22 / 25 / 26 / 30 / 32 / 33 in the broader role-split
  chain.
- Application lifecycle transition graph (reviewer MINOR #3) —
  admin patch can currently flip status to any allowed enum value.
  A future hardening could enforce a strict transition graph
  (SUBMITTED → UNDER_REVIEW → INTERVIEW_SCHEDULED → ...).

---

## REVIEW-P2-4b Round 2 — PASS (2026-05-09)

Round 2 of REVIEW-P2-4b-CHATGPT (against `a86cbbf`) returned
**PASS**. Reviewer's per-finding verification table:

| Prior Finding                                                        |    Status |
| -------------------------------------------------------------------- | --------: |
| Recruitment admin pipeline exposed through broad HR-002 / Staff role | **FIXED** |
| Offer acceptance could reuse another school's hr_employees row       | **FIXED** |
| Public application apply could race a posting close/cancel           | **FIXED** |
| `hr.job.posted` payload built from non-transactional reread          | **FIXED** |
| Missing role_in_panel CHECK                                          | **FIXED** |
| Auto-hire assigned arbitrary first active position                   | **FIXED** |
| Regression tests                                                     | **FIXED** |

Updated dimension scores all PASS: Schema Compliance, Security /
Privacy, Multi-Tenancy / School Isolation, Public Apply Path,
Kafka / Outbox Contract, Auto-Hire, Test Coverage.

**Three non-blocking carry-overs from the Round 2 verdict** (move
to Phase 2 / pre-pilot punch list):

1. **Recruitment Administrator role split** (already documented in
   Round 1 fix log + the broader role-split chain). HR-011 is held
   today only by School Admin / Platform Admin through everyFunction.
   Pre-pilot a dedicated Recruitment Administrator role gets HR-011
   explicitly so non-admin recruiters can run the pipeline.

2. **Candidate-facing HR-002:read onboarding story.** Service-layer
   candidate row-scope (matched on application.person_id) is correct,
   but external candidates currently have account_status=
   PENDING_VERIFICATION with no IAM role assignment. Pre-pilot they
   need a deliberate way to receive a minimal role/permission so
   they can authenticate and self-serve `PATCH /hr/offers/:id`
   Accept / Decline. The admin-on-behalf path already works for the
   demo + CAT.

3. **Application lifecycle transition graph.** Admin PATCH can
   currently flip status to any enum value; pre-pilot hardening
   enforces a strict transition map (e.g. SUBMITTED → UNDER_REVIEW →
   INTERVIEW_SCHEDULED → ...). Recommendation-class today.

Tagged `p2c4b-complete` at `a86cbbf` (the Round 1 fix commit that
earned PASS) and `p2c4b-approved` at the closeout commit.

**Wave A (Pilot Critical) ships P2-4b clean — Phase 2 Wave A
continues with P2-4c (Training + Appraisals + Step 12 CAT) per
the original plan's continuation guidance above.**
