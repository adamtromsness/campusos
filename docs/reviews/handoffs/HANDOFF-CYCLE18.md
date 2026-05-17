# Cycle 18 Handoff — Groups & Communities

**Status:** Cycle 18 **COMPLETE + APPROVED at `f091de6`** (REVIEW-CYCLE18-CHATGPT Round 2 verdict). Round 1 against `cycle18-complete` at `7e7f33a` returned Reject pending fixes (4 BLOCKING + 6 MAJOR); Round 2 against `f091de6` returned Approved after all 4 BLOCKING + 2 code-level MAJORs landed in fix commit; MAJORs 7–10 carried as Phase 2 punch list items 26–29. **Wave 3 closes here.** All 8 steps shipped; vertical-slice CAT at `docs/cycle18-cat-script.md` verified live on `tenant_demo` 2026-05-06; both ADR-057 wire envelopes captured live (`grp.announcement.posted`, `grp.event.created`); the **two-party ownership transfer handshake** verified end-to-end with atomic role swap inside one tenant tx; the **scope-aware bindings** proven through CLASS / YEAR_GROUP / SCHOOL / CUSTOM / ACTIVITY scope variants; the **re-join semantics** verified through the partial UNIQUE(group_id, person_id) WHERE status<>'LEFT' index. **Cycle 18 closes Wave 3 (Communications & Community).** Final cycle totals: 8 grp\_\* base tables (tenant base table count 239 → **247**); 9 intra-tenant FKs (5 + 4); 0 cross-schema FKs; 30 endpoints across 5 services + 1 controller; 2 Kafka emit topics; 1 new permission code (GRP-001 — catalogue 150 → **151 functions × 3 tiers = 453**); 4 new web routes + a new `Groups` launchpad tile.

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle18-implementation-plan.html`
**Vertical-slice deliverable:** Mitchell creates "Grade 5 Parents" YEAR_GROUP APPROVAL_REQUIRED → David Chen requests to join → Mitchell approves → Rivera creates "Chess Club Community" (ACTIVITY, OPEN, scope_id linked to Cycle 17 Chess Club via the `ext_activities.group_id` soft FK back-reference) → Maya, Rivera, and Mitchell are members → Rivera (OWNER) posts the pinned "Tournament Registration Open" announcement → Maya marks read → Rivera creates "Inter-School Chess Tournament" event with `max_attendees=16` and `requires_rsvp=true` → Rivera initiates ownership transfer to Mitchell with 7-day expiry → Mitchell accepts → atomic role swap (Rivera→ADMIN, Mitchell→OWNER) inside one tenant tx → admin creates a temporary "Spring Concert Volunteers" CUSTOM group with `auto_dissolve_at = today + 60 days`.

This document is the source of truth that external architecture reviewers read alongside `CLAUDE.md`.

---

## Step status

| Step | Title                                    | Status   |
| ---- | ---------------------------------------- | -------- |
| 1    | Groups + Members + Ownership Schema      | Complete |
| 2    | Announcements + Events Schema            | Complete |
| 3    | Seed Data + GRP Permissions              | Complete |
| 4    | Groups + Membership NestJS Module        | Complete |
| 5    | Announcements + Events NestJS Module     | Complete |
| 6    | Groups UI — Browse + Manage + Membership | Complete |
| 7    | Groups UI — Announcements + Events       | Complete |
| 8    | Vertical Slice Integration Test          | Complete |

---

## What this cycle adds on top of Cycle 17

**Greenfield — clean `grp_*` namespace.** Cycle 18 ships the entire M103 Groups & Communities module from scratch.

- **8 new tenant base tables** across 2 migrations (061 + 062): `grp_groups`, `grp_members`, `grp_member_notification_prefs`, `grp_ownership_transfers`, `grp_announcements`, `grp_announcement_reads`, `grp_events`, `grp_event_rsvps`. Tenant base table count 239 → **247**.
- **1 new backend module** (GroupsModule) with 5 services (GroupService + MembershipService + OwnershipTransferService + GroupAnnouncementService + GroupEventService) + 1 GroupsController + ~30 endpoints under `grp-001:read/write/admin`.
- **2 new Kafka emit topics**: `grp.announcement.posted` (group announcement published) + `grp.event.created` (group event scheduled).
- **4 new web routes**: `/groups` browse + create, `/groups/[id]` detail with announcements + events + members + transfers tabs, `/groups/my` aggregated memberships, `/groups/feed` upcoming RSVPs across all groups.
- **1 new permission code**: `GRP-001` ("Groups & Communities") added to `permissions.json`. Catalogue 150 → **151 functions × 3 tiers = 453 codes**. GRP-001:read+write granted to Teacher / Student / Parent / Staff. Admin gets all three tiers via everyFunction.

**Three structural keystones for the cycle:**

1. **Two-party ownership transfer handshake** — `grp_ownership_transfers` carries `from_member_id + to_member_id + status + initiated_at + expires_at`. **Partial UNIQUE(group_id) WHERE status='PENDING'** caps pending transfers at one per group. On ACCEPT, `OwnershipTransferService.accept` opens a tenant transaction, locks the transfer row + both grp_members rows with `FOR UPDATE`, demotes the from-member to ADMIN and promotes the to-member to OWNER, stamps the transfer ACCEPTED + `responded_at = now()` per the multi-column `responded_chk` lockstep — all four updates inside one tx so a failure rolls back the entire handshake. The 7-day expiry default is enforced both at write time (`expires_at` defaulted forward by service) and during accept (expired transfers refused with 400).
2. **Scope-aware group bindings** — `grp_groups.scope_type` is a 5-value CHECK (CLASS / YEAR_GROUP / SCHOOL / CUSTOM / ACTIVITY) + `scope_id` soft polymorphic UUID. Multi-column `scope_pair_chk` enforces SCHOOL/CUSTOM with `scope_id IS NULL` and CLASS/YEAR_GROUP/ACTIVITY with `scope_id IS NOT NULL`. The application layer resolves `scope_id` to the matching tenant table at read time (`sis_classes` for CLASS, `sis_academic_years` for YEAR_GROUP, `ext_activities` for ACTIVITY) and the Step 4 `GroupService.create` pre-flight validates the supplied scope_id matches an existing row in the right table. Cycle 17's `ext_activities.group_id` soft FK closes the resolution loop in the other direction.
3. **Membership re-join semantics via partial UNIQUE** — `grp_members` has **partial UNIQUE(group_id, person_id) WHERE status != 'LEFT'** so a person can leave (status flips to LEFT, partial UNIQUE drops the row from the index) and re-join (fresh row inserts cleanly). The 6-state lifecycle (ACTIVE / INVITED / PENDING_APPROVAL / SUSPENDED / LEFT / REMOVED) covers every transition the join-policy + admin-action matrix needs, with multi-column `left_chk` keeping `left_at` populated only when `status = 'LEFT'`.

**Existing-system touchpoints:**

- `iam_person(id)` — soft refs on `grp_announcements.author_id`, `grp_events.created_by`, `grp_announcement_reads.reader_id`, `grp_event_rsvps.responder_id` per ADR-001/020.
- `platform_users(id)` — soft FK on `grp_groups.created_by`, `grp_members.person_id`, `grp_members.invited_by`.
- `ext_activities(id)` — soft polymorphic FK on `grp_groups.scope_id` when `scope_type='ACTIVITY'` (closes the loop with Cycle 17's `ext_activities.group_id`).
- `sis_classes(id)` — soft polymorphic FK when `scope_type='CLASS'`.
- `sis_academic_years(id)` — soft polymorphic FK when `scope_type='YEAR_GROUP'`.

What does not change: every existing module continues to function. Cycle 18 is purely additive on a clean `grp_*` namespace.

---

## Step 1 — Groups + Members + Ownership Schema (complete)

**Migration:** `packages/database/prisma/tenant/migrations/061_grp_groups_members.sql`. 4 logical base tables.

- `grp_groups` — 5-value `scope_type` CHECK + 3-value `status` CHECK + 3-value `join_policy` CHECK + multi-column `scope_pair_chk` (SCHOOL/CUSTOM ⇒ scope_id NULL; CLASS/YEAR_GROUP/ACTIVITY ⇒ scope_id NOT NULL). Partial INDEX `(auto_dissolve_at) WHERE auto_dissolve_at IS NOT NULL AND status='ACTIVE'` for the future Phase 3 dissolve sweep.
- `grp_members` — 3-value `member_role` CHECK (OWNER/ADMIN/MEMBER), 6-value `status` CHECK, multi-column `left_chk` (LEFT ⇒ left_at NOT NULL; non-LEFT ⇒ left_at NULL), partial UNIQUE(group_id, person_id) WHERE status<>'LEFT' (re-join semantics keystone), partial INDEX(person_id) WHERE status='ACTIVE' for the my-groups hot path, partial INDEX(group_id, member_role) WHERE OWNER/ADMIN for the manager roster lookup.
- `grp_member_notification_prefs` — UNIQUE(membership_id) so 1-to-1 with member; 5-value `preferred_channel` CHECK (IN_APP / EMAIL / PUSH / ALL / NONE).
- `grp_ownership_transfers` — TWO-PARTY HANDSHAKE keystone. 5-value `status` CHECK + multi-column `responded_chk` (PENDING ⇒ responded_at NULL; terminal ⇒ NOT NULL), `window_chk` (expires_at > initiated_at), `distinct_chk` (from_member_id <> to_member_id), partial UNIQUE(group_id) WHERE status='PENDING' (caps pending at one per group). NO ACTION FKs on from/to member ids preserve audit when a member is removed during a pending transfer.

**5 new intra-tenant FKs**: 1 CASCADE members→groups, 1 CASCADE prefs→members, 1 CASCADE transfers→groups, 2 NO ACTION transfers→members. 0 cross-schema FKs.

**Splitter trap caught + fixed pre-provision** — Python audit script flagged 1 stray `;` inside the block-comment header (`; SCHOOL and CUSTOM leave scope_id NULL`); rewritten with em-dash. Provisioned cleanly on first attempt after audit. **Live verification on `tenant_demo` (single BEGIN…ROLLBACK with savepoints, 13 assertions all green):** every CHECK rejects bogus values (scope_type, status, join_policy, member_role, member status, transfer status); scope_pair_chk rejects all 4 mismatch directions; left_chk rejects both directions of the lockstep mismatch; responded_chk rejects PENDING-with-respondedAt and ACCEPTED-without-respondedAt; window_chk rejects expires_at <= initiated_at; distinct_chk rejects from=to; partial UNIQUE on members rejects 2nd ACTIVE row + accepts a fresh INSERT after the first row flips to LEFT (the keystone); partial UNIQUE on transfers rejects 2nd PENDING row for same group + accepts after the first flips to ACCEPTED/CANCELLED; CASCADE on group delete drops members + prefs + transfers in one statement.

---

## Step 2 — Announcements + Events Schema (complete)

**Migration:** `packages/database/prisma/tenant/migrations/062_grp_announcements_events.sql`. 4 logical base tables.

- `grp_announcements` — `author_id` soft to `platform.iam_person`; `pinned BOOLEAN` + partial INDEX(group_id, pinned) WHERE pinned=true for the pinned-first feed; `attachments JSONB` for forward-compat with Cycle 14 messaging attachments; `window_chk` (expires_at IS NULL OR expires_at > publish_at).
- `grp_announcement_reads` — append-only read receipts; UNIQUE(announcement_id, reader_id) so a reader counts at most once per announcement; CASCADE on parent announcement.
- `grp_events` — 7-value `event_type` CHECK (PRACTICE/MATCH/MEETING/SOCIAL/PERFORMANCE/COMPETITION/OTHER); `dates_chk` (ends_at NULL OR >= starts_at); `rsvp_window_chk` (rsvp_deadline NULL OR <= starts_at); `max_chk` (max_attendees NULL OR > 0); `is_public BOOLEAN` flips visibility to non-members.
- `grp_event_rsvps` — 3-value `status` CHECK (GOING/NOT_GOING/MAYBE); UNIQUE(event_id, responder_id) so a respondent has exactly one RSVP per event; PATCH replaces via `ON CONFLICT … DO UPDATE`. **Decision documented:** the plan's 7-table count omits this link table but Cycle 18 ships it because per-RSVP audit is a real requirement that the parent table can't satisfy. **Adjusted total: 8 tables across 2 migrations.**

**4 new intra-tenant FKs** all CASCADE (announcements→groups, reads→announcements, events→groups, rsvps→events). 0 cross-schema FKs.

**Cycle 18 schema phase total:** 8 grp\_\* tables, 9 intra-tenant FKs (5 + 4), 0 cross-schema FKs. Tenant base table count: 239 → **247**.

**Splitter trap caught + fixed pre-provision** — Python audit script flagged 3 stray `;` instances (1 inside block-comment header, 2 inside `COMMENT ON TABLE` strings); rewritten with periods + em-dashes + "and" before any provision attempt. Provisioned cleanly on second attempt. Idempotent re-provision verified (zero new applies on second run); both `tenant_demo` and `tenant_test` provisioned cleanly. **Twenty-third migration in a row to clear the splitter trap on first attempt after audit** (Cycles 4–18 unbroken streak).

---

## Step 3 — Seed Data + GRP Permissions (complete)

**`packages/database/src/seed-groups.ts`** (idempotent, gated on `grp_groups` row count for the demo school) wired as `seed:groups`. 6 sections seeded on `tenant_demo`:

- **A) 3 groups**: "Grade 5 Parents" (YEAR_GROUP, APPROVAL_REQUIRED, Mitchell owner, scope_id = current academic year UUID); "Chess Club Community" (ACTIVITY, OPEN, Rivera owner, scope_id = Cycle 17 Chess Club id from `ext_activities`); "Spring Concert Volunteers" (CUSTOM, OPEN, Mitchell owner, `auto_dissolve_at = now() + 60 days`).
- **B) 6 members**: Grade 5 Parents — Mitchell OWNER + David Chen MEMBER. Chess Club — Rivera OWNER + Maya MEMBER + Mitchell MEMBER (the seed uses Mitchell as the second co-member rather than Ethan since the seed only ships 5 personas). Spring Concert Volunteers — Mitchell OWNER.
- **C) 3 notification prefs** demonstrating the schema: David in Grade 5 Parents (defaults: announcements + events on, channel IN_APP); Maya in Chess Club (announcements + events on, channel IN_APP); Rivera in Chess Club (announcements only, channel EMAIL).
- **D) 1 PENDING ownership transfer** — Rivera → Mitchell on Chess Club. Reason "Stepping back from Chess Club leadership next term." Expires in 7 days.
- **E) 2 announcements + 1 read** — Chess Club "Tournament Registration Open" pinned, published yesterday, 0 reads. Grade 5 Parents "Spring Concert Details" published last week, 1 read (David read it).
- **F) 2 events** — Chess Club "Inter-School Chess Tournament" (COMPETITION, requires_rsvp=true, max_attendees=16, in 30 days); Grade 5 Parents "Spring Concert" (PERFORMANCE, no RSVP, public, in 40 days).

**`packages/database/data/permissions.json`** — new function added: `{ code: "GRP-001", name: "Groups & Communities", group: "Communications" }`. Catalogue: 150 → **151 functions × 3 tiers = 453 permissions**.

**`seed-iam.ts`** — Teacher (62 → 64), Parent (31 → 33), Student (33 → 35), Staff (80 → 82) each gain `GRP-001:read+write`. School Admin / Platform Admin retain `GRP-001:admin` via everyFunction (450 → 453). Cache rebuild reports 7 account-scope pairs.

---

## Step 4 + 5 — Backend modules (complete)

**`apps/api/src/groups/`** — GroupsModule with 5 services + 1 controller + DTO module + 30 endpoints + 2 Kafka emit topics. Module wired into AppModule between ClubsModule and the global guards.

**`GroupService`** (4 endpoints + helper methods)

- `assertCanManageGroup(groupId, actor)` — manager scope = school admin OR caller is OWNER/ADMIN of the group; the canonical write gate for every mutation surface.
- `assertOwner(groupId, accountId)` — used by OwnershipTransferService.initiate.
- Persona-aware row-scope: admins see every group in the school; everyone else can browse OPEN/APPROVAL_REQUIRED groups (the discovery surface) and INVITE_ONLY groups stay hidden unless the caller is a member. The `myMembership` field on the response DTO surfaces the caller's role/status when they belong to the group.
- POST stamps creator as OWNER atomically inside one tenant transaction; PATCH applies field-by-field with multi-column casts on TIMESTAMPTZ.
- Scope shape validators: SCHOOL/CUSTOM groups MUST have `scope_id` null; CLASS/YEAR_GROUP/ACTIVITY MUST have `scope_id` set. Pre-flight validates the supplied `scope_id` matches an existing row in the right tenant table.

**`MembershipService`** (12 endpoints) — `joinGroup` keystone routes by join policy (OPEN → ACTIVE; APPROVAL_REQUIRED → PENDING_APPROVAL; INVITE_ONLY → 403). `leaveGroup` refuses on OWNER (must transfer first). `invite` / `acceptInvite` / `declineInvite` for the INVITED → ACTIVE/LEFT lifecycle. `approveJoin` / `denyJoin` for the PENDING_APPROVAL → ACTIVE/REMOVED lifecycle. `updateRole` (ADMIN ↔ MEMBER, OWNER untouchable). `suspend` / `unsuspend` (reason required; refuses on OWNER). `remove` (refuses on OWNER). `getPrefs` / `updatePrefs` for per-member notification preferences (UPSERT keyed on membership_id; defaults inlined when no row exists yet).

**`OwnershipTransferService`** (6 endpoints, the keystone of the cycle):

- `initiate(groupId, input, actor)` — validates caller is OWNER, validates destination is ACTIVE member of the same group, validates from <> to, INSERTs the PENDING transfer row inside one tenant context. Partial UNIQUE catches concurrent transfers via `isUniqueViolation` translation to a friendly "A pending ownership transfer already exists" 400.
- `accept(transferId, actor)` — KEYSTONE. Opens a tenant transaction, locks the transfer row + both grp_members rows with `FOR UPDATE`, validates PENDING + not expired + caller is the to-member, atomically demotes the from-member to ADMIN and promotes the to-member to OWNER, stamps the transfer ACCEPTED + `responded_at = now()` per the multi-column `responded_chk` lockstep — all four updates inside one tx.
- `decline(transferId, actor)` — recipient-only; flips PENDING → DECLINED.
- `cancel(transferId, actor)` — initiator or admin; flips PENDING → CANCELLED.
- `list(groupId, actor)` — returns transfer history for a group.
- `listMine(actor)` — returns PENDING transfers awaiting the caller's response (used by the `/groups` page warning banner).

**`GroupAnnouncementService`** (6 endpoints, 1 Kafka emit):

- `assertCanRead(groupId, actor)` — caller must see the group AND be an ACTIVE member (or admin).
- `assertCanAuthor(groupId, actor)` — must be OWNER/ADMIN of the group.
- `create(groupId, input, actor)` — INSERTs the announcement row + emits `grp.announcement.posted` AFTER the tenant tx commits so a Kafka hiccup cannot roll back the announcement.
- `getById` / `listForGroup` filter expired announcements (publish_at <= now() < expires_at) and order pinned-first then publish_at DESC. The `iHaveRead` field is a subquery returning `EXISTS(SELECT 1 FROM grp_announcement_reads WHERE announcement_id = a.id AND reader_id = $reader)`.
- `markRead` — UNIQUE(announcement_id, reader_id) catches duplicates with `ON CONFLICT DO NOTHING` so it's idempotent.
- `patch` / `remove` — author or OWNER/ADMIN of the group.

**`GroupEventService`** (6 endpoints, 1 Kafka emit):

- Read scope: members see all group events; non-members see only `is_public=true`.
- `create(groupId, input, actor)` — manager only; pre-flights `endsAt >= startsAt`, `rsvpDeadline <= startsAt`, `maxAttendees > 0`; INSERTs the event + emits `grp.event.created` AFTER the tx commits.
- `rsvp(eventId, input, actor)` — KEYSTONE. Opens a tenant transaction, locks the event row with `FOR UPDATE`, validates RSVP deadline + start time + group visibility, then per-status branches: only `GOING` consumes a slot from `maxAttendees`. The capacity check counts existing GOING RSVPs other than the caller's own (so re-RSVP-as-GOING is idempotent and doesn't double-count). UNIQUE(event_id, responder_id) catches via `ON CONFLICT … DO UPDATE` for atomic flip.
- `listMyRsvps` — used by `/groups/feed`.

---

## Step 6 + 7 — UI (complete)

**`apps/web/src/components/shell/apps.tsx`** — new `Groups` launchpad tile gated on `grp-001:read` (every persona since Step 3) using `ChatBubbleIcon`. Persona-aware copy: Staff "Communities, announcements, and events" / Student "My groups + announcements" / Guardian "Parent groups and community events" / others "Groups and communities". `routePrefix: '/groups'` so all nested routes keep the tile lit.

**`apps/web/src/lib/types.ts`** — Cycle 18 DTO surface: 8 enum unions (GroupScopeType, GroupStatus, JoinPolicy, GroupMemberRole, GroupMemberStatus, GroupTransferStatus, GroupEventType, GroupRsvpStatus, GroupNotificationChannel) + 11 DTO/payload interfaces.

**`apps/web/src/lib/groups-format.ts`** — label + pill maps for every enum (scope, status, policy, role, member status, transfer status, event type, RSVP) + relative date helpers (`formatRelativeDate`, `formatDateTime`, `formatDate`).

**`apps/web/src/hooks/use-groups.ts`** — 25 React Query hooks: useGroups / useMyGroups / useGroup / useCreateGroup / useUpdateGroup; useGroupMembers / useMyMemberships / useJoinGroup / useLeaveGroup / useInviteMember / useApproveJoin / useDenyJoin / useUpdateMemberRole / useSuspendMember / useRemoveMember / useGroupNotificationPrefs / useUpdateGroupNotificationPrefs; useGroupTransfers / useMyPendingTransfers / useInitiateTransfer / useAcceptTransfer / useDeclineTransfer / useCancelTransfer; useGroupAnnouncements / useCreateGroupAnnouncement / useMarkAnnouncementRead; useGroupEvents / useCreateGroupEvent / useRsvpEvent / useMyEventRsvps. Mutation invalidations cover the matching list query + per-id detail query.

**4 web routes:**

1. **`/groups`** — Browse + manage. 6-state scope filter chips (All / Class / Year group / School / Custom / Activity). Pending-ownership-transfer banner when the caller has an awaiting transfer. Group cards show name + description + scope label + 3-pill row (scope / policy / my role) + member count + pending count. Header has "My groups →" + "My feed →" links. Admin/Staff sees a "New group" button that opens a Modal with name / description / scopeType picker / scopeId input (only when needed) / joinPolicy picker.
2. **`/groups/[id]`** — Detail with 4 tabs (Announcements / Events / Members / Transfers). Header shows scope + policy + role pills + member count + auto-dissolve countdown when set. Action bar: Join/Request to join button (for non-members), Leave button (for non-OWNER members), Transfer ownership button (for OWNERs only). Announcements tab: pinned-first feed with read-tinted rows + manager Post-announcement Modal. Events tab: per-row card with type pill + date/location/RSVP indicator + 3-button RSVP bar (Going/Maybe/Not going) + manager New-event Modal. Members tab: per-member row with role + status pills. Transfers tab: chronological list with per-row Accept / Decline / Cancel buttons on PENDING rows.
3. **`/groups/my`** — Aggregated active memberships across all groups. Same card shape as `/groups` but filtered server-side via `mine=true`.
4. **`/groups/feed`** — Upcoming events I've RSVP'd to + quick navigation to my groups.

**Build sizes:** `/groups` 3.10 kB / `/groups/[id]` 4.75 kB / `/groups/feed` 946 B / `/groups/my` 930 B First Load JS.

---

## Step 8 — Vertical Slice Integration Test (complete)

**`docs/cycle18-cat-script.md`** ships the reproducible CAT. Schema preamble (8-check) + 8 plan scenarios verified live on `tenant_demo` 2026-05-06:

1. Group browsing + visibility — 4 personas see 3 groups with correctly-resolved `myMembership`.
2. **TWO-PARTY OWNERSHIP TRANSFER HANDSHAKE** — Mitchell sees pending transfer in `/groups/me/pending-transfers`; Rivera (from-member) attempts accept → 403; Mitchell accepts → atomic role swap (Mitchell OWNER, Rivera ADMIN, Maya untouched as MEMBER).
3. Group announcements + read receipts — Rivera posts; Maya marks read; lists show `readCount=1` and `iHaveRead=false` from author POV; student POST → 403 service-layer.
4. **`grp.announcement.posted` envelope** captured live with full ADR-057 shape.
5. Event creation + RSVP cap enforcement — Rivera creates with `max_attendees=2`; Maya RSVPs GOING; Mitchell RSVPs GOING; Rivera tries 3rd GOING → 400 capacity error; Rivera RSVPs MAYBE → accepted (does not consume cap).
6. **`grp.event.created` envelope** captured live.
7. Re-join semantics + scope-aware bindings — Maya leaves Chess Club; partial UNIQUE allows fresh ACTIVE row; both LEFT and ACTIVE rows coexist post-rejoin. Scope shape rules reject CLASS without scopeId and SCHOOL with scopeId.
8. Permission denials — student POST announcement on non-managed group 403; INVITE_ONLY non-member 404; transfer recipient binding 403; OWNER-must-transfer-first 400.

Cleanup section restores tenant to post-Step-3 seed shape.

---

## Wave 3 status — CLOSED

Cycle 18 is the **fifth and final cycle of Wave 3 (Communications & Community)**, following Cycle 14 (Communications), Cycle 15 (Meetings & Conferences), Cycle 16 (Enrolment & Admissions), and Cycle 17 (Clubs & Student Life). **Wave 3 closes here.** Wave 4 (Operations & Logistics) is next.

Tagged `cycle18-complete` at `7e7f33a` (after CI green); `cycle18-approved` at `f091de6` (after Round 2 verdict).
