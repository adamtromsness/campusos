/*
 * 060_ext_elections_service.sql — Cycle 17 Step 3.
 *
 * M64 Clubs and Student Life domains 3 + 4: structurally anonymous
 * student government elections, plus community service programmes
 * with student hour logging and supervisor approval.
 *
 * ANONYMITY KEYSTONE — ext_votes carries the candidate selection but
 * has NO voter identity column. The separate ext_election_voter_check
 * table records WHO voted using a composite primary key but contains
 * NO reference to any ext_votes row. There is no JOIN path from a vote
 * to a voter at the schema level. This is the strongest privacy
 * guarantee in CampusOS and cannot be reversed by any database
 * administrator without rewriting the schema and re-running an attack
 * after the fact.
 *
 * STUDENT-INPUT KEYSTONE — ext_service_hours is the third student-input
 * surface in CampusOS after wellbeing check-ins (Cycle 11.1) and
 * library reading logs / reviews (Cycle 12). Students POST their own
 * rows. The Step 7 ServiceHourService row-scopes student reads to
 * own_student_id and gates writes on clb-004:write.
 */

CREATE TABLE IF NOT EXISTS ext_elections (
  id                        UUID PRIMARY KEY,
  school_id                 UUID NOT NULL,
  title                     TEXT NOT NULL,
  description               TEXT,
  voting_start              TIMESTAMPTZ NOT NULL,
  voting_end                TIMESTAMPTZ NOT NULL,
  eligible_voters_filter    JSONB NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'DRAFT',
  created_by                UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ext_elections_status_chk CHECK (
    status IN ('DRAFT', 'OPEN', 'CLOSED', 'RESULTS_PUBLISHED')
  ),
  CONSTRAINT ext_elections_window_chk CHECK (voting_end > voting_start),
  CONSTRAINT ext_elections_creator_fk FOREIGN KEY (created_by)
    REFERENCES hr_employees(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS ext_elections_school_status_idx
  ON ext_elections (school_id, status);

COMMENT ON TABLE ext_elections IS
  'Student government election. eligible_voters_filter is structured JSONB shaped {gradeLevels:[..]} or {yearGroups:[..]} or {studentIds:[..]} or {all:true}. status flows DRAFT -> OPEN -> CLOSED -> RESULTS_PUBLISHED.';

CREATE TABLE IF NOT EXISTS ext_candidates (
  id                UUID PRIMARY KEY,
  election_id       UUID NOT NULL,
  student_id        UUID NOT NULL,
  position          TEXT NOT NULL,
  statement         TEXT,
  photo_s3_key      TEXT,
  is_approved       BOOLEAN NOT NULL DEFAULT true,
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ext_candidates_election_fk FOREIGN KEY (election_id)
    REFERENCES ext_elections(id) ON DELETE CASCADE,
  CONSTRAINT ext_candidates_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT ext_candidates_uq UNIQUE (election_id, student_id, position)
);

COMMENT ON TABLE ext_candidates IS
  'Election candidates. UNIQUE on (election, student, position) so a student can run for at most one position per election. CASCADE on both parents because candidate registration is meaningless without its election and is personal student data.';

CREATE TABLE IF NOT EXISTS ext_votes (
  id              UUID PRIMARY KEY,
  election_id     UUID NOT NULL,
  position        TEXT NOT NULL,
  candidate_id    UUID NOT NULL,
  voted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ext_votes_election_fk FOREIGN KEY (election_id)
    REFERENCES ext_elections(id) ON DELETE NO ACTION,
  CONSTRAINT ext_votes_candidate_fk FOREIGN KEY (candidate_id)
    REFERENCES ext_candidates(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS ext_votes_election_position_idx
  ON ext_votes (election_id, position);

COMMENT ON TABLE ext_votes IS
  'ANONYMITY KEYSTONE. Carries the ballot selection only. NO voter_id, student_id, person_id, or any column that could trace the vote to a voter. NO ACTION on both FKs so votes outlive election cleanup attempts. The companion ext_election_voter_check table records WHO voted with NO reference back to this table. There is no JOIN path from a vote to a voter.';

CREATE TABLE IF NOT EXISTS ext_election_voter_check (
  election_id     UUID NOT NULL,
  student_id      UUID NOT NULL,
  voted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (election_id, student_id),
  CONSTRAINT ext_election_voter_check_election_fk FOREIGN KEY (election_id)
    REFERENCES ext_elections(id) ON DELETE CASCADE,
  CONSTRAINT ext_election_voter_check_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE
);

COMMENT ON TABLE ext_election_voter_check IS
  'Anti-double-vote ledger. The (election_id, student_id) primary key prevents a student from casting more than one ballot per election. Carries NO reference to any ext_votes row. There is no JOIN path from this table to ext_votes that would allow tracing a vote to a voter. The structural anonymity holds even when a database administrator queries both tables directly.';

CREATE TABLE IF NOT EXISTS ext_service_programmes (
  id                        UUID PRIMARY KEY,
  school_id                 UUID NOT NULL,
  name                      TEXT NOT NULL,
  description               TEXT,
  academic_year_id          UUID NOT NULL,
  target_hours              NUMERIC(6,1) NOT NULL,
  start_date                DATE,
  end_date                  DATE,
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  eligible_grade_levels     TEXT[],
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ext_service_programmes_target_chk CHECK (target_hours > 0),
  CONSTRAINT ext_service_programmes_dates_chk CHECK (
    start_date IS NULL OR end_date IS NULL OR end_date >= start_date
  ),
  CONSTRAINT ext_service_programmes_year_fk FOREIGN KEY (academic_year_id)
    REFERENCES sis_academic_years(id) ON DELETE NO ACTION,
  CONSTRAINT ext_service_programmes_uq UNIQUE (school_id, name, academic_year_id)
);

COMMENT ON TABLE ext_service_programmes IS
  'Community service programme definition. UNIQUE on (school, name, year) so a programme name is unique per academic year. academic_year_id NO ACTION because admin must reassign before a year can be removed.';

CREATE TABLE IF NOT EXISTS ext_service_hours (
  id                    UUID PRIMARY KEY,
  student_id            UUID NOT NULL,
  programme_id          UUID,
  organisation          TEXT NOT NULL,
  description           TEXT NOT NULL,
  service_date          DATE NOT NULL,
  hours                 NUMERIC(4,1) NOT NULL,
  supervisor_name       TEXT,
  supervisor_contact    TEXT,
  evidence_s3_key       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ext_service_hours_hours_chk CHECK (hours > 0),
  CONSTRAINT ext_service_hours_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT ext_service_hours_programme_fk FOREIGN KEY (programme_id)
    REFERENCES ext_service_programmes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ext_service_hours_student_date_idx
  ON ext_service_hours (student_id, service_date DESC);

COMMENT ON TABLE ext_service_hours IS
  'STUDENT-INPUT KEYSTONE. Third student-input surface in CampusOS. Students POST their own rows via clb-004:write. programme_id SET NULL on delete so a row keeps its detail when its programme is removed. CASCADE on student because the row is personal student data.';

CREATE TABLE IF NOT EXISTS ext_service_hour_approvals (
  id                  UUID PRIMARY KEY,
  service_hour_id     UUID NOT NULL,
  approved_by         UUID NOT NULL,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  notes               TEXT,
  reviewed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ext_service_hour_approvals_status_chk CHECK (
    status IN ('PENDING', 'APPROVED', 'REJECTED')
  ),
  CONSTRAINT ext_service_hour_approvals_reviewed_chk CHECK (
    (status = 'PENDING' AND reviewed_at IS NULL)
    OR (status IN ('APPROVED', 'REJECTED') AND reviewed_at IS NOT NULL)
  ),
  CONSTRAINT ext_service_hour_approvals_hour_fk FOREIGN KEY (service_hour_id)
    REFERENCES ext_service_hours(id) ON DELETE CASCADE,
  CONSTRAINT ext_service_hour_approvals_approver_fk FOREIGN KEY (approved_by)
    REFERENCES hr_employees(id) ON DELETE NO ACTION,
  CONSTRAINT ext_service_hour_approvals_uq UNIQUE (service_hour_id)
);

COMMENT ON TABLE ext_service_hour_approvals IS
  'Per-service-hour-row approval. UNIQUE on service_hour_id so each row gets at most one approval record. Multi-column reviewed_chk keeps reviewed_at in lockstep with status. approved_by NO ACTION preserves audit when staff leaves.';

CREATE TABLE IF NOT EXISTS ext_service_progress (
  id                UUID PRIMARY KEY,
  programme_id      UUID NOT NULL,
  student_id        UUID NOT NULL,
  approved_hours    NUMERIC(6,1) NOT NULL DEFAULT 0,
  pending_hours     NUMERIC(6,1) NOT NULL DEFAULT 0,
  is_complete       BOOLEAN NOT NULL DEFAULT false,
  last_updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ext_service_progress_approved_chk CHECK (approved_hours >= 0),
  CONSTRAINT ext_service_progress_pending_chk CHECK (pending_hours >= 0),
  CONSTRAINT ext_service_progress_programme_fk FOREIGN KEY (programme_id)
    REFERENCES ext_service_programmes(id) ON DELETE CASCADE,
  CONSTRAINT ext_service_progress_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT ext_service_progress_uq UNIQUE (programme_id, student_id)
);

COMMENT ON TABLE ext_service_progress IS
  'Per-(programme, student) running total. The Step 7 ServiceHourService auto-upserts approved_hours on every APPROVED transition and pending_hours on every PENDING insert / edit. is_complete flips when approved_hours reaches the programme target_hours.';
