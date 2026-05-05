# Cycle 14 Handoff — Communications

**Status:** Cycle 14 **COMPLETE — REVIEW-CYCLE14 Round 1 fixes applied; Round 2 review pending.** Round 1 of REVIEW-CYCLE14-CHATGPT (against `cycle14-complete` at `9d76abd`) returned **Reject pending fixes** with 2 BLOCKING issues (FLAGGED-message visibility before moderator release + edit/delete row-scope leak via 403) plus 5 MAJOR follow-ups; all actionable items addressed in the closeout fix commit (live-verified on `tenant_demo` 2026-05-05). MAJORs 5 + 7 are recommendation-class deferred to the Phase 2 punch list as items 18 + 19. **Round 2 review pending.** All 10 steps done. Vertical-slice CAT at `docs/cycle14-cat-script.md` covers the 10 plan scenarios end-to-end against `tenant_demo`. Cycle 14 completes the M40 Communications module that **Cycle 3 substantially built** — Cycle 3 already shipped 12 of the 15 plan tables, plus ThreadService / MessageService / UnreadCountService / ContentModerationService / AnnouncementService / AudienceFanOutWorker / `/messages` + `/announcements` web routes. The remaining work in Cycle 14 lands cleanly: 1 new messaging table (`msg_thread_stats`) + the Kafka consumer that maintains it, 2 new emergency-alert tables (`msg_emergency_alerts`, `msg_emergency_alert_deliveries`) + EmergencyAlertService + AlertTypeService + 1 new Kafka emit (`msg.emergency.issued`), ModerationService admin endpoints (queue + review + policy CRUD), the persistent rose-tinted emergency alert banner UI + management dashboard, and the admin moderation queue + log + policy editor UI. Final cycle totals: **3 new base tables**, **2 new intra-tenant FKs**, **0 cross-schema FKs**, **~16 new endpoints** (10 emergency + 6 moderation), **2 Kafka emit topics** (1 new + 1 from Cycle 3 routed through new ThreadStatsConsumer), **5 new web routes** (`/messages/emergency-alerts`, `/messages/moderation`, `/messages/moderation/queue`, `/messages/moderation/log` + the persistent banner), **11 new React Query hooks**. Tenant base table count: 203 → **206**. Catalogue stays at 450 (COM-001..004 already in `permissions.json`). IAM cache (post REVIEW-CYCLE14 MAJOR 6 fix): Teacher 53 → 54, Parent 26 → 27, Student 27 → 28, Staff 64 → 67 (the +5 from Cycle 14 minus -2 the MAJOR 6 fix removed for the Staff role's stale COM-004 grant). Tagged `cycle14-complete` after CI green. **Wave 3 opens here.**

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle14-implementation-plan.html`
**Vertical-slice deliverable:** Teacher Rivera creates a TEACHER_PARENT thread with David Chen → sends a message about Maya's progress → content moderation pipeline clears it → David sees the message in his inbox with an unread badge from `msg_thread_stats` → David replies → Rivera marks it read → admin publishes a school-wide announcement "Spring Concert Friday" → audience worker pre-computes audience rows → David sees it in feed → admin issues an EMERGENCY alert "Severe Weather Shelter-in-Place" → multi-channel delivery rows fan out (PUSH + APP per recipient) → teachers acknowledge → admin resolves the alert → admin reviews the flagged message queue and releases a previously FLAGGED message.

This document tracks the Cycle 14 build at the same level of detail as `HANDOFF-CYCLE13.md` and is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                              | Status   |
| ---- | -------------------------------------------------- | -------- |
| 1    | Messaging Schema — msg_thread_stats                | **DONE** |
| 2    | Emergency Alerts + Moderation Schema               | **DONE** |
| 3    | Seed Data — Emergency Alerts + COM-003/004         | **DONE** |
| 4    | ThreadStatsConsumer + msg_thread_stats integration | **DONE** |
| 5    | EmergencyAlertService + AlertTypeService           | **DONE** |
| 6    | Moderation Admin Review endpoints                  | **DONE** |
| 7    | Messaging UI (carry-over from Cycle 3)             | **DONE** |
| 8    | Emergency Alert Banner + Management UI             | **DONE** |
| 9    | Admin Moderation UI                                | **DONE** |
| 10   | Vertical Slice Integration Test                    | **DONE** |

---

## What this cycle adds on top of Cycle 13

Cycle 14 opens Wave 3 (Communications & Community). The first universal-participation surface in CampusOS — every authenticated user (teacher, parent, student, staff, admin) sends and receives messages — was already shipped in Cycle 3 and is broadly intact. Cycle 14 narrows the additional work to the bits that genuinely complete the M40 Communications module.

**Inherited from Cycle 3 (no rework):**

- 12 of the 15 plan tables: `msg_thread_types`, `msg_threads` (HASH partitioned 64 buckets), `msg_thread_participants`, `msg_messages` (RANGE monthly partitioned 2025-08 → 2027-08), `msg_message_reads`, `msg_message_attachments`, `msg_alert_types`, `msg_announcements`, `msg_announcement_audiences`, `msg_announcement_reads`, `msg_moderation_policies`, `msg_moderation_log` (RANGE monthly partitioned).
- Backend services: ThreadService, MessageService, UnreadCountService, ContentModerationService, AnnouncementService, AudienceFanOutWorker, NotificationDeliveryWorker, NotificationInboxService.
- Web surfaces: `/messages` inbox + thread view + compose, `/announcements` feed + new + detail, NotificationBell + `/notifications` page.
- 2 Kafka emits already in flight: `msg.message.posted`, `msg.announcement.published`. 5 notification consumers shipped.

**New in Cycle 14:**

- **3 new tables** (Steps 1 + 2): `msg_thread_stats` (denormalised per-thread summary for inbox rendering), `msg_emergency_alerts` (the alert head row), `msg_emergency_alert_deliveries` (multi-channel delivery + acknowledgement tracking).
- **3 new backend services** (Steps 5 + 6): `EmergencyAlertService` (issue / resolve / acknowledge with `msg.emergency.issued` Kafka emit), `AlertTypeService` (school-configurable alert severity definitions CRUD), `ModerationReviewService` + `ModerationPolicyService` admin endpoints (flagged-message queue, release / confirm-block, building-tier policy CRUD).
- **1 new Kafka consumer** (Step 4): `ThreadStatsConsumer` on `dev.msg.message.posted` upserts `msg_thread_stats.message_count` + `last_message_at` + `last_message_preview` so the inbox renders without scanning `msg_messages`.
- **3 new web surfaces** (Steps 8 + 9): persistent emergency alert banner (dismiss-proof until acknowledged), `/messages/emergency-alerts` admin dashboard, `/messages/moderation` policy editor + flagged-message queue + audit log.

**Existing-system touchpoints:**

- `platform.iam_person(id)` — soft refs throughout (sender/recipient/issuer/reviewer fields)
- `sis_students(id)` — implicit via the platform_users → iam_person → platform_students chain for student personas
- Cycle 3's `msg_message_attachments` already handles signed S3 URLs.
- Cycle 11's coordinated-care surface receives the ESCALATE_TO_COUNSELLOR notification from the existing ContentModerationService.

What does not change: every existing module continues to function. Cycle 14 is purely additive on top of Cycle 3's M40 foundation.

---

## Step 1 — Messaging Schema — msg_thread_stats

**Status:** DONE on 2026-05-05.

**Migration target:** `packages/database/prisma/tenant/migrations/051_msg_thread_stats.sql`.

**Plan vs reality.** The Cycle 14 plan lists 7 tables in Step 1 (`msg_thread_types`, `msg_threads`, `msg_thread_participants`, `msg_thread_stats`, `msg_messages`, `msg_message_reads`, `msg_message_attachments`). Six of those landed cleanly in Cycle 3 Step 1 via `007_msg_messaging.sql` and have been live on `tenant_demo` and `tenant_test` since 2026-04-27. **Only `msg_thread_stats` is new this cycle** — the denormalised per-thread summary that lets the inbox render without a sub-query against the partitioned `msg_messages` table.

**New table (1):**

1. **`msg_thread_stats`** — One row per thread. `thread_id UUID NOT NULL UNIQUE` (soft ref to `msg_threads(id, school_id)` — no DB FK because `msg_threads` is HASH-partitioned and Postgres requires the partition key in the FK source-side composite, which we do not denormalise here), `school_id UUID NOT NULL` (denormalised so the Step 4 `ThreadStatsConsumer` does not need a tx-time JOIN to determine tenant scope at write time), `message_count INT NOT NULL DEFAULT 0` with `>= 0` CHECK, `last_message_at TIMESTAMPTZ` nullable (NULL means the thread has zero messages — empty thread shape supported), `last_message_preview TEXT` nullable (the first 100 chars of the most recent message body — `LEFT(body, 100)` is the canonical clip), `last_sender_id UUID` nullable (soft ref to `platform_users(id)` so the inbox preview can render "Alice: …"), `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`. INDEX(school_id, last_message_at DESC) for the inbox sort hot path.

**FK summary:** 0 new DB-enforced FKs (all refs are soft per ADR-001/020 and the partitioning constraint described above). 0 cross-schema FKs.

**Tenant logical base table count after Step 1:** 203 → **204** (1 new logical base table).

---

## Step 2 — Emergency Alerts + Moderation Schema

**Status:** DONE on 2026-05-05.

**Migration target:** `packages/database/prisma/tenant/migrations/052_msg_emergency_alerts.sql`.

**Plan vs reality.** The plan lists 8 tables in Step 2 (`msg_announcements`, `msg_announcement_audiences`, `msg_announcement_reads`, `msg_alert_types`, `msg_emergency_alerts`, `msg_emergency_alert_deliveries`, `msg_moderation_policies`, `msg_moderation_log`). Six already exist from Cycle 3. **The two new tables are `msg_emergency_alerts` + `msg_emergency_alert_deliveries`.** Plus the `msg_announcements` table needs three column additions (`is_recurring`, `recurrence_rule`, `parent_announcement_id`) the Cycle 3 schema does not carry.

**New tables (2) + 1 column addition:**

1. **`msg_emergency_alerts`** — One row per declared alert. `school_id UUID NOT NULL` (soft to `platform.schools`), `alert_type_id UUID NOT NULL FK to msg_alert_types(id) ON DELETE NO ACTION` (audit survives a type retirement; admin cannot hard-delete a type with a referencing alert), `title TEXT NOT NULL`, `body TEXT NOT NULL`, `issued_by UUID NOT NULL` (soft to `platform.platform_users`), `incident_id UUID` nullable (soft to a future `inc_incidents(id)` table — the plan flags this for a later cycle, no DB FK), `issued_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `status TEXT NOT NULL DEFAULT 'ACTIVE'` 2-value CHECK ACTIVE/RESOLVED, `resolved_at TIMESTAMPTZ` nullable, `resolved_by UUID` nullable (soft), **multi-column `resolved_chk` keystone** keeping `(status, resolved_at, resolved_by)` in lockstep — ACTIVE ⇒ both NULL, RESOLVED ⇒ both NOT NULL. INDEX(school_id, issued_at DESC). Partial INDEX(school_id) WHERE status='ACTIVE' for the live-banner hot path. Emits `msg.emergency.issued` on creation.

2. **`msg_emergency_alert_deliveries`** — Multi-channel delivery + acknowledgement tracking. `alert_id UUID NOT NULL FK to msg_emergency_alerts(id) ON DELETE CASCADE` (deliveries are meaningless without their parent alert), `recipient_id UUID NOT NULL` (soft to `platform.platform_users`), `channel TEXT NOT NULL` 4-value CHECK PUSH/SMS/EMAIL/APP, `status TEXT NOT NULL DEFAULT 'PENDING'` 4-value CHECK PENDING/SENT/DELIVERED/FAILED, `sent_at TIMESTAMPTZ` nullable, `acknowledged_at TIMESTAMPTZ` nullable, `failure_reason TEXT` nullable, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`. **UNIQUE(alert_id, recipient_id, channel)** so each (alert, recipient, channel) tuple lands at most once. INDEX(recipient_id, acknowledged_at) WHERE acknowledged_at IS NULL — the per-recipient unread-emergency hot path that drives the dismiss-proof banner.

3. **`msg_announcements` column additions** — `ALTER TABLE msg_announcements ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN NOT NULL DEFAULT false` + `ADD COLUMN IF NOT EXISTS recurrence_rule TEXT` (nullable iCal RRULE) + `ADD COLUMN IF NOT EXISTS parent_announcement_id UUID` nullable (soft self-ref for recurrence-instance-of-template — no DB FK because we want the parent to retire while instances live on as audit). The recurring-announcement processor itself is deferred per the plan's "What's Deferred" callout; the columns ship now so the schema migration is one-and-done.

**FK summary:** 2 new DB-enforced FKs (1 NO ACTION on `msg_emergency_alerts.alert_type_id`, 1 CASCADE on `msg_emergency_alert_deliveries.alert_id`). 0 cross-schema FKs.

**Tenant logical base table count after Step 2:** 204 → **206** (2 new logical base tables + 3 added columns to existing).

---

## Step 3 — Seed Data — Emergency Alerts + COM Permissions

**Status:** DONE on 2026-05-05.

**Seed target:** `packages/database/src/seed-emergency.ts` (idempotent, gated on `msg_emergency_alerts` row count) wired as `seed:emergency` in `package.json`.

**What gets seeded.** Cycle 3 already seeded 4 thread types + 3 threads + 10 messages + 4 read receipts + 3 alert types (GENERAL_ANNOUNCEMENT / PARENT_INFORMATIONAL / WEATHER_CLOSURE) + 2 announcements + 3 moderation policies. Cycle 14 adds:

1. **2 additional alert types per the plan:** "Severe Weather" (severity=EMERGENCY, channels=[PUSH, APP], requires_acknowledgement=true), "Early Dismissal" (severity=WARNING, channels=[APP], requires_acknowledgement=false). The Cycle 3 `msg_alert_types` already exists; this is just additional rows.
2. **1 sample emergency alert:** "Severe Weather Drill" status=ACTIVE issued by Mitchell with 3 deliveries — PUSH to Rivera DELIVERED+acknowledged, APP to David Chen DELIVERED, APP to Maya PENDING.
3. **`msg_thread_stats` backfill** for the 3 seeded threads — message_count + last_message_at + last_message_preview computed from the existing `msg_messages` rows so the inbox renders correctly on first boot without waiting for the consumer.

**`seed-iam.ts` updates:**

- COM-003:read to all (Teacher / Parent / Student / Staff). COM-003:write to Staff (covers admin issuing alerts; School Admin and Platform Admin already inherit `:admin` via `everyFunction`).
- COM-004:read+write to Staff + Admin only (moderation policy + queue management — never granted to teachers, parents, students).

**Catalogue stays at 450** — COM-001 through COM-004 already exist in `permissions.json`.

---

## Step 4 — ThreadStatsConsumer + msg_thread_stats integration

**Status:** DONE on 2026-05-05.

**Files:** `apps/api/src/messaging/consumers/thread-stats.consumer.ts` (new), edit `apps/api/src/messaging/thread.service.ts` to read inbox preview from `msg_thread_stats`.

**ThreadStatsConsumer.** New Kafka consumer subscribed to `dev.msg.message.posted` under group `thread-stats-consumer`. Reuses the standard `unwrapEnvelope` + `processWithIdempotency` claim-after-success pattern. Per inbound event: `INSERT INTO msg_thread_stats (thread_id, school_id, message_count, last_message_at, last_message_preview, last_sender_id, updated_at) VALUES (...) ON CONFLICT (thread_id) DO UPDATE SET message_count = msg_thread_stats.message_count + 1, last_message_at = EXCLUDED.last_message_at, last_message_preview = EXCLUDED.last_message_preview, last_sender_id = EXCLUDED.last_sender_id, updated_at = now()`. The UPSERT preserves count idempotency only on first arrival per `event_id` (the Kafka claim is the dedup gate — redelivery returns from `processWithIdempotency` before reaching the worker body).

**ThreadService.list integration.** The existing `list` query returns the 4 most-recent message body chars via a `LEFT JOIN LATERAL` on `msg_messages` — fine for the demo but not partition-prune-friendly. Switch to LEFT JOIN on `msg_thread_stats` and read `last_message_preview` + `last_message_at` + `last_sender_id` directly. The LATERAL fallback stays in place for threads created before the consumer was online.

---

## Step 5 — EmergencyAlertService + AlertTypeService

**Status:** DONE on 2026-05-05.

**New module:** `apps/api/src/emergency-alerts/` with EmergencyAlertModule + EmergencyAlertService + AlertTypeService + EmergencyAlertController + AlertTypeController + DTO module. Wired into AppModule between AnnouncementsModule and the global guards. Imports TenantModule + IamModule + KafkaModule.

**Endpoints (~10):**

- `GET /messaging/alert-types` (every persona via `com-003:read`)
- `POST /messaging/alert-types` (admin via `com-004:write`)
- `PATCH /messaging/alert-types/:id` (admin)
- `GET /messaging/emergency-alerts` (school-active alerts; every persona via `com-003:read`; the persistent banner reads from here)
- `GET /messaging/emergency-alerts/:id` (with deliveries inlined for admins; non-admins see only their own delivery row)
- `POST /messaging/emergency-alerts` (admin via `com-003:write`; KEYSTONE — issues alert + fans out one delivery row per recipient × channel + emits `msg.emergency.issued` outside the tx)
- `PATCH /messaging/emergency-alerts/:id/resolve` (admin; flips ACTIVE → RESOLVED with `resolved_chk` lockstep on `resolved_at` + `resolved_by`)
- `POST /messaging/emergency-alerts/:id/deliveries/:deliveryId/acknowledge` (recipient marks their own delivery acknowledged; idempotent; row-scope check `delivery.recipient_id == actor.accountId`)
- `GET /messaging/emergency-alerts/:id/status` (admin; delivery + acknowledgement count rollup)

**Issue keystone.** `EmergencyAlertService.issue(input, actor)` runs in `executeInTenantTransaction`: validates the alert type exists, INSERTs the head row, resolves the recipient set per the alert type's `default_channels` (every active staff/student/guardian by default — same audience-resolution shape as `AudienceFanOutWorker.audienceAllSchool`), bulk-INSERTs `msg_emergency_alert_deliveries` rows with status=PENDING, then emits `msg.emergency.issued` AFTER tx commit so a Kafka hiccup cannot roll back the alert. The actual SMS / push / email send is stubbed in dev (the existing Cycle 3 `NotificationDeliveryWorker` pattern) — the deliveries land in PENDING and a future Phase 3 ops task wires real channel transports.

---

## Step 6 — Moderation Admin Review endpoints

**Status:** DONE on 2026-05-05.

**Files:** extend `apps/api/src/messaging/content-moderation.service.ts` with admin queue + review methods, add `apps/api/src/messaging/moderation.controller.ts`, add `apps/api/src/messaging/moderation-policy.service.ts`. All gated on `com-004:read` / `com-004:write`.

**New endpoints (~6):**

- `GET /messaging/moderation/policies` (admin lists every active policy across all 3 tiers — PLATFORM / DISTRICT / BUILDING — for this school)
- `POST /messaging/moderation/policies` (admin creates a building-tier policy; refuses PLATFORM / DISTRICT scope creation — those are seed-only)
- `PATCH /messaging/moderation/policies/:id` (admin updates building-tier `keywords` / `keyword_action` / `is_active`; refuses edit of PLATFORM / DISTRICT)
- `GET /messaging/moderation/queue` (admin lists messages with `moderation_status='FLAGGED'` joined to the most-restrictive matching `msg_moderation_log` row)
- `PATCH /messaging/moderation/log/:id/review` (admin sets `review_outcome` to `CONFIRMED_BLOCK` or `RELEASED`; RELEASED flips the parent message back to `moderation_status='APPROVED'` and stamps `reviewed_at`/`reviewed_by`)
- `GET /messaging/moderation/log` (admin paginated audit trail with optional `flag_type` / date-range filters)

The existing `ContentModerationService.evaluate` already writes the `msg_moderation_log` rows; Step 6 adds the read + admin-action surface on top.

---

## Step 7 — Messaging UI (carry-over from Cycle 3)

**Status:** DONE on 2026-05-05.

**No new UI in this step.** Cycle 3 Step 9 already shipped `/messages` (inbox), `/messages/[threadId]` (thread view with reply input + moderation feedback), and `/messages/new` (compose with thread-type picker + recipient search). The 9 messaging hooks in `apps/web/src/hooks/use-messaging.ts` cover every endpoint that the existing UI consumes. The "Messages" launchpad tile is already gated on `com-001:read` and visible to every persona.

**Carry-over note:** the existing Cycle 3 `ThreadDto.lastMessagePreview` is computed via LATERAL JOIN on `msg_messages` at read time. Step 4 of this cycle moves that read to `msg_thread_stats` (server-side change only) so the existing UI does not need to know — it keeps reading `lastMessagePreview` from the DTO.

---

## Step 8 — Emergency Alert Banner + Management UI

**Status:** DONE on 2026-05-05.

**New web surfaces.**

- **Persistent banner (`apps/web/src/components/notifications/EmergencyAlertBanner.tsx`)** — renders at the top of every `(app)` page when at least one ACTIVE `msg_emergency_alerts` row exists for the user that they have not yet acknowledged. Rose-tinted (`bg-rose-100 border-rose-700`), title + body + Acknowledge button calling the Step 5 `acknowledge` endpoint. Dismiss-proof until acknowledged. Polls `/messaging/emergency-alerts?status=ACTIVE` every 30 s and refetches on focus. The banner is placed in the shell so every authenticated route renders it.
- **`/messages/emergency-alerts`** — admin (gated on `sch-001:admin OR com-003:write`) management dashboard with two tabs (Active / History) and per-alert delivery stats card (sent / delivered / acknowledged counts). Issue-alert form modal: alert type picker, title, body, audience scope (school-wide for now). Resolve button on every ACTIVE alert.
- **`/messages/alert-types`** — admin CRUD on alert type catalogue.

---

## Step 9 — Admin Moderation UI

**Status:** DONE on 2026-05-05.

**New web surfaces** under `/messages/moderation/` — gated on `sch-001:admin OR com-004:read`.

- **`/messages/moderation`** — policy editor. Three sections grouped by tier: PLATFORM (read-only), DISTRICT (read-only this cycle), BUILDING (admin CRUD). Per-policy: keywords (chip array), action pill (BLOCK rose / FLAG_FOR_REVIEW amber / ESCALATE_TO_COUNSELLOR purple), Active/Inactive toggle. Create-policy modal for BUILDING-tier rows.
- **`/messages/moderation/queue`** — flagged-message review queue. Per-row: matched keywords, flagging policy, message body preview, sender + thread context, Release / Confirm Block buttons opening confirmation modals.
- **`/messages/moderation/log`** — paginated audit trail with `flag_type` / date-range filters. Per-row: timestamp, flag_type, message preview, matched keywords, review outcome (when reviewed) + reviewer name.

---

## Step 10 — Vertical Slice Integration Test

**Status:** DONE on 2026-05-05.

**CAT script target:** `docs/cycle14-cat-script.md` — schema preamble + 10 plan scenarios verified live on `tenant_demo`. Tag `cycle14-complete` after CI green. Cycle 14 is the **first cycle of Wave 3 (Communications & Community)**.

---

## REVIEW-CYCLE14 Round 1 fixes (2026-05-05)

Round 1 of REVIEW-CYCLE14-CHATGPT (against `cycle14-complete` at `9d76abd`) returned **Reject pending fixes**. Two BLOCKING issues on the messaging surface plus five MAJOR follow-ups. The fix commit closes both BLOCKING items + three of the five MAJORs in code; MAJORs 5 + 7 are recommendation-class and move to the Phase 2 punch list as items 18 + 19. Triage table + verification trail in `REVIEW-CYCLE14-CHATGPT.md`.

**(BLOCKING 1 — moderation contract) `MessageService.list()` returned FLAGGED + ESCALATED + BLOCKED messages to recipients before moderator review.** The Cycle 14 vertical-slice contract says "admin reviews the flagged message queue and releases a previously FLAGGED message" — implying flagged messages should be held pending moderation. The pre-fix list query had no moderation_status filter so flagged content reached recipients before any review action. Fix: `list()` now appends `AND (m.moderation_status = 'APPROVED' OR m.sender_id = $N::uuid)` for non-admin readers. FLAGGED + ESCALATED + BLOCKED messages stay hidden until the moderator's `PATCH /messaging/moderation/log/:id/review` with outcome=RELEASED flips the parent message back to APPROVED — at which point the recipient's next list call returns it. The original sender continues to see their own pending-moderation message (so they get the "your message is being reviewed" UX rather than thinking their message vanished). School admins bypass the filter so the moderation queue sees every message regardless of status.

**(BLOCKING 2 — privacy leak) `MessageService.edit()` + `softDelete()` returned 403 for non-participant callers, leaking message existence.** A user with `com-001:write` who guessed a UUID could distinguish "nonexistent" (404) from "exists in someone else's private thread" (403). Fix: both methods now call `threads.isActiveParticipant(thread_id, actor.accountId)` before the sender / admin check; non-participant non-admin callers receive a collapsed `404 NotFoundException` matching the row-scope-don't-leak-existence pattern from REVIEW-CYCLE13 BLOCKING 2 + REVIEW-CYCLE10. Sender editing own message inside the 15-min window still works (sender is implicitly a participant). Admin deleting any message still works (admin bypass). Participant-but-not-sender attempting to edit still returns 403 ("Only the original sender may edit this message").

**(MAJOR 3 — audience scope) `EmergencyAlertService.issue()` audience query unioned PLATFORM-scope users into every school's alert fan-out.** The pre-fix `WHERE st.name IN ('SCHOOL', 'PLATFORM') AND (sc.scope_ref_id = $1 OR st.name = 'PLATFORM')` meant Platform Admin accounts received emergency deliveries for every tenant they could reach. Fix: tightened to `WHERE st.name = 'SCHOOL' AND sc.scope_ref_id = $1` so emergency alerts default to school-affiliated recipients only. Cross-tenant Platform Admin notification can be re-introduced as an explicit `includePlatformAdmins` option once a real-school operator workflow needs it; for the demo + pilot baseline, school emergencies stay school-affiliated.

**(MAJOR 4 — count accuracy) `deliveryCount` incremented inside the loop regardless of whether `ON CONFLICT DO NOTHING` actually inserted a row.** With fresh `alertId` per call this was rare, but a future deterministic-id retry path that hit existing tuples would have over-reported the delivery surface in the emitted `msg.emergency.issued` payload. Fix: INSERT switched to `RETURNING id` and the loop body increments `deliveryCount` only when the row was actually inserted.

**(MAJOR 6 — permission contract alignment) `ModerationService.assertAdmin()` requires `actor.isSchoolAdmin` but `seed-iam.ts` granted COM-004 to the Staff role.** Staff with `com-004:write` would still hit a 403 at the service layer — the gate and the service contract disagreed. Fix: removed the COM-004 grant from the Staff spec in `seed-iam.ts` + DELETE'd the 2 stale role-permission rows for Staff (`com-004:read`, `com-004:write`) directly from the DB so the live IAM cache (VP/Counsellor 69 → 67 perms) matches the service contract. A comment in `seed-iam.ts` documents the locked product decision: moderation policy + queue + log are admin-only until the AD/role-split pre-pilot work introduces a dedicated Moderator role.

**(MAJOR 5 — DEFERRED) `msg_thread_stats` does not update on `msg.message.edited` / `msg.message.deleted`.** Recommendation-class. Today's `ThreadStatsConsumer` only listens on `msg.message.posted`; edits to the most-recent message and soft-deletes don't propagate, so the inbox preview can drift on the sender's own most recent message until the next `posted` event lands. The pre-pilot fix is described in CLAUDE.md punch list item 18: emit `msg.message.edited` + `msg.message.deleted` from `MessageService.edit()` + `softDelete()`; extend `ThreadStatsConsumer` to recompute stats from `msg_messages` (`MAX(created_at)` + `LEFT(body,100)` + `COUNT WHERE deleted_at IS NULL`) instead of a simple increment.

**(MAJOR 7 — DEFERRED) Emergency alert list returns alert headers to non-recipients.** Recommendation-class. Today's school-wide emit makes every active school user a recipient by construction so the `myDelivery=null` rows the reviewer flagged only happen when audience resolution missed the user (a configuration concern, not a leak). When audience targeting lands (Phase 2 — routes via M61 Transportation, year groups, classes, custom lists), the non-admin list path must filter to alerts where the caller has a `msg_emergency_alert_deliveries` row. Documented as CLAUDE.md punch list item 19.

**Live verification on `tenant_demo` 2026-05-05.** All five code-level fixes verified end-to-end:

- BLOCKING 1 — Rivera posts a message containing the BUILDING-tier ESCALATE_TO_COUNSELLOR keyword "suicide" → message persists with `moderation_status='ESCALATED'`. David Chen's `GET /threads/:threadId/messages` now omits the ESCALATED row. Admin RELEASES via `PATCH /messaging/moderation/log/:id/review` → parent message flips to APPROVED → David's next list call returns it. Rivera (sender) sees his own pending-moderation message throughout. School admin sees every message regardless of status.
- BLOCKING 2 — `PATCH /messages/<random-uuid>` → 404 (was: 403). Real message in a non-participant thread → 404 (was: 403). Sender editing own message inside the 15-min window → 200. Admin delete → 200. Participant-but-not-sender attempting to edit → 403.
- MAJOR 3 — Pre-fix audience COUNT included every Platform Admin across the deployment; post-fix audience for `tenant_demo` includes only school-affiliated users (principal / teacher / student / parent / vp / counsellor).
- MAJOR 4 — Re-running `issue()` with the same `alertId` (synthetic test only) returns deliveryCount=0 since every `(alert_id, recipient_id, channel)` triple already exists. `SELECT COUNT(*) FROM msg_emergency_alert_deliveries WHERE alert_id = $1` matches the emitted payload's `deliveryCount`.
- MAJOR 6 — `iam_effective_access_cache` shows VP/Counsellor at **67 perms** (was 69, -2 stale `com-004:*`). Re-running `pnpm seed-iam` produces 0 newly-added rows. Teacher / Parent / Student counts unchanged at 54 / 27 / 28.

Build clean (`pnpm --filter @campusos/api build`); `pnpm format:check` clean; unit tests pass (7/7).

---

## Cycle 14 Completion Criteria

1. Tenant schema: 3 new tables (1 thread stats + 2 emergency alerts) + 3 column additions to existing `msg_announcements`. Tenant table count: 203 → ~206.
2. Messaging API: ~10 new endpoints (emergency alerts + admin moderation). Existing Cycle 3 surface preserved.
3. Three-tier content moderation: admin queue + log + policy editor all reachable.
4. Emergency alerts with multi-channel delivery + acknowledgement tracking + persistent dismiss-proof banner.
5. `msg.emergency.issued` Kafka emit. ThreadStatsConsumer on `msg.message.posted` upserts `msg_thread_stats`.
6. HANDOFF-CYCLE14.md and CLAUDE.md updated. CI green.
7. **Wave 3 open.**
