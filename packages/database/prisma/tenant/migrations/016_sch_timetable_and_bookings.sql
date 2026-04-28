/* 016_sch_timetable_and_bookings.sql
 * Cycle 5 Step 2 — Timetable slots, room bookings, room change requests.
 *
 * Three tables:
 *   sch_timetable_slots       — the master schedule. One row per (class,
 *                                period) with the teacher and room currently
 *                                assigned. effective_from and effective_to
 *                                let a slot describe a date range — use NULL
 *                                effective_to for an open-ended assignment.
 *                                Two EXCLUSION constraints (one for teacher
 *                                double-booking, one for room double-booking)
 *                                catch conflicts at the schema layer using
 *                                btree_gist plus daterange overlap.
 *   sch_room_bookings         — ad-hoc room bookings outside the timetable
 *                                (e.g. parent evening, club meeting). Status
 *                                is CONFIRMED or CANCELLED. The application
 *                                cross-checks sch_timetable_slots before
 *                                confirming, but the schema itself does not
 *                                bind a booking to a slot — overlap with the
 *                                regular timetable is handled at the request
 *                                layer (RoomBookingService.checkConflict).
 *   sch_room_change_requests  — teacher-submitted requests to move a class to
 *                                a different room for a specific date. Once
 *                                APPROVED the application creates a one-day
 *                                timetable override row in Step 6.
 *
 * Two intra-tenant DB-enforced FKs land here that are central to Step 5 and
 * Step 6 query plans:
 *   sch_timetable_slots.period_id     -> sch_periods(id)
 *   sch_timetable_slots.room_id       -> sch_rooms(id)
 *   sch_timetable_slots.class_id      -> sis_classes(id)
 *   sch_timetable_slots.teacher_id    -> hr_employees(id)  nullable
 *   sch_room_bookings.room_id         -> sch_rooms(id)
 *   sch_room_change_requests.timetable_slot_id -> sch_timetable_slots(id)
 *   sch_room_change_requests.current_room_id   -> sch_rooms(id)
 *   sch_room_change_requests.requested_room_id -> sch_rooms(id) nullable
 *
 * No cascade on most of these — deleting a class, period, or room should
 * fail loudly if a timetable slot still references it. Step 5 services own
 * the lifecycle (mark a slot ineffective_to, deactivate a room, etc).
 *
 * EXCLUSION constraints require btree_gist. The extension lives at database
 * scope, so CREATE EXTENSION IF NOT EXISTS at the top of this migration is
 * idempotent across re-provisions and across multiple tenants on the same
 * database.
 *
 * Block-comment style required per the splitter quirk — no semicolons inside
 * any string literal, default expression, COMMENT, CHECK predicate, or block
 * comment. Idempotent — safe to re-run.
 */
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS sch_timetable_slots (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    class_id UUID NOT NULL REFERENCES sis_classes(id),
    period_id UUID NOT NULL REFERENCES sch_periods(id),
    teacher_id UUID REFERENCES hr_employees(id),
    room_id UUID NOT NULL REFERENCES sch_rooms(id),
    effective_from DATE NOT NULL,
    effective_to DATE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sch_timetable_slots_dates_chk CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT sch_timetable_slots_class_period_from_uq UNIQUE (class_id, period_id, effective_from),
    CONSTRAINT sch_timetable_slots_teacher_no_overlap EXCLUDE USING gist (
        teacher_id WITH =,
        period_id WITH =,
        daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)') WITH &&
    ),
    CONSTRAINT sch_timetable_slots_room_no_overlap EXCLUDE USING gist (
        room_id WITH =,
        period_id WITH =,
        daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)') WITH &&
    )
);
CREATE INDEX IF NOT EXISTS sch_timetable_slots_class_idx ON sch_timetable_slots(class_id);
CREATE INDEX IF NOT EXISTS sch_timetable_slots_teacher_idx ON sch_timetable_slots(teacher_id) WHERE teacher_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sch_timetable_slots_room_idx ON sch_timetable_slots(room_id);
CREATE INDEX IF NOT EXISTS sch_timetable_slots_period_idx ON sch_timetable_slots(period_id);
CREATE INDEX IF NOT EXISTS sch_timetable_slots_active_idx ON sch_timetable_slots(school_id) WHERE effective_to IS NULL;
COMMENT ON COLUMN sch_timetable_slots.teacher_id IS 'Soft FK to hr_employees(id) per ADR-055. Nullable so a slot can exist before the teacher is assigned (room and period can be planned ahead). NULL teachers do not conflict against other NULL teachers under the EXCLUSION constraint because the equality operator treats NULL as not-equal-to-anything.';
COMMENT ON COLUMN sch_timetable_slots.effective_to IS 'NULL means open-ended — the slot remains active indefinitely. The EXCLUSION constraint coalesces NULL into infinity so an open-ended slot blocks every future date.';
COMMENT ON COLUMN sch_timetable_slots.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON CONSTRAINT sch_timetable_slots_teacher_no_overlap ON sch_timetable_slots IS 'Teacher cannot be scheduled for two classes in the same period during overlapping date ranges. SQLSTATE 23P01 on violation — Step 5 services translate this to 409 Conflict.';
COMMENT ON CONSTRAINT sch_timetable_slots_room_no_overlap ON sch_timetable_slots IS 'Room cannot be assigned to two classes in the same period during overlapping date ranges. SQLSTATE 23P01 on violation — translated to 409 Conflict by the Step 5 service.';

