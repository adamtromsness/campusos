/* 119_enr_tours
 *
 * Phase 2 Cycle 5 (P2-5) Step 1 — Campus Tours.
 *
 * Plan reference — docs/campusos-p2c5-enrolment-advanced.html Step 1.
 *
 * 3 tables completing the campus tour scheduling surface that the
 * Cycle 16 enrolment module (M81 Admissions) deferred:
 *
 *   enr_tour_slots          — per-school tour calendar. Group slots
 *                             carry max_bookings greater than 1, and
 *                             current_bookings is bumped by the
 *                             TourBookingService inside a locked tx.
 *                             A partial INDEX on the published and
 *                             non-cancelled rows backs the public
 *                             slot picker hot path.
 *   enr_tour_bookings       — one row per (slot, booked_by) per
 *                             ADR-055 the booked_by column is the
 *                             iam_person id created at booking when
 *                             the prospective family has no account.
 *                             Cross-schema soft ref per ADR-001/020.
 *                             Multi-column cancelled_chk lockstep
 *                             keeps status and cancelled_at and
 *                             cancellation_reason in sync.
 *                             linked_application_id closes the loop
 *                             when the family later submits a full
 *                             application via Cycle 16's pipeline.
 *   enr_tour_booking_guests — per-booking guest manifest with a
 *                             3-value guest_type CHECK so a tour
 *                             can plan for adults, children, and the
 *                             prospective student.
 *
 * Splitter rules — no semicolons inside any block comment header,
 * single-quoted string, or COMMENT ON ... text. Use commas, em
 * dashes, or "and" in narrative text instead.
 */

CREATE TABLE IF NOT EXISTS enr_tour_slots (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    tour_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    max_bookings INT NOT NULL DEFAULT 1,
    current_bookings INT NOT NULL DEFAULT 0,
    tour_type TEXT NOT NULL DEFAULT 'INDIVIDUAL_FAMILY_TOUR',
    led_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
    meeting_point TEXT,
    notes TEXT,
    is_published BOOLEAN NOT NULL DEFAULT false,
    is_cancelled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_tour_slots_school_date_time_uq UNIQUE (school_id, tour_date, start_time),
    CONSTRAINT enr_tour_slots_type_chk
      CHECK (tour_type IN (
        'GENERAL_OPEN_DAY',
        'INDIVIDUAL_FAMILY_TOUR',
        'VIRTUAL_TOUR',
        'SPECIALIST_TOUR'
      )),
    CONSTRAINT enr_tour_slots_window_chk
      CHECK (end_time > start_time),
    CONSTRAINT enr_tour_slots_max_chk
      CHECK (max_bookings > 0),
    CONSTRAINT enr_tour_slots_current_chk
      CHECK (current_bookings >= 0 AND current_bookings <= max_bookings)
);

CREATE INDEX IF NOT EXISTS enr_tour_slots_published_idx
  ON enr_tour_slots(school_id, tour_date, start_time)
  WHERE is_published = true AND is_cancelled = false;

CREATE INDEX IF NOT EXISTS enr_tour_slots_school_date_idx
  ON enr_tour_slots(school_id, tour_date);

COMMENT ON COLUMN enr_tour_slots.led_by IS
  'Optional FK to hr_employees(id) — the staff member leading the tour. SET NULL on employee removal so the historical slot survives staff turnover.';

COMMENT ON COLUMN enr_tour_slots.current_bookings IS
  'Bumped by TourBookingService inside a locked tx. Capped at max_bookings by current_chk so a race cannot oversell.';

CREATE TABLE IF NOT EXISTS enr_tour_bookings (
    id UUID PRIMARY KEY,
    slot_id UUID NOT NULL REFERENCES enr_tour_slots(id) ON DELETE CASCADE,
    school_id UUID NOT NULL,
    booked_by UUID NOT NULL,
    family_name TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    contact_phone TEXT,
    status TEXT NOT NULL DEFAULT 'CONFIRMED',
    booked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT,
    linked_application_id UUID REFERENCES enr_applications(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_tour_bookings_slot_person_uq UNIQUE (slot_id, booked_by),
    CONSTRAINT enr_tour_bookings_status_chk
      CHECK (status IN ('CONFIRMED', 'CANCELLED', 'NO_SHOW', 'COMPLETED')),
    CONSTRAINT enr_tour_bookings_cancelled_chk
      CHECK (
        (status = 'CANCELLED'
          AND cancelled_at IS NOT NULL
          AND cancellation_reason IS NOT NULL
          AND length(trim(cancellation_reason)) > 0)
        OR (status <> 'CANCELLED'
          AND cancelled_at IS NULL
          AND cancellation_reason IS NULL)
      )
);

CREATE INDEX IF NOT EXISTS enr_tour_bookings_booked_by_idx
  ON enr_tour_bookings(booked_by, booked_at DESC);

CREATE INDEX IF NOT EXISTS enr_tour_bookings_slot_idx
  ON enr_tour_bookings(slot_id, status);

CREATE INDEX IF NOT EXISTS enr_tour_bookings_school_status_idx
  ON enr_tour_bookings(school_id, status);

CREATE INDEX IF NOT EXISTS enr_tour_bookings_linked_app_idx
  ON enr_tour_bookings(linked_application_id)
  WHERE linked_application_id IS NOT NULL;

COMMENT ON COLUMN enr_tour_bookings.booked_by IS
  'Tenant-local soft reference to platform.iam_person(id) per ADR-001/020. The TourBookingService creates the iam_person row at first booking when the prospective family has no CampusOS account per ADR-055.';

COMMENT ON COLUMN enr_tour_bookings.linked_application_id IS
  'Optional soft FK to enr_applications(id). EO links a tour booking to a later admission application via the Cycle 16 pipeline. SET NULL on application removal so historical tour records survive.';

CREATE TABLE IF NOT EXISTS enr_tour_booking_guests (
    id UUID PRIMARY KEY,
    booking_id UUID NOT NULL REFERENCES enr_tour_bookings(id) ON DELETE CASCADE,
    guest_type TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    age INT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_tour_booking_guests_type_chk
      CHECK (guest_type IN ('ADULT', 'CHILD', 'PROSPECTIVE_STUDENT')),
    CONSTRAINT enr_tour_booking_guests_age_chk
      CHECK (age IS NULL OR (age >= 0 AND age <= 130))
);

CREATE INDEX IF NOT EXISTS enr_tour_booking_guests_booking_idx
  ON enr_tour_booking_guests(booking_id);
