/*
 * 138_trn_gps_fleet.sql — Phase 2 Cycle 11 sub-cycle c (P2-11c).
 *
 * M61 Transportation Advanced — GPS Telemetry plus Fleet Dashboard.
 * 7 base tables. Completes P2-11 at 22 tables across migrations 136
 * 137 138.
 *
 *   trn_vehicle_positions    high-frequency GPS telemetry. Source
 *                            from a real GPS device or from the
 *                            Transport Dispatch extracted service
 *                            when deployed. RANGE partition by
 *                            recorded_at DAILY because the volume
 *                            shape is per-vehicle insert every 10
 *                            to 30 seconds. Composite PK
 *                            id plus recorded_at because the
 *                            partition column must appear in the
 *                            unique constraint. No UPDATE and no
 *                            DELETE service surface — the row is
 *                            an immutable telemetry record. The
 *                            partition pruner walks one daily leaf
 *                            for every recent-position query and
 *                            seven daily leaves for the seven-day
 *                            hot window. Retention is ops work and
 *                            schema-only this cycle. INDEX on
 *                            vehicle_id plus recorded_at DESC backs
 *                            the latest-position lookup.
 *   trn_geofences            per-school zone definitions for school
 *                            grounds plus stops plus speed-limited
 *                            zones plus restricted areas. boundary
 *                            JSONB carries either a GeoJSON-style
 *                            polygon shape with a coordinates array
 *                            of latitude longitude pairs or a circle
 *                            shape with a center plus a radius in
 *                            metres. 4-value geofence_type CHECK.
 *                            UNIQUE on school plus name. speed
 *                            limit nullable because only SPEED_ZONE
 *                            and RESTRICTED_AREA geofences enforce a
 *                            cap.
 *   trn_geofence_events      enter and exit events fired by the
 *                            GeofenceWorker on every new position
 *                            update. 2-value event_type CHECK.
 *                            RANGE partition by recorded_at DAILY
 *                            mirroring the parent positions table
 *                            because per-vehicle per-geofence
 *                            crossing volume scales with position
 *                            volume. Composite PK id plus
 *                            recorded_at. INDEX on geofence_id plus
 *                            recorded_at DESC for the per-geofence
 *                            history hot path plus INDEX on
 *                            vehicle_id plus recorded_at DESC for
 *                            the per-vehicle history. Emits
 *                            trn.geofence.entered and
 *                            trn.geofence.exited.
 *   trn_vehicle_eta          per-vehicle per-stop ETA snapshot.
 *                            Upserted by the GeofenceWorker on every
 *                            position update or by the dispatch
 *                            integration. UNIQUE on vehicle plus
 *                            stop so the read path renders the
 *                            freshest snapshot. 3-value confidence
 *                            CHECK (HIGH MEDIUM LOW). Parent-facing
 *                            view formats this as "Your child's bus
 *                            is 8 minutes away".
 *   trn_dispatch_events      dispatcher-logged events with 8-value
 *                            event_type CHECK covering route start
 *                            and completion plus delay and breakdown
 *                            plus student no-show plus emergency
 *                            stop plus detour plus driver swap.
 *                            event_data JSONB captures free-shape
 *                            payload (lat lng plus minutes delayed
 *                            plus other context). Real-time
 *                            operations log — visible to TC.
 *   trn_parent_tracking_tokens
 *                            unauthenticated bearer token a parent
 *                            scans from a notification or a sign-in
 *                            confirmation. token TEXT UNIQUE backs
 *                            the lookup. partial UNIQUE on student
 *                            plus route plus is_active true keeps
 *                            at most one active token per
 *                            (student route) pair. expires_at
 *                            terminates the session — parents
 *                            re-issue from the parent portal. The
 *                            partial UNIQUE releases on revoke
 *                            (is_active flips to false) so a fresh
 *                            token can land for the same
 *                            (student route) pair.
 *   rpt_fleet_status         materialised nightly by the
 *                            FleetStatusWorker. One row per vehicle
 *                            with denormalised dashboard counters —
 *                            days until insurance expiry plus
 *                            registration plus MOT plus driver
 *                            licence plus incident counts plus the
 *                            last position timestamp plus the last
 *                            month fuel efficiency. UNIQUE on
 *                            vehicle_id. INDEX on school plus
 *                            maintenance_overdue for the TC fleet
 *                            health dashboard hot path.
 *
 * Soft FKs to platform_vendor_accounts and to soft cross-cycle
 * targets per ADR-001 and ADR-020 are not enforced at the schema
 * level. DB enforced FKs for the GPS chain use ON DELETE CASCADE on
 * the geofence_events child path because an event is meaningless
 * past the parent geofence delete. On trn_vehicle_eta the FK to
 * trn_stops uses ON DELETE CASCADE because the ETA row has no value
 * past stop hard-delete. On trn_parent_tracking_tokens the FK to
 * the student plus route soft refs are deliberately not enforced
 * because the token outlives both routes and student transfers.
 *
 * Daily partition window choice — the migration ships 100 daily
 * partitions covering 14 days before today through 90 days into
 * the future. The Step 6 partition-maintenance worker creates
 * forward partitions on a rolling 30-day window and retires old
 * partitions to a cold-storage table 90 days after the last write.
 * Both maintenance jobs are deferred to ops — schema-only this
 * cycle. Splitter rule — no semicolons inside string literals or
 * block comments. The tenant provisioner splits the migration on
 * every semicolon character without quoting context.
 */

