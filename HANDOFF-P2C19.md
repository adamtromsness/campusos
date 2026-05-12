# HANDOFF — Phase 2 Cycle 19 (P2-19): Communications Advanced

**Status:** P2-19a + P2-19b complete with REVIEW-P2C19 Round 1 fixes applied. Awaiting Round 2 verdict.
**Plan:** `docs/campusos-p2c19-communications-advanced.html`
**Review scaffold:** `P2C19-REVIEW-NOTES.md`
**Dates:** 2026-05-12

## REVIEW-P2C19 Round 1 fix log

Round 1 against `6e08571` + `c2d9f68` returned **FAIL** with 6 BLOCKING + 2 actionable MAJOR. All 8 fixes landed in this commit + new migration `155_msg_event_contributions.sql` + 19 pinned regression tests in `apps/api/src/communications-advanced/communications-advanced-review-p2c19.spec.ts`.

**BLOCKING fixes:**

1. **Translation message visibility** — `TranslationService.translate()` and `listForMessage()` now take an actor and run a sender / thread-participant / school-admin EXISTS probe against `msg_messages` + `msg_thread_participants` before reading the body or returning cached translations. The auto-translate worker path passes `null` actor and bypasses the check. The controller threads `actor` through. Cross-thread translation reads collapse to 404 don't-leak-existence.

2. **Moderation rule + action + appeal current-school scope** — `ModerationService.listRules` / `getRule` / `loadRule` / `patchRule` now filter `scope='PLATFORM' OR school_id = tenant.schoolId`. `listQueue` / `getAction` / `patchAction` / `loadActionInTx` add an EXISTS clause through `msg_moderation_rules` so cross-school action UUIDs return 404. `AppealService.list` / `getById` / `patch` chain the EXISTS through `msg_moderation_actions → msg_moderation_rules` so cross-school appeals return 404 too.

3. **CUSTOM segment current-school affiliation** — `BroadcastSegmentService.resolveAccountIds` CUSTOM branch now JOINs through `platform.iam_person` + (`sis_students` via `platform_students.person_id` OR `sis_guardians.person_id` OR `hr_employees.person_id`) with `school_id = $tenant`. Bogus / cross-school platform_users ids fall out silently.

4. **Push campaign worker school-scope** — `PushCampaignService.findRipe()` adds `school_id = $tenant`. `dispatchScheduled()` adds the school predicate to both the FOR UPDATE lock and the UPDATE. `resolveAudienceSize()` no longer counts every active device token in the tenant — it joins through `platform_users → iam_person` and the three current-school projections (student, guardian, employee) so total_targeted reflects the real audience.

5. **Push analytics contribution ledger** — new tenant table `msg_push_analytics_contributions(consumer_group, source_event_id, campaign_id)` UNIQUE. `PushCampaignService.recordDelivery()` now takes `(consumerGroup, sourceEventId)` and INSERTs the contribution row in the same tx as the additive bump. A 23505 on the ledger short-circuits the additive update so a redelivered event after a crash before the idempotency claim returns the current analytics row instead of double-counting. `PushAnalyticsConsumer` passes `CONSUMER_GROUP + event.eventId`.

6. **Moderation action contribution ledger** — new tenant table `msg_moderation_contributions(consumer_group, source_event_id, message_id, action_id, action_created_at)` UNIQUE. `ModerationService.recordAction()` takes `(consumerGroup, sourceEventId)` and INSERTs the claim row before the action INSERT. A 23505 on the ledger re-reads the existing action row from the ledger's `(action_id, action_created_at)` columns and returns it — a redelivered moderation event after a crash inserts at most one `msg_moderation_actions` row. `ModerationConsumer` passes `CONSUMER_GROUP + event.eventId`.

**MAJOR fixes:**

7. **Push campaign audienceSegmentId same-school validation** — `PushCampaignService.create()` and `patch()` validate the supplied `audienceSegmentId` against `msg_broadcast_segments.school_id = tenant.schoolId` before storing. A cross-school segment id returns 400 with the offending UUID inlined.

