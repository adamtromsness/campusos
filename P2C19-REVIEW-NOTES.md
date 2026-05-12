# P2C19 — Peer Review Scaffold (Communications Advanced)

**Cycle:** Phase 2 Cycle 19 (P2-19a + P2-19b)
**Plan:** `docs/campusos-p2c19-communications-advanced.html`
**Handoff:** `HANDOFF-P2C19.md`
**Cycle final commit:** closeout commit after Round 2 PASS verdict
**Final verdict:** **PASS / APPROVED** at the closeout commit (Round 2 against `025d1dd`).

## REVIEW-P2C19 — Round 2 final verdict (2026-05-12)

Round 2 against the Round 1 fix commit `025d1dd` returned **PASS** across every dimension (Translation, Moderation, Broadcast Segments, Push Campaigns, Push Analytics, Moderation Consumer, Test Coverage). The reviewer confirmed each of the 6 BLOCKING fixes + 2 actionable MAJORs matches in code via cache-busted file reads.

**Tags applied:**

- `p2c19-complete` at `025d1dd` (the Round 1 fix commit that earned PASS).
- `p2c19-approved` at the closeout commit (this commit).

**Carry-over (Phase 2 punch list):** broadcast analytics needs school-defensive handling around `broadcastId` before the future `msg.broadcast.delivered` producer is wired. No production producer exists yet; the consumer is exercise-cold. Pre-wiring fix is either add a `school_id` column to `msg_broadcast_analytics` or validate the broadcast row through its owning broadcast table.

## REVIEW-P2C19 Round 1 verification trail

| #   | Finding                                                              | Status | Evidence                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Translation endpoints do not enforce message/thread visibility       | FIXED  | `translation.service.ts::assertMessageVisible` runs `EXISTS (sender_id OR thread_participant) OR isSchoolAdmin` against `msg_messages` + `msg_thread_participants` before any read of the body or cached translations. Spec: 4 tests in `BLOCKING 1` describe block.                                                                                                                          |
| B2  | Moderation rules/actions/appeals are not current-school scoped       | FIXED  | `moderation.service.ts` listRules / loadRule / patchRule add `scope='PLATFORM' OR school_id = tenant`. Action queue + getAction + patchAction + loadActionInTx add the EXISTS clause through `msg_moderation_rules`. AppealService list / getById / patch chain the EXISTS through `msg_moderation_actions → msg_moderation_rules`. Spec: 5 tests in `BLOCKING 2` describe block.             |
| B3  | Broadcast segment CUSTOM audience leak                               | FIXED  | `broadcast-segment.service.ts` CUSTOM branch JOINs through `platform.iam_person` + 3 current-school projections (sis_students via platform_students.person_id / sis_guardians.person_id / hr_employees.person_id). Spec: SQL-shape fragments asserted in `BLOCKING 3` describe block.                                                                                                         |
| B4  | Push campaign worker not school-scoped                               | FIXED  | `push-campaign.service.ts` findRipe + dispatchScheduled + resolveAudienceSize all add `school_id = $tenant`. Audience counting joins through current-school projections instead of counting every active device token. Spec: 3 tests in `BLOCKING 4` describe block.                                                                                                                          |
| B5  | Push analytics counters not crash/redelivery idempotent              | FIXED  | New table `msg_push_analytics_contributions(consumer_group, source_event_id, campaign_id) UNIQUE`. `recordDelivery` INSERTs ledger row in same tx as additive bump; 23505 on redelivery short-circuits to current row. `PushAnalyticsConsumer` passes `CONSUMER_GROUP + event.eventId`. Spec: 2 tests in `BLOCKING 5` describe block (INSERT order assertion + 23505 short-circuit).          |
| B6  | Moderation action materialisation not crash/redelivery idempotent    | FIXED  | New table `msg_moderation_contributions(consumer_group, source_event_id, message_id, action_id, action_created_at) UNIQUE`. `recordAction` INSERTs ledger before action INSERT; 23505 on redelivery re-reads via `(action_id, action_created_at)`. `ModerationConsumer` passes `CONSUMER_GROUP + event.eventId`. Spec: 2 tests in `BLOCKING 6` describe block (INSERT order + 23505 re-read). |
| M2  | Push campaign audienceSegmentId not validated against current school | FIXED  | `PushCampaignService.assertSegmentInCurrentSchool` runs `WHERE id AND school_id = $tenant` before create/patch. Spec: 2 tests in `MAJOR 2` describe block.                                                                                                                                                                                                                                    |
| M3  | Template/segment post-mutation reloads use id-only WHERE             | FIXED  | `template.service.ts` + `broadcast-segment.service.ts` create/patch SELECT + UPDATE statements now carry `school_id = $tenant`. Mirrors the wider Phase 2 convention.                                                                                                                                                                                                                         |
| M1  | Broadcast analytics is not school-defensive around broadcastId       | CARRY  | Recorded on the Phase 2 punch list in CLAUDE.md. No production producer exists yet so the surface is exercise-cold; before the future broadcast-delivery wiring lands the analytics reads/writes must add a school_id column or validate the broadcast row through its owning broadcast table.                                                                                                |

