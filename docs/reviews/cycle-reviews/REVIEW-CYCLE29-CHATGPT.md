# REVIEW-CYCLE29-CHATGPT

**Cycle:** 29 — Analytics & Reporting (M110, Wave 7 opener).
**Round 1 verdict:** **Reject pending fixes** — 5 BLOCKING + 4 MAJOR.
**Round 1 commit:** `cycle29-complete` at `99d80e7`.
**Round 1 fix commit:** `3ee566d` on `main`.
**Round 2 verdict:** **Approved.** Cycle 29 ships clean. Tagged `cycle29-approved` at `3ee566d`. **Wave 7 (Analytics & Governance) opens with this approval.**
**Live verification:** `tenant_demo` 2026-05-07.

---

## Triage table

| #          | Class         | Title                                                        | Disposition                                                                                                                                      |
| ---------- | ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| BLOCKING 1 | Privacy       | Teacher academic dashboard exposes at-risk flags via RPT-001 | **Fixed** — `listAcademic` strips `at_risk_flags` for non-managers + 403s `atRiskOnly=true`.                                                     |
| BLOCKING 2 | Validity      | At-risk config JSON not validated                            | **Fixed** — `validateTriggerConditions` enforces allowed keys + ranges; rejects unknown keys.                                                    |
| BLOCKING 3 | Validity      | Recipient IDs not tenant-validated                           | **Fixed** — shared `assertAccountsInCurrentTenant` helper applied to both at-risk + scheduled report create/update paths.                        |
| BLOCKING 4 | Bug           | Scheduled-report `next_run_at` ignores timezone              | **Fixed** — `computeNextRun(cron, timezone)` walks the cron via `Intl.DateTimeFormat` in the target zone. Invalid TZ → 400.                      |
| BLOCKING 5 | Authorisation | Worker trigger permissions too broad                         | **Fixed** — per-worker WORKER_PERMS table; `runWorkers` pre-checks every selected worker's tier; controller gate downgraded to lowest tier.      |
| MAJOR 6    | Authorisation | `listAgedDebtors` exposed via Staff RPT-002                  | DEVIATION-FOLLOW-UP — joins items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / role-split chain in CLAUDE.md.                                |
| MAJOR 7    | Validity      | Report definition templateConfig.data_source not validated   | **Fixed** — `validateTemplateConfig` enforces allowlist at create + update; allowlist hoisted to `ReportDefinitionService.ALLOWED_DATA_SOURCES`. |
| MAJOR 8    | Authorisation | `listRunsForReport` / `listScheduled` not actor-aware        | DEVIATION-FOLLOW-UP — joins the role-split chain. Phase 2.                                                                                       |
| MAJOR 9    | UX            | Worker chain returns HTTP 200 with FAILED entries            | DEVIATION-FOLLOW-UP — UI surfaces FAILED via the status pill; matches the handoff "failure in one doesn't cascade" model. Phase 2 polish.        |

---

## Verification trail (live on `tenant_demo` 2026-05-07)

### BLOCKING 1 — teacher academic dashboard strips at-risk flags

```
=== teacher /academics ===
  rows=15  flagged_in_payload=0 (must=0)  all_empty=15
=== teacher /academics?atRiskOnly=true ===
HTTP 403
=== admin /academics ===
  rows=15  flagged_in_payload=1
```

Non-manager actors get the academic summary for their own classes with every `atRiskFlags` row set to `{}`. The `atRiskOnly` filter returns 403 with: "atRiskOnly filter requires the rpt-002:read permission. Teachers can only see academic summaries for their own classes without at-risk attribution."

### BLOCKING 2 — at-risk config JSON validation

5 paths:

```
=== attendance_threshold=2.0 ===
HTTP 400  triggerConditions.attendance_threshold must be between 0 and 1 (inclusive).

=== unknown key foo_bar ===
HTTP 400  triggerConditions has unknown key "foo_bar". Allowed keys: attendance_threshold,
          grade_threshold, missed_assignments_threshold, behaviour_incident_threshold.

=== empty conditions ===
HTTP 400  triggerConditions must include at least one of: attendance_threshold,
          grade_threshold, missed_assignments_threshold, behaviour_incident_threshold

=== valid config ===
GoodConfig-fix id: 019e0227...   (HTTP 201)
```