CREATE TABLE IF NOT EXISTS sch_room_bookings (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    room_id UUID NOT NULL REFERENCES sch_rooms(id),
    booked_by UUID NOT NULL,
    booking_purpose TEXT NOT NULL,
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'CONFIRMED',
    cancelled_at TIMESTAMPTZ,
    cancelled_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sch_room_bookings_status_chk CHECK (status IN ('CONFIRMED','CANCELLED')),
    CONSTRAINT sch_room_bookings_window_chk CHECK (end_at > start_at),
    CONSTRAINT sch_room_bookings_cancelled_chk CHECK (
        (status = 'CONFIRMED' AND cancelled_at IS NULL AND cancelled_reason IS NULL)
        OR
        (status = 'CANCELLED' AND cancelled_at IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS sch_room_bookings_room_window_idx ON sch_room_bookings(room_id, start_at, end_at) WHERE status = 'CONFIRMED';
CREATE INDEX IF NOT EXISTS sch_room_bookings_booked_by_idx ON sch_room_bookings(booked_by);
CREATE INDEX IF NOT EXISTS sch_room_bookings_school_window_idx ON sch_room_bookings(school_id, start_at) WHERE status = 'CONFIRMED';
COMMENT ON COLUMN sch_room_bookings.booked_by IS 'Soft FK to hr_employees(id) — the staff member who reserved the room. Audit-only.';
COMMENT ON COLUMN sch_room_bookings.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';

CREATE TABLE IF NOT EXISTS sch_room_change_requests (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    timetable_slot_id UUID NOT NULL REFERENCES sch_timetable_slots(id),
    requested_by UUID NOT NULL,
    current_room_id UUID NOT NULL REFERENCES sch_rooms(id),
    requested_room_id UUID REFERENCES sch_rooms(id),
    request_date DATE NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    reviewed_by UUID,
    reviewed_at TIMESTAMPTZ,
    review_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sch_room_change_requests_status_chk CHECK (status IN ('PENDING','APPROVED','REJECTED','AUTO_APPROVED')),
    CONSTRAINT sch_room_change_requests_reviewed_chk CHECK (
        (status = 'PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL)
        OR
        (status IN ('APPROVED','REJECTED','AUTO_APPROVED') AND reviewed_at IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS sch_room_change_requests_school_status_date_idx ON sch_room_change_requests(school_id, status, request_date);
CREATE INDEX IF NOT EXISTS sch_room_change_requests_slot_idx ON sch_room_change_requests(timetable_slot_id);
CREATE INDEX IF NOT EXISTS sch_room_change_requests_requested_by_idx ON sch_room_change_requests(requested_by);
COMMENT ON COLUMN sch_room_change_requests.requested_by IS 'Soft FK to hr_employees(id) — the teacher who submitted the change request.';
COMMENT ON COLUMN sch_room_change_requests.requested_room_id IS 'NULL means "any available room" — the admin reviewer picks at approval time.';
COMMENT ON COLUMN sch_room_change_requests.reviewed_by IS 'Soft FK to platform.platform_users(id) — admin who approved or rejected. Audit-only.';