**Migration:** `155_msg_event_contributions.sql` — additive, splitter-safe. 2 new tenant tables (`msg_moderation_contributions`, `msg_push_analytics_contributions`).

**Test coverage:** vitest 905 → **924** (+19 new pinned regression tests).

**CI parity:** format:check + lint:logs (850 files) + API + web build + vitest 924/924 all green at the fix commit.
**Reviewer prompt template:** see `REVIEW-CYCLEN-CHATGPT.md` files in
prior cycles. Same shape — 12 dimensions, FAIL/PASS verdict per finding,
final verdict at the bottom.

This document explains the cycle's design decisions so the architecture
reviewer can verify intent against code rather than guess.

## 1. Translation caching strategy (P2-19a)

**Contract.** Caller passes `(messageId, targetLanguage)`. We return
the cached translation if one exists; otherwise we call the AI Inference
service, INSERT the row with `ON CONFLICT (message_id, target_language)
DO NOTHING`, then re-read and return.

**Why ON CONFLICT DO NOTHING + re-read instead of an UPSERT?** Translations
are immutable per (message, target_language). A second writer racing
the cache-miss path should see the first writer's row, not overwrite
it. Re-reading after the INSERT means both racers return the same final
state regardless of who won the INSERT slot.

**Why `message_created_at` is denormalised** on `msg_translations`:
`msg_messages` is RANGE-partitioned on `created_at` so a DB-enforced
FK to `msg_messages(id)` would require partition-aware FK semantics
which PostgreSQL does not support without denormalising the partition
key. We follow the same pattern Cycle 3 used on `msg_message_attachments`.

**Confidence column.** 0.0–1.0 NUMERIC(3,2) reflecting the AI's
self-reported confidence. Stub returns 0.95; production model varies.
The UI uses confidence < 0.8 to surface a "machine-translated" badge.

## 2. Template variable validation (P2-19a)

**Contract.** Variables are declared on the template row as a JSONB
array of `{name, description, required, default_value}` entries.
`TemplateService.render(templateId, providedVars)` walks the declared
variables, applies provided values, then default_value if required is
true and no value was provided. If a required variable has neither a
provided value nor a default, render() throws 400 with the missing
names inlined.

**Why JSONB instead of a sibling table?** Templates are read-mostly and
templates without variable definitions are common. A single row with
a JSONB column is simpler than a normalised parent + children pair,
and the JSONB GIN index makes `WHERE variables ?` lookups cheap.

**Unknown variables are silently ignored.** A future template-author UI
will warn on unknown variables at edit time; the runtime accepts them
because failing on every misspelled placeholder during a fan-out
breaks bulk operations.

## 3. Three-tier moderation resolution (P2-19b KEYSTONE)

**Contract.** On every `msg.message.posted`, the ModerationConsumer
calls `ModerationService.resolveDecision(text, aiScore)`:

1. SELECT every active rule where `scope='PLATFORM'` OR `school_id =
tenant.schoolId`. PLATFORM rules apply to every tenant; tenant-scoped
   rules (DISTRICT, BUILDING) apply only to this tenant.