Range checks: attendance_threshold ∈ [0, 1], grade_threshold ∈ [0, 5], missed_assignments_threshold + behaviour_incident_threshold integers ≥ 0. Unknown keys rejected.

### BLOCKING 3 — recipient tenant validation

Shared `DashboardService.assertAccountsInCurrentTenant(accountIds, fieldName)` helper joins through `sis_students` (via `platform_students.person_id`), `sis_guardians`, and `hr_employees` projections. Applied to:

- `DashboardService.createAtRiskConfig` (`alertRecipients`)
- `DashboardService.updateAtRiskConfig` (`alertRecipients`)
- `ScheduledReportWorker.create` (`recipientIds`)
- `ScheduledReportWorker.update` (`recipientIds`)

```
=== bogus recipient on at-risk config ===
HTTP 400  alertRecipients contains account ids not affiliated with this school: 00000000-0000-7000-8000-000000000099

=== bogus recipient on scheduled report ===
HTTP 400  recipientIds contains account ids not affiliated with this school: 00000000-0000-7000-8000-000000000099
```

### BLOCKING 4 — timezone-aware cron `next_run_at`

`computeNextRun(cron, timezone)` walks forward 1 minute at a time, evaluating the cron pattern against `Intl.DateTimeFormat` wall-clock components in the target timezone. Bounded at 366 days. Supports comma lists, ranges, step values, and named day-of-week tokens. New `assertValidTimezone(tz)` rejects unknown IANA identifiers.

```
=== "0 8 * * MON" America/Chicago (CDT in May, UTC−5) ===
nextRunAt = 2026-05-11 13:00:00+00   ✓ 08:00 Chicago = 13:00 UTC during DST

=== "0 8 * * MON" UTC ===
nextRunAt = 2026-05-11 08:00:00+00   ✓ 08:00 UTC

=== timezone "Mars/Olympus" ===
HTTP 400  timezone "Mars/Olympus" is not a valid IANA timezone identifier
          (e.g. "UTC", "America/Chicago", "Europe/London").
```

`update()` re-computes `next_run_at` whenever EITHER `scheduleCron` OR `timezone` changes, using the effective post-patch values. `runNow()` reads the stored timezone for the next-run recompute.

### BLOCKING 5 — per-worker permission gates

New `WORKER_PERMS` table:

| Worker         | Required permission |
| -------------- | ------------------- |
| sis            | rpt-001:write       |
| classroom      | rpt-001:write       |
| at-risk        | rpt-002:write       |
| school-summary | rpt-002:write       |
| wellbeing      | rpt-002:write       |
| district       | rpt-003:write       |
| finance-ar     | rpt-004:write       |

`POST /analytics/workers/run` pre-checks every selected worker's tier (or all 7 for full-chain). Any miss → 403 before any work fires. Controller gate downgraded from `rpt-002:write` to the lowest tier (`rpt-001:write`) so the inner per-worker check is the actual access boundary. School admins bypass via `actor.isSchoolAdmin`.

```
=== teacher worker:district ===          HTTP 403   (needs rpt-003:write)
=== teacher worker:finance-ar ===        HTTP 403   (needs rpt-004:write)
=== teacher worker:sis ===               HTTP 403   (gate is rpt-001:write; teacher only has :read)
=== admin worker:district ===            HTTP 201
=== admin full chain (no worker dto) === HTTP 201
  7 workers: sis=OK, classroom=OK, at-risk=OK, school-summary=OK, district=OK, wellbeing=OK, finance-ar=OK
```

### MAJOR 7 — report definition templateConfig validation

New `validateTemplateConfig` runs at create + update. The allowlist (`ReportDefinitionService.ALLOWED_DATA_SOURCES`) is now the single source of truth — `ReportRunService.run()` reads the same constant.