CREATE TABLE IF NOT EXISTS trn_vehicle_positions (
  id                       UUID         NOT NULL,
  vehicle_id               UUID         NOT NULL,
  latitude                 NUMERIC(9,6) NOT NULL,
  longitude                NUMERIC(9,6) NOT NULL,
  speed_kmh                NUMERIC(5,1),
  heading                  NUMERIC(5,1),
  recorded_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  source                   TEXT         NOT NULL DEFAULT 'GPS',
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, recorded_at),
  CONSTRAINT trn_pos_lat_chk CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT trn_pos_lng_chk CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT trn_pos_speed_chk CHECK (speed_kmh IS NULL OR speed_kmh >= 0),
  CONSTRAINT trn_pos_heading_chk CHECK (
    heading IS NULL OR (heading >= 0 AND heading < 360)
  ),
  CONSTRAINT trn_pos_source_chk CHECK (
    source IN ('GPS', 'MANUAL', 'SIMULATED')
  )
) PARTITION BY RANGE (recorded_at);

CREATE INDEX IF NOT EXISTS trn_pos_vehicle_time_idx
  ON trn_vehicle_positions (vehicle_id, recorded_at DESC);

COMMENT ON TABLE trn_vehicle_positions IS
  'High-frequency GPS telemetry. RANGE partition by recorded_at DAILY because the per-vehicle insert cadence runs from 10 to 30 seconds. Composite PK id plus recorded_at because the partition column must appear in the unique constraint. No UPDATE and no DELETE service surface — the row is an immutable telemetry record. 3-value source CHECK (GPS MANUAL SIMULATED) covers real GPS device plus dispatcher entry plus testing.';

CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_14 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-14') TO ('2026-04-15');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_15 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-15') TO ('2026-04-16');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_16 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-16') TO ('2026-04-17');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_17 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-17') TO ('2026-04-18');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_18 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-18') TO ('2026-04-19');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_19 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-19') TO ('2026-04-20');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_20 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-20') TO ('2026-04-21');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_21 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-21') TO ('2026-04-22');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_22 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-22') TO ('2026-04-23');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_23 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-23') TO ('2026-04-24');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_24 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-24') TO ('2026-04-25');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_25 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-25') TO ('2026-04-26');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_26 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-26') TO ('2026-04-27');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_27 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-27') TO ('2026-04-28');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_28 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-28') TO ('2026-04-29');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_29 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-29') TO ('2026-04-30');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_04_30 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-04-30') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_01 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-01') TO ('2026-05-02');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_02 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-02') TO ('2026-05-03');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_03 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-03') TO ('2026-05-04');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_04 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-04') TO ('2026-05-05');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_05 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-05') TO ('2026-05-06');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_06 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-06') TO ('2026-05-07');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_07 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-07') TO ('2026-05-08');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_08 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-08') TO ('2026-05-09');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_09 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-09') TO ('2026-05-10');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_10 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-10') TO ('2026-05-11');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_11 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-11') TO ('2026-05-12');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_12 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-12') TO ('2026-05-13');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_13 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-13') TO ('2026-05-14');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_14 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-14') TO ('2026-05-15');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_15 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-15') TO ('2026-05-16');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_16 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-16') TO ('2026-05-17');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_17 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-17') TO ('2026-05-18');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_18 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-18') TO ('2026-05-19');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_19 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-19') TO ('2026-05-20');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_20 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-20') TO ('2026-05-21');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_21 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-21') TO ('2026-05-22');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_22 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-22') TO ('2026-05-23');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_23 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-23') TO ('2026-05-24');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_24 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-24') TO ('2026-05-25');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_25 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-25') TO ('2026-05-26');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_26 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-26') TO ('2026-05-27');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_27 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-27') TO ('2026-05-28');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_28 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-28') TO ('2026-05-29');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_29 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-29') TO ('2026-05-30');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_30 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-30') TO ('2026-05-31');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_05_31 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-05-31') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_01 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-01') TO ('2026-06-02');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_02 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-02') TO ('2026-06-03');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_03 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-03') TO ('2026-06-04');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_04 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-04') TO ('2026-06-05');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_05 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-05') TO ('2026-06-06');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_06 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-06') TO ('2026-06-07');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_07 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-07') TO ('2026-06-08');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_08 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-08') TO ('2026-06-09');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_09 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-09') TO ('2026-06-10');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_10 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-10') TO ('2026-06-11');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_11 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-11') TO ('2026-06-12');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_12 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-12') TO ('2026-06-13');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_13 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-13') TO ('2026-06-14');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_14 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-14') TO ('2026-06-15');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_15 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-15') TO ('2026-06-16');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_16 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-16') TO ('2026-06-17');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_17 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-17') TO ('2026-06-18');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_18 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-18') TO ('2026-06-19');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_19 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-19') TO ('2026-06-20');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_20 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-20') TO ('2026-06-21');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_21 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-21') TO ('2026-06-22');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_22 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-22') TO ('2026-06-23');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_23 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-23') TO ('2026-06-24');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_24 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-24') TO ('2026-06-25');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_25 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-25') TO ('2026-06-26');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_26 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-26') TO ('2026-06-27');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_27 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-27') TO ('2026-06-28');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_28 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-28') TO ('2026-06-29');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_29 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-29') TO ('2026-06-30');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_06_30 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-06-30') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_01 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-01') TO ('2026-07-02');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_02 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-02') TO ('2026-07-03');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_03 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-03') TO ('2026-07-04');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_04 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-04') TO ('2026-07-05');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_05 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-05') TO ('2026-07-06');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_06 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-06') TO ('2026-07-07');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_07 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-07') TO ('2026-07-08');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_08 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-08') TO ('2026-07-09');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_09 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-09') TO ('2026-07-10');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_10 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-10') TO ('2026-07-11');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_11 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-11') TO ('2026-07-12');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_12 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-12') TO ('2026-07-13');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_13 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-13') TO ('2026-07-14');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_14 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-14') TO ('2026-07-15');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_15 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-15') TO ('2026-07-16');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_16 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-16') TO ('2026-07-17');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_17 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-17') TO ('2026-07-18');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_18 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-18') TO ('2026-07-19');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_19 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-19') TO ('2026-07-20');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_20 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-20') TO ('2026-07-21');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_21 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-21') TO ('2026-07-22');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_22 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-22') TO ('2026-07-23');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_23 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-23') TO ('2026-07-24');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_24 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-24') TO ('2026-07-25');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_25 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-25') TO ('2026-07-26');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_26 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-26') TO ('2026-07-27');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_27 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-27') TO ('2026-07-28');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_28 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-28') TO ('2026-07-29');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_29 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-29') TO ('2026-07-30');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_30 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-30') TO ('2026-07-31');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_07_31 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-07-31') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_08_01 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-08-01') TO ('2026-08-02');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_08_02 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-08-02') TO ('2026-08-03');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_08_03 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-08-03') TO ('2026-08-04');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_08_04 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-08-04') TO ('2026-08-05');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_08_05 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-08-05') TO ('2026-08-06');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_08_06 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-08-06') TO ('2026-08-07');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_08_07 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-08-07') TO ('2026-08-08');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_08_08 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-08-08') TO ('2026-08-09');
CREATE TABLE IF NOT EXISTS trn_vehicle_positions_2026_08_09 PARTITION OF trn_vehicle_positions FOR VALUES FROM ('2026-08-09') TO ('2026-08-10');