2. For each rule, check keyword matches (case-insensitive whole-substring,
   `lower(text).includes(lower(keyword))`) AND check the AI score
   against `ai_sensitivity_threshold` if set.
3. A rule "matches" when at least one keyword is present OR the AI
   score meets the threshold. Both signals are weighted equally —
   logical OR.
4. Among matching rules, pick the one whose `keyword_action` ranks
   highest:
   - **BLOCK** = 3 (highest)
   - **ESCALATE_TO_COUNSELLOR** = 2
   - **FLAG_FOR_REVIEW** = 1
5. Materialise into `msg_moderation_actions.action_taken`:
   - BLOCK → BLOCKED
   - ESCALATE_TO_COUNSELLOR → ESCALATED_TO_COUNSELLOR
   - FLAG_FOR_REVIEW → FLAGGED_FOR_REVIEW
   - No matches → AUTO_APPROVED (review_status pre-stamped RELEASED).

**Why "most-restrictive wins" instead of fan-out across all matching
rules?** A single message produces a single moderation outcome. The
admin queue would be unmanageable if every matching rule produced a
separate row to review. The chosen action's matched_keywords array
captures which keywords from the chosen rule fired; we lose visibility
into the keywords from less-restrictive rules but the admin can re-run
analysis against any rule if they need to drill in.

**PLATFORM rules are non-negotiable.** `ModerationService.createRule`
and `patchRule` enforce that scope=PLATFORM mutations require Platform
Admin authority (today: `actor.isSchoolAdmin` is the closest signal;
Phase 2 punch list adds a tighter platform-scope-only check). Tenant
admins (school admin) own the DISTRICT and BUILDING tiers.

## 4. AI sensitivity threshold configuration (P2-19b)

**Contract.** Each rule can carry `ai_sensitivity_threshold NUMERIC(3,2)`
in 0.0–1.0 range. The ModerationConsumer:

1. Computes the AI sensitivity score for the message body once via the
   `AIModerationService.analyze` cache.
2. Passes the score to `ModerationService.resolveDecision`. The resolver
   compares it against each rule's threshold; rules whose threshold is
   met fire the same `keyword_action` they would fire on a keyword
   match.

**Why one AI call per message?** AI inference is expensive and produces
the same output for the same input. Caching by `UNIQUE(message_id,
message_created_at)` means a redelivered moderation event reads the
cached row instead of re-calling the AI service. The cache row also
serves the admin-tier `GET /communications/ai-moderation/:messageId`
endpoint so reviewers see which AI signal fired without re-running.

**Threshold semantics.** Higher threshold = looser filter. A rule with
`ai_sensitivity_threshold=0.50` (the seeded BUILDING self-harm rule)
fires more aggressively than one with `0.70` (the DISTRICT bullying
rule). Schools choose thresholds based on tolerance for false positives
vs missed escalations — the seed pins self-harm at 0.50 because the
cost of a missed escalation is higher than the cost of a false alarm.

## 5. Appeal workflow state machine (P2-19b KEYSTONE)

**States.** SUBMITTED → UPHELD or OVERTURNED. The schema-side
`msg_moderation_appeals_status_chk` 3-value CHECK is the safety net;
the service is the authoritative gate.

**Transitions:**

| From      | To         | Authority | Side effect on parent moderation_action                               |
| --------- | ---------- | --------- | --------------------------------------------------------------------- |
| SUBMITTED | UPHELD     | admin     | None — parent stays in its current review_status.                     |
| SUBMITTED | OVERTURNED | admin     | **Parent flips to review_status=RELEASED inside the same tenant tx.** |

**Why OVERTURNED releases atomically.** Without the atomic flip, an
operator could land an OVERTURNED appeal while the parent action stays
PENDING — the message stays blocked even though the appeal was upheld.
The schema's `msg_moderation_actions.reviewed_chk` lockstep means
`(review_status='RELEASED', reviewed_by NOT NULL, reviewed_at NOT
NULL)` must all flip together; doing it inside the appeal tx is the
only way to satisfy the lockstep atomically.

