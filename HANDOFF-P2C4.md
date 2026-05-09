# P2C4 — HR Advanced (M80 .1 + M87 Appraisals) — HANDOFF

**Status:** P2-4a (Payroll) ships clean, awaiting peer review. Sub-cycles
P2-4b (Recruitment) and P2-4c (Training + Appraisals) deferred to a
follow-up session. The plan called this out explicitly: "if Claude
Code hits context limits, split into 3 sub-cycles… commit after each
sub-cycle." This commit is sub-cycle a.

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
