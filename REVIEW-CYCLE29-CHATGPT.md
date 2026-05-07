# REVIEW-CYCLE29-CHATGPT

**Cycle:** 29 — Analytics & Reporting (M110, Wave 7 opener).
**Status:** Awaiting Round 1 verdict.
**Round 1 commit:** `cycle29-complete` at TBD (see git log on `main`).
**Live verification:** `tenant_demo` 2026-05-07.

---

## What this cycle ships

Cycle 29 ships the M110 Analytics module — 16 of the 34 ERD tables in scope across 3 migrations (095 + 096 + 097). The operational read layer per ADR-008 CQRS-lite. **Wave 7 (Analytics & Governance) opens here.**

Six structural keystones:

1. **READ MODEL OWNERSHIP (ADR-008)** — every `rpt_*` table has exactly one owning module + one writing worker. Analytics API is read-only.
2. **FROM_SNAPSHOT REBUILD (ADR-049)** — `rpt_rebuild_snapshots` stores frozen aggregate state + per-topic-partition Kafka offsets. SLA <10 min.
3. **OFFSET-BASED CHECKPOINTS** — `rpt_analytics_worker_checkpoints` stores Kafka positions, never timestamps.
4. **CONFIGURABLE AT-RISK DETECTION** — `rpt_at_risk_configurations.trigger_conditions JSONB` + AtRiskEvaluationWorker emits `rpt.at_risk.flagged` for new flags.
5. **CHAINED NIGHTLY EXECUTION** — SIS → Classroom → AtRisk → SchoolSummary → District (03:00 UTC) → Wellbeing → Finance.
6. **REPORT ENGINE WITH CRON SCHEDULING** — `rpt_scheduled_reports` + ScheduledReportWorker; first cron-driven worker in CampusOS.

Backend: AnalyticsModule with **7 workers + 3 services + 1 controller + 30 endpoints + 1 Kafka emit topic** (`rpt.at_risk.flagged`).

Web: 1 new `Analytics` launchpad tile + 12 routes + 22 React Query hooks.

Cycle ships nightly batch materialisation only; per-event Kafka consumer wiring lands per-read-model in Phase 2 per ADR-049.

CAT script: `docs/cycle29-cat-script.md`. Plan: `docs/campusos-cycle29-implementation-plan.html`. Handoff: `HANDOFF-CYCLE29.md`.

---

## Reviewer attention items already documented + on the punch list

These are not blockers; they are recorded so reviewers don't re-flag closed items:

1. **Real Kafka consumer wiring per read model** — Cycle 29 ships nightly batch materialisation only. Per-event consumers (subscribe to `att.attendance.confirmed`, `cls.grade.posted`) land per read model in Phase 2 per ADR-049. The schema is set up for Kafka-offset checkpoints; the workers currently use synthetic offsets.
2. **PDF / XLSX rendering** — `output_s3_key` is recorded; actual S3 + headless Chrome / ExcelJS upload is stubbed. Pre-pilot work.
3. **Cron polling loop** — `ScheduledReportWorker.runNow()` works for both admin-trigger and future cron-tick paths; the actual setInterval polling registration ships with the production deploy container.
4. **18 deferred ERD tables (Cycle 29.1)** — domain-specific read models for procurement / store / officials / facilities / transportation / food service / IT / library / enrollment / athletics / groups / publications / clubs / messaging surface as their owning modules ship per-domain workers post-pilot.
5. **Multi-school district** — single school in demo tenant. DistrictAnalyticsWorker correctly aggregates across `rpt_school_summary` rows joined on `organisation_id`, but rankings only really exercise when 2+ schools are seeded. The seed plants a synthetic Elmwood comparison row to make the dashboard render.
6. **Custom dashboard builder** — pre-built dashboards this cycle. Drag-and-drop dashboard widget configuration is a future polish item.
7. **Multi-year trend analysis** — current year + prior year comparison only.
8. **Read replica routing (ADR-050)** — analytics queries currently route through the same Postgres connection as the operational module.
9. **Snapshot rebuild SLA** — `rpt_rebuild_snapshots` is schema-ready but the FROM_SNAPSHOT rebuild path is not yet exercised end-to-end.
10. **`rpt_state_report_templates` should be platform-scope** — the schema places it in tenant scope today.
11. **Splitter `--`-line-comment fragility** — the SQL splitter drops any chunk that begins with `--` after trim, even if the chunk contains real SQL after the comment. Cycle 29 caught this on Cycle 28 migration 094 (re-provision lost the DROP CONSTRAINT IF EXISTS); fix landed in this cycle by rewriting two `--` block headers to `/* */`. Pre-pilot rewrite the splitter to strip `--` lines per-chunk.
12. **At-risk worker overwrites seed flags** — SISReadModelWorker re-materialises `rpt_student_academic_summary` from real `cls_grades` / `sis_attendance_records`. The CAT manually plants a low-GPA student before the at-risk run for a deterministic envelope emit. Joins item 1 above.

