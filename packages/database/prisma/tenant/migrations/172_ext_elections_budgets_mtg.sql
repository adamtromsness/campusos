/* 172_ext_elections_budgets_mtg.sql
 *
 * Phase 2 Cycle 28 sub-cycle b (P2-28b) — Clubs and Meetings
 * Advanced.
 *
 * 6 new tenant tables completing the M64 Clubs and Student Life
 * deferred surface from Cycle 17 plus the M41 Meetings deferred
 * surface from Cycle 7.
 *
 * Note on the plan vs reality: the P2-28b plan headers list 10
 * tables. Four of those (ext_elections, ext_candidates, ext_votes,
 * ext_election_voter_check) already shipped in Cycle 17 migration
 * 060_ext_elections_service.sql together with the matching
 * ElectionService and VoteService — including the STRUCTURAL
 * ANONYMITY KEYSTONE on ext_votes (no voter_id column anywhere).
 * P2-28b only ships the 6 truly-new tables here. The plan over-
 * counts the same way P2-26 and P2-27 did. The election anonymity
 * contract is already enforced at the schema layer and at the
 * Cycle 17 ElectionService / VoteService request paths.
 *
 *   ext_club_budgets             Per-(activity, academic_year)
 *                                budget head. UNIQUE(activity_id,
 *                                academic_year_id). allocated_amount
 *                                NUMERIC(10,2) non-negative.
 *                                spent_amount NUMERIC(10,2)
 *                                non-negative — maintained by the
 *                                Step 4 BudgetService inside the
 *                                tx that INSERTs ext_budget_
 *                                transactions rows. remaining_amount
 *                                is computed at the service layer
 *                                as allocated_amount - spent_amount.
 *
 *   ext_budget_transactions      Per-budget transaction ledger.
 *                                4-value transaction_type CHECK
 *                                ALLOCATION/EXPENSE/REFUND/
 *                                ADJUSTMENT. amount NUMERIC(10,2)
 *                                positive. INSERT triggers a Step 4
 *                                service-layer UPDATE on the parent
 *                                ext_club_budgets.spent_amount in
 *                                the same tenant tx.
 *
 *   ext_field_trip_evaluations   Per-(field_trip, evaluator)
 *                                post-trip evaluation row. UNIQUE
 *                                (field_trip_id, evaluated_by) caps
 *                                each evaluator at one row. 1..5
 *                                CHECK on overall_rating and the
 *                                three subscale columns.
 *
 *   ext_service_partner_orgs     Per-school external service-learning
 *                                partner organisation. UNIQUE
 *                                (school_id, org_name). service_types
 *                                TEXT[] free-form tags. is_active
 *                                for soft deactivation matching the
 *                                Cycle 18 ext_activities precedent.
 *
 *   mtg_meeting_templates        Reusable meeting template. UNIQUE
 *                                (school_id, name). default_agenda
 *                                JSONB pre-populates agenda items
 *                                when the Step 4 service creates a
 *                                meeting from the template.
 *                                meeting_type_id FK NO ACTION so
 *                                admins must reassign or archive
 *                                before deleting a referenced type.
 *
 *   mtg_ai_minutes               Per-meeting AI minutes row.
 *                                UNIQUE(meeting_id). 3-value status
 *                                CHECK PENDING/GENERATED/APPROVED.
 *                                approved_chk multi-column lockstep
 *                                requires approved_by populated when
 *                                status APPROVED. ai_action_items
 *                                and ai_key_decisions are JSONB —
 *                                the Step 4 AIMinutesService stub
 *                                writes placeholder content until
 *                                P3-A1 AI Inference deploys.
 *
 * All cross-table refs are intra-tenant DB-enforced FKs. 0 cross-
 * schema FKs.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 */

/* --- 1. ext_club_budgets --- */

