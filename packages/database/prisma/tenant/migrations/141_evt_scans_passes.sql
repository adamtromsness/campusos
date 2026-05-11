/*
 * 141_evt_scans_passes.sql — Phase 2 Cycle 12 sub-cycle a (P2-12a).
 *
 * M101 Events and Ticketing — 4 base tables completing P2-12 at 9
 * tables across migrations 140 plus 141.
 *
 *   evt_ticket_scans       Gate audit log — every scan attempt is
 *                          recorded regardless of result. 4-value
 *                          scan_result CHECK (VALID
 *                          ALREADY_SCANNED INVALID EXPIRED).
 *                          RANGE partition by scanned_at MONTHLY
 *                          over the 2025-08 through 2027-08 window
 *                          mirroring the msg_messages and
 *                          tsk_tasks precedents. Composite PK
 *                          (id scanned_at) because the partition
 *                          column must appear in the unique
 *                          constraint. Soft FK ticket_id is
 *                          nullable so an INVALID scan attempt
 *                          against an unknown token still lands a
 *                          row.
 *   evt_season_passes      Multi-event admission pass. 3-value
 *                          status CHECK (ACTIVE EXPIRED REVOKED).
 *                          events_included UUID array — null
 *                          means all events of the matching type
 *                          for the academic year. Gate check
 *                          verifies pass is ACTIVE and the
 *                          current event is in events_included
 *                          (or events_included IS NULL which
 *                          means all events). INDEX(school_id
 *                          person_id academic_year) backs the
 *                          per-person look-up at the gate.
 *   evt_comp_lists         Complimentary entry list. 8-value
 *                          comp_type CHECK (ATHLETE COACH
 *                          OFFICIAL MEDIA STAFF STUDENT VIP
 *                          OTHER). UNIQUE on (event_id comp_type
 *                          person_id) so a person cannot appear
 *                          twice under the same comp type for
 *                          the same event. Comp list members
 *                          bypass ticketing at the gate.
 *   evt_volunteers         Event volunteer sign-up. 3-value
 *                          status CHECK (SIGNED_UP CONFIRMED
 *                          CANCELLED). UNIQUE on (event_id
 *                          person_id) so a person cannot sign
 *                          up twice for the same event. check_in_at
 *                          stamped at gate when volunteer arrives.
 *
 * Soft FKs to platform.iam_person per ADR-001 and ADR-020 are not
 * enforced at the schema layer — the request-path service layer
 * validates the supplied person_id against the calling tenant
 * before INSERT. DB-enforced FKs to evt_events use ON DELETE
 * CASCADE on the comp_list and volunteer link because those rows
 * have no audit value past the event being hard-deleted. The
 * evt_ticket_scans table does NOT carry a DB-enforced FK to
 * evt_tickets because the scan audit is an event-stream record
 * that survives ticket cleanup and because INVALID scans land
 * with ticket_id NULL.
 *
 * No semicolons inside string literals or block comments. The
 * tenant provisioner splits the migration on every semicolon
 * regardless of quoting context.
 */

CREATE TABLE IF NOT EXISTS evt_ticket_scans (
  id                UUID NOT NULL DEFAULT gen_random_uuid(),
  ticket_id         UUID,
  qr_code_token     TEXT,
  event_id          UUID,
  scanned_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  scanned_by        UUID NOT NULL,
  scan_result       TEXT NOT NULL,
  scan_source       TEXT,
  notes             TEXT,
  CONSTRAINT evt_scans_result_chk CHECK (
    scan_result IN ('VALID','ALREADY_SCANNED','INVALID','EXPIRED')
  ),
  PRIMARY KEY (id, scanned_at)
) PARTITION BY RANGE (scanned_at);

CREATE INDEX IF NOT EXISTS evt_scans_ticket_idx
  ON evt_ticket_scans(ticket_id, scanned_at DESC) WHERE ticket_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS evt_scans_event_idx
  ON evt_ticket_scans(event_id, scanned_at DESC) WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS evt_scans_token_idx
  ON evt_ticket_scans(qr_code_token, scanned_at DESC) WHERE qr_code_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS evt_ticket_scans_2025_08 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2025_09 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2025_10 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2025_11 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2025_12 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2026_01 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2026_02 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2026_03 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2026_04 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2026_05 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2026_06 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2026_07 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2026_08 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2026_09 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2026_10 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2026_11 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2026_12 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2027_01 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2027_02 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2027_03 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2027_04 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2027_05 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2027_06 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2027_07 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE IF NOT EXISTS evt_ticket_scans_2027_08 PARTITION OF evt_ticket_scans FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');

COMMENT ON TABLE evt_ticket_scans IS
  'Gate audit log. Every scan attempt is recorded regardless of result so the security team can reconstruct who tried what when. 4-value scan_result CHECK (VALID ALREADY_SCANNED INVALID EXPIRED). RANGE partition by scanned_at MONTHLY mirrors msg_messages and tsk_tasks. Soft FK to evt_tickets so INVALID scans against unknown tokens still land a row with ticket_id NULL. The composite PK includes scanned_at because the partition column must appear in any unique constraint.';