CREATE TABLE IF NOT EXISTS trn_geofences (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  name                TEXT NOT NULL,
  geofence_type       TEXT NOT NULL,
  boundary            JSONB NOT NULL,
  speed_limit_kmh     INT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  description         TEXT,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_geofences_uq UNIQUE (school_id, name),
  CONSTRAINT trn_geofences_type_chk CHECK (
    geofence_type IN ('SCHOOL', 'STOP', 'SPEED_ZONE', 'RESTRICTED_AREA')
  ),
  CONSTRAINT trn_geofences_speed_chk CHECK (
    speed_limit_kmh IS NULL OR speed_limit_kmh >= 0
  )
);

CREATE INDEX IF NOT EXISTS trn_geofences_school_active_idx
  ON trn_geofences (school_id, is_active);

COMMENT ON TABLE trn_geofences IS
  'Per-school geofence definitions for school grounds plus stops plus speed-limited zones plus restricted areas. 4-value geofence_type CHECK (SCHOOL STOP SPEED_ZONE RESTRICTED_AREA). boundary JSONB carries either a circle shape with a center latitude longitude pair and a radius in metres or a polygon shape with a coordinates array. The Step 6 GeofenceWorker walks every active geofence on every new position update and runs point-in-polygon for the polygon type or haversine distance for the circle type. UNIQUE on school plus name keeps the TC catalogue clean.';

CREATE TABLE IF NOT EXISTS trn_geofence_events (
  id                  UUID         NOT NULL,
  geofence_id         UUID         NOT NULL,
  vehicle_id          UUID         NOT NULL,
  event_type          TEXT         NOT NULL,
  recorded_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  speed_at_event      NUMERIC(5,1),
  latitude            NUMERIC(9,6),
  longitude           NUMERIC(9,6),
  PRIMARY KEY (id, recorded_at),
  CONSTRAINT trn_geofence_event_type_chk CHECK (
    event_type IN ('ENTER', 'EXIT')
  ),
  CONSTRAINT trn_geofence_event_speed_chk CHECK (
    speed_at_event IS NULL OR speed_at_event >= 0
  )
) PARTITION BY RANGE (recorded_at);

