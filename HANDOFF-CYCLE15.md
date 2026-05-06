# Cycle 15 Handoff — Meetings & Conferences

**Status:** Cycle 15 **COMPLETE pending architecture review — Wave 3 Cycle 2 (Meetings & Conferences).** All 10 steps done. Vertical-slice CAT at `docs/cycle15-cat-script.md` covers the 10 plan scenarios end-to-end against `tenant_demo`. Cycle 15 builds the M41 Meetings module — 11 of the 13 ERD tables in scope (the 2 AI-deferred tables ship in Cycle 15.1 once an external transcription / minutes-generation service is integrated). Final cycle totals: **11 new base tables**, **11 new intra-tenant FKs**, **0 cross-schema FKs**, **~32 new endpoints**, **1 new Kafka emit topic** (`mtg.meeting.scheduled`), **4 new web routes** (`/meetings` dashboard, `/meetings/[id]` detail, `/meetings/conferences/[id]` PTC slot grid, `/meetings/action-items`), **17 new React Query hooks**. Tenant base table count: 206 → **217**. Catalogue stays at 450 (MTG-001 + MTG-002 already in `permissions.json`). IAM cache: Teacher 54 → 58 (+4 from MTG-001 + MTG-002 read+write), Parent 27 → 29 (+2 from MTG-001 + MTG-002 read), Student 28 → 29 (+1 from MTG-001 read), Staff 67 → 70 (+3 from MTG-001 read+write + MTG-002 read). Tagged `cycle15-complete` after CI green. This is the first cycle where parents are active schedulers rather than passive recipients: the parent-teacher conference (PTC) slot grid is parent self-service. The module bridges Cycle 10's IEP plans (via `mtg_iep_meeting_records.iep_plan_id` soft FK) and resolves Cycle 11's `svc_mtss_team_meetings.meeting_id` soft FK.

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle15-implementation-plan.html`
**Vertical-slice deliverable:** Admin creates a "Spring Parent-Teacher Conferences" event (PARENT_TEACHER, May 20–21) → Rivera sets availability by creating 15-minute time slots across both days → David Chen (parent) browses available slots and books one with Rivera to discuss Maya's progress → Rivera conducts the meeting, logs notes with `is_parent_visible=true` and a separate parent-facing summary → Rivera creates 2 action items (1 self-assigned, 1 to David Chen) → Rivera approves the notes → David sees the parent summary on his portal → Admin schedules an IEP review meeting for Maya, linking it to her Cycle 10 IEP plan → the IEP meeting record captures attendee roles and outcomes → Cycle 11's `svc_mtss_team_meetings.meeting_id` soft FK resolves to this meeting.

This document tracks the Cycle 15 build at the same level of detail as `HANDOFF-CYCLE14.md` and is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                               | Status   |
| ---- | --------------------------------------------------- | -------- |
| 1    | Conference + Meeting Schema                         | **DONE** |
| 2    | Notes + Actions + Recording + IEP Schema            | **DONE** |
| 3    | Seed Data — Conference, Meetings, Slots, Notes, IEP | **DONE** |
| 4    | Conference + Meeting NestJS Module                  | **DONE** |
| 5    | Notes + Actions + Recording NestJS Module           | **DONE** |
| 6    | IEP Meeting + Cross-Cycle Integration               | **DONE** |
| 7    | Meetings UI — Calendar + Conference Booking         | **DONE** |
| 8    | Meetings UI — Notes + Actions + IEP + Parent Portal | **DONE** |
| 9    | Recording + Consent UI                              | **DONE** |
| 10   | Vertical Slice Integration Test                     | **DONE** |

---

## What this cycle adds on top of Cycle 14

Cycle 15 builds the M41 Meetings module — 11 of the 13 ERD tables. The 2 AI-deferred tables (`mtg_transcription_jobs`, `mtg_ai_minutes_jobs`) move to Cycle 15.1 because they require an external transcription / inference service.

**Existing-system touchpoints:**

- `platform.platform_users(id)` — soft refs throughout (organiser, participant, slot booker, action-item assignee, recording consenter)
- `sis_students(id)` — soft ref on `mtg_iep_meeting_records.student_id`
- `hlth_iep_plans(id)` (Cycle 10) — soft ref on `mtg_iep_meeting_records.iep_plan_id` for IEP-linked meetings
- `svc_mtss_team_meetings.meeting_id` (Cycle 11) — Cycle 11 left this as a soft UUID forward-compat. Cycle 15 ships the target `mtg_meetings` table so MTSS team meetings can now reference real meeting rows.

**New surface:**

- **11 new tables** across 2 migrations (053 + 054).
- **3 new backend modules**: ConferenceService + MeetingService + SlotService (Step 4); MeetingNotesService + AgendaService + ActionItemService + RecordingService (Step 5); IepMeetingRecordService (Step 6).
- **1 new Kafka emit topic**: `mtg.meeting.scheduled` on meeting creation.
- **~32 new endpoints** across the cycle.
- **5 new web routes**: `/meetings` dashboard, `/meetings/[id]` detail, `/meetings/conferences/[id]` PTC slot grid (the parent self-service keystone), `/meetings/calendar`, `/meetings/action-items`. Parent portal extends the existing `/children/[id]/meetings` route.

**Two product keystones drive this cycle:**

1. **Parent self-service slot booking.** `mtg_meeting_slots` plus `PATCH /meetings/slots/:id/book` use `SELECT FOR UPDATE` on the slot row to prevent two parents booking the same slot in a race. The booking auto-creates a participant row so the parent appears on the meeting roster.
2. **Two-layer parent visibility on meeting notes.** `mtg_meeting_notes` has `is_parent_visible BOOLEAN` (teacher-controlled flag) AND `is_approved BOOLEAN` (locked once stamped). Parents see the notes only when BOTH are true; they see `parent_visible_summary` if provided, otherwise full `notes_text`. IEP-linked meetings render a rose warning encouraging staff to keep `is_parent_visible=false` for sensitive content.

What does not change: every existing module continues to function. Cycle 15 is purely additive.

---

## Step 1 — Conference + Meeting Schema

**Status:** DONE on 2026-05-06.

**Migration target:** `packages/database/prisma/tenant/migrations/053_mtg_conferences_meetings.sql`.

**Tables (5):**

1. **`mtg_conference_events`** — Top-level container for a school's conference week. `school_id UUID NOT NULL` (soft to platform.schools), `title TEXT NOT NULL`, `description TEXT`, `conference_type TEXT NOT NULL` 5-value CHECK PARENT_TEACHER/STAFF/BOARD/IEP/TRAINING, `start_date DATE NOT NULL`, `end_date DATE NOT NULL` with `dates_chk: end_date >= start_date`, `status TEXT NOT NULL DEFAULT 'SCHEDULED'` 4-value CHECK SCHEDULED/ACTIVE/COMPLETED/CANCELLED, `created_by UUID`, `created_at` + `updated_at`. INDEX(school_id, start_date DESC).
2. **`mtg_meeting_types`** — Per-school catalogue. `school_id UUID NOT NULL`, `name TEXT NOT NULL`, `description TEXT`, `default_duration_minutes INT NOT NULL DEFAULT 30 > 0` CHECK, `is_video BOOLEAN DEFAULT false`, `is_active BOOLEAN DEFAULT true`. UNIQUE(school_id, name). Seeded types (Step 3): "Parent-Teacher Conference" (15min), "Staff Meeting" (60min), "IEP Review" (45min, video=true), "Department Meeting" (30min).
3. **`mtg_meetings`** — Individual meeting instance. `school_id UUID NOT NULL`, `meeting_type_id UUID NOT NULL FK to mtg_meeting_types(id) ON DELETE NO ACTION` (audit survives type retirement), `conference_event_id UUID FK to mtg_conference_events(id) ON DELETE SET NULL` nullable (standalone meetings have no parent event), `title TEXT NOT NULL`, `description TEXT`, `scheduled_at TIMESTAMPTZ NOT NULL`, `duration_minutes INT NOT NULL DEFAULT 30 > 0` CHECK, `meeting_url TEXT` nullable (manual entry for video links this cycle — auto-generation deferred), `status TEXT NOT NULL DEFAULT 'SCHEDULED'` 4-value CHECK SCHEDULED/IN_PROGRESS/COMPLETED/CANCELLED, `organiser_id UUID NOT NULL` (soft to platform.platform_users), `started_at TIMESTAMPTZ` + `completed_at TIMESTAMPTZ` nullable. INDEX(school_id, scheduled_at DESC), partial INDEX(organiser_id, scheduled_at DESC) for "my meetings".
4. **`mtg_meeting_participants`** — Per-(meeting, participant) row. `meeting_id UUID NOT NULL FK to mtg_meetings(id) ON DELETE CASCADE`, `participant_id UUID NOT NULL` (soft to platform.platform_users), `role TEXT NOT NULL DEFAULT 'ATTENDEE'` 4-value CHECK HOST/PRESENTER/ATTENDEE/OBSERVER, `attended BOOLEAN DEFAULT false`, `join_at TIMESTAMPTZ` + `leave_at TIMESTAMPTZ` nullable, `notes TEXT`. UNIQUE(meeting_id, participant_id) so each participant appears at most once per meeting. INDEX(participant_id, meeting_id) for "my meetings" view.
5. **`mtg_meeting_slots`** — **PTC BOOKING KEYSTONE.** `meeting_id UUID NOT NULL FK to mtg_meetings(id) ON DELETE CASCADE` (the parent meeting under the conference — represents the teacher's availability container), `start_time TIMESTAMPTZ NOT NULL`, `end_time TIMESTAMPTZ NOT NULL` with `window_chk: end_time > start_time`, `is_booked BOOLEAN NOT NULL DEFAULT false`, `booked_by UUID` nullable (soft to platform.platform_users), `booked_at TIMESTAMPTZ` nullable, **multi-column `booked_chk` keystone** keeping `(is_booked, booked_by, booked_at)` in lockstep — `is_booked=false` requires both NULL, `is_booked=true` requires both NOT NULL. INDEX(meeting_id, start_time). Partial INDEX(meeting_id) WHERE is_booked=false for the available-slots picker. The Step 4 `book` endpoint uses `SELECT FOR UPDATE` on the slot row inside `executeInTenantTransaction` to prevent double-booking.

**FK summary:** 4 new DB-enforced FKs (1 NO ACTION on meeting_type_id audit-preserving, 1 SET NULL on conference_event_id, 2 CASCADE on participants/slots → meeting). 0 cross-schema FKs.

**Tenant logical base table count after Step 1:** 206 → **211** (5 new logical base tables).

---

## Step 2 — Notes + Actions + Recording + IEP Schema

**Status:** DONE on 2026-05-06.

**Migration target:** `packages/database/prisma/tenant/migrations/054_mtg_notes_recording_iep.sql`.

**Tables (6):**

1. **`mtg_agenda_items`** — Ordered per-meeting agenda. `meeting_id UUID NOT NULL FK to mtg_meetings(id) ON DELETE CASCADE`, `title TEXT NOT NULL`, `description TEXT`, `presenter_id UUID` nullable (soft to platform.platform_users), `duration_minutes INT > 0` CHECK when set, `sort_order INT NOT NULL >= 0` CHECK, `notes TEXT` nullable. INDEX(meeting_id, sort_order).
2. **`mtg_meeting_notes`** — **PARENT-VISIBILITY KEYSTONE.** `meeting_id UUID NOT NULL FK to mtg_meetings(id) ON DELETE CASCADE` + UNIQUE(meeting_id) so each meeting has at most one notes record, `notes_text TEXT`, `is_approved BOOLEAN NOT NULL DEFAULT false`, `approved_by UUID` nullable (soft to platform_users), `approved_at TIMESTAMPTZ` nullable, **multi-column `approved_chk`** keeping the trio in lockstep — unapproved requires both NULL, approved requires both NOT NULL, `is_parent_visible BOOLEAN NOT NULL DEFAULT false`, `parent_visible_summary TEXT` nullable. The Step 5 service applies the parent-visibility gate: parents see notes only when BOTH `is_parent_visible=true` AND `is_approved=true`; they see `parent_visible_summary` if provided, otherwise full `notes_text`.
3. **`mtg_action_items`** — Per-meeting action items with cross-persona assignees. `meeting_id UUID NOT NULL FK to mtg_meetings(id) ON DELETE CASCADE`, `assignee_id UUID NOT NULL` (soft to platform.platform_users — covers staff and parent assignees), `description TEXT NOT NULL`, `due_date DATE` nullable, `status TEXT NOT NULL DEFAULT 'OPEN'` 4-value CHECK OPEN/IN_PROGRESS/DONE/CANCELLED, `completed_at TIMESTAMPTZ` nullable, **multi-column `completed_chk`** pinning DONE/CANCELLED to a populated `completed_at` and OPEN/IN_PROGRESS to NULL. INDEX(assignee_id, status) for "my action items" dashboard hot path. INDEX(meeting_id, sort_order) — wait, no sort_order; just INDEX(meeting_id).
4. **`mtg_recordings`** — Recording metadata. `meeting_id UUID NOT NULL FK to mtg_meetings(id) ON DELETE CASCADE` + UNIQUE(meeting_id) so each meeting has at most one recording, `s3_key TEXT` nullable (populated when recording lands), `duration_seconds INT >= 0` CHECK when set, `file_size_bytes BIGINT >= 0` CHECK when set, `status TEXT NOT NULL DEFAULT 'PROCESSING'` 3-value CHECK PROCESSING/AVAILABLE/FAILED, `consent_confirmed BOOLEAN NOT NULL DEFAULT false`, `created_by UUID` (soft to platform_users). Signed S3 URLs with 15–60 min expiry generated at read time by the Step 5 service.
5. **`mtg_recording_consents`** — Per-(recording, participant) consent row. `recording_id UUID NOT NULL FK to mtg_recordings(id) ON DELETE CASCADE`, `participant_id UUID NOT NULL` (soft to platform_users), `consent_given BOOLEAN NOT NULL`, `consented_at TIMESTAMPTZ NOT NULL DEFAULT now()`. UNIQUE(recording_id, participant_id). Step 5 RecordingService flips `mtg_recordings.consent_confirmed=true` once every meeting participant has consented (and at least one consent has been given).
6. **`mtg_iep_meeting_records`** — **CROSS-CYCLE INTEGRATION KEYSTONE.** `meeting_id UUID NOT NULL FK to mtg_meetings(id) ON DELETE CASCADE` + UNIQUE(meeting_id), `student_id UUID NOT NULL` (soft to sis_students per ADR-001/020), `iep_plan_id UUID` nullable (soft to Cycle 10 hlth_iep_plans), `attendee_roles JSONB NOT NULL DEFAULT '[]'::jsonb` (structured `[{personId, role, name}]`), `outcomes_summary TEXT`, `next_review_date DATE` nullable, `recorded_by UUID` (soft to platform_users), `created_at` + `updated_at`. Resolves Cycle 11's `svc_mtss_team_meetings.meeting_id` soft FK — MTSS team meetings can now reference real `mtg_meetings(id)` rows.

**FK summary:** 6 new DB-enforced FKs (all CASCADE on meeting → child) plus 1 CASCADE on `mtg_recording_consents.recording_id`. 0 cross-schema FKs.

**Tenant logical base table count after Step 2:** 211 → **217** (6 new logical base tables). Cycle 15 schema phase total: **11 mtg\_\* tables** across migrations 053 + 054 + 11 intra-tenant FKs (4 + 7).

---

## Step 3 — Seed Data — Conference, Meetings, Slots, Notes, IEP Record

**Status:** DONE on 2026-05-06.

**Seed target:** `packages/database/src/seed-meetings.ts` (idempotent, gated on `mtg_meeting_types` row count for the demo school) wired as `seed:meetings` in `package.json`.

**What gets seeded:**

1. **4 meeting types** — Parent-Teacher Conference (15min), Staff Meeting (60min), IEP Review (45min, video=true), Department Meeting (30min).
2. **1 conference event** — "Spring Parent-Teacher Conferences 2026" PARENT_TEACHER status=SCHEDULED, May 20–21.
3. **2 meetings** — (1) PTC meeting under the conference (Rivera as organiser, COMPLETED). (2) IEP review (Hayes as organiser, COMPLETED).
4. **6 PTC time slots** — 3 per day across May 20–21 (15min each, 3:00 / 3:15 / 3:30 PM). Slot #1 (May 20 3:00) booked by David Chen with `booked_chk` lockstep verified. The other 5 are available.
5. **4 meeting participants** — PTC: Rivera HOST + David Chen ATTENDEE attended=true. IEP: Hayes HOST + Mitchell PRESENTER attended=true.
6. **2 agenda items** — IEP meeting: "Review current goals progress" sort=0 + "Discuss accommodation adjustments" sort=1.
7. **2 meeting notes** — PTC: `is_parent_visible=true, is_approved=true`, parent summary populated. IEP: `is_parent_visible=false` (sensitive content stays staff-side).
8. **3 action items** — PTC: Rivera "Send reading materials" OPEN due+7d + David "Practice multiplication at home" OPEN. IEP: Hayes "Update accommodation plan" DONE.
9. **1 IEP meeting record** — links to Maya's Cycle 10 IEP plan, attendee_roles JSONB with Hayes (counsellor) + Mitchell (admin), outcomes_summary, next_review_date.

**`seed-iam.ts` updates:**

- MTG-001:read to Teacher / Parent / Student / Staff (view meetings + my schedule)
- MTG-001:write to Teacher / Staff (create meetings, manage agenda)
- MTG-002:read to Teacher / Parent (view conference schedule + own bookings)
- MTG-002:write to Teacher (set availability, create slots)
- MTG-002:admin to Admin only via `everyFunction`

**Catalogue stays at 450** (MTG-001 + MTG-002 already in `permissions.json`).

---

## Step 4 — Conference + Meeting NestJS Module

**Status:** DONE on 2026-05-06.

**Module:** `apps/api/src/meetings/` with MeetingsModule + ConferenceService + MeetingService + SlotService + matching controllers + DTO module. Wired into AppModule. Imports TenantModule + IamModule + KafkaModule.

**~14 endpoints:**

- ConferenceService — `GET /meetings/conferences`, `GET /meetings/conferences/:id`, `POST /meetings/conferences` admin, `PATCH /meetings/conferences/:id` admin status transitions
- MeetingService — `GET /meetings` (my meetings: organiser OR participant), `GET /meetings/:id`, `POST /meetings`, `PATCH /meetings/:id` (reschedule + status with locked-row tx), `POST /meetings/:id/participants`, `DELETE /meeting-participants/:id`
- SlotService — `GET /meetings/:id/slots`, `POST /meetings/:id/slots` (bulk create), `PATCH /meeting-slots/:id/book` (PARENT KEYSTONE — `SELECT FOR UPDATE` + auto-create participant row), `PATCH /meeting-slots/:id/cancel`

**Kafka emit:** `mtg.meeting.scheduled` on meeting creation per ADR-057.

---

## Step 5 — Notes + Actions + Recording NestJS Module

**Status:** DONE on 2026-05-06.

**Services:** MeetingNotesService (parent-vis gate keystone), AgendaService, ActionItemService, RecordingService. ~14 endpoints.

- Notes: `GET /meetings/:id/notes` applies parent-vis gate (parent sees parent_visible_summary or notes_text only when `is_parent_visible=true AND is_approved=true`; staff sees full; student sees nothing); POST/PATCH/approve.
- Agenda: standard CRUD per meeting.
- Action items: `GET /meeting-action-items` ("my action items" — assignee_id = me), POST/PATCH (assignees can update their own status; meeting organiser/admin can update anyone's).
- Recording: GET (signed S3 URL only when `consent_confirmed=true`), POST placeholder, `POST /meeting-recordings/:id/consent` (participant gives/withholds; service auto-flips `consent_confirmed=true` when every meeting participant has a `consent_given=true` row).

---

## Step 6 — IEP Meeting + Cross-Cycle Integration

**Status:** DONE on 2026-05-06.

**Service:** IepMeetingRecordService. ~4 endpoints. Cross-cycle integration keystone — IEP records gate on `hlt-001:read` since IEP data is health-sensitive; counsellor sees own caseload students; admin sees all.

- `GET /meetings/:id/iep-record`, `POST /meetings/:id/iep-record` (counsellor/admin), `PATCH /meeting-iep-records/:id`, `GET /meeting-iep-records` (admin all / counsellor own caseload).

This service resolves Cycle 11's `svc_mtss_team_meetings.meeting_id` soft FK — MTSS team meetings can now reference real `mtg_meetings(id)` rows.

---

## Step 7 — Meetings UI — Calendar + Conference Booking

**Status:** DONE on 2026-05-06.

**Routes:**

- `/meetings` — dashboard (Meetings app tile gated on mtg-001:read). Persona-aware: staff sees upcoming meetings + conference management. Parent sees upcoming conferences with "Book a slot" CTA + own appointments + own action items.
- `/meetings/[id]` — detail card with type/date/status/organiser/video link, participants, agenda, notes (gated), action items, recording panel (Step 9).
- `/meetings/conferences/[id]` — **PARENT BOOKING GRID KEYSTONE**. Time-slot matrix (rows = slots, cols = teachers) with available/booked/my-booking pills. Click-to-book on available slots. Teacher sees their own column with "Add slots" bulk-create form.
- `/meetings/calendar` — weekly view of meetings where actor is participant or organiser.

---

## Step 8 — Notes Editor + Actions + IEP + Parent Portal

**Status:** DONE on 2026-05-06.

**Surfaces:**

- Notes editor inline on `/meetings/[id]` — rich-text textarea for `notes_text`, parent-visibility toggle with amber warning, separate parent-summary textarea (visible when toggle on), Approve button (irreversible). IEP-linked meetings show a rose warning recommending `is_parent_visible=false` for sensitive content.
- `/meetings/action-items` — "my action items" with status filter chips, due-date sort, overdue tinting. Status toggle.
- IEP meeting view inline on `/meetings/[id]` for IEP-type meetings — student card, linked Cycle 10 IEP plan summary, attendee roles grid, outcomes, next review date. Visible only to staff with hlt-001:read.
- `/children/[id]/meetings` — parent conference portal with upcoming conferences + booked appointments + parent-visible notes + action items assigned to parent + past history.

---

## Step 9 — Recording + Consent UI

**Status:** DONE on 2026-05-06.

- Recording panel inline on `/meetings/[id]` — status pill (PROCESSING amber / AVAILABLE emerald / FAILED rose), consent status bar showing N of M participants consented. Playback when `consent_confirmed=true`; "available once all consent" otherwise.
- Consent modal — opens on first view of a recorded meeting. Accept/Decline. Decline sets `consent_given=false`; recording remains inaccessible until all participants consent.
- Staff-only upload placeholder — creates `mtg_recordings` row with `status=PROCESSING`. S3 upload integration deferred.

---

## Step 10 — Vertical Slice Integration Test

**Status:** DONE on 2026-05-06.

**CAT script target:** `docs/cycle15-cat-script.md`. Tag `cycle15-complete` after CI green.

---

## Cycle 15 Completion Criteria

1. Tenant schema: 11 new tables (5 conference/meeting + 6 notes/recording/IEP). Tenant table count: 206 → ~217.
2. Meetings API: ~32 endpoints with parent self-service slot booking + parent-visibility notes gate.
3. PTC slot booking with double-book prevention via SELECT FOR UPDATE.
4. Meeting notes with two-layer parent-visibility (`is_parent_visible` + `is_approved` + optional parent summary).
5. Action items with cross-persona assignees (staff + parent).
6. Recording consent tracking — all participants must consent before recording is accessible.
7. IEP meeting records linking to Cycle 10 health plans + resolving Cycle 11 MTSS soft FK.
8. `mtg.meeting.scheduled` Kafka emit.
9. HANDOFF-CYCLE15.md and CLAUDE.md updated. CI green.
