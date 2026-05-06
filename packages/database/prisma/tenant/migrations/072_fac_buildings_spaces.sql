/* ============================================================
 * Cycle 21 — Step 1: Buildings + Spaces + Bookings + Closures
 * ============================================================
 *
 * 4 logical base tables for the M65 Facilities Management module
 * registry layer. The keystone here is fac_space_bookings, which
 * carries the schema-level EXCLUDE USING gist constraint that
 * prevents two CONFIRMED bookings for the same space with overlapping
 * time windows from coexisting in the database. This is stronger than
 * application-layer conflict detection because PostgreSQL guarantees
 * the invariant under any concurrency. The Step 5 BookingService
 * translates the SQLSTATE 23P01 raised by a conflict into a friendly
 * 409 Conflict response.
 *
 * btree_gist is required for the bookings EXCLUDE constraint. The
 * Cycle 5 migration 016_sch_timetable_and_bookings.sql already
 * enables it for the timetable EXCLUSIONs, so the extension is
 * already present in every tenant. This migration includes the IF
 * NOT EXISTS guard for first-time provisions all the same.
 *
 * fac_spaces.sch_room_id is a DISPLAY-ONLY soft ref to sch_rooms.id
 * per ADR-001/020 — links the facilities-side space record to the
 * scheduling-side classroom record so the timetable + booking
 * calendar can resolve names + amenities consistently. Nullable
 * because only the 6 classroom spaces carry the cross-link in the
 * seed (gym, cafeteria, corridors do not).
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. CHECK predicates, default expressions, and COMMENT
 * strings all use plain prose with em-dashes or commas where
 * punctuation would otherwise call for a semicolon.
 *
 * Idempotent — re-runs are a no-op (CREATE TABLE IF NOT EXISTS).
 * ============================================================ */

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS fac_buildings (
  id            UUID PRIMARY KEY,
  school_id     UUID NOT NULL,
  name          TEXT NOT NULL,
  code          TEXT,
  year_built    INT,
  total_floors  INT,
  address       TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_bldg_year_chk CHECK (year_built IS NULL OR year_built BETWEEN 1800 AND 2100),
  CONSTRAINT fac_bldg_floors_chk CHECK (total_floors IS NULL OR total_floors > 0),
  CONSTRAINT fac_bldg_uq UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS fac_bldg_school_active_idx
  ON fac_buildings (school_id, is_active);

COMMENT ON TABLE fac_buildings IS
  'Per-school physical building registry. UNIQUE(school_id, name) so the building name doubles as a stable handle in audit references. is_active=false soft-deactivates a retired building while preserving historical work orders and inspections. school_id is a soft FK to platform.schools per ADR-001/020.';

CREATE TABLE IF NOT EXISTS fac_spaces (
  id            UUID PRIMARY KEY,
  building_id   UUID NOT NULL,
  name          TEXT NOT NULL,
  floor         TEXT,
  space_type    TEXT NOT NULL,
  area_sqft     NUMERIC(8,1),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  sch_room_id   UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_space_type_chk CHECK (
    space_type IN (
      'CLASSROOM', 'BATHROOM', 'CORRIDOR', 'STAIRWELL', 'MECHANICAL',
      'STORAGE', 'OFFICE', 'GROUNDS', 'COMMON_AREA', 'GYM',
      'CAFETERIA', 'OTHER'
    )
  ),
  CONSTRAINT fac_space_area_chk CHECK (area_sqft IS NULL OR area_sqft >= 0),
  CONSTRAINT fac_space_uq UNIQUE (building_id, name),
  CONSTRAINT fac_space_building_fk FOREIGN KEY (building_id)
    REFERENCES fac_buildings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fac_space_bldg_type_idx
  ON fac_spaces (building_id, space_type, is_active);

CREATE INDEX IF NOT EXISTS fac_space_sch_room_idx
  ON fac_spaces (sch_room_id) WHERE sch_room_id IS NOT NULL;

COMMENT ON TABLE fac_spaces IS
  'Per-building physical space catalogue. 12-value space_type CHECK covers classrooms, bathrooms, corridors, mechanical rooms, gyms, cafeterias, common areas, and an OTHER bucket. UNIQUE(building_id, name) so room numbers are unique within a building. CASCADE on building delete since spaces are meaningless without their building (admin should soft-deactivate the building instead — is_active=false on fac_buildings).';

COMMENT ON COLUMN fac_spaces.sch_room_id IS
  'DISPLAY-ONLY soft ref to sch_rooms.id per ADR-001/020. Links the facilities-side space record to the scheduling-side classroom record so the timetable + booking calendar can resolve names + amenities consistently. Nullable because only the classroom spaces carry the cross-link (gym, cafeteria, corridors do not).';

CREATE TABLE IF NOT EXISTS fac_space_bookings (
  id            UUID PRIMARY KEY,
  space_id      UUID NOT NULL,
  booked_by     UUID NOT NULL,
  title         TEXT NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'CONFIRMED',
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_booking_status_chk CHECK (status IN ('CONFIRMED', 'CANCELLED', 'COMPLETED')),
  CONSTRAINT fac_booking_time_chk CHECK (ends_at > starts_at),
  CONSTRAINT fac_booking_space_fk FOREIGN KEY (space_id)
    REFERENCES fac_spaces(id) ON DELETE NO ACTION,
  CONSTRAINT fac_booking_no_overlap EXCLUDE USING gist (
    space_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status = 'CONFIRMED')
);

CREATE INDEX IF NOT EXISTS fac_booking_space_starts_idx
  ON fac_space_bookings (space_id, starts_at);

CREATE INDEX IF NOT EXISTS fac_booking_actor_idx
  ON fac_space_bookings (booked_by, starts_at DESC);

COMMENT ON TABLE fac_space_bookings IS
  'KEYSTONE — schema-level temporal overlap prevention via EXCLUDE USING gist. Two CONFIRMED bookings for the same space with overlapping tstzrange windows can NEVER coexist in the database. The partial WHERE status=CONFIRMED clause means CANCELLED and COMPLETED bookings drop out of the index so a follow-up CONFIRMED booking on the same window is accepted. Multi-column time_chk requires ends_at > starts_at. Soft FK booked_by points at platform.iam_person per ADR-001/020. NO ACTION on space delete forces admins to cancel bookings before retiring a space.';

COMMENT ON CONSTRAINT fac_booking_no_overlap ON fac_space_bookings IS
  'EXCLUSION constraint backing the booking conflict gate. The Step 5 BookingService translates SQLSTATE 23P01 raised by a conflict into a 409 Conflict response with a friendly explanation of the overlap.';

CREATE TABLE IF NOT EXISTS fac_space_closures (
  id                     UUID PRIMARY KEY,
  school_id              UUID NOT NULL,
  space_id               UUID NOT NULL,
  closure_reason         TEXT NOT NULL,
  starts_at              TIMESTAMPTZ NOT NULL,
  ends_at                TIMESTAMPTZ,
  affects_scheduling     BOOLEAN NOT NULL DEFAULT true,
  linked_work_order_id   UUID,
  created_by             UUID NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_closure_time_chk CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT fac_closure_space_fk FOREIGN KEY (space_id)
    REFERENCES fac_spaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fac_closure_space_starts_idx
  ON fac_space_closures (space_id, starts_at);

CREATE INDEX IF NOT EXISTS fac_closure_indefinite_idx
  ON fac_space_closures (school_id, starts_at DESC)
  WHERE ends_at IS NULL;

CREATE INDEX IF NOT EXISTS fac_closure_school_ends_idx
  ON fac_space_closures (school_id, ends_at);

COMMENT ON TABLE fac_space_closures IS
  'Temporary or indefinite space closure record. ends_at NULL means the closure is open-ended and the partial indefinite_idx surfaces it on the active-closures dashboard at constant cost. The companion (school_id, ends_at) index supports the time-bounded active query at the service layer (now() is not IMMUTABLE so it cannot live in a partial index predicate — the service filters at query time instead). affects_scheduling=true is an ADVISORY signal for Cycle 5 scheduling — the timetable will not auto-block lessons but the UI surfaces a warning. linked_work_order_id is a soft polymorphic ref to fac_work_orders that ships in Cycle 21 Step 2 — NOT a DB-enforced FK because the work order may not exist when the closure is created. CASCADE on space delete.';

COMMENT ON COLUMN fac_space_closures.linked_work_order_id IS
  'Soft polymorphic ref to fac_work_orders(id) per ADR-001/020. Populated when a closure is driven by a tracked repair so the work order detail page can surface the closure. The FK is intentionally not enforced — the closure may be authored before the work order is opened.';

COMMENT ON COLUMN fac_space_closures.created_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. Records the FM or admin who created the closure. NOT NULL because every closure must carry an audit identity.';