CREATE INDEX IF NOT EXISTS trn_geofence_events_geofence_time_idx
  ON trn_geofence_events (geofence_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS trn_geofence_events_vehicle_time_idx
  ON trn_geofence_events (vehicle_id, recorded_at DESC);

COMMENT ON TABLE trn_geofence_events IS
  'Per-boundary enter and exit events. RANGE partition by recorded_at DAILY mirrors the parent positions table because per-vehicle per-geofence crossing volume scales with position volume. Composite PK id plus recorded_at. 2-value event_type CHECK (ENTER EXIT). The Step 6 GeofenceWorker inserts a row whenever a position update flips a vehicle across a geofence boundary. Emits trn.geofence.entered and trn.geofence.exited.';

CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_14 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-14') TO ('2026-04-15');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_15 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-15') TO ('2026-04-16');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_16 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-16') TO ('2026-04-17');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_17 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-17') TO ('2026-04-18');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_18 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-18') TO ('2026-04-19');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_19 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-19') TO ('2026-04-20');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_20 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-20') TO ('2026-04-21');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_21 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-21') TO ('2026-04-22');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_22 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-22') TO ('2026-04-23');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_23 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-23') TO ('2026-04-24');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_24 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-24') TO ('2026-04-25');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_25 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-25') TO ('2026-04-26');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_26 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-26') TO ('2026-04-27');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_27 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-27') TO ('2026-04-28');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_28 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-28') TO ('2026-04-29');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_29 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-29') TO ('2026-04-30');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_04_30 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-04-30') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_01 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-01') TO ('2026-05-02');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_02 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-02') TO ('2026-05-03');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_03 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-03') TO ('2026-05-04');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_04 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-04') TO ('2026-05-05');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_05 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-05') TO ('2026-05-06');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_06 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-06') TO ('2026-05-07');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_07 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-07') TO ('2026-05-08');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_08 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-08') TO ('2026-05-09');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_09 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-09') TO ('2026-05-10');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_10 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-10') TO ('2026-05-11');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_11 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-11') TO ('2026-05-12');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_12 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-12') TO ('2026-05-13');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_13 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-13') TO ('2026-05-14');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_14 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-14') TO ('2026-05-15');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_15 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-15') TO ('2026-05-16');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_16 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-16') TO ('2026-05-17');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_17 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-17') TO ('2026-05-18');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_18 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-18') TO ('2026-05-19');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_19 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-19') TO ('2026-05-20');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_20 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-20') TO ('2026-05-21');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_21 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-21') TO ('2026-05-22');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_22 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-22') TO ('2026-05-23');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_23 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-23') TO ('2026-05-24');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_24 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-24') TO ('2026-05-25');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_25 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-25') TO ('2026-05-26');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_26 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-26') TO ('2026-05-27');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_27 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-27') TO ('2026-05-28');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_28 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-28') TO ('2026-05-29');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_29 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-29') TO ('2026-05-30');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_30 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-30') TO ('2026-05-31');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_05_31 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-05-31') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_01 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-01') TO ('2026-06-02');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_02 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-02') TO ('2026-06-03');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_03 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-03') TO ('2026-06-04');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_04 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-04') TO ('2026-06-05');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_05 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-05') TO ('2026-06-06');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_06 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-06') TO ('2026-06-07');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_07 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-07') TO ('2026-06-08');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_08 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-08') TO ('2026-06-09');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_09 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-09') TO ('2026-06-10');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_10 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-10') TO ('2026-06-11');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_11 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-11') TO ('2026-06-12');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_12 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-12') TO ('2026-06-13');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_13 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-13') TO ('2026-06-14');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_14 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-14') TO ('2026-06-15');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_15 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-15') TO ('2026-06-16');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_16 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-16') TO ('2026-06-17');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_17 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-17') TO ('2026-06-18');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_18 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-18') TO ('2026-06-19');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_19 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-19') TO ('2026-06-20');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_20 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-20') TO ('2026-06-21');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_21 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-21') TO ('2026-06-22');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_22 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-22') TO ('2026-06-23');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_23 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-23') TO ('2026-06-24');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_24 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-24') TO ('2026-06-25');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_25 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-25') TO ('2026-06-26');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_26 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-26') TO ('2026-06-27');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_27 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-27') TO ('2026-06-28');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_28 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-28') TO ('2026-06-29');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_29 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-29') TO ('2026-06-30');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_06_30 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-06-30') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_01 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-01') TO ('2026-07-02');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_02 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-02') TO ('2026-07-03');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_03 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-03') TO ('2026-07-04');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_04 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-04') TO ('2026-07-05');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_05 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-05') TO ('2026-07-06');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_06 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-06') TO ('2026-07-07');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_07 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-07') TO ('2026-07-08');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_08 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-08') TO ('2026-07-09');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_09 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-09') TO ('2026-07-10');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_10 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-10') TO ('2026-07-11');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_11 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-11') TO ('2026-07-12');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_12 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-12') TO ('2026-07-13');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_13 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-13') TO ('2026-07-14');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_14 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-14') TO ('2026-07-15');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_15 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-15') TO ('2026-07-16');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_16 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-16') TO ('2026-07-17');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_17 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-17') TO ('2026-07-18');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_18 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-18') TO ('2026-07-19');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_19 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-19') TO ('2026-07-20');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_20 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-20') TO ('2026-07-21');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_21 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-21') TO ('2026-07-22');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_22 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-22') TO ('2026-07-23');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_23 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-23') TO ('2026-07-24');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_24 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-24') TO ('2026-07-25');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_25 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-25') TO ('2026-07-26');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_26 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-26') TO ('2026-07-27');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_27 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-27') TO ('2026-07-28');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_28 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-28') TO ('2026-07-29');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_29 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-29') TO ('2026-07-30');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_30 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-30') TO ('2026-07-31');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_07_31 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-07-31') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_08_01 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-08-01') TO ('2026-08-02');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_08_02 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-08-02') TO ('2026-08-03');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_08_03 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-08-03') TO ('2026-08-04');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_08_04 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-08-04') TO ('2026-08-05');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_08_05 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-08-05') TO ('2026-08-06');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_08_06 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-08-06') TO ('2026-08-07');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_08_07 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-08-07') TO ('2026-08-08');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_08_08 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-08-08') TO ('2026-08-09');
CREATE TABLE IF NOT EXISTS trn_geofence_events_2026_08_09 PARTITION OF trn_geofence_events FOR VALUES FROM ('2026-08-09') TO ('2026-08-10');

