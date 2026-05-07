# Cycle 29 Handoff — Analytics & Reporting

**Status:** Cycle 29 **COMPLETE — Round 1 fixes applied; awaiting Round 2 verdict.** Wave 7 (Analytics & Governance) opens here. REVIEW-CYCLE29-CHATGPT Round 1 against `cycle29-complete` (`99d80e7`) returned `Reject pending fixes` with 5 BLOCKING + 4 MAJOR; the closeout fix commit lands all 5 BLOCKINGs + MAJOR 7 with live verification on `tenant_demo` 2026-05-07. (BLOCKING 1) `listAcademic` strips `at_risk_flags` for non-managers + 403s `atRiskOnly=true`; teacher rows now show `atRiskFlags: {}` while admin sees the populated map. (BLOCKING 2) `validateTriggerConditions` enforces allowed keys + ranges and rejects unknown keys / empty / out-of-range. (BLOCKING 3) shared `assertAccountsInCurrentTenant` helper validates each platform_users.id against `sis_students` / `sis_guardians` / `hr_employees` projections; applied to at-risk + scheduled report `recipientIds` on both create + update. (BLOCKING 4) `computeNextRun(cron, timezone)` walks forward 1 minute at a time with `Intl.DateTimeFormat` evaluating wall-clock components in the target IANA zone (no new dependency); supports comma lists / ranges / step values / named DOW; rejects unknown timezones with 400. `update()` re-computes `next_run_at` whenever EITHER scheduleCron OR timezone changes. Verified live: Mon 8am Chicago → 13:00 UTC (CDT in May, UTC−5); Mon 8am UTC → 08:00 UTC. (BLOCKING 5) `WORKER_PERMS` table + per-worker pre-check inside `runWorkers`; controller gate downgraded to `rpt-001:write` (lowest tier) so the inner check is the actual access boundary; teacher → 403 on district / finance-ar / sis; admin OK on full chain. (MAJOR 7) `validateTemplateConfig` runs at create + update; `ALLOWED_DATA_SOURCES` hoisted to a static on ReportDefinitionService used by both create-time + run-time guards. **MAJORs 6 + 8 + 9 carried to Phase 2 punch list** per the reviewer's gate decision (role-split chain — listAgedDebtors needs dedicated finance-tier permission; listRunsForReport / listScheduled need actor-aware scope; worker-chain UX header for FAILED-on-200). All 6 fixes verified live. See `REVIEW-CYCLE29-CHATGPT.md` for the triage table + per-fix verification trail.

