# P2C4 — HR Advanced (M80 .1 + M87 Appraisals) — HANDOFF

**Status:** P2-4a (Payroll) **COMPLETE + APPROVED** at the closeout
commit (REVIEW-P2-4a — final verdict, 2026-05-09).

Tagged `p2c4a-complete` at `617e37c` (the Round 1 fix that earned
PASS) and `p2c4a-approved` at the closeout commit. Round 1 against
`1a5c3e8` returned **FAIL** with 3 BLOCKING + 4 MAJOR; Round 2
against `617e37c` returned **PASS** — reviewer cache-busted each
affected file in code on Round 2 and confirmed every fix matches.
Two non-blocking items correctly carried to P2-4b/P2-4c per the
reviewer's gate decision: salary-scale assignment stub (first
commit in P2-4b) and salary-review department scope (Wave 2
Phase 2 role-split work).

Sub-cycles P2-4b (Recruitment) and P2-4c (Training + Appraisals)
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