---

## Reviewer prompt (paste this into ChatGPT alongside the listed files)

> You are reviewing Cycle 29 of CampusOS — the M110 Analytics & Reporting module that opens Wave 7 (Analytics & Governance). The spec, plan, and verification record are all in this repo. Your job is to verify the implementation against the plan and call out any **BLOCKING** correctness/security/data-integrity issues, then any **MAJOR** robustness/architecture issues that should land before pilot.
>
> **Scope:** review the closeout commit on `main` (`HANDOFF-CYCLE29.md` calls out the SHA). Treat `CLAUDE.md` Project Status section as the authoritative summary of what shipped. Treat `docs/cycle29-cat-script.md` as the live verification record on `tenant_demo` 2026-05-07.
>
> **Files to read in order:**
>
> 1. `docs/campusos-cycle29-implementation-plan.html` — the spec.
> 2. `HANDOFF-CYCLE29.md` — final cycle summary with iteration log + Phase 2 punch list.
> 3. `docs/cycle29-cat-script.md` — the CAT (10 plan scenarios verified live).
> 4. `packages/database/prisma/tenant/migrations/095_rpt_infrastructure.sql`, `096_rpt_core_read_models.sql`, `097_rpt_district_reports.sql` — the schema.
> 5. `packages/database/src/seed-analytics.ts` — the seed.
> 6. `apps/api/src/analytics/workers.service.ts` (SIS + Classroom + AtRisk workers + Checkpoint helper), `cross-domain.service.ts` (School + District + Wellbeing + Finance workers), `reports.service.ts` (Report engine + Scheduled reports), `dashboard.service.ts` (read-only across all rpt\_\*), `analytics.controller.ts`, `analytics.module.ts`.
> 7. `apps/web/src/hooks/use-analytics.ts` + `apps/web/src/lib/analytics-format.ts` + the 12 routes under `apps/web/src/app/(app)/analytics/*`.
>
> **Specifically verify:**
>
> - READ MODEL OWNERSHIP (ADR-008) — workers are the sole writers; the Analytics API surface (DashboardService) only SELECTs. No UPSERT in DashboardService.
> - At-risk flagging emits `rpt.at_risk.flagged` only for NEW flags (not previously present). Worker preserves existing flags via load-and-diff before UPDATE.
> - Cross-tenant isolation — every backend service path uses `executeInTenantContext` or `executeInTenantTransaction`.
> - Permission gates match the IAM seed grants. Teacher row scope binds via `sis_class_teachers` → `sis_enrollments` chain.
> - Wellbeing trends contain NO individual student identifiers (privacy invariant). Schema has no `student_id` column.
> - ScheduledReportWorker correctly computes `next_run_at` from cron expression with timezone handling.
> - FinanceARWorker bucket math reads from Cycle 6 `pay_invoices` / `pay_payments` / `pay_refunds` correctly.
>
> **Disposition format:** for every finding, classify as BLOCKING / MAJOR / MINOR / DEVIATION-FOLLOW-UP and supply the file path + line number + before/after suggestion. Group findings by class. End with a Round 1 verdict (Approved | Reject pending fixes).

---

## Triage table (to fill in when Round 1 returns)

| #   | Class | Title | Disposition |
| --- | ----- | ----- | ----------- |

(empty until verdict lands)

---

## Verification trail (to fill in when fixes land)

(empty until Round 1 fix commit lands)
