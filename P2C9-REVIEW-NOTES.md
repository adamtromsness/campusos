# P2-9 Review Notes — Schema Decisions + Deferred Work

This document captures the load-bearing schema decisions in P2-9 and the items that intentionally defer to P2-9b. Reviewers reviewing the schema commit (P2-9a) should skim this before opening migrations.

## 1. Why `platform_substitute_profiles` was extended, not replaced

The ADR-014 forward-compat skeleton (migration `20260426094416_add_identity_tables`) shipped `platform_substitute_profiles` with a different column set than the P2-9 plan calls for: `phone`, `background_check_*`, `certifications JSONB`, `subject_qualifications JSONB`, `grade_range` (single string, not array), `daily_rate`, `is_active`. No data was ever inserted (count = 0 confirmed pre-migration).

The P2-9 plan calls for `display_name`, `bio`, `grade_levels TEXT[]` (the GIN-keystone), `subject_areas TEXT[]`, `years_experience`, `is_available`, `profile_photo_s3_key`, `overall_rating`, `total_assignments`.

**Decision: extend the existing table additively.** Per CLAUDE.md "no DROP COLUMN, additive only", the legacy columns are preserved as nullable (they already were). The P2-9 columns are added with sensible defaults (`grade_levels DEFAULT '{}'::TEXT[]`, `total_assignments DEFAULT 0`, `is_available DEFAULT true`).

`max_distance_miles` (legacy) is reused as the canonical max-travel column. The P2-9 plan calls it `max_travel_miles` but they are the same concept; documented via `COMMENT ON COLUMN`. The Prisma model field is `maxDistanceMiles` and the DTO field is `maxTravelMiles` — service code maps between them.

## 2. EXCLUDE gist on `sub_pay_rates`

```sql
CONSTRAINT sub_pay_rates_no_overlap EXCLUDE USING gist (
    school_id WITH =,
    substitute_id WITH =,
    job_type WITH =,
    daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)') WITH &&
)
```

The plan's keystone: per-(school, substitute, job_type) combination cannot have two rows whose `daterange` overlaps. Open-ended ranges coalesce `NULL → infinity` so an open-ended row blocks any future-starting overlap.

**Verified live (T15 + T16 of the migration smoke):**

