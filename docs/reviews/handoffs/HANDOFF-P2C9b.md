# HANDOFF — Phase 2 Cycle 9 sub-cycle b (P2-9b Sub Marketplace backend completion)

**Status:** request-path + workers + consumers complete; CI green (build + format + lint:logs); 21 new endpoints + 2 background workers + 2 Kafka consumers registered at boot. UI + vitest tests defer to **P2-9c**.

## Plan reference

`docs/campusos-p2c9-sub-marketplace.html` — 10 steps. P2-9a (commit `46751c2`) covered steps 1–6 (schema + seed + first 3 services). P2-9b (this commit) ships steps 7 + 10 + the deferred worker pieces from steps 5–6 — completing the backend surface. UI (step 8) + vitest (step 9) move to P2-9c.

## What landed

### Services (5 new)

| Service                         | Endpoints | Key behaviour                                                                                                                                                                                                                                                              |
| ------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SubstituteAvailabilityService` | 3         | listMine + create (RECURRING / SPECIFIC / BLOCKED with shape validation) + remove (own only via personId match)                                                                                                                                                            |
| `SubstitutePreferenceService`   | 3         | listMine + create (PREFERRED / BLOCKED with private reason) + remove                                                                                                                                                                                                       |
| `AssignmentService`             | 5         | list (admin all / sub own) + getById + check-in + check-out (bumps `total_assignments` on platform) + **cancel keystone** (computes `is_late_cancellation` against school policy + emits `sub.assignment.late_cancelled` via outbox with deterministic v5-shaped event_id) |
| `RatingService`                 | 2         | listForAssignment + create (bidirectional with UNIQUE catch + **`rematerialiseOverallRating`** on SCHOOL_RATES_SUB)                                                                                                                                                        |
| `SessionNoteService`            | 2         | getForAssignment (admin + writing sub + returning teacher with `is_visible_to_teacher` gate) + create (one per assignment)                                                                                                                                                 |
| `PayRateService`                | 4         | list + create (EXCLUDE-gist 23P01 → 409 translation) + close (stamp effectiveTo) + **computePay** (per-substitute first, school default fallback)                                                                                                                          |
| `CancellationPolicyService`     | 2         | get + upsert (PATCH semantics merge with current row + multi-column suspension_chk / penalty_chk lockstep validated app-side)                                                                                                                                              |

### Workers (2 new)

| Worker                   | Cadence  | Behaviour                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AcceptanceExpiryWorker` | 60s poll | Walks every active school, flips `sub_job_notifications` rows WHERE `response='PENDING' AND acceptance_window_expires_at <= now()` to EXPIRED via the `sub_job_notifications_pending_expiry_idx` partial index hot path                                                                                                                                                                 |
| `JobNotificationWorker`  | 60s poll | Walks every active school, finds jobs ready for tier-2 escalation (`escalate_to_marketplace_at <= now() AND status='OPEN' AND notification_tier='POOL' AND no ACCEPTED notifications`), runs the matching engine candidate query (grade overlap + verified credentials + availability resolver + non-BLOCKED), inserts MARKETPLACE notifications, flips tier, emits `sub.job.escalated` |

### Consumers (2 new)

