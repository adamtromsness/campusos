# REVIEW-CYCLE18-CHATGPT

**Round 1 verdict:** _pending_ (against `cycle18-complete` at `7e7f33a`).

This file is the scaffold for the Cycle 18 (Groups & Communities) post-cycle architecture review. It will fill in once the review is run. The shape mirrors `REVIEW-CYCLE17-CHATGPT.md` — a triage table per finding (severity / file / claim / triage / resolution), a Round 2 verdict block, and a tag chain.

Tag chain:

- `cycle18-complete` on `7e7f33a` (original closeout commit + first CAT — Wave 3 closes here)
- `cycle18-approved` (after Round 2 verdict)

---

## What the reviewer should look at

Cycle 18 ships M103 Groups & Communities — universal community fabric layer in a clean greenfield `grp_*` namespace. The cycle has three structural keystones the reviewer should verify in code:

1. **Two-party ownership transfer handshake.** `OwnershipTransferService.accept` opens a tenant transaction, locks the transfer row + both `grp_members` rows with `FOR UPDATE`, demotes the from-member to ADMIN and promotes the to-member to OWNER, and stamps the transfer ACCEPTED + `responded_at = now()` per the multi-column `responded_chk` lockstep — all four updates inside one tx. Partial UNIQUE(group_id) WHERE status='PENDING' caps pending transfers at one per group; `isUniqueViolation` translates 23505 to a friendly 400. Verify the tx ordering, the recipient binding (only the `to_member`'s `person_id` can accept), and the expiry check.

2. **Scope-aware bindings.** `grp_groups.scope_type` is a 5-value CHECK (CLASS / YEAR_GROUP / SCHOOL / CUSTOM / ACTIVITY); multi-column `scope_pair_chk` enforces SCHOOL/CUSTOM with `scope_id IS NULL` and CLASS/YEAR_GROUP/ACTIVITY with `scope_id IS NOT NULL`. The application layer resolves `scope_id` to the matching tenant table at read time. `GroupService.create` validates the supplied `scope_id` matches an existing row in the right tenant table. Cycle 17's `ext_activities.group_id` soft FK closes the resolution loop.

3. **Re-join semantics.** Partial UNIQUE(group_id, person_id) WHERE status<>'LEFT' on `grp_members` allows leave-and-rejoin without rejecting the new row. Multi-column `left_chk` keeps `left_at` populated only when status='LEFT'. The 6-state lifecycle (ACTIVE / INVITED / PENDING_APPROVAL / SUSPENDED / LEFT / REMOVED) covers every transition the join-policy + admin-action matrix needs.

## Surface to review

- **Schema:** `packages/database/prisma/tenant/migrations/061_grp_groups_members.sql` + `062_grp_announcements_events.sql`. 8 tables; 9 intra-tenant FKs (5 + 4); 0 cross-schema FKs. Verify the multi-column CHECKs (`scope_pair_chk`, `responded_chk`, `left_chk`, `dates_chk`, `rsvp_window_chk`, `max_chk`, `window_chk` on announcements) and the partial UNIQUE / partial INDEX patterns.

- **Backend:** `apps/api/src/groups/`. 5 services + 1 controller + DTO module + 30 endpoints. Manager scope = school admin OR caller is OWNER/ADMIN of the specific group via `GroupService.assertCanManageGroup`. Reader scope on announcements = active members + admin. Reader scope on events = members for non-public; anyone with group visibility for public. Two Kafka emit topics (`grp.announcement.posted`, `grp.event.created`) wrapped in the standard ADR-057 envelope; emits fire AFTER the tenant tx commits.

- **Permissions:** `GRP-001` added (Groups & Communities). 150 → 151 functions × 3 tiers = 453. Teacher / Student / Parent / Staff each gain `GRP-001:read+write`; Admin via everyFunction.

- **Web:** `Groups` launchpad tile + 4 routes (`/groups`, `/groups/[id]`, `/groups/my`, `/groups/feed`) + 25 React Query hooks. Detail page has 4 tabs (Announcements / Events / Members / Transfers).

- **CAT:** `docs/cycle18-cat-script.md`. 8 plan scenarios with inline-captured live output per scenario; both ADR-057 envelopes captured live; cleanup section restores tenant to post-Step-3 seed shape.

## Open follow-ups (non-blocking — Phase 2 polish)

1. **Notification fan-out on group emits.** `grp.announcement.posted` and `grp.event.created` land cleanly but no Cycle 3 NotificationQueueService consumer fans them out to member inboxes per the `grp_member_notification_prefs.notify_announcements / notify_events` toggles yet. Phase 2 wiring.
2. **Auto-dissolve sweep.** `grp_groups.auto_dissolve_at` is set on Spring Concert Volunteers but no cron flips status to `DISSOLVED` when the timestamp passes. Schema-side partial INDEX is ready.
3. **Activity → group binding back-reference UI.** Cycle 17's `ext_activities.group_id` soft FK closes the loop; the Step 7 UI on `/clubs/activities/[id]` could surface a `Group community →` link. Phase 2 polish.
4. **Group invite admin UI.** Hooks (`useInviteMember`, `useApproveJoin`, `useDenyJoin`) are wired but the per-row Invite + Approve modals on the Members tab are not yet built out. Phase 2.

---

## Triage table

_(populated after Round 1 review)_

| #   | Severity | File | Reviewer claim | Triage | Resolution |
| --- | -------- | ---- | -------------- | ------ | ---------- |
|     |          |      |                |        |            |

---

## Round 1 fixes

_(populated after Round 1 review + fix commit)_

## Round 2 verdict

_(populated after Round 2 review)_
