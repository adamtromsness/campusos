# REVIEW-CYCLE14-CHATGPT

**Round 1 verdict:** **Reject pending fixes** (against `cycle14-complete` at `9d76abd`).

The reviewer flagged 2 BLOCKING issues on the messaging surface (FLAGGED visibility + edit/delete row-scope leak) plus 5 MAJOR follow-ups (emergency fan-out audience scope, deliveryCount accuracy, msg_thread_stats drift on edit/delete, COM-004 grant vs assertAdmin contract, alert-headers-to-non-recipients). All actionable items either fixed in code in the closeout fix commit (`b36ffc8`, live-verified on `tenant_demo` 2026-05-05) or documented as Phase 2 backlog items. MAJORs 5 + 7 are recommendation-class and require new event types / audience targeting — they move to the Wave 3 Phase 2 punch list.

**Round 2 verdict:** **Approved** (against `b36ffc8`, 2026-05-05). Reviewer confirmed both BLOCKING findings are closed in code (`MessageService.list()` filter + `edit()`/`softDelete()` participant-first row-scope) plus the three code-level MAJOR follow-ups (emergency fan-out audience scope, deliveryCount RETURNING accuracy, Staff COM-004 grant aligned with `assertAdmin()`). MAJORs 5 + 7 correctly carried as Phase 2 punch list items 18 + 19 (`msg_thread_stats` recompute on edit/delete + audience-targeted alert list filtering). **Cycle 14 ships clean. Wave 3 (Communications & Community) is now open.**

Tag chain:

- `cycle14-complete` on `9d76abd` (original closeout commit + first CAT)
- `cycle14-approved` on `b36ffc8` (Round 2 APPROVED, after the fix commit)

---

## Triage table

| #   | Severity | File                                                           | Reviewer claim                                                                                                                                                   | Triage           | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | BLOCKING | `apps/api/src/messaging/message.service.ts`                    | `MessageService.list()` returns FLAGGED + ESCALATED + BLOCKED messages to non-sender recipients before moderator review.                                         | VALID            | `list()` now appends `AND (m.moderation_status = 'APPROVED' OR m.sender_id = $N::uuid)` for non-admin readers. Sender continues to see their own pending-moderation message; recipients only see APPROVED messages. ContentModerationService's RELEASED action already flips the parent message back to APPROVED so a released message becomes visible immediately. School admins bypass the filter so the moderation queue sees everything.                  |
| 2   | BLOCKING | `apps/api/src/messaging/message.service.ts`                    | `edit()` + `softDelete()` return 403 for non-participant callers, leaking message existence.                                                                     | VALID            | Both methods now call `threads.isActiveParticipant(thread_id, actor.accountId)` before the sender / admin check. Non-participant non-admin callers receive a collapsed `404 NotFoundException` matching the pattern from REVIEW-CYCLE13 BLOCKING 2 + REVIEW-CYCLE10 row-scope.                                                                                                                                                                                |
| 3   | MAJOR    | `apps/api/src/emergency-alerts/emergency-alert.service.ts`     | `EmergencyAlertService.issue()` audience query unions PLATFORM-scope users into every school's alert fan-out.                                                    | VALID            | Audience query tightened to `WHERE st.name = 'SCHOOL' AND sc.scope_ref_id = $1::uuid` only. Cross-tenant Platform Admin notification can be re-introduced as an explicit `includePlatformAdmins` option once a real-school operator workflow needs it; for the demo + pilot baseline, school emergencies stay school-affiliated.                                                                                                                              |
| 4   | MAJOR    | `apps/api/src/emergency-alerts/emergency-alert.service.ts`     | `deliveryCount` increments inside the loop regardless of whether `ON CONFLICT DO NOTHING` actually inserted a row.                                               | VALID            | INSERT switched to `RETURNING id`; the loop body increments `deliveryCount` only when the row was actually inserted. With fresh `alertId` per call this is rare today, but a future deterministic-id retry path now gets accurate counts.                                                                                                                                                                                                                     |
| 5   | MAJOR    | `apps/api/src/messaging/consumers/thread-stats.consumer.ts`    | `msg_thread_stats` does not update on `msg.message.edited` / `msg.message.deleted`; the inbox preview can drift on edit + delete.                                | VALID — DEFERRED | Recommendation-class. Requires emitting two new Kafka topics (`msg.message.edited`, `msg.message.deleted`) AND updating ThreadStatsConsumer to recompute stats from `msg_messages` on edit/delete (the simple increment pattern is correct for post but not for retract). Documented in CLAUDE.md punch list as item 18. Today's inbox preview accepts a small staleness window when a sender edits or deletes their most recent message.                     |
| 6   | MAJOR    | `apps/api/src/messaging/moderation.service.ts` + `seed-iam.ts` | `ModerationService.assertAdmin()` requires `actor.isSchoolAdmin` but the seed grants COM-004 to Staff, so a non-admin Staff with COM-004:write still gets a 403. | VALID            | Removed COM-004 from the Staff role spec in `seed-iam.ts` + DELETEd the existing 2 stale role-permission rows for Staff (`com-004:read`, `com-004:write`) so the live IAM cache now matches the service contract. Comment in `seed-iam.ts` documents the locked product decision: moderation policy + queue + log are admin-only until the AD/role-split pre-pilot work introduces a dedicated Moderator role.                                                |
| 7   | MAJOR    | `apps/api/src/emergency-alerts/emergency-alert.service.ts`     | `list()` returns alert headers to non-recipients with `myDelivery=null`; future audience-targeted alerts would leak existence/content.                           | VALID — DEFERRED | Recommendation-class. The Cycle 14 plan ships only school-wide alerts so every active school user is a recipient by construction; `myDelivery=null` on the list response only happens when audience resolution missed the user (a configuration concern, not a leak today). When audience targeting lands (Phase 2 routes / years / classes / custom), the list path needs to filter to `EXISTS (myDelivery)`. Documented in CLAUDE.md punch list as item 19. |

