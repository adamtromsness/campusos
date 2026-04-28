/* 017_sch_calendar_and_coverage.sql
 * Cycle 5 Step 3 — School calendar, day overrides, coverage requests, and the
 * substitution timetable. This is the schema the Step 6 CoverageConsumer
 * writes to when it consumes hr.leave.coverage_needed from Cycle 4.
 *
 * Four tables:
 *   sch_calendar_events      — published / draft calendar entries spanning one
 *                                or more dates. event_type catalogues the kind
 *                                (HOLIDAY, PROFESSIONAL_DEVELOPMENT, etc).
 *                                bell_schedule_id is an optional override that
 *                                pins this event to a non-default schedule.
 *                                affects_attendance flips the attendance
 *                                pre-population off for the date range. Time
 *                                consistency CHECK keeps all_day in lockstep
 *                                with start_time and end_time.
 *   sch_calendar_day_overrides — per-(school, date) override that takes
 *                                precedence over the default bell schedule.
 *                                is_school_day=false closes the school for the
 *                                day (snow day, emergency closure). The
 *                                CalendarService resolution order is override
 *                                first, then calendar event, then default bell
 *                                schedule.
 *   sch_coverage_requests    — one row per (timetable_slot, coverage_date) the
 *                                CoverageConsumer creates from an approved
 *                                leave. Status lifecycle OPEN -> ASSIGNED ->
 *                                COVERED, plus a terminal CANCELLED. The
 *                                multi-column CHECK keeps assigned_substitute
 *                                and assigned_at in sync with status — OPEN
 *                                requires both NULL, ASSIGNED and COVERED
 *                                require both NOT NULL, CANCELLED is
 *                                unconstrained because a request can be
 *                                cancelled either before or after assignment
 *                                and both audit shapes are legitimate.
 *   sch_substitution_timetable — concrete substitution rows. One row per
 *                                (original_slot, effective_date) when a
 *                                substitute is assigned. The substitute sees
 *                                this row in their daily schedule. Cascades on
 *                                coverage_request_id because a substitution
 *                                without its parent request is meaningless.
 *
 * DB-enforced FKs (intra-tenant):
 *   sch_calendar_events.bell_schedule_id           -> sch_bell_schedules(id)
 *   sch_calendar_day_overrides.bell_schedule_id    -> sch_bell_schedules(id)
 *   sch_coverage_requests.timetable_slot_id        -> sch_timetable_slots(id)
 *   sch_coverage_requests.absent_teacher_id        -> hr_employees(id)
 *   sch_coverage_requests.assigned_substitute_id   -> hr_employees(id) nullable
 *   sch_substitution_timetable.original_slot_id    -> sch_timetable_slots(id)
 *   sch_substitution_timetable.substitute_id       -> hr_employees(id)
 *   sch_substitution_timetable.room_id             -> sch_rooms(id)
 *   sch_substitution_timetable.coverage_request_id -> sch_coverage_requests(id) ON DELETE CASCADE
 *
 * Soft cross-schema refs per ADR-001/020:
 *   sch_calendar_events.school_id, sch_calendar_day_overrides.school_id,
 *   sch_coverage_requests.school_id, sch_substitution_timetable.school_id
 *     -> platform.schools(id)
 *   sch_calendar_events.created_by -> platform.platform_users(id)
 *   sch_coverage_requests.leave_request_id -> hr_leave_requests(id)  -- intra-
 *     tenant but kept soft to leave the seed flexible (the seed in Step 4 may
 *     create a coverage request for a leave that is not yet in the table on a
 *     fresh provision, since the live CoverageConsumer creates it from the
 *     event payload not from a synchronous DB lookup).
 *
 * Block-comment style required per the splitter quirk — line-comment headers
 * cause the first statement to be filtered. No semicolons inside any string
 * literal, default expression, COMMENT, or CHECK predicate — splitter cuts on
 * every semicolon regardless of quoting context. Idempotent — safe to re-run.
 */