```
=== bogus data_source "sis_attendance_records" ===
HTTP 400  templateConfig.data_source "sis_attendance_records" is not allowed.
          Allowed values: rpt_daily_attendance_summary, rpt_student_academic_summary, ...

=== missing data_source ===
HTTP 400  templateConfig.data_source is required (string). Allowed values: ...

=== valid data_source rpt_school_summary ===
GoodReport-fix id: 019e0227...   (HTTP 201)
```

---

## MAJOR follow-ups carried to Phase 2 punch list

These are recommendation-class hardening tasks per the reviewer's gate decision. They join the existing CLAUDE.md backlog.

### MAJOR 6 — `listAgedDebtors` Staff scope

Aged debtors expose family financial data and currently allow anyone holding `rpt-002:read` (Staff role: principal/VP/counsellor stand-in). Pre-pilot, this should split to a dedicated `RPT-005:finance` permission OR carry a per-actor finance-role check. Joins items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 in the broader role-split chain.

### MAJOR 8 — `listRunsForReport` / `listScheduled` actor-aware scope

Currently RPT-004:read returns every run + schedule in the tenant. Pre-pilot: scope to creator OR an `actor.isReportAdmin` check. Demo + first-pilot acceptable; pre-pilot lock-down required.

### MAJOR 9 — Worker chain returns 200 with FAILED entries

Matches the handoff "failure in one doesn't cascade" model. The Step 8 Analytics dashboard surfaces the FAILED status pill clearly; the operator sees per-worker outcomes. Pre-pilot polish: add a dedicated header indicator when any worker in a manual run failed.

---

## Files changed in the fix commit

- `apps/api/src/analytics/dashboard.service.ts` — added `validateTriggerConditions` + `assertAccountsInCurrentTenant`; strip atRiskFlags for non-managers + 403 atRiskOnly; wired both validators into createAtRiskConfig + updateAtRiskConfig.
- `apps/api/src/analytics/reports.service.ts` — injected DashboardService into ScheduledReportWorker; added `assertValidTimezone` + rewrote `computeNextRun(cron, timezone)` with `Intl.DateTimeFormat` walker; added `validateTemplateConfig` to ReportDefinitionService + hoisted `ALLOWED_DATA_SOURCES` static; create/update/runNow paths apply timezone + recipient validation.
- `apps/api/src/analytics/analytics.controller.ts` — injected PermissionCheckService; added WORKER_PERMS map + `assertWorkerPermission`; runWorkers pre-checks every selected worker; controller gate downgraded to `rpt-001:write`.

No DB migrations required. All 5 BLOCKING + MAJOR 7 fixes are service-layer.

## Round 2 verdict

**Approved at `3ee566d`.** Reviewer's Round 2 note (verbatim):

> Cycle 29 is clean from my review perspective. You can tag `cycle29-approved` at `3ee566d`.
>
> All 5 BLOCKING + MAJOR 7 fixes confirmed in code:
>
> - Teacher at-risk flag exposure — fixed (`atRiskFlags` stripped to `{}` for non-managers, `atRiskOnly=true` returns 403)
> - At-risk configuration validation — fixed (allowlist + ranges + unknown-key rejection)
> - Recipient tenant validation — fixed (`assertAccountsInCurrentTenant` validates through `sis_students` / `sis_guardians` / `hr_employees`)
> - Timezone-aware scheduled reports — fixed (cron walked in target IANA zone via `Intl.DateTimeFormat`; create + update + run-now use stored timezone)
> - Worker-trigger permissions — fixed (per-worker permission map; controller pre-checks before running selected worker or full chain)
> - Report template config validation — fixed (single allowlist enforced at create + update + run)
>
> Phase 2 follow-ups acceptable: aged-debtors finance-tier permission, report-runs/schedule actor scoping, worker-chain UX header.

**Final gate decision: Approved.** Tagged `cycle29-approved` on `3ee566d`. **Wave 7 (Analytics & Governance) opens.** Cycle 30 (Data Governance & Compliance) closes the wave.