---

## Verification

After the fix commit, all five code-level changes were live-verified against `tenant_demo`:

- **BLOCKING 1.** Rivera posts a message containing the BUILDING-tier ESCALATE_TO_COUNSELLOR keyword "suicide" → message persists with `moderation_status='ESCALATED'` + `msg_moderation_log` row. David Chen's `GET /threads/:threadId/messages` now omits the ESCALATED row. After admin RELEASES via `PATCH /messaging/moderation/log/:id/review` the parent message flips back to APPROVED and David's next list call returns it. Rivera (the sender) continues to see his own pending-moderation message throughout. School admin sees every message regardless of status.
- **BLOCKING 2.** Synthetic UUID lookup: Rivera tries `PATCH /messages/<random-uuid>` → 404 Not Found (was: 403 leaking existence). Real message in a thread Rivera is not a participant of: `PATCH /messages/<existing-id>` → 404 (was: 403). Sender editing own message inside the 15-min window: still 200. Admin deleting any message: still 200. Participant-but-not-sender attempting to edit: still 403 ("Only the original sender may edit").
- **MAJOR 3.** Pre-fix audience COUNT included every Platform Admin across the deployment (admin@ accounts on test + demo). Post-fix audience COUNT for an alert issued on `tenant_demo` includes only school-affiliated users (`principal@`, `teacher@`, `student@`, `parent@`, `vp@`, `counsellor@`). Cross-tenant accounts no longer receive school-emergency deliveries.
- **MAJOR 4.** Post-fix issue path correctly counts inserted rows. Re-running issue with the same `alertId` (synthetic test only — production uses fresh UUIDv7 per call) returns deliveryCount=0 since every `(alert_id, recipient_id, channel)` triple already exists. Verified via `SELECT COUNT(*) FROM msg_emergency_alert_deliveries WHERE alert_id = $1` matching the emitted payload's `deliveryCount`.
- **MAJOR 6.** `iam_effective_access_cache` shows VP / Counsellor at **67 perms** (was 69 — the 2 stale `com-004:*` grants removed). Re-running the IAM seed produces no new role-permission rows. Teacher / Parent / Student counts unchanged at 54 / 27 / 28.