CREATE TABLE IF NOT EXISTS trn_vehicle_eta (
  id                  UUID PRIMARY KEY,
  vehicle_id          UUID NOT NULL,
  stop_id             UUID NOT NULL,
  eta                 TIMESTAMPTZ NOT NULL,
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence          TEXT NOT NULL DEFAULT 'HIGH',
  distance_metres     NUMERIC(8,1),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_eta_uq UNIQUE (vehicle_id, stop_id),
  CONSTRAINT trn_eta_confidence_chk CHECK (
    confidence IN ('HIGH', 'MEDIUM', 'LOW')
  ),
  CONSTRAINT trn_eta_distance_chk CHECK (
    distance_metres IS NULL OR distance_metres >= 0
  ),
  CONSTRAINT trn_eta_stop_fk FOREIGN KEY (stop_id)
    REFERENCES trn_stops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS trn_eta_vehicle_idx
  ON trn_vehicle_eta (vehicle_id);
CREATE INDEX IF NOT EXISTS trn_eta_stop_idx
  ON trn_vehicle_eta (stop_id, computed_at DESC);

COMMENT ON TABLE trn_vehicle_eta IS
  'Per-vehicle per-stop ETA snapshot. UNIQUE on vehicle plus stop so the read path renders the freshest snapshot. Upserted by the Step 6 GeofenceWorker on every position update or by the dispatch integration. 3-value confidence CHECK (HIGH MEDIUM LOW). Parent-facing view renders this as the ETA countdown to the child stop. CASCADE on stop_id since an ETA has no value past stop hard-delete.';

CREATE TABLE IF NOT EXISTS trn_dispatch_events (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  vehicle_id          UUID,
  route_id            UUID,
  driver_id           UUID,
  event_type          TEXT NOT NULL,
  event_data          JSONB,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by         UUID,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_dispatch_type_chk CHECK (
    event_type IN (
      'ROUTE_STARTED', 'ROUTE_COMPLETED', 'DELAY_REPORTED',
      'BREAKDOWN_REPORTED', 'STUDENT_NO_SHOW', 'EMERGENCY_STOP',
      'DETOUR', 'DRIVER_SWAP'
    )
  ),
  CONSTRAINT trn_dispatch_route_fk FOREIGN KEY (route_id)
    REFERENCES trn_routes(id) ON DELETE SET NULL,
  CONSTRAINT trn_dispatch_vehicle_fk FOREIGN KEY (vehicle_id)
    REFERENCES trn_vehicles(id) ON DELETE SET NULL,
  CONSTRAINT trn_dispatch_driver_fk FOREIGN KEY (driver_id)
    REFERENCES hr_employees(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS trn_dispatch_school_time_idx
  ON trn_dispatch_events (school_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS trn_dispatch_route_time_idx
  ON trn_dispatch_events (route_id, recorded_at DESC)
  WHERE route_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS trn_dispatch_vehicle_time_idx
  ON trn_dispatch_events (vehicle_id, recorded_at DESC)
  WHERE vehicle_id IS NOT NULL;

COMMENT ON TABLE trn_dispatch_events IS
  'Dispatcher-logged events. 8-value event_type CHECK covers route start and completion plus delay and breakdown plus student no-show plus emergency stop plus detour plus driver swap. event_data JSONB captures free-shape payload (lat lng plus minutes delayed plus other context). Real-time operations log surfaced on the TC dispatch console. SET NULL on route_id vehicle_id and driver_id preserves the historical event row past hard-delete of any single referent.';

CREATE TABLE IF NOT EXISTS trn_parent_tracking_tokens (
  id                  UUID PRIMARY KEY,
  student_id          UUID NOT NULL,
  route_id            UUID NOT NULL,
  guardian_account_id UUID,
  token               TEXT NOT NULL UNIQUE,
  expires_at          TIMESTAMPTZ NOT NULL,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  revoked_at          TIMESTAMPTZ,
  revoked_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_token_revoked_chk CHECK (
    (is_active = true AND revoked_at IS NULL)
    OR (is_active = false AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT trn_token_route_fk FOREIGN KEY (route_id)
    REFERENCES trn_routes(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS trn_token_active_uq
  ON trn_parent_tracking_tokens (student_id, route_id)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS trn_token_lookup_idx
  ON trn_parent_tracking_tokens (token)
  WHERE is_active = true;

COMMENT ON TABLE trn_parent_tracking_tokens IS
  'Unauthenticated bearer token a parent reads from a notification or a sign-in confirmation. token TEXT UNIQUE backs the lookup. partial UNIQUE on student plus route plus is_active true caps active tokens at one per (student route) pair — the partial WHERE releases on revoke so a fresh token can land for the same pair. multi-column revoked_chk pins revoked_at populated only when is_active false. CASCADE on route_id since the token has no value past route hard-delete. The Step 6 ParentTrackingService GET path is the only unauthenticated read in the entire transport module — every position lookup is scoped through the active token.';

CREATE TABLE IF NOT EXISTS rpt_fleet_status (
  id                                UUID PRIMARY KEY,
  vehicle_id                        UUID NOT NULL UNIQUE,
  school_id                         UUID NOT NULL,
  vehicle_registration              TEXT NOT NULL,
  vehicle_status                    TEXT NOT NULL,
  days_until_insurance_expiry       INT,
  days_until_registration_expiry    INT,
  days_until_mot_expiry             INT,
  days_until_licence_expiry         INT,
  maintenance_overdue               BOOLEAN NOT NULL DEFAULT false,
  last_incident_date                DATE,
  total_incidents_this_year         INT NOT NULL DEFAULT 0,
  current_route_assignment          TEXT,
  current_route_id                  UUID,
  last_position_at                  TIMESTAMPTZ,
  fuel_efficiency_last_month        NUMERIC(5,2),
  open_safety_critical_repair_count INT NOT NULL DEFAULT 0,
  materialised_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_fleet_incidents_chk CHECK (total_incidents_this_year >= 0),
  CONSTRAINT rpt_fleet_repair_chk CHECK (open_safety_critical_repair_count >= 0),
  CONSTRAINT rpt_fleet_vehicle_fk FOREIGN KEY (vehicle_id)
    REFERENCES trn_vehicles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS rpt_fleet_school_maint_idx
  ON rpt_fleet_status (school_id, maintenance_overdue);
CREATE INDEX IF NOT EXISTS rpt_fleet_school_insurance_idx
  ON rpt_fleet_status (school_id, days_until_insurance_expiry)
  WHERE days_until_insurance_expiry IS NOT NULL;

COMMENT ON TABLE rpt_fleet_status IS
  'Materialised nightly by the Step 6 FleetStatusWorker. One row per vehicle with denormalised dashboard counters. UNIQUE on vehicle_id. INDEX on school plus maintenance_overdue for the TC fleet health hot path. INDEX on school plus days_until_insurance_expiry partial NOT NULL drives the expiring-documents alert. CASCADE on vehicle_id since the snapshot is meaningless past vehicle hard-delete. The worker reads from trn_vehicles plus trn_vehicle_documents plus trn_vehicle_repairs plus trn_vehicle_fuel_logs plus trn_vehicle_positions and overwrites the row in one tx per vehicle.';
