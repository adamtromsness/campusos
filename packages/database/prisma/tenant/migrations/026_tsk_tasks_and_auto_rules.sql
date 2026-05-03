/* 026_tsk_tasks_and_auto_rules.sql
 * Cycle 7 Step 1 — Task management schema.
 *
 * Six new tenant base tables for the M1 Task Management module:
 *   tsk_acknowledgements    — per-(school, subject) acknowledgement rows
 *                              with PENDING / ACKNOWLEDGED /
 *                              ACKNOWLEDGED_WITH_DISPUTE / EXPIRED
 *                              lifecycle. Source rows in domain tables
 *                              are linked via the soft polymorphic
 *                              source_type and source_ref_id pair.
 *   tsk_auto_task_rules     — catalogue of auto-task triggers keyed on
 *                              the inbound Kafka event_type. is_system
 *                              flag distinguishes seeded rules from
 *                              school-authored rules. is_active drives
 *                              the runtime gate inside the Step 4 Task
 *                              Worker.
 *   tsk_auto_task_conditions — optional AND-ed conditions on the event
 *                              payload. field_path is a JSON dot-path
 *                              evaluated by the worker. operator chooses
 *                              the comparison.
 *   tsk_auto_task_actions    — one or more actions per rule. Most rules
 *                              ship a single CREATE_TASK action.
 *                              Acknowledgement flows ship a
 *                              CREATE_ACKNOWLEDGEMENT followed by
 *                              CREATE_TASK.
 *   tsk_tasks                — RANGE-partitioned by created_at, monthly,
 *                              24 partitions covering 2025-08 through
 *                              2027-08. Composite PK (id, created_at)
 *                              because the partition column must appear
 *                              in the unique constraint. Same convention
 *                              as msg_messages, msg_notification_log,
 *                              and pay_ledger_entries.
 *   tsk_tasks_archive        — RANGE-partitioned by created_at annually,
 *                              3 partitions covering 2025 / 2026 / 2027.
 *                              The archiver job (move DONE / CANCELLED
 *                              rows older than 30 days from tsk_tasks
 *                              into this table) is deferred to ops.
 *                              Schema-only this cycle.
 *
 * Soft cross-schema refs per ADR-001 and ADR-020:
 *   tsk_acknowledgements.subject_id   -> platform.iam_person(id)
 *   tsk_acknowledgements.created_by   -> platform.platform_users(id)
 *   tsk_tasks.owner_id                -> platform.platform_users(id)
 *   tsk_tasks.created_for_id          -> platform.platform_users(id)
 *
 * DB-enforced intra-tenant FKs (4 logical):
 *   tsk_auto_task_conditions.rule_id   -> tsk_auto_task_rules(id) CASCADE
 *   tsk_auto_task_actions.rule_id      -> tsk_auto_task_rules(id) CASCADE
 *   tsk_tasks.acknowledgement_id       -> tsk_acknowledgements(id) SET NULL
 *     This last FK replicates onto each of the 24 monthly partitions
 *     plus the parent for a total of 25 pg_constraint rows. Matches the
 *     pay_ledger_entries.family_account_id precedent from Cycle 6.
 *
 * Auto-task dedup is dual-layer. The partial INDEX on
 * (owner_id, source, source_ref_id) WHERE source != MANUAL is non-unique
 * because partitioned tables require the partition key in any UNIQUE
 * constraint, which would defeat dedup across months. Authoritative
 * idempotency is Redis SET NX inside the Step 4 Task Worker — same
 * pattern as msg_notification_queue.idempotency_key from Cycle 3.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header, no semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 6. The splitter
 * cuts on every semicolon regardless of quoting context including
 * inside block comments and inside default expressions.
 */