Build clean (`pnpm --filter @campusos/api build`); `pnpm format:check` clean; unit tests pass (7/7).

---

## Phase 2 / pre-pilot punch list additions

Two recommendation-class follow-ups are added to CLAUDE.md as items 18 + 19:

- **Item 18 — `msg_thread_stats` recompute on edit/delete**: emit `msg.message.edited` + `msg.message.deleted` Kafka topics from `MessageService.edit()` + `softDelete()`; extend ThreadStatsConsumer to recompute `last_message_at`/`last_message_preview`/`message_count` from `msg_messages` (using `MAX` + `LEFT(body,100)` + `COUNT`) instead of a simple increment. Today's inbox accepts a small staleness window on the sender's own most-recent message when they edit or delete it. Pre-pilot polish.
- **Item 19 — Audience-targeted emergency alert list filtering**: when emergency alerts gain audience targeting (Phase 2 — routes / year groups / classes / custom lists), `EmergencyAlertService.list()` must filter the non-admin path to alerts where the caller has a `msg_emergency_alert_deliveries` row. Today's school-wide emit makes every active user a recipient by construction so the leak is theoretical; pre-pilot polish.

---

## Reviewer Round 2 verdict (2026-05-05)

> **Approved.**
>
> I reviewed the fix commit `b36ffc8` directly against the two blocking findings and the major follow-ups from Round 1. The two blockers are fixed, and the code-level major findings that were selected for Cycle 14 closeout are also addressed.
>
> **Confirmed fixes**
>
> 1. **Flagged/escalated message visibility — fixed.** `MessageService.list()` now hides non-approved messages from normal non-admin participants unless the caller is the sender. Non-admin readers get only messages where `m.moderation_status = 'APPROVED' OR m.sender_id = actor.accountId`. The sender can still see their own pending moderation message, school admins can still review everything, but recipients do not see FLAGGED, ESCALATED, or BLOCKED content before release. The moderation release action flips the parent message back to APPROVED, making it visible after review. **Blocker closed.**
> 2. **Message edit/delete UUID probing — fixed.** `edit()` and `softDelete()` now check whether the actor is an active participant in the parent thread before applying sender/admin authorization. Non-participant, non-admin callers receive a collapsed 404 Not Found, rather than 403. Participant-but-not-sender still receives 403, which is appropriate because they are already allowed to know the message exists. **Blocker closed.**
> 3. **Emergency fan-out audience scope — fixed.** `EmergencyAlertService.issue()` now resolves recipients only from active role assignments scoped to the issuing school. The previous PLATFORM-scope inclusion path is gone. **Major follow-up closed.**
> 4. **Emergency delivery count accuracy — fixed.** Emergency delivery insertion now uses `RETURNING id`, and `deliveryCount` increments only when the delivery row was actually inserted. **Major follow-up closed.**
> 5. **Moderation permission contract — fixed.** Stale COM-004 Staff grants were removed and the product decision is now explicit: moderation policy, queue, and log are admin-only until a dedicated Moderator role is introduced. **Major follow-up closed.**
>
> **Accepted Phase 2 follow-ups**
>
> Two items are appropriately deferred: `msg_thread_stats` recompute on edit/delete (requires new `msg.message.edited` + `msg.message.deleted` events + recompute logic) and audience-targeted emergency-alert list filtering (lands when alerts support non-schoolwide audiences). Both documented as Phase 2 / pre-pilot punch-list items 18 + 19.
>
> **Final Gate Decision: Approved.** Cycle 14 is clean from my review perspective.