8. **Template + segment reload SQL school predicates** — `TemplateService.create()` / `patch()` reload SELECT + UPDATE statements now carry `school_id = $tenant` predicate alongside the existing FOR UPDATE lock. `BroadcastSegmentService.create()` / `patch()` + the `resolve()` cache UPDATE same treatment. Mirrors the broader Phase 2 convention that every tenant write carries `school_id`.

**Carry-overs (acknowledged, not fixed in this round):**

- MAJOR 1 — broadcast analytics is not school-defensive around `broadcastId`. No production producer for `msg.broadcast.delivered` exists yet so the path is exercise-cold; before the future broadcast wiring lands the analytics reads/writes must add a school_id column or validate the broadcast row through its owning communications/broadcast table. Tracked on the Phase 2 punch list.

**Migration:** `155_msg_event_contributions.sql` adds the two contribution-ledger tables (`msg_moderation_contributions`, `msg_push_analytics_contributions`). Splitter-safe additive. Both `tenant_demo` and `tenant_test` provisioned cleanly.

**Test coverage:** vitest 905 → **924** (+19 new pinned regression tests across 7 describe blocks pinning each BLOCKING fix + MAJOR 2: translation visibility refusal + sender-allowed + listForMessage refusal + visibility probe SQL shape; moderation rule listRules SQL shape + getRule 404 + listQueue EXISTS clause + appeal list join shape + getById 404; CUSTOM segment SQL shape; push worker findRipe school predicate + dispatchScheduled school predicate + resolveAudienceSize join shape; push analytics ledger INSERT + 23505 skip-additive; moderation action ledger INSERT + 23505 re-read; push campaign create with cross-school segmentId 400 + same-school accepted).

**CI parity green at the fix commit:** format:check + lint:logs (850 files clean) + API build clean + web build clean + vitest **924/924** across 44 spec files.

See `P2C19-REVIEW-NOTES.md` "REVIEW-P2C19 Round 1 verification trail" for the per-fix evidence table.

## Scope

P2-19 closes the M40 Communications module — the 13 ERD tables deferred
from Cycle 14. Pre-split into two sub-cycles per the plan; ships as
two commits but reviewed as a single cycle.

| Sub-cycle | Tables | Endpoints | Workers / consumers                                | Commit                                                    |
| --------- | ------ | --------- | -------------------------------------------------- | --------------------------------------------------------- |
| P2-19a    | 6      | ~18       | 2 consumers                                        | `6e08571` (Translation + Templates + Broadcast Analytics) |
| P2-19b    | 7      | ~16       | 3 (1 consumer + 1 worker + 1 polling worker reuse) | this commit                                               |
| **Total** | **13** | **~34**   | **5**                                              |                                                           |

Six structural keystones across the full cycle (verified live):

1. **Translation cache** (P2-19a) — `UNIQUE(message_id, target_language)`
   on `msg_translations`. The cache key. Same message + same target
   language returns the cached row, never re-translates.
2. **Template render-time variable validation** (P2-19a) — required
   variables without a value AND without a `default_value` throw 400
   with the offending names. Schools cannot accidentally send
   `Hello {student_name}` to families when the placeholder wasn't filled.
3. **Three-tier moderation, most-restrictive wins** (P2-19b) —
   `ModerationService.resolveDecision` reads every active rule matching
   PLATFORM tier OR the calling tenant school, then picks the
   keyword_action with the highest rank: **BLOCK > ESCALATE > FLAG**.
   AUTO_APPROVED only fires when zero rules match.
4. **Appeal OVERTURNED releases parent action atomically** (P2-19b) —
   `AppealService.patch` opens one tenant tx, flips the appeal to
   OVERTURNED, then calls `ModerationService.releaseActionInTx` so the
   parent moderation action flips to `review_status=RELEASED` inside
   the same tx. Schema-side `reviewed_chk` lockstep is always satisfied.