| Consumer                     | Subscribes                      | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CancellationPolicyConsumer` | `sub.assignment.late_cancelled` | Reads school policy, counts substitute's late-cancellations in last 6 months at this school, applies configured consequence: WARNING_ONLY (log) / TEMPORARY_POOL_SUSPENSION (flips pool row to SUSPENDED with suspended_until + reason) / PERMANENT_POOL_REMOVAL (flips to REMOVED) / RATING_PENALTY (inserts synthetic SCHOOL_RATES_SUB row + re-materialises overall_rating). Stamps `late_cancellation_consequence_applied=true`. |
| `CoverArrangementConsumer`   | `sub.assignment.confirmed`      | Bridges P2-9 marketplace into Cycle 5 `sch_coverage_requests`. For every snapshot in `sub_job_classes`, finds matching `sch_coverage_requests` rows (same timetable_slot + same date) and flips OPEN → CANCELLED with notes pointing at the marketplace assignment. (See "Known limitations" below for why CANCELLED rather than ASSIGNED.)                                                                                          |

### Endpoint summary

**21 new endpoints** under `/api/v1/substitutes/*` registered at boot via `SubstitutesPostController`:

| Verb   | Route                           | Permission                                    |
| ------ | ------------------------------- | --------------------------------------------- |
| GET    | `/availability/me`              | `sub-001:read`                                |
| POST   | `/availability`                 | `sub-001:write`                               |
| DELETE | `/availability/:id`             | `sub-001:write`                               |
| GET    | `/preferences/me`               | `sub-001:read`                                |
| POST   | `/preferences`                  | `sub-001:write`                               |
| DELETE | `/preferences/:id`              | `sub-001:write`                               |
| GET    | `/assignments`                  | `sch-004:read`                                |
| GET    | `/assignments/:id`              | `sch-004:read`                                |
| POST   | `/assignments/:id/check-in`     | `sub-001:write`                               |
| POST   | `/assignments/:id/check-out`    | `sub-001:write`                               |
| POST   | `/assignments/:id/cancel`       | `sub-001:write`                               |
| GET    | `/assignments/:id/ratings`      | `sch-004:read`                                |
| POST   | `/assignments/:id/ratings`      | `sch-004:read` (service-layer authority gate) |
| GET    | `/assignments/:id/session-note` | `sub-001:read`                                |
| POST   | `/assignments/:id/session-note` | `sub-001:write`                               |
| GET    | `/pay-rates`                    | `sch-004:read`                                |
| POST   | `/pay-rates`                    | `sch-004:write`                               |
| PATCH  | `/pay-rates/:id/close`          | `sch-004:write`                               |
| GET    | `/assignments/:id/pay`          | `sch-004:read`                                |
| GET    | `/cancellation-policy`          | `sch-004:read`                                |
| PATCH  | `/cancellation-policy`          | `sch-004:write`                               |

**Cycle 9 endpoint total: 34** (13 from P2-9a + 21 from P2-9b).

### Kafka topics

| Topic                           | Producer                             | Outbox?                         | Consumer                               |
| ------------------------------- | ------------------------------------ | ------------------------------- | -------------------------------------- |
| `sub.job.posted`                | P2-9a `JobPostingService.post`       | yes                             | (P2-9c notification fan-out)           |
| `sub.assignment.confirmed`      | P2-9a `JobPostingService.accept`     | yes                             | **P2-9b `CoverArrangementConsumer`**   |
| `sub.assignment.late_cancelled` | **P2-9b `AssignmentService.cancel`** | yes (deterministic v5 event_id) | **P2-9b `CancellationPolicyConsumer`** |
| `sub.job.escalated`             | **P2-9b `JobNotificationWorker`**    | yes                             | (P2-9c notification fan-out)           |

**Cycle 9 emit topics: 4 total** (2 from P2-9a + 2 from P2-9b — `sub.assignment.late_cancelled` durable via outbox with deterministic event_id; `sub.job.escalated` durable via outbox).

## Keystones verified

- **Late-cancellation policy escalation chain** — `AssignmentService.cancel()` computes `is_late_cancellation` from `now() vs job_start_at - late_window_hours` per school policy. On the late-SUBSTITUTE-cancel path emits `sub.assignment.late_cancelled` via outbox with deterministic event_id `sha1(assignmentId + ':sub.assignment.late_cancelled:v1')` v5-shaped. `CancellationPolicyConsumer` reads policy + counts late cancellations in last 6 months and applies consequence per `repeat_offence_threshold`. Pool suspension/removal stamps `sub_school_pool` directly; RATING_PENALTY inserts synthetic SCHOOL_RATES_SUB row + re-materialises `overall_rating`.
- **EXCLUDE-gist translation** — `PayRateService.create` catches SQLSTATE 23P01 from `sub_pay_rates_no_overlap` and returns `409 Conflict` with the friendly "close out the prior rate first" message.
- **PayRate resolution order** — `computePay()` queries per-substitute first (matching school + sub + jobType + date in range); on miss falls back to school default (sentinel `00000000-...` substitute_id); on miss returns 404 with policy-required guidance. Verified against the seeded rows where Sarah's $200 override and the school's $180 default coexist.
- **BLOCKED-overrides-RECURRING availability** — exposed both via `SubstituteProfileService.search` (P2-9a) and the new `JobNotificationWorker` candidate query (P2-9b), running the same `EXISTS RECURRING/SPECIFIC AND NOT EXISTS BLOCKED` shape against `platform_sub_availability`.
- **UNIQUE(assignment, rater_type) bidirectional ratings** — `RatingService.create` catches the constraint violation and translates to a 409 with PATCH-redirect guidance; SCHOOL_RATES_SUB inserts trigger `rematerialiseOverallRating` AFTER the tx commits; SUB_RATES_SCHOOL inserts skip re-materialisation by design (school-side reputation is a Phase 2 backlog item per P2C9-REVIEW-NOTES.md).
- **Cover-arrangement bridging** — `CoverArrangementConsumer` flips matching `sch_coverage_requests` OPEN → CANCELLED. The CANCELLED-not-ASSIGNED choice is intentional: `sch_coverage_requests.assigned_substitute_id` is a real DB-enforced FK to `hr_employees(id)` and platform substitutes have no hr_employees row in this tenant per the ADR-029 platform-portable model. Phase 2 punch list item: shadow `hr_employees` row creation on first marketplace acceptance to enable the proper ASSIGNED state.

## CI gates

| Check                               | Status                                                                                                                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @campusos/api build` | ✓ clean                                                                                                                                                                                        |
| `pnpm format:check`                 | ✓ clean                                                                                                                                                                                        |
| `pnpm lint:logs`                    | ✓ 697 files clean                                                                                                                                                                              |
| API boot — P2-9b routes register    | ✓ `/api/v1/substitutes/*` adds 21 endpoints (verified live)                                                                                                                                    |
| API boot — workers schedule         | ✓ `AcceptanceExpiryWorker` + `JobNotificationWorker` register on `onModuleInit`                                                                                                                |
| API boot — consumers subscribe      | ✓ `cancellation-policy-consumer` + `cover-arrangement-consumer` register; "Kafka unavailable" warning is the documented dev-broker quirk where topics aren't pre-created — degrades gracefully |

## What defers to P2-9c

- 6 web routes (substitute profile, dashboard, school pool manager, job posting form, coverage dashboard, ratings + pay).
- vitest unit + integration tests for the matching engine + EXCLUDE-gist + acceptance-window expiry + cancellation-policy escalation + cover-arrangement bridging.
- Shadow `hr_employees` row creation for marketplace substitutes (so `CoverArrangementConsumer` can flip OPEN → ASSIGNED rather than OPEN → CANCELLED).
- TaskWorker integration on `sub.session_note` events for the returning-teacher inbox notification.
- Notification fan-out consumers on `sub.job.posted` + `sub.job.escalated` + `sub.assignment.confirmed` (substitute-side IN_APP / EMAIL via the Cycle 14 NotificationConsumer pipeline).
- Cross-tenant `overall_rating` aggregation (currently scoped to the calling tenant only — see P2C9-REVIEW-NOTES.md section 6).
- Dedicated Substitute role split (joins items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / 33 in the broader role-split work).

## Cross-module dependencies (introduced or extended)

- **Cycle 5 `sch_coverage_requests`** — `CoverArrangementConsumer` writes (CANCELLED status flip) on `sub.assignment.confirmed`. New tenant-side dependency.
- **Cycle 4 `hr_employees`** — `AssignmentService.cancel` reads parent job's `absent_teacher_id`; pool suspension UPDATE writes `sub_school_pool.suspension_reason` referencing leave/late-cancel context.
- **`platform.platform_substitute_profiles.overall_rating + total_assignments`** — `RatingService.rematerialiseOverallRating` + `AssignmentService.checkOut.bumpedSubId` both update these materialised counters across the schema boundary. Best-effort outside the tenant tx with logged failures (counter can be re-materialised by manual SQL or a future maintenance job).
- **Cycle 4 outbox + Kafka** — 2 new emits via `OutboxService.enqueueInTx` (`sub.assignment.late_cancelled`, `sub.job.escalated`).

## Files in this commit

```
apps/api/src/substitutes/availability.service.ts                # new
apps/api/src/substitutes/preference.service.ts                  # new
apps/api/src/substitutes/assignment.service.ts                  # new (with deterministic event_id helper)
apps/api/src/substitutes/rating.service.ts                      # new
apps/api/src/substitutes/session-note.service.ts                # new
apps/api/src/substitutes/pay-rate.service.ts                    # new
apps/api/src/substitutes/cancellation-policy.service.ts         # new
apps/api/src/substitutes/substitutes-b.controller.ts            # new — 21 endpoints
apps/api/src/substitutes/acceptance-expiry.worker.ts            # new — cron worker
apps/api/src/substitutes/job-notification.worker.ts             # new — tier-2 escalation worker
apps/api/src/substitutes/cancellation-policy.consumer.ts        # new — Kafka consumer
apps/api/src/substitutes/cover-arrangement.consumer.ts          # new — Kafka consumer
apps/api/src/substitutes/dto/substitutes.dto.ts                 # extended — 13 new DTO classes
apps/api/src/substitutes/substitutes.module.ts                  # rewired
HANDOFF-P2C9b.md                                                # this file
P2C9-REVIEW-NOTES.md                                            # extended with P2-9b sections
```

## Next session (P2-9c)

UI + tests + the 5 deferred pieces above. Estimated 1.5 days of work. The schema + backend are solid foundations.