CREATE TABLE IF NOT EXISTS sch_calendar_events (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    event_type TEXT NOT NULL DEFAULT 'CUSTOM',
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    all_day BOOLEAN NOT NULL DEFAULT true,
    start_time TIME,
    end_time TIME,
    bell_schedule_id UUID REFERENCES sch_bell_schedules(id),
    affects_attendance BOOLEAN NOT NULL DEFAULT false,
    is_published BOOLEAN NOT NULL DEFAULT false,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sch_calendar_events_type_chk CHECK (event_type IN ('HOLIDAY','PROFESSIONAL_DEVELOPMENT','EARLY_DISMISSAL','ASSEMBLY','EXAM_PERIOD','PARENT_EVENT','FIELD_TRIP','CUSTOM')),
    CONSTRAINT sch_calendar_events_dates_chk CHECK (end_date >= start_date),
    CONSTRAINT sch_calendar_events_time_consistency_chk CHECK (
        (all_day = true AND start_time IS NULL AND end_time IS NULL)
        OR
        (all_day = false AND start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time)
    )
);
CREATE INDEX IF NOT EXISTS sch_calendar_events_school_dates_idx ON sch_calendar_events(school_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS sch_calendar_events_school_published_idx ON sch_calendar_events(school_id, start_date) WHERE is_published = true;
CREATE INDEX IF NOT EXISTS sch_calendar_events_bell_schedule_idx ON sch_calendar_events(bell_schedule_id) WHERE bell_schedule_id IS NOT NULL;
COMMENT ON COLUMN sch_calendar_events.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN sch_calendar_events.event_type IS 'Catalogue tag — HOLIDAY closes the school, PROFESSIONAL_DEVELOPMENT and EARLY_DISMISSAL change the school day shape, ASSEMBLY / EXAM_PERIOD / PARENT_EVENT / FIELD_TRIP describe contents of an otherwise normal day, CUSTOM is the catch-all.';
COMMENT ON COLUMN sch_calendar_events.bell_schedule_id IS 'Optional override — if set, the school runs this bell schedule for the date range instead of the default. NULL means use the default schedule (or whichever sch_calendar_day_overrides row applies).';
COMMENT ON COLUMN sch_calendar_events.affects_attendance IS 'When true, attendance pre-population skips this date range. The Cycle 1 attendance pipeline reads this flag before generating per-class daily rows.';
COMMENT ON COLUMN sch_calendar_events.created_by IS 'Soft FK to platform.platform_users(id) per ADR-055 — admin who authored the event.';

CREATE TABLE IF NOT EXISTS sch_calendar_day_overrides (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    override_date DATE NOT NULL,
    bell_schedule_id UUID REFERENCES sch_bell_schedules(id),
    is_school_day BOOLEAN NOT NULL DEFAULT true,
    reason TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sch_calendar_day_overrides_school_date_uq UNIQUE (school_id, override_date)
);
CREATE INDEX IF NOT EXISTS sch_calendar_day_overrides_school_idx ON sch_calendar_day_overrides(school_id, override_date);
COMMENT ON COLUMN sch_calendar_day_overrides.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN sch_calendar_day_overrides.bell_schedule_id IS 'Override the default bell schedule for this single date. NULL is permitted — meaningful when is_school_day=false (closure days do not need a schedule).';
COMMENT ON COLUMN sch_calendar_day_overrides.is_school_day IS 'false closes the school (snow day, emergency closure). The CalendarService resolution order is this override first, then a matching sch_calendar_events row, then the default bell schedule.';
COMMENT ON COLUMN sch_calendar_day_overrides.created_by IS 'Soft FK to platform.platform_users(id) per ADR-055 — admin who logged the override.';

CREATE TABLE IF NOT EXISTS sch_coverage_requests (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    timetable_slot_id UUID NOT NULL REFERENCES sch_timetable_slots(id),
    absent_teacher_id UUID NOT NULL REFERENCES hr_employees(id),
    leave_request_id UUID,
    coverage_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    assigned_substitute_id UUID REFERENCES hr_employees(id),
    assigned_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sch_coverage_requests_status_chk CHECK (status IN ('OPEN','ASSIGNED','COVERED','CANCELLED')),
    CONSTRAINT sch_coverage_requests_slot_date_uq UNIQUE (timetable_slot_id, coverage_date),
    CONSTRAINT sch_coverage_requests_assignment_chk CHECK (
        (status = 'OPEN' AND assigned_substitute_id IS NULL AND assigned_at IS NULL)
        OR
        (status IN ('ASSIGNED','COVERED') AND assigned_substitute_id IS NOT NULL AND assigned_at IS NOT NULL)
        OR
        (status = 'CANCELLED')
    )
);
CREATE INDEX IF NOT EXISTS sch_coverage_requests_school_date_status_idx ON sch_coverage_requests(school_id, coverage_date, status);
CREATE INDEX IF NOT EXISTS sch_coverage_requests_absent_teacher_idx ON sch_coverage_requests(absent_teacher_id, coverage_date);
CREATE INDEX IF NOT EXISTS sch_coverage_requests_substitute_idx ON sch_coverage_requests(assigned_substitute_id, coverage_date) WHERE assigned_substitute_id IS NOT NULL;
COMMENT ON COLUMN sch_coverage_requests.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN sch_coverage_requests.absent_teacher_id IS 'DB-enforced FK to hr_employees(id) — the teacher whose absence drove this request. Cycle 4 Step 0 staff identity convention.';
COMMENT ON COLUMN sch_coverage_requests.leave_request_id IS 'Soft FK to hr_leave_requests(id) — the approved leave that fired hr.leave.coverage_needed and produced this row. Soft because the seed in Step 4 may instantiate a coverage row before its leave row exists.';
COMMENT ON COLUMN sch_coverage_requests.assigned_substitute_id IS 'DB-enforced FK to hr_employees(id) — the staff member assigned to cover. NULL while status=OPEN, NOT NULL once status flips to ASSIGNED or COVERED. May remain set on CANCELLED for audit.';

CREATE TABLE IF NOT EXISTS sch_substitution_timetable (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    original_slot_id UUID NOT NULL REFERENCES sch_timetable_slots(id),
    effective_date DATE NOT NULL,
    substitute_id UUID NOT NULL REFERENCES hr_employees(id),
    room_id UUID NOT NULL REFERENCES sch_rooms(id),
    coverage_request_id UUID NOT NULL REFERENCES sch_coverage_requests(id) ON DELETE CASCADE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sch_substitution_timetable_slot_date_uq UNIQUE (original_slot_id, effective_date)
);
CREATE INDEX IF NOT EXISTS sch_substitution_timetable_substitute_idx ON sch_substitution_timetable(substitute_id, effective_date);
CREATE INDEX IF NOT EXISTS sch_substitution_timetable_request_idx ON sch_substitution_timetable(coverage_request_id);
CREATE INDEX IF NOT EXISTS sch_substitution_timetable_school_date_idx ON sch_substitution_timetable(school_id, effective_date);
COMMENT ON COLUMN sch_substitution_timetable.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN sch_substitution_timetable.substitute_id IS 'DB-enforced FK to hr_employees(id) — the staff member covering the original slot for this date. Cycle 4 Step 0 staff identity convention.';
COMMENT ON COLUMN sch_substitution_timetable.room_id IS 'DB-enforced FK to sch_rooms(id). Usually matches the original slot room but may differ if the cover requires a relocation.';
COMMENT ON COLUMN sch_substitution_timetable.coverage_request_id IS 'CASCADE — a substitution without its parent coverage request is meaningless. Deleting the request drops every substitution that materialises it.';