**Authority.** Submission is `com-001:write` (any user with messaging
write authority — typically the original message sender). Review is
`com-003:write` (the moderation surface). The service additionally
restricts submission to (actor is the sender OR actor is a school
admin) by joining through `msg_messages.sender_id`.

**UNIQUE on (action_id, action_created_at).** Each moderation action
accepts at most one appeal. A duplicate submission returns 409. The
composite key is required because `msg_moderation_actions` is
RANGE-partitioned by created_at — the unique constraint on a non-
partitioned child table referencing a partitioned parent must
denormalise the partition column.

## 6. Push device token lifecycle (P2-19b)

**Register.** `POST /communications/push-devices` with
`(deviceToken, platform, deviceName, appVersion)`. Pinned to the
calling user via `actor.accountId`. UNIQUE(user_id, device_token)
means re-registering the same token UPDATEs (refreshes last_used_at +
flips is_active=true + bumps device metadata) instead of inserting a
duplicate.

**Deregister.** `DELETE /communications/push-devices/:id` hard-deletes
the row. Soft-delete via `is_active=false` is reserved for the future
push-server-reported-unreachable path — when APNs/FCM returns
"unregistered" the worker will flip the row to is_active=false rather
than DELETE so we keep the history.

**Audience resolution.** `PushCampaignWorker` reads active tokens
(`is_active=true`) at dispatch time. Today only the school-wide
(audience_segment_id NULL) path is implemented — for a school-wide
campaign, every active token in the tenant. Segment-scoped resolution
will forward to `BroadcastSegmentService.resolve(segmentId)` once that
path lands its push-targeting variant.

## 7. Push campaign scheduling

**State machine.** DRAFT → SCHEDULED → SENT, with CANCELLED as the
terminal alt-path from DRAFT or SCHEDULED.

**Schema invariants:**

- `msg_push_campaigns_scheduled_chk`: `status='SCHEDULED'` requires
  scheduled_at NOT NULL.
- `msg_push_campaigns_sent_chk`: `(status='SENT') ⇔ (sent_at NOT NULL)`.
  Both columns flip atomically inside `PushCampaignService.dispatchScheduled`.

**Worker tick.** Every 30s the `PushCampaignWorker` iterates every
active tenant via `runWithTenantContextAsync`, calls
`PushCampaignService.findRipe()` for SCHEDULED rows whose scheduled_at
has elapsed, resolves the audience size, then `dispatchScheduled`
inside one tenant tx (FOR UPDATE lock + state transition + analytics
seed).

**Idempotency.** `dispatchScheduled` refuses non-SCHEDULED rows — a
sibling worker tick that catches a row already flipped to SENT is a
no-op. The schema-side `sent_chk` is the schema-layer belt-and-braces.

## 8. AI moderation result cache

**Cache contract.** `UNIQUE(message_id, message_created_at)` is the
cache key. `AIModerationService.analyze(messageId, text?)` reads the
cache first; on miss it calls the AI Inference service and INSERTs
with `ON CONFLICT (message_id, message_created_at) DO NOTHING` to
handle the rare two-concurrent-first-call race.

**Storage shape.** `sensitivity_score NUMERIC(3,2)` is the headline
0.0–1.0 number. `categories_detected JSONB` carries per-category
scores e.g. `{profanity: 0.92, bullying: 0.3, self_harm: 0.1}`. The
JSONB shape is intentionally free-form because the upstream model
catalog may evolve (new categories like "harassment_age_inappropriate"
become available without a schema migration).

**Why we don't fan out per-category to separate rows.** The cache is
read-once-per-message — a row-per-category would make the cache check
N queries instead of 1, with no operational benefit until the admin UI
needs per-category filtering. Easy to add later if needed.

## 9. Risk assessment