CREATE TABLE IF NOT EXISTS ext_club_budgets (
  id                   UUID            PRIMARY KEY,
  activity_id          UUID            NOT NULL,
  academic_year_id     UUID            NOT NULL,
  allocated_amount     NUMERIC(10,2)   NOT NULL DEFAULT 0,
  spent_amount         NUMERIC(10,2)   NOT NULL DEFAULT 0,
  approved_by          UUID,
  approved_at          TIMESTAMPTZ,
  notes                TEXT,
  created_at           TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ     NOT NULL DEFAULT now(),
  CONSTRAINT ext_club_budgets_uq UNIQUE (activity_id, academic_year_id),
  CONSTRAINT ext_club_budgets_allocated_chk CHECK (allocated_amount >= 0),
  CONSTRAINT ext_club_budgets_spent_chk CHECK (spent_amount >= 0),
  CONSTRAINT ext_club_budgets_activity_fk FOREIGN KEY (activity_id)
    REFERENCES ext_activities(id) ON DELETE CASCADE,
  CONSTRAINT ext_club_budgets_year_fk FOREIGN KEY (academic_year_id)
    REFERENCES sis_academic_years(id) ON DELETE NO ACTION,
  CONSTRAINT ext_club_budgets_approver_fk FOREIGN KEY (approved_by)
    REFERENCES hr_employees(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ext_club_budgets_activity_idx
  ON ext_club_budgets (activity_id);

COMMENT ON TABLE ext_club_budgets IS
  'P2-28b Step 3 — per-(activity, academic_year) club budget head. UNIQUE(activity_id, academic_year_id) caps a club at one budget per year. spent_amount is maintained by the Step 4 BudgetService inside the same tenant tx as the ext_budget_transactions INSERT. remaining_amount is computed by the service as allocated_amount - spent_amount.';

/* --- 2. ext_budget_transactions --- */

CREATE TABLE IF NOT EXISTS ext_budget_transactions (
  id                  UUID            PRIMARY KEY,
  budget_id           UUID            NOT NULL,
  transaction_type    TEXT            NOT NULL,
  amount              NUMERIC(10,2)   NOT NULL,
  description         TEXT            NOT NULL,
  receipt_s3_key      TEXT,
  recorded_by         UUID            NOT NULL,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
  CONSTRAINT ext_budget_tx_type_chk CHECK (
    transaction_type IN ('ALLOCATION', 'EXPENSE', 'REFUND', 'ADJUSTMENT')
  ),
  CONSTRAINT ext_budget_tx_amount_chk CHECK (amount > 0),
  CONSTRAINT ext_budget_tx_budget_fk FOREIGN KEY (budget_id)
    REFERENCES ext_club_budgets(id) ON DELETE CASCADE,
  CONSTRAINT ext_budget_tx_recorder_fk FOREIGN KEY (recorded_by)
    REFERENCES hr_employees(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS ext_budget_tx_budget_idx
  ON ext_budget_transactions (budget_id, created_at DESC);

COMMENT ON TABLE ext_budget_transactions IS
  'P2-28b Step 3 — per-budget transaction ledger. 4-value transaction_type CHECK (ALLOCATION, EXPENSE, REFUND, ADJUSTMENT). amount is always positive — the sign is encoded in transaction_type. The Step 4 BudgetService.record path INSERTs this row and UPDATEs the parent ext_club_budgets in one tenant tx — ALLOCATION bumps allocated_amount, EXPENSE bumps spent_amount up, REFUND bumps spent_amount down, ADJUSTMENT carries the rationale in description.';

/* --- 3. ext_field_trip_evaluations --- */

CREATE TABLE IF NOT EXISTS ext_field_trip_evaluations (
  id                          UUID         PRIMARY KEY,
  field_trip_id               UUID         NOT NULL,
  evaluated_by                UUID         NOT NULL,
  overall_rating              INT          NOT NULL,
  educational_value_rating    INT,
  logistics_rating            INT,
  safety_rating               INT,
  comments                    TEXT,
  would_recommend             BOOLEAN,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ext_field_trip_eval_overall_chk CHECK (
    overall_rating BETWEEN 1 AND 5
  ),
  CONSTRAINT ext_field_trip_eval_edu_chk CHECK (
    educational_value_rating IS NULL OR educational_value_rating BETWEEN 1 AND 5
  ),
  CONSTRAINT ext_field_trip_eval_log_chk CHECK (
    logistics_rating IS NULL OR logistics_rating BETWEEN 1 AND 5
  ),
  CONSTRAINT ext_field_trip_eval_safety_chk CHECK (
    safety_rating IS NULL OR safety_rating BETWEEN 1 AND 5
  ),
  CONSTRAINT ext_field_trip_eval_uq UNIQUE (field_trip_id, evaluated_by),
  CONSTRAINT ext_field_trip_eval_trip_fk FOREIGN KEY (field_trip_id)
    REFERENCES ext_field_trips(id) ON DELETE CASCADE,
  CONSTRAINT ext_field_trip_eval_evaluator_fk FOREIGN KEY (evaluated_by)
    REFERENCES hr_employees(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS ext_field_trip_eval_trip_idx
  ON ext_field_trip_evaluations (field_trip_id);

COMMENT ON TABLE ext_field_trip_evaluations IS
  'P2-28b Step 3 — per-(field_trip, evaluator) post-trip evaluation. UNIQUE(field_trip_id, evaluated_by) caps each evaluator at one row — PATCH replaces. All four rating columns are 1..5 with overall_rating NOT NULL and the three subscales optional. CASCADE on parent trip delete drops evaluations.';

/* --- 4. ext_service_partner_orgs --- */

CREATE TABLE IF NOT EXISTS ext_service_partner_orgs (
  id                UUID         PRIMARY KEY,
  school_id         UUID         NOT NULL,
  org_name          TEXT         NOT NULL,
  contact_name      TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  service_types     TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  description       TEXT,
  website_url       TEXT,
  is_active         BOOLEAN      NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ext_service_partner_orgs_uq UNIQUE (school_id, org_name)
);

CREATE INDEX IF NOT EXISTS ext_service_partner_orgs_school_active_idx
  ON ext_service_partner_orgs (school_id, is_active);

COMMENT ON TABLE ext_service_partner_orgs IS
  'P2-28b Step 3 — per-school service-learning partner organisation. UNIQUE(school_id, org_name) caps the catalogue at one row per name. service_types TEXT[] is a free-form tag array — schools pin their own taxonomy. is_active gates whether the org appears in the Step 4 student-volunteer placement picker.';

/* --- 5. mtg_meeting_templates --- */

CREATE TABLE IF NOT EXISTS mtg_meeting_templates (
  id                          UUID         PRIMARY KEY,
  school_id                   UUID         NOT NULL,
  name                        TEXT         NOT NULL,
  description                 TEXT,
  meeting_type_id             UUID,
  default_duration_minutes    INT          NOT NULL DEFAULT 60,
  default_agenda              JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_by                  UUID         NOT NULL,
  is_active                   BOOLEAN      NOT NULL DEFAULT true,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT mtg_meeting_templates_uq UNIQUE (school_id, name),
  CONSTRAINT mtg_meeting_templates_duration_chk CHECK (default_duration_minutes > 0),
  CONSTRAINT mtg_meeting_templates_type_fk FOREIGN KEY (meeting_type_id)
    REFERENCES mtg_meeting_types(id) ON DELETE NO ACTION,
  CONSTRAINT mtg_meeting_templates_creator_fk FOREIGN KEY (created_by)
    REFERENCES hr_employees(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS mtg_meeting_templates_school_active_idx
  ON mtg_meeting_templates (school_id, is_active);

COMMENT ON TABLE mtg_meeting_templates IS
  'P2-28b Step 3 — reusable meeting template. UNIQUE(school_id, name) caps the catalogue at one row per name. default_agenda JSONB carries pre-populated agenda items — the Step 4 MeetingTemplateService.createMeeting path applies this to a new mtg_meeting and writes the corresponding mtg_agenda_items rows in the same tenant tx.';

/* --- 6. mtg_ai_minutes --- */

CREATE TABLE IF NOT EXISTS mtg_ai_minutes (
  id                   UUID         PRIMARY KEY,
  meeting_id           UUID         NOT NULL,
  raw_transcript       TEXT,
  ai_summary           TEXT,
  ai_action_items      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  ai_key_decisions     JSONB        NOT NULL DEFAULT '[]'::jsonb,
  model_version        TEXT,
  generated_at         TIMESTAMPTZ,
  status               TEXT         NOT NULL DEFAULT 'PENDING',
  approved_by          UUID,
  approved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT mtg_ai_minutes_meeting_uq UNIQUE (meeting_id),
  CONSTRAINT mtg_ai_minutes_status_chk CHECK (
    status IN ('PENDING', 'GENERATED', 'APPROVED')
  ),
  CONSTRAINT mtg_ai_minutes_generated_chk CHECK (
    (status IN ('GENERATED', 'APPROVED') AND generated_at IS NOT NULL)
    OR (status = 'PENDING' AND generated_at IS NULL)
  ),
  CONSTRAINT mtg_ai_minutes_approved_chk CHECK (
    (status = 'APPROVED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR (status IN ('PENDING', 'GENERATED') AND approved_by IS NULL AND approved_at IS NULL)
  ),
  CONSTRAINT mtg_ai_minutes_meeting_fk FOREIGN KEY (meeting_id)
    REFERENCES mtg_meetings(id) ON DELETE CASCADE,
  CONSTRAINT mtg_ai_minutes_approver_fk FOREIGN KEY (approved_by)
    REFERENCES hr_employees(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS mtg_ai_minutes_status_idx
  ON mtg_ai_minutes (status);

COMMENT ON TABLE mtg_ai_minutes IS
  'P2-28b Step 3 — per-meeting AI minutes row. UNIQUE(meeting_id) caps minutes at one row per meeting. 3-value status CHECK PENDING/GENERATED/APPROVED. multi-column generated_chk and approved_chk lockstep keeps the timestamp columns aligned with status. ai_action_items and ai_key_decisions are JSONB — the Step 4 AIMinutesService writes placeholder content via the AI Inference stub until P3-A1 deploys.';

COMMENT ON COLUMN mtg_ai_minutes.model_version IS
  'Tracks which AI model version produced the minutes — populated by the Step 4 stub as STUB_VERSION_0 until P3-A1 AI Inference ships. Future model upgrades preserve audit traceability.';