CREATE TABLE IF NOT EXISTS tsk_acknowledgements (
  id                       UUID         PRIMARY KEY,
  school_id                UUID         NOT NULL,
  subject_id               UUID         NOT NULL,
  source_type              TEXT         NOT NULL,
  source_ref_id            UUID         NOT NULL,
  source_table             TEXT         NOT NULL,
  title                    TEXT         NOT NULL,
  body_s3_key              TEXT,
  requires_dispute_option  BOOLEAN      NOT NULL DEFAULT false,
  status                   TEXT         NOT NULL DEFAULT 'PENDING',
  acknowledged_at          TIMESTAMPTZ,
  dispute_reason           TEXT,
  created_by               UUID         NOT NULL,
  expires_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tsk_acknowledgements_source_type_chk
    CHECK (source_type IN ('ANNOUNCEMENT', 'DISCIPLINE_RECORD', 'POLICY_DOCUMENT', 'SIGNED_FORM', 'CONSENT_REQUEST', 'CUSTOM')),
  CONSTRAINT tsk_acknowledgements_status_chk
    CHECK (status IN ('PENDING', 'ACKNOWLEDGED', 'ACKNOWLEDGED_WITH_DISPUTE', 'EXPIRED')),
  CONSTRAINT tsk_acknowledgements_dispute_chk
    CHECK ((status <> 'ACKNOWLEDGED_WITH_DISPUTE') OR (dispute_reason IS NOT NULL)),
  CONSTRAINT tsk_acknowledgements_ack_chk
    CHECK ((status NOT IN ('ACKNOWLEDGED', 'ACKNOWLEDGED_WITH_DISPUTE')) OR (acknowledged_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS tsk_acknowledgements_subject_status_idx
  ON tsk_acknowledgements (subject_id, status);

CREATE INDEX IF NOT EXISTS tsk_acknowledgements_source_idx
  ON tsk_acknowledgements (source_type, source_ref_id);

COMMENT ON TABLE tsk_acknowledgements IS
  'Per-(school, subject) acknowledgement rows. The Step 4 Task Worker creates a tsk_tasks row with task_category=ACKNOWLEDGEMENT linked back via acknowledgement_id whenever a row lands here.';

COMMENT ON COLUMN tsk_acknowledgements.source_type IS
  'Polymorphic source. Pair with source_ref_id and source_table to identify the originating row in the domain table.';

CREATE TABLE IF NOT EXISTS tsk_auto_task_rules (
  id                    UUID         PRIMARY KEY,
  school_id             UUID         NOT NULL,
  trigger_event_type    TEXT         NOT NULL,
  target_role           TEXT,
  title_template        TEXT         NOT NULL,
  description_template  TEXT,
  priority              TEXT         NOT NULL DEFAULT 'NORMAL',
  due_offset_hours      INT,
  task_category         TEXT         NOT NULL DEFAULT 'PERSONAL',
  is_active             BOOLEAN      NOT NULL DEFAULT true,
  is_system             BOOLEAN      NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tsk_auto_task_rules_priority_chk
    CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  CONSTRAINT tsk_auto_task_rules_category_chk
    CHECK (task_category IN ('ACADEMIC', 'PERSONAL', 'ADMINISTRATIVE', 'ACKNOWLEDGEMENT'))
);

CREATE UNIQUE INDEX IF NOT EXISTS tsk_auto_task_rules_school_event_uq
  ON tsk_auto_task_rules (school_id, trigger_event_type)
  WHERE is_system = true;

COMMENT ON COLUMN tsk_auto_task_rules.title_template IS
  'Supports placeholders such as student_name, assignment_title, class_name. Substitution is handled in the Step 4 Task Worker.';

CREATE TABLE IF NOT EXISTS tsk_auto_task_conditions (
  id          UUID         PRIMARY KEY,
  rule_id     UUID         NOT NULL REFERENCES tsk_auto_task_rules(id) ON DELETE CASCADE,
  field_path  TEXT         NOT NULL,
  operator    TEXT         NOT NULL,
  value       JSONB,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tsk_auto_task_conditions_operator_chk
    CHECK (operator IN ('EQUALS', 'NOT_EQUALS', 'IN', 'NOT_IN', 'GT', 'LT', 'EXISTS'))
);

CREATE INDEX IF NOT EXISTS tsk_auto_task_conditions_rule_idx
  ON tsk_auto_task_conditions (rule_id);

CREATE TABLE IF NOT EXISTS tsk_auto_task_actions (
  id             UUID         PRIMARY KEY,
  rule_id        UUID         NOT NULL REFERENCES tsk_auto_task_rules(id) ON DELETE CASCADE,
  action_type    TEXT         NOT NULL,
  action_config  JSONB        NOT NULL DEFAULT '{}'::jsonb,
  sort_order     INT          NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tsk_auto_task_actions_type_chk
    CHECK (action_type IN ('CREATE_TASK', 'CREATE_ACKNOWLEDGEMENT', 'SEND_NOTIFICATION'))
);

CREATE INDEX IF NOT EXISTS tsk_auto_task_actions_rule_idx
  ON tsk_auto_task_actions (rule_id, sort_order);

CREATE TABLE IF NOT EXISTS tsk_tasks (
  id                  UUID         NOT NULL,
  school_id           UUID         NOT NULL,
  owner_id            UUID         NOT NULL,
  title               TEXT         NOT NULL,
  description         TEXT,
  source              TEXT         NOT NULL DEFAULT 'MANUAL',
  source_ref_id       UUID,
  priority            TEXT         NOT NULL DEFAULT 'NORMAL',
  status              TEXT         NOT NULL DEFAULT 'TODO',
  due_at              TIMESTAMPTZ,
  task_category       TEXT         NOT NULL DEFAULT 'PERSONAL',
  acknowledgement_id  UUID         REFERENCES tsk_acknowledgements(id) ON DELETE SET NULL,
  created_for_id      UUID,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  CONSTRAINT tsk_tasks_source_chk
    CHECK (source IN ('MANUAL', 'AUTO', 'SYSTEM')),
  CONSTRAINT tsk_tasks_priority_chk
    CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  CONSTRAINT tsk_tasks_status_chk
    CHECK (status IN ('TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED')),
  CONSTRAINT tsk_tasks_category_chk
    CHECK (task_category IN ('ACADEMIC', 'PERSONAL', 'ADMINISTRATIVE', 'ACKNOWLEDGEMENT')),
  CONSTRAINT tsk_tasks_completed_chk
    CHECK (
      (status IN ('TODO', 'IN_PROGRESS') AND completed_at IS NULL)
      OR
      (status IN ('DONE', 'CANCELLED') AND completed_at IS NOT NULL)
    )
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS tsk_tasks_owner_status_due_idx
  ON tsk_tasks (owner_id, status, due_at);

CREATE INDEX IF NOT EXISTS tsk_tasks_school_status_idx
  ON tsk_tasks (school_id, status);

CREATE INDEX IF NOT EXISTS tsk_tasks_auto_dedup_idx
  ON tsk_tasks (owner_id, source, source_ref_id)
  WHERE source <> 'MANUAL';

COMMENT ON TABLE tsk_tasks IS
  'Cycle 7 task surface. Step 4 Task Worker is the sole writer per ADR-011. Domain modules emit Kafka events and auto-task rules translate them into rows here. Manual rows come through TaskService with source=MANUAL.';

CREATE TABLE IF NOT EXISTS tsk_tasks_2025_08 PARTITION OF tsk_tasks FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2025_09 PARTITION OF tsk_tasks FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2025_10 PARTITION OF tsk_tasks FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2025_11 PARTITION OF tsk_tasks FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2025_12 PARTITION OF tsk_tasks FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2026_01 PARTITION OF tsk_tasks FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2026_02 PARTITION OF tsk_tasks FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2026_03 PARTITION OF tsk_tasks FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2026_04 PARTITION OF tsk_tasks FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2026_05 PARTITION OF tsk_tasks FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2026_06 PARTITION OF tsk_tasks FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2026_07 PARTITION OF tsk_tasks FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2026_08 PARTITION OF tsk_tasks FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2026_09 PARTITION OF tsk_tasks FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2026_10 PARTITION OF tsk_tasks FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2026_11 PARTITION OF tsk_tasks FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2026_12 PARTITION OF tsk_tasks FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2027_01 PARTITION OF tsk_tasks FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2027_02 PARTITION OF tsk_tasks FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2027_03 PARTITION OF tsk_tasks FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2027_04 PARTITION OF tsk_tasks FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2027_05 PARTITION OF tsk_tasks FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2027_06 PARTITION OF tsk_tasks FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_2027_07 PARTITION OF tsk_tasks FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');

CREATE TABLE IF NOT EXISTS tsk_tasks_archive (
  id                  UUID         NOT NULL,
  school_id           UUID         NOT NULL,
  owner_id            UUID         NOT NULL,
  title               TEXT         NOT NULL,
  description         TEXT,
  source              TEXT         NOT NULL,
  source_ref_id       UUID,
  priority            TEXT         NOT NULL,
  status              TEXT         NOT NULL,
  due_at              TIMESTAMPTZ,
  task_category       TEXT         NOT NULL,
  acknowledgement_id  UUID,
  created_for_id      UUID,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL,
  updated_at          TIMESTAMPTZ  NOT NULL,
  archived_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS tsk_tasks_archive_owner_completed_idx
  ON tsk_tasks_archive (owner_id, completed_at DESC);

COMMENT ON TABLE tsk_tasks_archive IS
  'Long-term storage for completed tasks. The archiver job moves DONE and CANCELLED rows older than 30 days from tsk_tasks into this table. Schema-only this cycle. The archiver itself is deferred to ops.';

CREATE TABLE IF NOT EXISTS tsk_tasks_archive_2025 PARTITION OF tsk_tasks_archive FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_archive_2026 PARTITION OF tsk_tasks_archive FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS tsk_tasks_archive_2027 PARTITION OF tsk_tasks_archive FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');