Cycle 29 builds the M110 Analytics module — 16 of the 34 ERD tables in scope. **The operational read layer (ADR-008 CQRS-lite)** that transforms the raw event stream from 28 prior cycles into actionable dashboards. No domain module serves analytics queries directly — all analytical reads go through `rpt_*` tables routed to the read replica per ADR-050. The chained nightly worker execution (SIS → Classroom → AtRisk → SchoolSummary → District → Wellbeing → Finance) is the most complex background processing pipeline in CampusOS to date.

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle29-implementation-plan.html`
**Vertical-slice deliverable:** SISReadModelWorker materialises rpt_daily_attendance_summary + rpt_student_academic_summary from operational data → ClassroomReadModelWorker materialises rpt_class_performance_summary → admin configures at-risk: "attendance < 85% AND GPA < 2.0" → AtRiskEvaluationWorker flags students + emits `rpt.at_risk.flagged` → SchoolSummaryWorker aggregates per-school → DistrictAnalyticsWorker (nightly 03:00 UTC) aggregates schools into rpt_district_summary + rpt_district_school_comparison for superintendents → admin creates "Weekly Attendance Report" definition + schedules Monday 8am EMAIL delivery → ScheduledReportWorker fires + generates CSV → principal receives the report.

This document is the source of truth that external architecture reviewers read alongside `CLAUDE.md`.

---

## Step status

| Step | Title                                                  | Status   |
| ---- | ------------------------------------------------------ | -------- |
| 1    | Analytics Infrastructure Schema                        | Complete |
| 2    | Core Read Models Schema                                | Complete |
| 3    | District + Cross-Domain + Report Engine Schema         | Complete |
| 4    | Seed Data + RPT-001..004 IAM grants                    | Complete |
| 5    | Analytics Workers NestJS Module                        | Complete |
| 6    | School + District + Cross-Domain Workers NestJS Module | Complete |
| 7    | Report Engine NestJS Module                            | Complete |
| 8    | Analytics UI — Dashboards + At-Risk                    | Complete |
| 9    | Analytics UI — Report Engine + Scheduled Reports       | Complete |
| 10   | Vertical Slice Integration Test                        | Complete |

---

## What this cycle adds on top of Cycle 28

**Greenfield — clean `rpt_*` namespace.** Cycle 29 ships the M110 Analytics module from scratch. **Wave 7 (Analytics & Governance) opens here** (Cycle 30 Data Governance & Compliance closes the wave).

- **16 new tenant base tables** across 3 migrations (095 + 096 + 097). Note: the plan's filenames (089/090/091) are out of date — those slots were taken by Cycle 27 Procurement; Cycle 28 used 092/093/094; Cycle 29 uses 095/096/097.
- **1 new backend module** (AnalyticsModule) with **7 workers + 3 services + ~30 endpoints** under `rpt-001:read/write/admin` (class dashboards) + `rpt-002:read/write/admin` (school dashboards + at-risk) + `rpt-003:read/write/admin` (district dashboards) + `rpt-004:read/write/admin` (report engine + scheduling).
- **1 new Kafka emit topic**: `rpt.at_risk.flagged` (fires when AtRiskEvaluationWorker newly flags a student). 0 new Kafka consumers — analytics workers read directly from operational tables this cycle (live consumer wiring deferred per ADR-049 incremental snapshots; nightly batch materialisation is the cycle scope).
- **4 new permission codes**: RPT-001 (Class Dashboards), RPT-002 (School Dashboards + At-Risk), RPT-003 (District Dashboards), RPT-004 (Report Engine + Scheduling). Catalogue 468 → **480**.
- **1 new web app tile** (Analytics under RPT-001:read with new `ChartBarIcon`) + **12 new web routes** (6 in Step 8 + 6 in Step 9).

**Six structural keystones for the cycle:**

1. **READ MODEL OWNERSHIP (ADR-008 KEYSTONE).** Every `rpt_*` table has exactly one owning module and one writing worker. No other module writes to a `rpt_*` table it does not own — cross-module reads are permitted for display. The worker naming convention is `{Domain}ReadModelWorker`. The Analytics API surface is read-only on every `rpt_*` table — workers are the sole writers.

2. **FROM_SNAPSHOT REBUILD (ADR-049).** `rpt_rebuild_snapshots` stores frozen aggregate state at a point in time + per-topic-partition Kafka offsets. A rebuild starts from the snapshot + replays events from those offsets — never from the beginning. SLA: <10 min for FROM_SNAPSHOT rebuild vs. hours for full replay.

3. **OFFSET-BASED CHECKPOINTS.** `rpt_analytics_worker_checkpoints` stores `(consumer_group, topic, partition, committed_offset, log_end_offset, lag)` — never timestamps. Kafka offsets are the authoritative position; timestamps drift under replays.

4. **CONFIGURABLE AT-RISK DETECTION.** `rpt_at_risk_configurations.trigger_conditions JSONB` lets schools express their own at-risk criteria (attendance threshold, GPA threshold, missed assignments, behaviour incidents). AtRiskEvaluationWorker reads each active config and evaluates against rpt_student_academic_summary. New flags emit `rpt.at_risk.flagged` so Cycle 11 counsellors get notified.

5. **CHAINED NIGHTLY EXECUTION.** SIS → Classroom → AtRisk → SchoolSummary → District (03:00 UTC) → Wellbeing → Finance — the most complex background pipeline in CampusOS. Each worker is independent + idempotent so a failure in one doesn't cascade; the next nightly run picks up.

6. **REPORT ENGINE WITH CRON SCHEDULING.** `rpt_scheduled_reports` carries a cron expression + timezone + recipient list. ScheduledReportWorker polls `WHERE next_run_at <= NOW() AND is_active=true`, runs the report via ReportRunService, computes next_run_at from the cron expression, delivers via Cycle 14 notification. **First cron-driven worker in CampusOS.**

**Existing-system touchpoints (read-only — no writes to other modules' tables):**

- `sis_attendance_records` (Cycle 1) → `rpt_daily_attendance_summary`
- `sis_enrollments` (Cycle 1) + `cls_grades` (Cycle 2) → `rpt_student_academic_summary`
- `cls_grades` + `cls_assignments` (Cycle 2) → `rpt_class_performance_summary`
- `hr_employees` + `hr_leave_requests` (Cycle 4) + `cls_grades` → `rpt_staff_summary`
- `sis_behavior_incidents` (Cycle 9) → `rpt_school_summary.incident_count`
- `svc_wellbeing_responses` (Cycle 11.1) → `rpt_wellbeing_trends` (NO individual identifiers)
- `pay_family_accounts` + `pay_ledger_entries` (Cycle 6) → `rpt_fin_aged_debtors`
- `platform.organisations` + `platform.schools` → `rpt_district_summary`

What does not change: every existing module continues to function. Cycle 29 is purely additive on a clean `rpt_*` namespace.

---

(per-step records appended as steps complete)

---

## Final cycle totals

- **Tenant base tables:** +16 `rpt_*` tables across migrations 095 + 096 + 097.
- **Backend:** AnalyticsModule with **7 workers + 3 services + 1 controller + 30 endpoints + 1 Kafka emit topic** (`rpt.at_risk.flagged`).
  - Workers: SISReadModelWorker, ClassroomReadModelWorker, AtRiskEvaluationWorker, SchoolSummaryWorker, DistrictAnalyticsWorker, WellbeingTrendsWorker, FinanceARWorker, ScheduledReportWorker.
  - Services: DashboardService (read-only across all rpt\_\*), ReportDefinitionService, ReportRunService.
- **Permission catalogue:** 156 → **160 functions × 3 tiers = 480 permissions** (+12 RPT-001..004 codes).
- **Web side:** new Analytics launchpad tile gated on `rpt-001:read OR rpt-002:read OR rpt-003:read` + new `ChartBarIcon` + **12 new web routes**:
  - Step 8: `/analytics`, `/analytics/attendance`, `/analytics/academics`, `/analytics/classes`, `/analytics/at-risk`, `/analytics/district`
  - Step 9: `/analytics/reports`, `/analytics/reports/[id]/runs`, `/analytics/scheduled-reports`, `/analytics/state-reports`, `/analytics/wellbeing`, `/analytics/aged-debtors`
- **CAT:** 10-check schema preamble + 10 plan scenarios all green on `tenant_demo` 2026-05-07. Two `rpt.at_risk.flagged` envelopes captured live with full ADR-057 shape (configName=Academic Risk + Attendance Only, conditionsMatched array populated).

---

## Iteration log

Recorded for review continuity:

1. **Splitter `--`-line-comment trap on Cycle 28 migration 094** caused Cycle 29 provisioning to fail with `constraint "str_orders_external_customer_fk" already exists`. The provision splitter (`sql.split(';')` then `.filter(s => !s.startsWith('--'))`) silently drops any chunk that begins with `--` line comments, even if the chunk contains a real SQL statement after the comment. Cycle 28's first provision worked because the constraint didn't exist yet; re-provision lost the DROP. **Fix:** rewrote two `--` block headers in 094 to `/* */` block comments. Both ALTER TABLE pairs now apply cleanly. The splitter still has the latent bug — Phase 2 hardening should rewrite the splitter to strip `--` line comments per-chunk (or use a real SQL parser).
2. **Splitter `;`-in-string trap on Cycle 29 migration 097**: 1 stray `;` in a `COMMENT ON TABLE` string ("WHERE next_run_at <= now() AND is_active=true; for each…"). Rewrote with em-dash. Cycles 4–29 unbroken streak after audit.
3. **Prisma TEXT vs NUMERIC parameter coercion**: seed-analytics passed `toFixed(4)` strings to NUMERIC columns and Prisma sent them as TEXT. Fixed with `::numeric` casts on every NUMERIC column placeholder.
4. **Worker SQL column names**: SISReadModelWorker + ClassroomReadModelWorker referenced `cls_grades.percentage` but the actual column is `grade_value`. WellbeingTrendsWorker referenced `svc_wellbeing_alerts.checkin_id` but the actual schema joins via `response_id` to `svc_wellbeing_responses.id`. FinanceARWorker referenced `pay_invoices.total` but the column is `total_amount`. All three fixed.
5. **`ResolvedActor.permissions` field doesn't exist**: DashboardService originally read `actor.permissions?.includes('rpt-002:read')`. The actual `ResolvedActor` interface only carries `accountId`, `personId`, `employeeId`, `personType`, `isSchoolAdmin`. Fixed by injecting `PermissionCheckService` and using `hasAnyPermissionInTenant`.
6. **At-risk worker overwrites seed flags**: SISReadModelWorker materialises `rpt_student_academic_summary` from real `cls_grades` + `sis_attendance_records`, which clears the hand-flagged seed students because the computed values mostly don't trip the seeded thresholds. The CAT script handles this by manually planting one student with bad metrics before the at-risk worker run, ensuring a deterministic envelope emit. Documented as Phase 2 punch list item: real Kafka consumer wiring per read model lands per-domain in Phase 2 per ADR-049.

---

## Phase 2 / pre-pilot punch list

Recorded for the post-cycle review and joins the existing CLAUDE.md backlog:

1. **Real Kafka consumer wiring per read model** — Phase 2 per ADR-049.
2. **PDF / XLSX rendering** — `output_s3_key` is recorded; actual S3 + headless Chrome / ExcelJS upload is stubbed.
3. **Cron polling loop** — `ScheduledReportWorker.runNow()` works for both admin-trigger and future cron-tick paths; the actual setInterval polling registration ships with the production deploy container.
4. **18 deferred ERD tables (Cycle 29.1)** — domain-specific read models for procurement / store / officials / facilities / transportation / food service / IT / library / enrollment / athletics / groups / publications / clubs / messaging.
5. **Multi-school district** — DistrictAnalyticsWorker correctly aggregates across `rpt_school_summary` rows joined on `organisation_id`, but rankings only really exercise when 2+ schools are seeded.
6. **Custom dashboard builder** — pre-built dashboards this cycle.
7. **Multi-year trend analysis** — current year + prior year comparison only.
8. **Read replica routing (ADR-050)** — analytics queries currently route through the same Postgres connection as the operational module.
9. **Snapshot rebuild SLA** — `rpt_rebuild_snapshots` schema-ready; FROM_SNAPSHOT rebuild path not yet exercised end-to-end.
10. **`rpt_state_report_templates` should be platform-scope** — currently per-tenant; pre-pilot move to a master table + per-tenant copy-on-create.
11. **Splitter `--`-line-comment fragility** — the SQL splitter drops any chunk that begins with `--` after trim, even if the chunk contains real SQL. Pre-pilot rewrite the splitter to strip `--` lines per-chunk.

---

## Closing record

- Plan: `docs/campusos-cycle29-implementation-plan.html`
- CAT: `docs/cycle29-cat-script.md`
- Review prompt scaffold: `REVIEW-CYCLE29-CHATGPT.md`
- Tag: `cycle29-complete` after CI green on the closeout commit.

**Wave 7 (Analytics & Governance) opens here.** Cycle 30 (Data Governance & Compliance) closes the wave.