5. **AI moderation cache** (P2-19b) — `UNIQUE(message_id, message_created_at)`
   on `msg_ai_moderation_results`. Computed once per message. A
   redelivered moderation event reads the cached row instead of
   re-calling the AI Inference service. Mirrors the P2-19a translation
   cache.
6. **Push campaign send-time lockstep** (P2-19b) — schema-side
   `msg_push_campaigns_sent_chk` pins `(status, sent_at)` atomic. The
   `PushCampaignWorker.dispatchScheduled` transition stamps both
   together inside one tenant tx and seeds `msg_push_analytics` with
   `total_targeted`.

## Schema — 13 tenant tables across 2 migrations

### Migration `153_msg_translation_templates.sql` (P2-19a — 6 tables)

| Table                           | Purpose                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `msg_user_language_preferences` | Per-user preferred_language + auto-translate toggles. `UNIQUE(user_id)`.                                                                           |
| `msg_translations`              | Cached translation per (message, target_language). `UNIQUE(message_id, target_language)` is the cache key.                                         |
| `msg_templates`                 | Reusable templates with variable slots. 6-value `category` CHECK + JSONB variable definitions + `allowed_roles` TEXT[]. `UNIQUE(school_id, name)`. |
| `msg_broadcast_segments`        | Audience definitions. 6-value `segment_type` CHECK + JSONB filter criteria. `UNIQUE(school_id, name)`.                                             |
| `msg_broadcast_analytics`       | Per-(broadcast, segment) delivery funnel. `UNIQUE(broadcast_id, segment_id)` + partial UNIQUE for `segment_id IS NULL` aggregate row.              |
| `msg_template_usage_log`        | Per-template usage audit. CASCADE on parent template. Sole DB-enforced FK in the migration.                                                        |

### Migration `154_msg_moderation_push.sql` (P2-19b — 7 tables)

| Table                       | Purpose                                                                                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `msg_moderation_rules`      | Three-tier policy catalogue. 3-value `scope` CHECK (PLATFORM, DISTRICT, BUILDING) + multi-column `scope_pair_chk` enforcing PLATFORM ⇔ school_id NULL. 3-value `keyword_action` CHECK (BLOCK, FLAG_FOR_REVIEW, ESCALATE_TO_COUNSELLOR). GIN INDEX on keywords. |
| `msg_moderation_actions`    | Per-(message, rule) decision log. **RANGE-partitioned by created_at MONTHLY** (2025-08 → 2027-08, 25 leaves). Composite PK `(id, created_at)`. 4-value `action_taken` CHECK + 4-value `review_status` CHECK + multi-column `reviewed_chk` lockstep.            |
| `msg_moderation_appeals`    | Per-action user appeal. `UNIQUE(action_id, action_created_at)` — composite because parent is partitioned. 3-value `status` CHECK (SUBMITTED, UPHELD, OVERTURNED) + multi-column `reviewed_chk` lockstep.                                                       |
| `msg_ai_moderation_results` | Cached AI sensitivity score. `UNIQUE(message_id, message_created_at)`. JSONB categories detected.                                                                                                                                                              |
| `msg_push_campaigns`        | Push notification campaigns. 4-value `status` CHECK (DRAFT, SCHEDULED, SENT, CANCELLED) + multi-column `sent_chk` + multi-column `scheduled_chk`.                                                                                                              |
| `msg_push_analytics`        | Per-campaign engagement funnel. `UNIQUE(campaign_id)`. Recomputed rates on every UPSERT.                                                                                                                                                                       |
| `msg_push_device_tokens`    | Per-(user, device) registry. `UNIQUE(user_id, device_token)`. 3-value `platform` CHECK (IOS, ANDROID, WEB).                                                                                                                                                    |

**Tenant logical base table count after Cycle 19:** previous ~838 (post P2-18 closeout) + 13 → **~851 logical tables** (does not count the 25 monthly `msg_moderation_actions` partition leaves which are partition objects, not logical base tables).

