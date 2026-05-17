# HANDOFF — Phase 2 Cycle 9 sub-cycle a (P2-9a Sub Marketplace)

**Status:** schema + seed + first 3 services + 13 endpoints landed; CI green (build + format + lint:logs). Vitest + UI + assignment lifecycle + ratings + cancellation policy worker + cover-arrangement consumer + acceptance-window worker carry to **P2-9b**.

## Plan reference

`docs/campusos-p2c9-sub-marketplace.html` — 10 steps. P2-9a covers steps 1–6 (schema + seed + minimal request-path); P2-9b will cover steps 7–10 + UI + workers.

## What landed

### Schema (Steps 1–3)

| Migration                                 | Schema   | Tables added                                                                                                                                                                                                                                                                        | Smoke                                                                                            |
| ----------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `20260510120000_add_p2c9_sub_marketplace` | platform | extends `platform_substitute_profiles` (display_name, bio, grade_levels TEXT[] GIN, subject_areas, years_experience, is_available, profile_photo_s3_key, overall_rating, total_assignments) + `platform_sub_credentials` + `platform_sub_availability` + `platform_sub_preferences` | 10 constraint tests live-verified                                                                |
| `132_sub_jobs.sql`                        | tenant   | `sub_school_pool` + `sub_job_postings` + `sub_job_classes` + `sub_job_notifications`                                                                                                                                                                                                | 17 constraint tests live-verified                                                                |
| `133_sub_assignments.sql`                 | tenant   | `sub_assignments` + `sub_ratings` + `sub_session_notes` + `sub_pay_rates` (EXCLUDE gist) + `sub_cancellation_policies`                                                                                                                                                              | 24 constraint tests live-verified including the EXCLUDE-gist keystone on overlapping date ranges |

**Total: 13 tables (4 platform + 9 tenant). Tenant logical base table count: ~520 → ~529.**

Splitter audit clean on every tenant migration on first attempt (after the `;`-in-COMMENT-string trap was caught + fixed pre-provision on 133). Both `tenant_demo` and `tenant_test` provisioned cleanly + idempotent re-provision verified.

### Seed (Step 4)

`packages/database/src/seed-substitutes.ts` — idempotent, gated on whether the 3 demo substitute profiles already exist. Wired as `seed:substitutes` in `package.json`.

Seed shape on `tenant_demo`:

| Table                        | Rows                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------- |
| platform_substitute_profiles | 3 (Sarah J. / Mike P. / Lisa A.)                                                  |
| platform_sub_credentials     | 6 (mix VERIFIED + PENDING; Sarah First Aid expires in 45d for the alert keystone) |
| platform_sub_availability    | 8 (Sarah Mon-Thu RECURRING + BLOCKED + Mike Tue+Thu + Lisa SPECIFIC)              |
| platform_sub_preferences     | 2 (Sarah PREFERRED Lincoln + Lisa BLOCKED Elmwood)                                |
| sub_school_pool              | 3 (Sarah ACTIVE + Mike ACTIVE + Lisa SUSPENDED 7d for late cancellation)          |
| sub_job_postings             | 2 (1 FILLED historical + 1 OPEN upcoming)                                         |
| sub_job_classes              | 3 (snapshot of Rivera's 3 timetable slots on the FILLED job)                      |
| sub_job_notifications        | 3 (Sarah ACCEPTED + Mike DECLINED + Lisa EXPIRED on Job 1)                        |
| sub_assignments              | 1 (Sarah CHECKED_OUT, full lifecycle)                                             |
| sub_ratings                  | 2 (bidirectional — SCHOOL_RATES_SUB 5/5 + SUB_RATES_SCHOOL 4)                     |
| sub_session_notes            | 1 (visible to teacher)                                                            |
| sub_pay_rates                | 2 (Lincoln default $180/day + Sarah override $200/day)                            |
| sub_cancellation_policies    | 1 (Lincoln 2h window / 3-strike WARNING_ONLY)                                     |

### IAM grants

- New permission code `SUB-001 (Substitute Self-Service)` added to `permissions.json` (Sub Marketplace group). Catalogue: 348 → 349 codes.
- `seed-iam.ts` updated:
  - **Teacher**: `SCH-004:read` (existing) + new `SUB-001:read` so a returning teacher can view session notes the substitute wrote during the absence.
  - **Staff**: upgraded `SCH-004` from `read` → `read+write` (operator persona posts jobs + manages pool) + new `SUB-001:read+write` (substitute self-service stand-in until a dedicated Substitute role lands).
  - School Admin / Platform Admin pick up admin tier on both via everyFunction.

Cache rebuild verified: admin/principal/vp/counsellor/teacher have SUB-001; parent + student do NOT. Teacher 95 → 97 perms; Staff 222 → 230 perms.

### Backend module (Steps 5–6)

`apps/api/src/substitutes/`:

- `dto/substitutes.dto.ts` — 14 enums + DTOs (PoolStatus, JobStatus, NotificationResponse, AssignmentStatus, etc).
- `substitute-profile.service.ts` — profile CRUD + **matching engine** (the keystone — GIN-overlap on grade_levels, BLOCKED-overrides-RECURRING availability resolver, VERIFIED-credentials filter, BLOCKED-school exclusion via NOT EXISTS subquery).
- `school-pool.service.ts` — list + add + suspend/remove pool members; admin-only writes.
- `job-posting.service.ts` — list + get + post (the keystone — locks, validates, fans out to ACTIVE pool members inline, emits `sub.job.posted` via outbox) + accept (locks job + notification, validates window, creates assignment, flips job to FILLED, emits `sub.assignment.confirmed`) + decline.
- `substitutes.controller.ts` — 13 endpoints under `/api/v1/substitutes/*`.
- `substitutes.module.ts` — wired into AppModule between AppraisalsModule and the global guards.

**13 endpoints registered + verified at boot** (all under `/api/v1/substitutes/*`):

| Verb  | Route               | Permission                                           |
| ----- | ------------------- | ---------------------------------------------------- |
| GET   | `/profile/me`       | `sub-001:read`                                       |
| GET   | `/profile/:id`      | `sch-004:read` (or self via service-layer match)     |
| GET   | `/profiles`         | `sch-004:read` (admin only at service layer)         |
| POST  | `/profile`          | `sub-001:write`                                      |
| GET   | `/search`           | `sch-004:read` (matching engine)                     |
| GET   | `/pool`             | `sch-004:read`                                       |
| POST  | `/pool`             | `sch-004:write`                                      |
| PATCH | `/pool/:id`         | `sch-004:write`                                      |
| GET   | `/jobs`             | `sch-004:read` (admin all; substitute notified-only) |
| GET   | `/jobs/:id`         | `sch-004:read`                                       |
| POST  | `/jobs`             | `sch-004:write` (the keystone)                       |
| POST  | `/jobs/:id/accept`  | `sub-001:write`                                      |
| POST  | `/jobs/:id/decline` | `sub-001:write`                                      |

### Kafka emits (durable via outbox)

- `sub.job.posted` — fired inline in `JobPostingService.post()` via `OutboxService.enqueueInTx`. Payload: `{jobId, schoolId, absentTeacherId, jobDate, startTime, endTime, jobType, gradeLevel, subject, notificationTier, poolSize, acceptanceWindowExpiresAt}`.
- `sub.assignment.confirmed` — fired in `JobPostingService.accept()` via `OutboxService.enqueueInTx`. Payload: `{assignmentId, jobId, schoolId, substituteId, substituteName, confirmedAt}`.

Both follow the ADR-057 envelope shape (`source_module: 'substitutes'`).

## Keystones verified

- **EXCLUDE gist on `sub_pay_rates`** — overlapping date ranges for the same `(school_id, substitute_id, job_type)` tuple rejected with SQLSTATE 23P01. Tested with the seeded school-default + Sarah-override coexisting cleanly because they differ on `substitute_id`. Smoke T15 + T16 verified live.
- **BLOCKED overrides RECURRING availability** — the search/availability resolver structure runs RECURRING/SPECIFIC EXISTS in an outer query, then `AND NOT EXISTS BLOCKED specific_date = $date`. Tested at the schema layer via shape_chk constraint smoke.
- **Matching engine GIN overlap** — `p.grade_levels && $1::text[]` on the search endpoint backed by the `platform_substitute_profiles_grade_levels_gin_idx`. The seed exercises ELEMENTARY/MIDDLE (Sarah), HIGH (Mike), all-three (Lisa).
- **Acceptance window** — `JobPostingService.post()` computes `escalateToMarketplaceAt = now() + acceptance_window_minutes`. `JobPostingService.accept()` validates `now() <= acceptance_window_expires_at` inside the locked tx + soft-flips the notification to EXPIRED on miss.
- **Multi-column lockstep CHECKs** — assignment cancelled_chk + check_in_chk + check_out_chk all fire on smoke; cancellation policy suspension_chk + penalty_chk reject mismatched detail-field combinations.

## What's deferred to P2-9b

This is the next session's scope. None of these block the schema review.

| Item                                                                                                                                         | Plan step |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| AvailabilityService + PreferenceService request-path endpoints (POST/DELETE) — read paths are exposed implicitly through the matching engine | Step 5    |
| AcceptanceExpiryWorker (PENDING → EXPIRED on window timeout sweep)                                                                           | Step 6    |
| JobNotificationWorker (tier-2 MARKETPLACE escalation when `escalate_to_marketplace_at` passes)                                               | Step 6    |
| AssignmentService (check-in / check-out / cancel)                                                                                            | Step 7    |
| CancellationPolicyWorker (`sub.assignment.late_cancelled` → consequence application — TEMPORARY_POOL_SUSPENSION etc.)                        | Step 7    |
| RatingService (bidirectional + overall_rating re-materialisation onto `platform_substitute_profiles`)                                        | Step 7    |
| SessionNoteService (returning teacher notification via Cycle 7 TaskWorker)                                                                   | Step 7    |
| PayRateService (compute pay for an assignment + EXCLUDE-gist date-range mutation surface)                                                    | Step 7    |
| CancellationPolicyService request-path (admin GET + PATCH the per-school policy)                                                             | Step 7    |
| 6 web routes (substitute profile, dashboard, school pool manager, job posting form, coverage dashboard, ratings + pay)                       | Step 8    |
| vitest unit + integration tests                                                                                                              | Step 9    |
| Cover arrangement consumer (Cycle 5 sch_cover_arrangements link on `sub.assignment.confirmed`)                                               | Step 10   |

## CI gates

| Check                                 | Status                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm --filter @campusos/api build`   | ✓ clean                                                                       |
| `pnpm format:check`                   | ✓ clean                                                                       |
| `pnpm lint:logs`                      | ✓ 685 files clean                                                             |
| API boot — Substitute routes register | ✓ 13 routes on `/api/v1/substitutes/*`                                        |
| Tenant provision idempotent           | ✓ both demo + test                                                            |
| Constraint smoke (schema)             | ✓ 51 assertions across 3 migrations                                           |
| Seed idempotent re-run                | ✓                                                                             |
| IAM cache rebuild                     | ✓ admin/principal/vp/counsellor/teacher have SUB-001; parent + student do NOT |

## Cross-module dependencies

- **Cycle 4 hr_employees** — `sub_job_postings.absent_teacher_id` + `posted_by` are real DB-enforced FKs. The Cycle 4 Step 0 staff identity convention applies.
- **Cycle 5 sch_timetable_slots** — `sub_job_classes.timetable_slot_id` is a real DB-enforced FK. The Step 6 service snapshots `class_name`, `room_name`, `period_label` at post time so the historical record survives schedule changes.
- **Cycle 5 sch_cover_arrangements** — the `sub.assignment.confirmed` outbox emit is the upstream signal for the P2-9b cover-arrangement consumer.
- **Cycle 7 wsk_approval_requests / TaskWorker** — `sub.session_note` written → P2-9b emits a task to the absent teacher's task list. Not wired this cycle.
- **ADR-029 platform/tenant split** — substitute profile + credentials + availability + preferences in platform; school pool + jobs + assignments + ratings + notes + pay + policies in tenant. Soft UUID refs across the boundary per ADR-001/020.

## Known limitations

1. **No dedicated Substitute role** — substitute self-service runs through Staff persona for P2-9a. The `personId === actor.personId` match in `SubstituteProfileService.create + getMyProfile` is the actual access boundary. A dedicated role split joins the Wave 2 Phase 2 punch list (items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / 33).
2. **No per-school Substitute auth account** — the seeded substitutes (Sarah / Mike / Lisa) have `iam_person` rows but no `platform_users` (login). Admin-on-behalf paths still work in the seed via the controller's `req.user` bearer; substitute self-service end-to-end requires P2-9b's auth onboarding.
3. **Notification fan-out is inline, not via worker** — `JobPostingService.post()` enumerates ACTIVE pool members and inserts notifications synchronously within the same tx. P2-9b extracts this into the JobNotificationWorker with tier-1/tier-2 escalation logic.
4. **Acceptance window expiry is reactive, not proactive** — only checked on accept. The AcceptanceExpiryWorker (P2-9b) sweeps the partial index `sub_job_notifications_pending_expiry_idx` and flips PENDING → EXPIRED on timeout.
5. **No accept race protection beyond the tx lock** — two substitutes hitting `/jobs/:id/accept` concurrently both pass through the FOR UPDATE on the job row; the second one fails the `status = 'OPEN'` check and gets a 409. Verified live in the seeded JOIN tests but a dedicated regression test belongs in P2-9b.
6. **Cover-arrangement consumer not wired** — the `sub.assignment.confirmed` event lands cleanly on the wire but `sch_cover_arrangements` is not yet auto-created. P2-9b ships the consumer.
7. **No P2-9 vitest** — schema correctness is verified by the 51 live SQL assertions across the 3 migration smoke runs. Service-layer unit tests + integration tests are P2-9b deliverables.

## Files in this commit

```
packages/database/data/permissions.json                              # +SUB-001
packages/database/prisma/platform/migrations/20260510120000_add_p2c9_sub_marketplace/migration.sql
packages/database/prisma/platform/schema.prisma                      # +PlatformSubCredential/Availability/Preference models + extended SubstituteProfile
packages/database/prisma/tenant/migrations/132_sub_jobs.sql
packages/database/prisma/tenant/migrations/133_sub_assignments.sql
packages/database/src/seed-substitutes.ts                            # new — 13 tables
packages/database/src/seed-iam.ts                                    # +SCH-004:write to Staff, +SUB-001 to Teacher/Staff
packages/database/package.json                                       # +seed:substitutes
apps/api/src/app.module.ts                                           # +SubstitutesModule
apps/api/src/substitutes/dto/substitutes.dto.ts
apps/api/src/substitutes/substitute-profile.service.ts
apps/api/src/substitutes/school-pool.service.ts
apps/api/src/substitutes/job-posting.service.ts
apps/api/src/substitutes/substitutes.controller.ts
apps/api/src/substitutes/substitutes.module.ts
HANDOFF-P2C9a.md                                                     # this file
P2C9-REVIEW-NOTES.md                                                 # schema decisions, deferred work
```

## Next session (P2-9b)

Steps 7–10 + UI + tests + handoff/review docs for full P2-9. The schema is in place so the remaining services map directly onto stable foundations. Estimated 1.5–2 days of work.
