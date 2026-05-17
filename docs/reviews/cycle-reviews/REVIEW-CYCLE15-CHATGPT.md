# REVIEW-CYCLE15-CHATGPT

**Round 1 verdict:** **Reject pending fixes** (against `cycle15-complete` at `93b1bd5`).

The reviewer flagged 3 BLOCKING row-scope / sensitive-data issues plus 5 MAJOR follow-ups. The fix commit closes all 3 BLOCKING items + 4 of the 5 MAJORs in code; MAJOR 6 (participant-row source marker so cancel doesn't remove manually-added participants) and MAJOR 8 (CAT live-output capture) are recommendation-class and move to the Phase 2 punch list. Live verification on `tenant_demo` 2026-05-06.

**Round 2 verdict:** **Approved** (against `39b0d90`, 2026-05-06). Reviewer confirmed all 3 BLOCKING findings are closed in code (`IepMeetingRecordService.canReadRecord` three-tier scope, slot identity stripping for non-organiser non-admin readers, agenda actor-scope with collapsed 404) plus the four code-level MAJOR follow-ups (tenant validation, slot booking authority restricted to GUARDIAN/admin/organiser, recording consent participation requirement). MAJOR 6 (`mtg_meeting_participants.source` marker) + MAJOR 8 (CAT live-output capture) correctly carried as Phase 2 punch list items 20 + 21. **Cycle 15 ships clean.**

Tag chain:

- `cycle15-complete` on `93b1bd5` (original closeout commit + first CAT)
- `cycle15-approved` on `39b0d90` (Round 2 APPROVED, after the fix commit)

---

## Triage table

| #   | Severity | File                                                                 | Reviewer claim                                                                                                                                           | Triage           | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | BLOCKING | `apps/api/src/meetings/iep-meeting-record.service.ts`                | IEP records visible to anyone with tenant-scoped `hlt-001:read` (which Parent holds for child-health summary).                                           | VALID            | New `canReadRecord(actor, meetingId, studentId)` helper. Tiers: admin all / counsellor (cou-001:write at the role level) own active caseload via `svc_caseloads` / non-counsellor STAFF + meeting participation + hlt-001:read for the health-team operator path / everyone else 404 don't-leak-existence. `create()` + `patch()` write authority restricted to admin or counsellor with the student on own active caseload. Parents and teachers no longer reach this surface. |
| 2   | BLOCKING | `apps/api/src/meetings/slot.service.ts`                              | `bookedBy` + `bookedByName` exposed on every slot to every reader, leaking other parents' booking identity.                                              | VALID            | `listForMeeting(meetingId, actor)` now resolves whether the actor is admin or organiser; only those two see the full identity columns. Other readers see `is_booked` plus their own booking with `bookedBy`/`bookedByName`/`bookedAt`/`notes` populated, and every other parent's booking has those columns nulled in the response.                                                                                                                                             |
| 3   | BLOCKING | `apps/api/src/meetings/agenda.service.ts`                            | `GET /meetings/:id/agenda` not actor-scoped — any user with `mtg-001:read` can read agenda items for unrelated meetings.                                 | VALID            | `listForMeeting(meetingId, actor)` calls `meetings.isParticipantOrOrganiser(...)` first; non-participant non-admin gets a collapsed 404 NotFoundException. Controller now resolves the actor and passes it through.                                                                                                                                                                                                                                                             |
| 4   | MAJOR    | `apps/api/src/meetings/meeting.service.ts` (+ agenda + action items) | participantId / presenterId / assigneeId not tenant-validated — a tenant A admin could land a meeting participant on tenant B by guessing UUIDs.         | VALID            | New shared `MeetingService.assertAccountInCurrentTenant(accountId, fieldName)` — joins through `sis_students` / `sis_guardians` / `hr_employees` projections (mirrors Cycle 6.1 Profile + Cycle 7 Task patterns). Applied to `MeetingService.create` (every supplied participantId) + `addParticipant` + `AgendaService.create/patch` (presenterId) + `ActionItemService.create` (assigneeId).                                                                                  |
| 5   | MAJOR    | `apps/api/src/meetings/slot.service.ts` + `meeting.controller.ts`    | `PATCH /meeting-slots/:id/book` requires only `mtg-002:read` so teachers + non-organiser staff can use the parent self-service path.                     | VALID            | `book()` now refuses non-GUARDIAN actors unless they are school admin OR the meeting organiser (so a teacher running the conference can book a slot on behalf of a parent who phoned in). Teachers + non-organiser staff are explicitly refused with the redirect message.                                                                                                                                                                                                      |
| 6   | MAJOR    | `apps/api/src/meetings/slot.service.ts`                              | `cancel()` removes the parent's participant row if no other slot is booked, but cannot distinguish "auto-created by booking" from "manually added" rows. | VALID — DEFERRED | Recommendation-class. Requires a `source = MANUAL / SLOT_BOOKING` column on `mtg_meeting_participants` so cancel-by-booking does not delete manually-curated roster rows. Documented in CLAUDE.md punch list as item 20. Today's seed + CAT path do not exercise the manual-then-booked-then-cancelled corner; pre-pilot polish.                                                                                                                                                |
| 7   | MAJOR    | `apps/api/src/meetings/recording.service.ts`                         | `giveConsent()` lets school admins consent even if not a participant; the consent then doesn't count toward `totalParticipants`.                         | VALID            | Removed the `actor.isSchoolAdmin` bypass. Consent now requires the actor to be a meeting participant or the organiser. An admin who is not on the roster cannot consent through this surface — a future override path with audit can be added if real-school operations need it.                                                                                                                                                                                                |
| 8   | MAJOR    | `docs/cycle15-cat-script.md`                                         | CAT script reads as a reproducible script rather than a live verification record with captured outputs.                                                  | VALID — DEFERRED | Recommendation-class, not a code blocker. The CAT shape matches the Cycle 14 pattern; future sensitive-cycle CATs (Cycle 16 Enrollment) should pin live output captures inline. Documented as Phase 2 punch list item 21.                                                                                                                                                                                                                                                       |

---

## Verification

After the fix commit, the five code-level changes were verified live against `tenant_demo`:

- **BLOCKING 1.** Parent (David Chen — holds `hlt-001:read`) `GET /meetings/<iepMeetingId>/iep-record` now returns 404 (was: full IEP record DTO including outcomes_summary + attendee_roles). Teacher Rivera (no caseload, no meeting participation) → 404. Counsellor Hayes (Maya is on her active caseload) → full record returned. Admin (principal) → full record. Counsellor attempting to create an IEP record for a student NOT on her active caseload → 403 with the redirect message. `list()` for counsellor returns only records for own active-caseload students.
- **BLOCKING 2.** Parent A `GET /meetings/<ptcMeetingId>/slots` returns 6 rows: David's own booking shows `bookedByName='David Chen'`; the other 5 booked slots seeded for testing show `bookedBy=null, bookedByName=null, bookedAt=null`. Organiser Rivera + admin see full identity columns on every booked row.
- **BLOCKING 3.** Teacher Rivera (no participation in IEP meeting) `GET /meetings/<iepMeetingId>/agenda` → 404 (was: 2 agenda items leaked). Hayes (organiser) → full agenda. Admin → full agenda.
- **MAJOR 4.** `POST /meetings` with `participantIds=['<random-uuid>']` → 400 "participantId does not belong to a user in this school". Real platform user account → 201. Same gate exercised on `POST /meetings/:id/participants` + `POST /meetings/:id/agenda` with bogus presenterId + `POST /meetings/:id/action-items` with bogus assigneeId.
- **MAJOR 5.** Teacher (mtg-002:read held) `PATCH /meeting-slots/<id>/book` → 403 with redirect message. Parent → 201. Admin / organiser → 201 (book-on-behalf path).
- **MAJOR 7.** Admin (mitchell, not a participant on a smoke recording) `POST /meeting-recordings/<id>/consent` → 403 "Only meeting participants can give consent". Same admin added as a participant first → 200. Counsellor (participant) → 200.

Build clean (`pnpm --filter @campusos/api build`); `pnpm format:check` clean; unit tests pass (7/7).

---

## Phase 2 / pre-pilot punch list additions

CLAUDE.md gains items 20 + 21:

- **Item 20 — `mtg_meeting_participants.source` marker** (REVIEW-CYCLE15 MAJOR 6). Add `source TEXT NOT NULL DEFAULT 'MANUAL'` 2-value CHECK MANUAL/SLOT_BOOKING column. The Step 4 SlotService.book inserts with `source='SLOT_BOOKING'`; cancel only removes participant rows where source matches. Pre-pilot polish.
- **Item 21 — CAT live-output capture for sensitive cycles** (REVIEW-CYCLE15 MAJOR 8). The reviewer notes that the CAT script reads as a reproducible script rather than a live verification record with captured pass/fail observations. Future sensitive-cycle CATs (Cycle 16 Enrollment is next) should inline live shell-output snippets per assertion. Documentation pattern only — no code change.

---

## Reviewer Round 2 verdict (2026-05-06)

> **Approved.**
>
> I reviewed commit `39b0d90` directly against the Round 1 findings and the triage/verification trail above. The three blocking findings are fixed, and four of the five major code-level follow-ups were also addressed. The remaining items are appropriately documented as Phase 2 / pre-pilot polish.
>
> **Confirmed fixes**
>
> 1. **IEP meeting record row-scope — fixed.** `IepMeetingRecordService` no longer uses broad `hlt-001:read` as a tenant-wide read gate. Explicit `canReadRecord()` logic: school admin all / counsellor own active caseload / non-counsellor staff with health read AND meeting participation / parents+teachers+students excluded. Create + patch restricted to admin or counsellor with the student on own active caseload. **Blocker closed.**
> 2. **Parent slot-grid identity leak — fixed.** `SlotService.listForMeeting()` is actor-aware; admins + organisers see full booking identity, normal readers see only their own booking identity, other booked slots return `bookedBy` / `bookedByName` / `bookedAt` / `notes` as null. Booking restricted to guardians, admins, or the meeting organiser. **Blocker closed.**
> 3. **Agenda listing row-scope — fixed.** `AgendaService.listForMeeting()` requires admin or participant/organiser visibility; non-participants get a collapsed 404. Presenter ID validation also added on create/patch. **Blocker closed.**
> 4. **Tenant validation for meeting-related account references — fixed.** `MeetingService.assertAccountInCurrentTenant()` validates request-supplied `platform_users.id` values through `sis_students` / `sis_guardians` / `hr_employees` projections. Applied to meeting participants, added participants, agenda presenter ids, and action-item assignees. **Major follow-up closed.**
> 5. **Recording consent admin bypass — fixed.** Admin bypass removed; consent now requires actual meeting participation or organiser status, with future admin override deferred to a separate audited path. **Major follow-up closed.**
>
> **Deferred follow-ups**
>
> Two items remain properly deferred: `mtg_meeting_participants.source` marker so slot cancellation never removes a manually-curated participant row, and CAT documentation improvements for sensitive cycles. Both are reasonable Phase 2 / pre-pilot polish items.
>
> **Final Gate Decision: Approved.** Cycle 15 is clean from my review perspective.
