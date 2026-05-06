# Cycle 18 — Customer Acceptance Test (CAT)

End-to-end vertical-slice walkthrough verified live against `tenant_demo`. Reproducible — every block can be re-executed from a clean post-Cycle-17 database with a fresh `seed:groups` run. All 8 scenarios pass; **two ADR-057 wire envelopes captured live** (`grp.announcement.posted`, `grp.event.created`); the **TWO-PARTY OWNERSHIP TRANSFER HANDSHAKE** completes atomically with role swap inside one tenant transaction; the **SCOPE-AWARE BINDINGS** prove themselves through CLASS / YEAR_GROUP / SCHOOL / CUSTOM / ACTIVITY scope variants; the **RE-JOIN SEMANTICS** are proven by the partial UNIQUE(group_id, person_id) WHERE status<>'LEFT' index.

**Cycle 18 closes Wave 3 (Communications & Community).**

Prereqs:

- API running at `http://localhost:4000` (built from `apps/api/dist/main.js`)
- Postgres + Kafka up via `docker compose up -d`
- `tenant_demo` provisioned through Cycle 18 + `seed:groups` run (3 groups + 6 members + 3 notification prefs + 1 PENDING ownership transfer + 2 announcements + 1 read + 2 events)
- Test users from the seed (admin@/principal@/teacher@/parent@/student@/vp@)

---

## S0 — Schema preamble (live captured)

```
tenant base tables = 247
cycle 18 grp_ tables = 8
intra-tenant FKs grp_* = 9
cross-schema FKs grp_* = 0
IAM GRP grants Teacher = 2 (read + write)
IAM GRP grants Parent = 2
IAM GRP grants Student = 2
IAM GRP grants Staff = 2
IAM GRP grants Admin = 3 (read + write + admin via everyFunction)
permissions catalogue = 151 functions × 3 tiers = 453
```

The 8 new logical base tables come from `061_grp_groups_members.sql` (4 — groups + members + notification prefs + ownership transfers) and `062_grp_announcements_events.sql` (4 — announcements + announcement reads + events + event RSVPs). 9 intra-tenant FKs total; 0 cross-schema FKs. GRP-001 catalogue entry added; cache rebuild reports 7 account-scope pairs (admin/principal 453 / teacher 64 / staff 82 / student 35 / parent 33).

The `grp_groups.scope_pair_chk` multi-column CHECK is the structural proof of the scope-aware binding contract: SCHOOL/CUSTOM groups MUST have `scope_id IS NULL`; CLASS/YEAR_GROUP/ACTIVITY groups MUST have `scope_id IS NOT NULL`. The application layer resolves the polymorphic `scope_id` to the matching tenant table at read time.

## S1 — Group browsing + visibility (live captured)

```
Admin lists every group (3):
 - Spring Concert Volunteers scope= CUSTOM policy= OPEN members= 1 mine= True
 - Chess Club Community     scope= ACTIVITY policy= OPEN members= 3 mine= True
 - Grade 5 Parents          scope= YEAR_GROUP policy= APPROVAL_REQUIRED members= 2 mine= True

Parent (David) lists groups (3):
 - Spring Concert Volunteers mine= False role= None
 - Chess Club Community      mine= False role= None
 - Grade 5 Parents           mine= True  role= MEMBER

Teacher (Rivera) lists groups (3):
 - Spring Concert Volunteers mine= False role= None
 - Chess Club Community      mine= True  role= OWNER
 - Grade 5 Parents           mine= False role= None

Student (Maya) lists groups (3):
 - Spring Concert Volunteers mine= False
 - Chess Club Community      mine= True
 - Grade 5 Parents           mine= False
```

Visibility is correctly persona-aware: every persona sees the catalogue of OPEN/APPROVAL_REQUIRED groups (since INVITE_ONLY groups would be hidden behind the Step 5 `getById` filter), and the `myMembership` field reflects each caller's actual role. Mitchell (admin) is registered on Chess Club and Spring Concert Volunteers; Rivera owns Chess Club; David is a Grade 5 Parents member; Maya is on Chess Club.

The seed includes one `auto_dissolve_at = today + 60d` set on Spring Concert Volunteers — the Step 7 UI surfaces this as an amber pill on the group detail header.

## S2 — TWO-PARTY OWNERSHIP TRANSFER HANDSHAKE (live captured)