COMMENT ON COLUMN evt_ticket_scans.scanned_by IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020. Identifies the gate volunteer or admin who performed the scan attempt.';

COMMENT ON COLUMN evt_ticket_scans.scan_source IS
  'Free-text source identifier for the scanner device (KIOSK_A, MOBILE_GATE_2, etc) so on-site logistics can debug a malfunctioning lane.';

CREATE TABLE IF NOT EXISTS evt_season_passes (
  id                          UUID PRIMARY KEY,
  school_id                   UUID NOT NULL,
  person_id                   UUID NOT NULL,
  pass_type                   TEXT NOT NULL,
  events_included             UUID[],
  price                       NUMERIC(8,2) NOT NULL,
  purchased_at                TIMESTAMPTZ,
  stripe_payment_intent_id    TEXT,
  status                      TEXT NOT NULL DEFAULT 'ACTIVE',
  academic_year               TEXT NOT NULL,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evt_passes_status_chk CHECK (
    status IN ('ACTIVE','EXPIRED','REVOKED')
  ),
  CONSTRAINT evt_passes_price_chk CHECK (price >= 0)
);

CREATE INDEX IF NOT EXISTS evt_passes_school_person_year_idx
  ON evt_season_passes(school_id, person_id, academic_year);

CREATE INDEX IF NOT EXISTS evt_passes_active_idx
  ON evt_season_passes(school_id, academic_year) WHERE status = 'ACTIVE';

COMMENT ON TABLE evt_season_passes IS
  'Multi-event admission pass. 3-value status CHECK (ACTIVE EXPIRED REVOKED). events_included UUID array — null means all events of the matching pass_type for the academic year. Gate check at SeasonPassService verifies status equals ACTIVE and the current event is either in events_included or events_included IS NULL.';

COMMENT ON COLUMN evt_season_passes.person_id IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020. The pass holder. Validated against the calling tenant at purchase time.';

COMMENT ON COLUMN evt_season_passes.pass_type IS
  'Free-text type identifier (All Sports, Theatre Season, All Events, etc). Used to filter which event_types the pass applies to when events_included IS NULL.';

CREATE TABLE IF NOT EXISTS evt_comp_lists (
  id              UUID PRIMARY KEY,
  event_id        UUID NOT NULL,
  comp_type       TEXT NOT NULL,
  person_id       UUID NOT NULL,
  notes           TEXT,
  added_by        UUID NOT NULL,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evt_comp_event_fk FOREIGN KEY (event_id)
    REFERENCES evt_events(id) ON DELETE CASCADE,
  CONSTRAINT evt_comp_type_chk CHECK (
    comp_type IN ('ATHLETE','COACH','OFFICIAL','MEDIA','STAFF','STUDENT','VIP','OTHER')
  ),
  CONSTRAINT evt_comp_uq UNIQUE (event_id, comp_type, person_id)
);

CREATE INDEX IF NOT EXISTS evt_comp_event_type_idx
  ON evt_comp_lists(event_id, comp_type);

CREATE INDEX IF NOT EXISTS evt_comp_person_idx
  ON evt_comp_lists(person_id);

COMMENT ON TABLE evt_comp_lists IS
  'Complimentary entry list. 8-value comp_type CHECK (ATHLETE COACH OFFICIAL MEDIA STAFF STUDENT VIP OTHER). UNIQUE on (event_id comp_type person_id) prevents a person from appearing twice under the same comp type for the same event but allows the same person to appear under different comp types (e.g. both ATHLETE and STUDENT for a school player). Comp list members bypass ticketing at the gate.';

COMMENT ON COLUMN evt_comp_lists.person_id IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020.';

COMMENT ON COLUMN evt_comp_lists.added_by IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020. Audit trail for who added the comp entry.';

CREATE TABLE IF NOT EXISTS evt_volunteers (
  id            UUID PRIMARY KEY,
  event_id      UUID NOT NULL,
  person_id     UUID NOT NULL,
  role          TEXT,
  status        TEXT NOT NULL DEFAULT 'SIGNED_UP',
  check_in_at   TIMESTAMPTZ,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evt_vol_event_fk FOREIGN KEY (event_id)
    REFERENCES evt_events(id) ON DELETE CASCADE,
  CONSTRAINT evt_vol_status_chk CHECK (
    status IN ('SIGNED_UP','CONFIRMED','CANCELLED')
  ),
  CONSTRAINT evt_vol_uq UNIQUE (event_id, person_id)
);

CREATE INDEX IF NOT EXISTS evt_vol_event_status_idx
  ON evt_volunteers(event_id, status);

CREATE INDEX IF NOT EXISTS evt_vol_person_idx
  ON evt_volunteers(person_id);

COMMENT ON TABLE evt_volunteers IS
  'Event volunteer sign-up. 3-value status CHECK (SIGNED_UP CONFIRMED CANCELLED). UNIQUE on (event_id person_id) prevents duplicate sign-ups. check_in_at is stamped at gate when the volunteer arrives. role is free-text (gate volunteer usher concessions setup cleanup).';

COMMENT ON COLUMN evt_volunteers.person_id IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020.';