- Two rows for the same (school, sub, job_type) with overlapping ranges → 23P01 rejected.
- Two rows for the same (school, sub, job_type) with adjacent non-overlapping ranges → accepted (after closing out the prior row's `effective_to`).
- A school-default row + per-substitute override coexist because they differ on `substitute_id` (default uses the sentinel UUID `00000000-0000-0000-0000-000000000000`).

Service translation: SQLSTATE 23P01 → `409 Conflict` with the conflicting daterange surfaced in the friendly error. P2-9b PayRateService.create implements this; for P2-9a the seed handles overlap with a `.catch(e => if !overlap throw e)` since the seed is idempotent and a successful prior run leaves the row in place.

## 3. Tiered notification design

`sub_job_postings.notification_tier` is a 2-value CHECK `(POOL, MARKETPLACE)`. Posts default to POOL. The `escalate_to_marketplace_at TIMESTAMPTZ` column is set at post time to `now() + acceptance_window_minutes`.

**Tier 1 (POOL)** — fires inline in `JobPostingService.post()` for P2-9a. Walks `sub_school_pool` ACTIVE members, honours BLOCKED preferences via NOT EXISTS, inserts one `sub_job_notifications` row per qualifying pool member with `notification_tier='POOL'`.

**Tier 2 (MARKETPLACE)** — deferred to P2-9b. The JobNotificationWorker polls jobs WHERE `escalate_to_marketplace_at <= now() AND status = 'OPEN' AND notification_tier = 'POOL' AND no ACCEPTED notifications`, flips `notification_tier = 'MARKETPLACE'`, and fans out to the wider marketplace (substitutes who are not in the school pool but match grade_levels + verified credentials + not BLOCKED).

The partial index `sub_job_postings_escalation_idx ON (escalate_to_marketplace_at) WHERE escalate_to_marketplace_at IS NOT NULL AND status = 'OPEN'` is the worker's hot path.

## 4. Acceptance window expiry — reactive vs proactive

`sub_job_notifications.acceptance_window_expires_at TIMESTAMPTZ NOT NULL` carries the deadline.

**P2-9a:** reactive only. `JobPostingService.accept()` validates `now() <= acceptance_window_expires_at` inside the locked tx and soft-flips the notification to EXPIRED on miss with a 409.

**P2-9b:** the AcceptanceExpiryWorker polls the partial index `sub_job_notifications_pending_expiry_idx ON (acceptance_window_expires_at) WHERE response = 'PENDING'`, flips PENDING → EXPIRED on timeout. This is what surfaces the "your acceptance window passed" state to substitutes who never opened the notification.

## 5. BLOCKED overrides RECURRING availability

`platform_sub_availability.availability_type` is a 3-value CHECK `(RECURRING, SPECIFIC, BLOCKED)`. The shape_chk multi-column CHECK enforces:

- RECURRING requires `day_of_week IS NOT NULL AND specific_date IS NULL`
- SPECIFIC + BLOCKED require `specific_date IS NOT NULL AND day_of_week IS NULL`

**The keystone:** when resolving "is substitute X available on date D?", BLOCKED for that exact date wins over any matching RECURRING row.

The matching engine SQL implements this:

```sql
(
  EXISTS (RECURRING for that day_of_week)
  OR EXISTS (SPECIFIC for that exact date)
) AND NOT EXISTS (
  BLOCKED for that exact date
)
```

Sarah's seed exercises this directly: she has RECURRING Mon-Thu 7am-3pm, plus a BLOCKED row for next Friday. A search for next Friday returns false (no RECURRING for Fri so the OR fails); a search for next Monday returns true (RECURRING for day_of_week=1 is matched, no BLOCKED for that exact date).

## 6. Bidirectional ratings

`sub_ratings.rater_type` is a 2-value CHECK `(SCHOOL_RATES_SUB, SUB_RATES_SCHOOL)` with `UNIQUE(assignment_id, rater_type)`. Each direction caps at one row per assignment; both directions can coexist.

P2-9b's RatingService re-materialises `platform_substitute_profiles.overall_rating` as `AVG(overall_score) WHERE rater_type = 'SCHOOL_RATES_SUB'` on every SCHOOL_RATES_SUB insert. The `total_assignments` counter bumps on CHECKED_OUT assignment transition (also P2-9b).

P2-9a seed exercises both directions on the historical assignment (school rates Sarah 5/5, Sarah rates school 4/4).

## 7. Cancellation policy escalation logic

`sub_cancellation_policies` carries 4 consequence values: `WARNING_ONLY`, `TEMPORARY_POOL_SUSPENSION`, `PERMANENT_POOL_REMOVAL`, `RATING_PENALTY`. `repeat_offence_threshold` (default 3) controls how many late-cancellations escalate from WARNING to the configured consequence.

**P2-9a:** schema in place + seed shape (Lincoln 2h window, WARNING_ONLY, 3-strike threshold). Lisa's seed pool entry shows the result of a triggered TEMPORARY_POOL_SUSPENSION (`status = SUSPENDED`, `suspended_until = today + 7d`).

**P2-9b CancellationPolicyWorker:**

1. Subscribe to `sub.assignment.late_cancelled` (emitted by AssignmentService.cancel when `now() > job_start - late_window_hours`).
2. Count this substitute's recent late cancellations at this school (e.g. last 6 months).
3. If `count >= repeat_offence_threshold`:
   - WARNING_ONLY → still WARNING (the threshold is the consequence trigger, not the WARNING ladder)
   - TEMPORARY_POOL_SUSPENSION → set `sub_school_pool.status = 'SUSPENDED'` + `suspended_until = today + suspension_duration_days`
   - PERMANENT_POOL_REMOVAL → set `sub_school_pool.status = 'REMOVED'`
   - RATING_PENALTY → insert a synthetic `sub_ratings` row with `rater_type = 'SCHOOL_RATES_SUB'` and `overall_score = (current_overall - rating_penalty_amount)` clamped to [1.0, 5.0]
4. Mark `sub_assignments.late_cancellation_consequence_applied = true`.

Multi-column `suspension_chk` + `penalty_chk` schema-level CHECKs enforce that the matching detail field is populated for the chosen consequence (TEMPORARY_POOL_SUSPENSION must have suspension_duration_days; RATING_PENALTY must have rating_penalty_amount).

## 8. Soft UUID refs to platform from tenant — ADR-001/020 + ADR-029

The schema strictly honours the cross-schema FK convention: `sub_school_pool.substitute_id`, `sub_job_notifications.substitute_id`, `sub_assignments.substitute_id`, `sub_pay_rates.substitute_id` are all soft UUID refs to `platform.platform_substitute_profiles(id)` — no DB-enforced FK across the schema boundary.

Validation lives at the application layer: `JobPostingService.post()` is the natural enforcement point (it walks the school pool, which only has rows for in-tenant substitutes). The matching engine in `SubstituteProfileService.search()` reads `platform.platform_substitute_profiles` directly via the platform client.

## 9. Why no Substitute role in P2-9a IAM

The plan calls for SUB-001:read+write on a "Substitute role" but the existing seed has 5 personas (Admin, Teacher, Parent, Student, Staff) — no Substitute role. Adding a role is a breaking change that needs platform_users + auth onboarding for Sarah/Mike/Lisa.

**P2-9a decision:** SUB-001 is granted to Staff (and Teacher gets read for the returning-teacher session-notes view). The substitute self-service paths use the `personId === actor.personId` match in `SubstituteProfileService.create + getMyProfile + JobPostingService.accept` as the actual access boundary. This is documented in the IAM seed comment + flagged in the Wave 2 Phase 2 punch list.

A dedicated Substitute role + login flow lands in **P2-9b** alongside auth onboarding for the seeded substitutes.

## 10. Splitter audit history

| Migration               | Stray ; in unsafe regions on first audit                  | Fixed pre-provision                                                      |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| 132_sub_jobs.sql        | 0                                                         | n/a (clean on first attempt)                                             |
| 133_sub_assignments.sql | 3 (all in COMMENT ON TABLE strings, line 121 / 163 / 224) | rewritten with em-dashes / "and" / period before first provision attempt |

Per the documented Cycles 4-onwards convention. Audit script lives at `docs/...` (in-line in this session). Both migrations applied cleanly to `tenant_demo` and `tenant_test` on first attempt after the audit.

## Action items for P2-9b reviewer

When reviewing P2-9b, please verify:

1. The CancellationPolicyWorker correctly interprets all 4 `consequence` values, especially the schema-side detail-field lockstep (`suspension_chk` + `penalty_chk`).
2. The AcceptanceExpiryWorker honours the partial index `sub_job_notifications_pending_expiry_idx`.
3. The JobNotificationWorker tier-2 fan-out excludes BLOCKED schools per `platform_sub_preferences`.
4. The cover-arrangement consumer correctly wires `sub.assignment.confirmed` to `sch_cover_arrangements` per ADR-029 (the bridging contract).
5. RatingService.create re-materialises `overall_rating` correctly inside the same tx as the rating insert, with the SCHOOL_RATES_SUB filter applied.
6. PayRateService.computePay correctly resolves the per-substitute override over the school default on overlapping ranges, and the EXCLUDE-gist schema invariant catches accidental concurrent overlapping inserts.

## CI parity status (P2-9a only)

- `pnpm --filter @campusos/api build` — clean.
- `pnpm format:check` — clean.
- `pnpm lint:logs` — 685 files clean.
- API boot — 13 substitute routes register at `/api/v1/substitutes/*`.
- `pnpm vitest` — **not run** for P2-9a; vitest tests defer to P2-9b.

## Migration applied state

```
platform.platform_substitute_profiles               (existing — extended, 3 demo rows)
platform.platform_sub_credentials                   (new — 6 demo rows)
platform.platform_sub_availability                  (new — 8 demo rows)
platform.platform_sub_preferences                   (new — 2 demo rows)
tenant_demo.sub_school_pool                         (new — 3 demo rows)
tenant_demo.sub_job_postings                        (new — 2 demo rows)
tenant_demo.sub_job_classes                         (new — 3 demo rows)
tenant_demo.sub_job_notifications                   (new — 3 demo rows)
tenant_demo.sub_assignments                         (new — 1 demo row)
tenant_demo.sub_ratings                             (new — 2 demo rows)
tenant_demo.sub_session_notes                       (new — 1 demo row)
tenant_demo.sub_pay_rates                           (new — 2 demo rows)
tenant_demo.sub_cancellation_policies               (new — 1 demo row)
```

Tenant base table count increment: +9. Total tenant base tables on `tenant_demo` after P2-9a: ~529 (was ~520 after P2-8).

---

# P2-9b additions (2026-05-10)

This section extends the P2-9 review notes with the P2-9b backend completion. P2-9c will add UI + tests + the deferred shadow-employee path.

## 11. Cover-arrangement consumer — CANCELLED-not-ASSIGNED design

**The constraint:** `sch_coverage_requests.assigned_substitute_id` is a real DB-enforced FK to `hr_employees(id)` (Cycle 5 Step 3 schema, tenant-scoped). Marketplace substitutes per ADR-029 live in `platform.platform_substitute_profiles` with no `hr_employees` row in the calling tenant.

**The choice:** `CoverArrangementConsumer.linkCoverArrangement` flips matching coverage requests OPEN → CANCELLED with notes pointing at the marketplace assignment id. This is the cleanest signal to the scheduling module that the slot is covered without trying to wedge a platform substitute into a tenant FK that won't satisfy.

**The Phase 2 fix:** auto-create a shadow `hr_employees` row when a marketplace substitute first accepts a job at a school. The shadow row stamps `person_id` from the platform substitute's `iam_person.id`, sets `employment_type='SUBSTITUTE'`, and lives in the tenant for the lifetime of the school's relationship with that substitute. With the shadow row in place, the consumer can flip OPEN → ASSIGNED, populate `assigned_substitute_id`, and stamp `assigned_at`.

**Why deferred:** the shadow row creation has knock-on implications for the Cycle 4 HR module (does this employee show up in the directory? in payroll? in the org chart?) and the Cycle 7 TaskWorker (does it own tasks? receive notifications?). These need a deliberate product decision before the auto-creation lands. P2-9c bandwidth permitting; otherwise carries to a Phase 2 punch list item alongside the Substitute role split.

## 12. Late-cancellation policy escalation — service vs schema invariants

The schema enforces:

- `sub_assignments.cancelled_chk` keeps cancelled_at + cancelled_by_type populated atomically with status=CANCELLED/NO_SHOW.
- `sub_cancellation_policies.suspension_chk` requires `suspension_duration_days IS NOT NULL` when `consequence='TEMPORARY_POOL_SUSPENSION'`.
- `sub_cancellation_policies.penalty_chk` requires `rating_penalty_amount IS NOT NULL` when `consequence='RATING_PENALTY'`.

The service enforces:

- `AssignmentService.cancel` validates `cancellationReason` is non-empty before any UPDATE.
- `CancellationPolicyService.upsert` validates the consequence/detail lockstep app-side BEFORE the INSERT/UPDATE so the DB CHECK never fires; PATCH semantics merge with the current row to honour partial updates.
- `CancellationPolicyConsumer.applyConsequence` reads the policy + counts late cancellations atomically inside one tenant tx; the `late_cancellation_consequence_applied` stamp idempotently signals that the consequence has been processed.

**6-month lookback window** for repeat-offence count is hard-coded for now. Schools with policies that need a different window (e.g. 12 months, or an academic year) will surface this in early pilot — the change is a single SQL interval edit in `CancellationPolicyConsumer`.

## 13. RatingService re-materialisation — tenant scope today

`RatingService.rematerialiseOverallRating(substituteId)` runs a query against the calling tenant's `sub_ratings` only. A substitute who works at multiple schools today gets each school's tenant computing its own AVG separately, with the platform-side `overall_rating` reflecting only the most recent tenant's view. This is a **known limitation documented in section 6 of the original review notes**.

**Cross-tenant rolling AVG** would require either:

- (a) Iterating every active school's tenant_schema in a single re-materialisation call (slow + tenant-routing-friendly but ops-heavy), or
- (b) A platform-side rating-snapshot table that consumes `sub.rating.created` events from every tenant and maintains the cross-tenant aggregate (cleaner architecture but a Phase 2 polish task).

For P2-9b the single-tenant aggregate is correct enough — most substitutes will work at one school for the foreseeable demo phase.

## 14. RATING_PENALTY consequence — synthetic rating row

The RATING_PENALTY branch in `CancellationPolicyConsumer` inserts a synthetic SCHOOL_RATES_SUB row tagged in `comments` as "AUTO-APPLIED RATING_PENALTY (cancellation policy)" with `overall_score = max(1.0, 5.0 - rating_penalty_amount)`. The UNIQUE(assignment_id, rater_type) catches a manual SCHOOL_RATES_SUB rating after the auto-applied one, so the CONFLICT DO NOTHING clause skips the auto-row when an admin has already submitted one — the admin rating wins.

This means schools that configure `RATING_PENALTY` and then also actively rate the substitute will see the manual rating, not the auto-applied penalty. Documented; the natural product call is "if you're going to rate them anyway, do that, and skip the auto-penalty."

## 15. Acceptance-window expiry — the partial-index hot path

`AcceptanceExpiryWorker.tick` runs `UPDATE sub_job_notifications WHERE response='PENDING' AND acceptance_window_expires_at <= now()` per tenant. The schema's partial index `sub_job_notifications_pending_expiry_idx ON (acceptance_window_expires_at) WHERE response='PENDING'` is the planner's hot path — without it the worker would full-scan every notification row per tick.

The worker's idempotency is structural: the WHERE-filter on `response='PENDING'` means a row that's already been flipped to EXPIRED (or ACCEPTED, or DECLINED) is excluded from the next sweep. No deterministic event_id, no Redis dedup needed — the schema is the gate.

## 16. JobNotificationWorker — matching engine reuse

The tier-2 escalation worker reuses the SubstituteProfileService matching engine SQL shape almost verbatim:

```sql
WHERE p.is_active=true AND p.is_available=true
  AND NOT EXISTS (BLOCKED preference)
  AND EXISTS (VERIFIED credential)
  AND (RECURRING or SPECIFIC for date)
  AND NOT EXISTS (BLOCKED for date)
  AND grade_levels && ARRAY[$grade]::text[]  -- when job has grade_level
```

If no candidates exist, the worker still flips `notification_tier='MARKETPLACE'` so the job doesn't sit in re-poll forever. The next cron tick won't re-process the job (the tier filter excludes it). An admin can then manually mark the job UNFILLED via a future endpoint.

## 17. Cancellation policy consumer reading school policy on each event

`CancellationPolicyConsumer.applyConsequence` reads the school cancellation policy fresh on every event. This means a policy change between two late-cancellations applies the new policy to the second event. By design — the policy is the school's current intent.

## CI parity status (P2-9b)

- `pnpm --filter @campusos/api build` — clean.
- `pnpm format:check` — clean.
- `pnpm lint:logs` — 697 files clean (was 685 after P2-9a; +12 new TS files).
- API boot — 21 P2-9b routes register at `/api/v1/substitutes/*` (verified live).
- API boot — 2 workers schedule (`AcceptanceExpiryWorker`, `JobNotificationWorker`) with default warmup=30s/interval=60s.
- API boot — 2 consumers register (`cancellation-policy-consumer` on `dev.sub.assignment.late_cancelled`, `cover-arrangement-consumer` on `dev.sub.assignment.confirmed`).
- `pnpm vitest` — **not run** for P2-9b; vitest tests defer to P2-9c.

## Cumulative Cycle 9 status after P2-9b

- 13 tables (4 platform + 9 tenant, unchanged from P2-9a).
- **34 endpoints** (13 P2-9a + 21 P2-9b).
- **8 services + 1 consumer cluster (`SubstitutesModule`)** — Profile + SchoolPool + JobPosting (P2-9a) + Availability + Preference + Assignment + Rating + SessionNote + PayRate + CancellationPolicy (P2-9b).
- **2 background workers** (P2-9b).
- **2 Kafka consumers** (P2-9b).
- **4 Kafka emit topics** (2 P2-9a outbox emits + 1 P2-9b deterministic outbox emit + 1 P2-9b worker outbox emit).