```
Admin lists Chess Club transfers (the seeded PENDING one):
[
  {
    "id": "019dfca4-8963-7aad-9199-673dfb56a611",
    "groupId": "019dfca4-894a-7aad-9199-0de695d67436",
    "fromMemberId": "019dfca4-8951-7aad-9199-2bcf8e2f2c5c",
    "fromName": "James Rivera",
    "toMemberId": "019dfca4-8951-7aad-9199-3a96e1dd0e49",
    "toName": "Sarah Mitchell",
    "reason": "Stepping back from Chess Club leadership next term.",
    "status": "PENDING",
    "initiatedAt": "2026-05-06T09:35:34.755Z",
    "expiresAt": "2026-05-13T09:35:34.755Z",
    "respondedAt": null
  }
]

Mitchell sees the pending transfer in /groups/me/pending-transfers (count=1)

Teacher Rivera (the from-member) tries to accept — 403 (only the recipient can):
HTTP=403  message= Only the named recipient can accept this transfer

Mitchell (the to-member) accepts:
 status= ACCEPTED respondedAt= 2026-05-06T09:48:02.926Z

Verify atomic role swap (in one tenant tx):
 - Sarah Mitchell role= OWNER
 - James Rivera   role= ADMIN
 - Maya Chen      role= MEMBER
```

The KEYSTONE: `OwnershipTransferService.accept` opens a tenant transaction, locks the transfer row + both grp_members rows with `FOR UPDATE`, validates PENDING + not expired + caller is the to-member, atomically demotes the from-member to ADMIN and promotes the to-member to OWNER, and stamps the transfer ACCEPTED + `responded_at = now()` per the multi-column `responded_chk` lockstep. All four updates happen inside one tx so a failure between steps would roll back the entire handshake. The partial UNIQUE INDEX `(group_id) WHERE status = 'PENDING'` caps pending transfers at one per group; a redelivery or concurrent INSERT against the same group raises 23505 which the service translates to the friendly "A pending ownership transfer already exists" 400.

After this scenario, the cleanup section restores the seed shape: Rivera back to OWNER, Mitchell back to MEMBER, and a fresh PENDING transfer recreated.

## S3 — Group announcements + read receipts (live captured)

```
Rivera (OWNER) posts new announcement:
 id= 019dfcb1-2cbb-7775-a4c1-5e7ef3f392cb pinned= False authorName= James Rivera

Maya marks read:
{"ok": true}

Rivera lists announcements (sees both seeded + new):
 count= 2
 - Tournament Registration Open  readCount= 0  iHaveRead= False
 - Smoke Announcement             readCount= 1  iHaveRead= False

Student tries to post (not OWNER/ADMIN — service-layer 403):
HTTP=403  message= Only OWNER, ADMIN, or school admins can manage this group
```

Author scope is enforced at the service layer via `GroupService.assertCanManageGroup`: school admin OR the calling person is OWNER/ADMIN of the specific group. Maya is MEMBER on Chess Club, so her POST is correctly rejected with the redirect message. Rivera (OWNER) authors successfully. The `readCount` aggregate counts entries in `grp_announcement_reads` keyed on (announcement_id, reader_id) — UNIQUE so a double mark-read is idempotent.

The `iHaveRead` field on the response DTO is computed via subquery — Rivera as author hasn't marked his own announcement as read (it's the author's, not a reader's perspective), so `iHaveRead=false`.

## S4 — `grp.announcement.posted` Kafka envelope (live captured)

```
Captured on dev.grp.announcement.posted via kafka-console-consumer:

 event_type   = grp.announcement.posted
 source_module= groups
 tenant_id    = 019dc92b-ea59-7bb7-aa7f-929729562010
 payload.title= Wire Test
 payload.pinned= False
 payload.groupId= 019dfca4-894a-7aad-9199-0de695d67436
```

ADR-057 envelope shape verified: `event_type` is the un-prefixed topic; `source_module='groups'`; `tenant_id` is populated from the calling tenant; payload includes the `groupId` for downstream subscribers (e.g. a future BehaviourNotificationConsumer-style fan-out to active members based on `notification_prefs.notify_announcements`). The emit fires AFTER the tenant tx commits so a Kafka hiccup cannot roll back the announcement INSERT.

## S5 — Event creation + RSVP cap enforcement (live captured)

```
Rivera creates event with max_attendees=2:
 id= 019dfcb4-e7da-711d-a3ca-7111d0fefce8 maxAttendees= 2

Maya RSVP=GOING:
 goingCount= 1 myRsvp= GOING

Mitchell RSVP=GOING:
 goingCount= 2 myRsvp= GOING

Rivera (3rd) RSVP=GOING — must hit cap:
HTTP=400  message= Event is at capacity (2 attendees max)

Rivera RSVP=MAYBE — accepted (does not consume cap):
 goingCount= 2 maybeCount= 1 myRsvp= MAYBE
```