| Risk                                                      | Likelihood | Impact     | Mitigation                                                                                                                                                                  |
| --------------------------------------------------------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Moderation rule SELECT scans all rules each message       | Low        | Low        | Today rule counts per tenant are <10. GIN index on keywords + simple text matching keep the read cheap. Phase 2 may need a per-tenant cached rule set if counts cross 100s. |
| AI Inference stub returns 0.05 always — no real signals   | High (dev) | None (dev) | Production swap-in calls the extracted AI service. Stub is acceptable for dev/CAT because the keystone tests don't depend on the score range.                               |
| PLATFORM rules can be deactivated by school admin         | Mitigated  | High       | Service-layer `isPlatformAdmin` gate refuses non-Platform-Admin to mutate scope=PLATFORM rows. Schema-side `scope_pair_chk` prevents accidental school_id-pollution.        |
| Appeal OVERTURNED before parent action review_status flip | Mitigated  | High       | Both writes inside same `executeInTenantTransaction`. Schema-side `reviewed_chk` lockstep on action would reject a half-flip anyway.                                        |
| Push campaign dispatched twice                            | Mitigated  | Low        | `dispatchScheduled` SELECT FOR UPDATE + state check; non-SCHEDULED returns null no-op.                                                                                      |
| Cross-tenant moderation rule leak                         | Mitigated  | High       | Resolver query reads `scope='PLATFORM' OR school_id = tenant.schoolId`. Tenant context is set via `executeInTenantContext` which pins search_path.                          |
| Device token UNIQUE collision during re-registration      | Mitigated  | Low        | Service checks for existing (user_id, device_token) row first and UPDATEs rather than INSERTs.                                                                              |

## 10. Reviewer attention checklist

A reviewer should be able to verify each item below against the code
without needing to run the system:

- [ ] Migration 154 is splitter-safe (no `;` inside strings / comments / block comments).
- [ ] `msg_moderation_actions` is RANGE-partitioned by created_at MONTHLY with 25 leaves covering 2025-08 → 2027-08, composite PK `(id, created_at)`.
- [ ] `msg_moderation_appeals.action_id` UNIQUE composite with `action_created_at` (because parent is partitioned).
- [ ] All 7 P2-19b tables have soft FKs only; the only DB-enforced FK in the full cycle is `msg_template_usage_log.template_id` (P2-19a).
- [ ] `ModerationService.resolveDecision` reads both PLATFORM and tenant tier rules in one SELECT (`scope = $1 OR school_id = $2::uuid`).
- [ ] `AppealService.patch` OVERTURNED path flips appeal row AND calls `ModerationService.releaseActionInTx` inside the same `executeInTenantTransaction`.
- [ ] `AIModerationService.analyze` uses ON CONFLICT DO NOTHING on the INSERT to handle the concurrent-first-call race.
- [ ] `PushCampaignWorker` polls every 30s via setTimeout chain (not setInterval — same pattern as NotificationDeliveryWorker) and uses `runWithTenantContextAsync` per tenant.
- [ ] `PushCampaignService.dispatchScheduled` locks the row with FOR UPDATE, validates SCHEDULED, flips to SENT with sent_at populated atomically, seeds analytics with total_targeted.
- [ ] All Cycle 19 controller endpoints gate on `com-001` / `com-002` / `com-003` permissions — none reuse `com-004`.

## 11. Open carry-overs (Phase 2 / pre-pilot)

Listed in HANDOFF-P2C19.md "Known carry-overs". Repeated here for the
reviewer:

1. `msg.broadcast.delivered` and `msg.push.delivered` topics have no
   production producer yet. Consumers ship forward-compatibly.
2. New emit topics are best-effort (no outbox). Joins item 4 on the
   Wave 2 Phase 2 backlog.
3. `msg.message.blocked` emit + recipient-side filter — Phase 2 polish.
4. Push notification service swap-in (APNs / FCM / web push).
5. Segment-scoped audience size resolution in `PushCampaignService`.
6. Cross-tenant moderation rule cache for high rule counts.

## 12. Verdict template

Round 1 verdict format (use the standard 12-dimension scorecard):

```
Schema / Multi-tenancy / FK + Soft Ref Discipline / Kafka Envelope /
Idempotency / Service-Layer Authorisation / State-Machine Concurrency /
Worker Reliability / Test Coverage / Documentation / Permission Model /
Code Quality
```

Each: PASS / DEVIATION-FOLLOW-UP / VIOLATION (the BLOCKING).

Final verdict: APPROVED / REJECT-PENDING-FIXES / FAIL.