**FK summary across both migrations:**

- 1 DB-enforced FK: `msg_template_usage_log.template_id → msg_templates(id) ON DELETE CASCADE` (P2-19a).
- 0 DB-enforced FKs in P2-19b — every cross-table reference is soft per ADR-001/020 because three of the parents are RANGE-partitioned (`msg_messages`, `msg_moderation_actions`) and three of the references cross the tenant/platform boundary (`schools`, `platform_users`).

**Splitter discipline:** both migrations cleared the splitter audit on first attempt after fixing 3 mid-string semicolons in 154 pre-provision (rewritten with commas / em-dashes). Provisioned cleanly on both `tenant_demo` and `tenant_test`.

## Services

`apps/api/src/communications-advanced/`:

| File                             | Sub-cycle | Purpose                                                                                             |
| -------------------------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `ai-inference.service.ts`        | P2-19a    | Stub for AI translation + sensitivity scoring. Swap for HTTP client when extracted service deploys. |
| `language-preference.service.ts` | P2-19a    | Per-user language preference + auto-translate toggles.                                              |
| `translation.service.ts`         | P2-19a    | On-demand AI translation with cache. UNIQUE(message_id, target_language) is the cache key.          |
| `template.service.ts`            | P2-19a    | Templates + render with variable validation + usage log.                                            |
| `broadcast-segment.service.ts`   | P2-19a    | Audience targeting. resolve() returns the platform_users.id set.                                    |
| `broadcast-analytics.service.ts` | P2-19a    | Per-(broadcast, segment) delivery / open / click funnel + aggregate rollup.                         |
| `moderation.service.ts`          | P2-19b    | Three-tier rule catalogue + admin queue + most-restrictive-wins resolver.                           |
| `appeal.service.ts`              | P2-19b    | User appeal workflow. OVERTURNED releases the blocked message atomically (KEYSTONE).                |
| `ai-moderation.service.ts`       | P2-19b    | Cached AI sensitivity scoring. UNIQUE(message_id) keeps the AI call to once per message.            |
| `push-campaign.service.ts`       | P2-19b    | Campaigns + analytics + device tokens.                                                              |
| `push-campaign.worker.ts`        | P2-19b    | 30s polling worker. Dispatches SCHEDULED rows whose scheduled_at has elapsed. Tenant-iterating.     |

`apps/api/src/communications-advanced/consumers/`:

| File                              | Sub-cycle | Consumer group               | Topic                     |
| --------------------------------- | --------- | ---------------------------- | ------------------------- |
| `translation.consumer.ts`         | P2-19a    | `translation-worker`         | `msg.message.posted`      |
| `broadcast-analytics.consumer.ts` | P2-19a    | `broadcast-analytics-worker` | `msg.broadcast.delivered` |
| `moderation.consumer.ts`          | P2-19b    | `moderation-worker`          | `msg.message.posted`      |
| `push-analytics.consumer.ts`      | P2-19b    | `push-analytics-worker`      | `msg.push.delivered`      |

All four consumers reuse the standard `unwrapEnvelope` + `processWithIdempotency` claim-after-success pattern documented in CLAUDE.md.

## Endpoints — ~34 total

All endpoints live on `CommunicationsAdvancedController` and reside under `/api/v1/communications/*`.

**P2-19a (~18 endpoints)** under `com-001:*` (translation, language preferences, templates read) + `com-002:*` (templates write, broadcast segments + analytics).

**P2-19b (~16 endpoints)** distributed:

| Surface                    | Method | Path                                          | Permission    |
| -------------------------- | ------ | --------------------------------------------- | ------------- |
| Moderation rules           | GET    | /communications/moderation/rules              | com-003:read  |
|                            | GET    | /communications/moderation/rules/:id          | com-003:read  |
|                            | POST   | /communications/moderation/rules              | com-003:admin |
|                            | PATCH  | /communications/moderation/rules/:id          | com-003:admin |
| Moderation queue / actions | GET    | /communications/moderation/queue              | com-003:write |
|                            | GET    | /communications/moderation-actions/:id        | com-003:read  |
|                            | PATCH  | /communications/moderation-actions/:id        | com-003:write |
| Appeals                    | GET    | /communications/moderation/appeals            | com-003:write |
|                            | GET    | /communications/moderation-appeals/:id        | com-003:read  |
|                            | POST   | /communications/moderation-actions/:id/appeal | com-001:write |
|                            | PATCH  | /communications/moderation-appeals/:id        | com-003:write |
| AI moderation              | POST   | /communications/ai-moderation/analyze         | com-003:write |
|                            | GET    | /communications/ai-moderation/:messageId      | com-003:read  |
| Push campaigns             | GET    | /communications/push-campaigns                | com-002:read  |
|                            | GET    | /communications/push-campaigns/:id            | com-002:read  |
|                            | POST   | /communications/push-campaigns                | com-002:write |
|                            | PATCH  | /communications/push-campaigns/:id            | com-002:write |
|                            | GET    | /communications/push-campaigns/:id/analytics  | com-002:read  |
| Push devices               | POST   | /communications/push-devices                  | com-001:write |
|                            | GET    | /communications/push-devices                  | com-001:read  |
|                            | DELETE | /communications/push-devices/:id              | com-001:write |

**Permission codes used:** `COM-001` (Internal Messaging), `COM-002` (Announcements + Broadcast), `COM-003` (Content Moderation), `COM-004` (Notification Preferences). All four are already in the catalogue from earlier waves — no catalogue edit required.

## Seeds

`packages/database/src/seed-communications-advanced.ts` (P2-19a) + `seed-moderation-push.ts` (P2-19b). Both idempotent; gated on whether the first table of the cycle already has rows for the demo school. Wired into `seed-all.ts` chain.

**P2-19b seed shape on `tenant_demo`:**

| Table                     | Count | Notes                                                                                                                                        |
| ------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| msg_moderation_rules      | 3     | 1 PLATFORM (school_id NULL, BLOCK) + 1 DISTRICT (FLAG, ai threshold 0.70) + 1 BUILDING (ESCALATE, ai threshold 0.50).                        |
| msg_moderation_actions    | 5     | 2 BLOCKED (1 PENDING, 1 RELEASED-via-appeal) + 1 FLAGGED_FOR_REVIEW RELEASED + 1 ESCALATED_TO_COUNSELLOR PENDING + 1 AUTO_APPROVED RELEASED. |
| msg_moderation_appeals    | 1     | OVERTURNED, paired with action2 (the BLOCKED-then-released row).                                                                             |
| msg_ai_moderation_results | 3     | Cached for the 3 action rows that had non-zero sensitivity scores.                                                                           |
| msg_push_campaigns        | 2     | 1 SENT (Snow Day Closure 3 days ago) + 1 SCHEDULED (Back-to-School next Monday).                                                             |
| msg_push_analytics        | 2     | SENT row has full counters (245/240/198/87, rates populated); SCHEDULED row has zeros.                                                       |
| msg_push_device_tokens    | 5     | 3 IOS (principal phone + iPad + David Chen phone) + 2 ANDROID (Maya phone + teacher phone).                                                  |

## Vitest

`communications-advanced.spec.ts` (P2-19a, 19 tests) + `communications-advanced-p2c19b.spec.ts` (P2-19b, 21 tests) — **40 cycle tests total**, all passing.

Whole-suite count: **905 tests across 43 spec files** (was 884 pre-P2-19b; +21 new P2-19b regressions).

P2-19b spec describe blocks:

- `ModerationService — three-tier most-restrictive-wins (P2-19b BLOCKING)` × 4
- `ModerationService — recordAction stamps schema lockstep correctly` × 2
- `AppealService — OVERTURNED releases parent action in same tx (P2-19b KEYSTONE)` × 3
- `AIModerationService — cache UNIQUE(message_id) keystone` × 2
- `PushCampaignService — schedule lockstep + analytics UPSERT keystones` × 4
- `CommunicationsAdvancedController P2-19b — permission gates pin the documented codes` × 6

## CI parity

| Gate                                                | State                                                |
| --------------------------------------------------- | ---------------------------------------------------- |
| `pnpm format:check`                                 | clean                                                |
| `pnpm lint:logs` (849 files)                        | clean                                                |
| `pnpm --filter @campusos/api build`                 | clean                                                |
| `pnpm --filter @campusos/web build`                 | clean                                                |
| `pnpm --filter @campusos/api test` (43/43, 905/905) | clean                                                |
| Tenant migrations 153 + 154                         | provisioned cleanly on `tenant_demo` + `tenant_test` |
| Splitter audit on both new migrations               | clean                                                |

## Cross-cycle integration

| Producer / data source                      | Topic / table                                 | Consumer / writer                                          |
| ------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| Cycle 3 MessageService (msg.message.posted) | `msg.message.posted`                          | TranslationConsumer (P2-19a) + ModerationConsumer (P2-19b) |
| Cycle 14 broadcast emitters (planned)       | `msg.broadcast.delivered`                     | BroadcastAnalyticsConsumer (P2-19a) — forward-compatible   |
| External push provider (planned)            | `msg.push.delivered`                          | PushAnalyticsConsumer (P2-19b) — forward-compatible        |
| Internal: PushCampaignWorker tick           | `msg_push_campaigns WHERE status='SCHEDULED'` | PushCampaignService.dispatchScheduled                      |

## Known carry-overs to Phase 2 / pre-pilot punch list

These are intentionally deferred and tracked on the Wave 2 Phase 2 backlog in CLAUDE.md:

1. **Source-event emits** — The `msg.broadcast.delivered` and `msg.push.delivered` topics have no production producer yet. Consumers ship forward-compatibly; producers wire as the broadcast and push notification services mature.
2. **Outbox-backed durability** — The new emit topics that Cycle 19 introduces are best-effort. The Phase 2 outbox migration (item 4 on the broader backlog) will move them onto durable enqueueInTx semantics.
3. **Message hide-on-block UI propagation** — `msg.message.blocked` emit is not yet wired so the recipient-side `MessageService.list` does not filter out BLOCKED messages immediately. Phase 2 polish task.
4. **Push notification service swap-in** — `PushCampaignWorker.dispatchForTenant` logs the dispatch but does not actually send via APNs / FCM / web push. Plug in once the extracted push service exists.
5. **Segment-scoped audience size** — `PushCampaignService.resolveAudienceSize` only implements the school-wide (audience_segment_id NULL) path. Segment-scoped resolution requires forwarding to `BroadcastSegmentService.resolve` and gating on the seeded segment shape.
6. **Region-aware moderation** — `ModerationService` queries all rules in one read for both tiers. As the rule catalogue grows we'll want a per-school-cached read path; today the partial GIN on keywords plus the small rule count keeps the read cheap.

## Tags

`p2c19a-complete` (not yet tagged in repo; this commit message includes both sub-cycles). After Round 2 PASS we will tag `p2c19-complete` at the closeout commit and `p2c19-approved` at the round-2 fix commit, matching the convention from prior cycles.

## What this closes

**M40 Communications.** Cycle 3 originally shipped 18 of the 31 plan tables (messaging core, notifications, announcements, moderation policies, basic moderation log) plus the audience fan-out worker. Cycle 14 added emergency alerts (3 tables) + multi-step approval consumer wiring. Cycle 19 closes out the deferred 13 tables — translation, templates, broadcast segments, broadcast analytics, three-tier moderation rules + actions + appeals, AI moderation results, push campaigns + analytics + device tokens. The Communications module is now feature-complete relative to the M40 ERD specification.