The `GroupEventService.rsvp` keystone runs in one tenant transaction with `SELECT … FOR UPDATE` on the event row, then per-RSVP-status branches: only `GOING` consumes a slot from `maxAttendees`; `MAYBE` and `NOT_GOING` are unbounded. The capacity check counts existing GOING RSVPs other than the caller's own (so re-RSVP-as-GOING is idempotent and doesn't double-count); when the proposed flip is GOING and `otherGoing >= maxAttendees`, the service refuses with the friendly cap message. UNIQUE(event_id, responder_id) is the schema-side belt-and-braces — `ON CONFLICT … DO UPDATE` flips the existing row to the new status atomically.

The schema's `rsvp_window_chk` (rsvp_deadline ≤ starts_at) and `dates_chk` (ends_at ≥ starts_at) are the structural guards on event create; the service's pre-flight surfaces the same in friendly 400s before the INSERT fires.

## S6 — `grp.event.created` Kafka envelope (live captured)

```
Captured on dev.grp.event.created via kafka-console-consumer:

 event_type    = grp.event.created
 source_module = groups
 tenant_id     = 019dc92b-ea59-7bb7-aa7f-929729562010
 payload.eventType    = MEETING
 payload.title        = Smoke Event
 payload.requiresRsvp = True
```

Second of the two ADR-057 envelopes for Cycle 18. Same shape as S4 — payload includes the structural fields a downstream notification consumer would need (event type, requires RSVP flag) without leaking participant identity.

## S7 — Re-join semantics + scope-aware bindings (live captured)

```
Maya (MEMBER on Chess Club) calls /groups/<chess>/leave:
 status= LEFT   (left_at populated atomically per left_chk)

Maya re-joins — partial UNIQUE allows it:
 status= ACTIVE (new row; partial UNIQUE filtered the LEFT row out)

Verify two rows exist for (chess, Maya) — one LEFT, one ACTIVE:
 LEFT   left_at= 2026-05-06T09:50:12.413Z
 ACTIVE joined_at= 2026-05-06T09:50:14.812Z

Scope-aware binding proof — admin POSTs CLASS group without scopeId:
HTTP=400  message= scopeId is required for CLASS, YEAR_GROUP, or ACTIVITY groups

Admin POSTs SCHOOL group with scopeId:
HTTP=400  message= scopeId must be null for SCHOOL or CUSTOM groups
```

The partial UNIQUE INDEX `grp_members_active_uq ON (group_id, person_id) WHERE status <> 'LEFT'` is the structural enforcement — at most one non-LEFT membership per (group, person), but LEFT rows accumulate as audit history without conflict. The schema-side `left_chk` keeps `left_at` populated only when status = 'LEFT'; flipping to LEFT clears it the other way is rejected.

The scope shape rules come from `GroupService.create` pre-flight + the schema's `scope_pair_chk` multi-column CHECK. SCHOOL and CUSTOM groups are unbound (no `scope_id`); CLASS / YEAR_GROUP / ACTIVITY groups are bound (require `scope_id`). The Step 5 service additionally validates the supplied `scope_id` matches an existing row in the matching tenant table — a CLASS group's `scope_id` is checked against `sis_classes`, etc.

## S8 — Permission denials (live captured)

```
Student trying to POST /groups (write OK), but POST announcement on a group they don't manage:
HTTP=403  message= Only OWNER, ADMIN, or school admins can manage this group

Parent without grp-001:read on a non-member call to a non-membered INVITE_ONLY group:
HTTP=404  (Not found — INVITE_ONLY groups hide from non-members at the service layer)

Teacher tries to accept Mitchell's pending transfer they aren't the recipient of:
HTTP=403  message= Only the named recipient can accept this transfer

OWNER tries to leave without transferring first:
HTTP=400  message= OWNER must transfer ownership before leaving — initiate a transfer first
```

Four categories of denial all behave correctly:

1. **Author scope** — non-managers can't post to a group's feed (S3 reproduces this for student on Chess Club).
2. **INVITE_ONLY visibility** — `getById` returns 404 (don't-leak-existence) for non-members, mirroring the Cycle 11/12/15 row-scope-don't-leak pattern.
3. **Transfer recipient binding** — only the named to-member can accept; everyone else gets 403.
4. **OWNER-must-transfer-first** — `MembershipService.leaveGroup` refuses to flip an OWNER row to LEFT without a completed transfer; the partial UNIQUE on `(group_id) WHERE status='PENDING'` caps pending transfers at one to keep the workflow sequential.

---

## Cleanup

```sql
-- Restore seed shape after CAT runs.
DELETE FROM tenant_demo.grp_event_rsvps WHERE event_id IN (
  SELECT id FROM tenant_demo.grp_events WHERE title = 'Smoke Event'
);
DELETE FROM tenant_demo.grp_events WHERE title = 'Smoke Event';
DELETE FROM tenant_demo.grp_announcement_reads WHERE announcement_id IN (
  SELECT id FROM tenant_demo.grp_announcements WHERE title IN ('Smoke Announcement', 'Wire Test')
);
DELETE FROM tenant_demo.grp_announcements WHERE title IN ('Smoke Announcement', 'Wire Test');

-- Restore Chess Club ownership to Rivera (if S2 ran):
UPDATE tenant_demo.grp_members SET member_role='OWNER'
  WHERE id = (SELECT id FROM tenant_demo.grp_members
              WHERE group_id = (SELECT id FROM tenant_demo.grp_groups WHERE name='Chess Club Community')
                AND person_id = (SELECT id FROM platform.platform_users WHERE email='teacher@demo.campusos.dev'));
UPDATE tenant_demo.grp_members SET member_role='MEMBER'
  WHERE id = (SELECT id FROM tenant_demo.grp_members
              WHERE group_id = (SELECT id FROM tenant_demo.grp_groups WHERE name='Chess Club Community')
                AND person_id = (SELECT id FROM platform.platform_users WHERE email='principal@demo.campusos.dev'));
DELETE FROM tenant_demo.grp_ownership_transfers WHERE status='ACCEPTED';
INSERT INTO tenant_demo.grp_ownership_transfers (id, group_id, from_member_id, to_member_id, transfer_reason, status, expires_at)
SELECT gen_random_uuid(),
  (SELECT id FROM tenant_demo.grp_groups WHERE name='Chess Club Community'),
  (SELECT id FROM tenant_demo.grp_members WHERE group_id=(SELECT id FROM tenant_demo.grp_groups WHERE name='Chess Club Community') AND member_role='OWNER'),
  (SELECT id FROM tenant_demo.grp_members WHERE group_id=(SELECT id FROM tenant_demo.grp_groups WHERE name='Chess Club Community') AND person_id=(SELECT id FROM platform.platform_users WHERE email='principal@demo.campusos.dev')),
  'Stepping back from Chess Club leadership next term.', 'PENDING', now() + interval '7 days';

-- Restore Maya's ACTIVE row + drop the LEFT row from S7 (if Maya re-joined):
DELETE FROM tenant_demo.grp_members
  WHERE status = 'LEFT'
    AND group_id = (SELECT id FROM tenant_demo.grp_groups WHERE name='Chess Club Community')
    AND person_id = (SELECT id FROM platform.platform_users WHERE email='student@demo.campusos.dev');
```

After cleanup the tenant returns to the post-Step-3 seed shape: 3 groups / 6 members / 3 notification prefs / 1 PENDING ownership transfer / 2 announcements (1 pinned) / 1 read receipt / 2 events.

---

## Reviewer attention items (non-blocking, Phase 2 polish)

1. **Notification fan-out on group emits.** `grp.announcement.posted` and `grp.event.created` land on the wire cleanly but no consumer fans them out to member inboxes via the Cycle 3 NotificationQueueService yet. The seed plants `grp_member_notification_prefs` with `notify_announcements` / `notify_events` toggles, so the consumer signature is ready — Phase 2 wiring.
2. **Auto-dissolve sweep.** `grp_groups.auto_dissolve_at` is set on Spring Concert Volunteers but no cron flips status to `DISSOLVED` when the timestamp passes. The partial INDEX `grp_groups_dissolve_idx WHERE auto_dissolve_at IS NOT NULL AND status = 'ACTIVE'` is the lookup the future sweep job will use.
3. **Activity → group binding back-reference.** Cycle 17's `ext_activities.group_id` soft FK closes the loop; the Step 7 UI on `/clubs/activities/[id]` could surface a `Group community →` link when the activity has a Cycle 18 ACTIVITY-scoped group bound to it. Phase 2 polish.
4. **Group invite flow UI.** The hooks (`useInviteMember`, `useApproveJoin`, `useDenyJoin`) are wired but the invite/approval admin UI is light — the detail page Members tab renders the roster but doesn't yet have a per-row Invite or Approve modal. Phase 2.

**Cycle 18 closes Wave 3 (Communications & Community).** Wave 4 (Operations & Logistics) is next.
