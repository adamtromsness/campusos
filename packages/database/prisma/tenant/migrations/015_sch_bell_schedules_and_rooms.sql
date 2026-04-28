/* 015_sch_bell_schedules_and_rooms.sql
 * Cycle 5 Step 1 — Scheduling foundation.
 *
 * Three tables:
 *   sch_bell_schedules — per-school catalogue of named schedules (Standard
 *                         Day, Early Dismissal, Exam, etc). schedule_type
 *                         enum + is_default flag. UNIQUE(school_id, name)
 *                         and a partial UNIQUE(school_id) WHERE is_default
 *                         so a school holds at most one default schedule.
 *   sch_periods        — periods within a bell schedule. day_of_week is
 *                         nullable (0..6 Mon..Sun) so future rotation-driven
 *                         schedules (Cycle 5b sch_rotation_cycles) can leave
 *                         it blank without changing this schema. start_time
 *                         and end_time are TIME with start < end CHECK and a
 *                         period_type enum (LESSON, BREAK, LUNCH, etc).
 *                         UNIQUE(bell_schedule_id, COALESCE(day_of_week,-1),
 *                         start_time) so two periods cannot share a start
 *                         time within a (schedule, day).
 *   sch_rooms          — per-school room catalogue. room_type enum, optional
 *                         capacity, has_projector / has_av amenity flags,
 *                         optional fac_space_id soft DISPLAY-ONLY ref to a
 *                         future fac_spaces table (M52 Facilities). Room is
 *                         the schedulable target for sch_timetable_slots and
 *                         sch_room_bookings — both land in Step 2.
 *
 * One intra-tenant DB-enforced FK: sch_periods.bell_schedule_id references
 * sch_bell_schedules ON DELETE CASCADE. Both sides are unpartitioned and a
 * period without its parent schedule is meaningless. Cross-schema refs to
 * platform.schools are soft per ADR-001/020. fac_space_id is a soft
 * forward-compat UUID — the fac_spaces table is not in this cycle.
 *
 * No PG ENUM types — TEXT plus CHECK in lockstep with the application DTOs
 * (matches every prior cycle, since CREATE TYPE is not idempotent under the
 * SQL splitter).
 *
 * Block-comment style required per the splitter quirk — line-comment headers
 * cause the first statement to be filtered. No semicolons inside any string
 * literal or block comment — splitter cuts on every semicolon regardless of
 * quoting context. Idempotent — safe to re-run.
 */
CREATE TABLE IF NOT EXISTS sch_bell_schedules (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    schedule_type TEXT NOT NULL DEFAULT 'STANDARD',
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sch_bell_schedules_school_name_uq UNIQUE (school_id, name),
    CONSTRAINT sch_bell_schedules_type_chk CHECK (schedule_type IN ('STANDARD','EARLY_DISMISSAL','ASSEMBLY','EXAM','CUSTOM'))
);
CREATE INDEX IF NOT EXISTS sch_bell_schedules_school_idx ON sch_bell_schedules(school_id);
CREATE UNIQUE INDEX IF NOT EXISTS sch_bell_schedules_one_default_uq ON sch_bell_schedules(school_id) WHERE is_default = true;
COMMENT ON COLUMN sch_bell_schedules.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN sch_bell_schedules.schedule_type IS 'Catalogue tag. STANDARD is the everyday schedule, EARLY_DISMISSAL / ASSEMBLY / EXAM are named variants the calendar can swap in for a given day, CUSTOM covers everything else.';
COMMENT ON COLUMN sch_bell_schedules.is_default IS 'At most one default per school enforced by sch_bell_schedules_one_default_uq partial index. The CalendarService falls back to the default schedule when no day-specific override exists.';
CREATE TABLE IF NOT EXISTS sch_periods (
    id UUID PRIMARY KEY,
    bell_schedule_id UUID NOT NULL REFERENCES sch_bell_schedules(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    day_of_week SMALLINT,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    period_type TEXT NOT NULL DEFAULT 'LESSON',
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sch_periods_times_chk CHECK (start_time < end_time),
    CONSTRAINT sch_periods_dow_chk CHECK (day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6)),
    CONSTRAINT sch_periods_type_chk CHECK (period_type IN ('LESSON','BREAK','LUNCH','REGISTRATION','ASSEMBLY'))
);
CREATE INDEX IF NOT EXISTS sch_periods_schedule_sort_idx ON sch_periods(bell_schedule_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS sch_periods_schedule_dow_start_uq ON sch_periods(bell_schedule_id, COALESCE(day_of_week, -1), start_time);
COMMENT ON COLUMN sch_periods.day_of_week IS 'ISO-style 0=Mon .. 6=Sun. NULL means rotation-driven (Cycle 5b sch_rotation_cycles will own that linkage) — the COALESCE -1 in the UNIQUE index keeps a NULL-day period from clashing with a Monday period that shares a start time.';
COMMENT ON COLUMN sch_periods.period_type IS 'LESSON is teachable time. BREAK / LUNCH / REGISTRATION / ASSEMBLY are non-teaching slots — the timetable slot creator in Step 5 only allows class assignment to LESSON-type periods.';
CREATE TABLE IF NOT EXISTS sch_rooms (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    capacity INT,
    room_type TEXT NOT NULL DEFAULT 'CLASSROOM',
    has_projector BOOLEAN NOT NULL DEFAULT false,
    has_av BOOLEAN NOT NULL DEFAULT false,
    floor TEXT,
    building TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    fac_space_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sch_rooms_school_name_uq UNIQUE (school_id, name),
    CONSTRAINT sch_rooms_type_chk CHECK (room_type IN ('CLASSROOM','LAB','GYM','HALL','LIBRARY','OFFICE','OUTDOOR')),
    CONSTRAINT sch_rooms_capacity_chk CHECK (capacity IS NULL OR capacity >= 0)
);
CREATE INDEX IF NOT EXISTS sch_rooms_school_active_idx ON sch_rooms(school_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS sch_rooms_type_idx ON sch_rooms(room_type);
COMMENT ON COLUMN sch_rooms.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN sch_rooms.fac_space_id IS 'DISPLAY-ONLY soft ref to a future fac_spaces(id) row (M52 Facilities). Unenforced and nullable so the M52 module can layer richer space hierarchy underneath without touching this schema.';
COMMENT ON COLUMN sch_rooms.capacity IS 'Optional headcount limit. NULL means unspecified — the timetable slot creator surfaces a warning when an enrolled class exceeds the room capacity but does not block.';
