/* 027_wsk_approval_workflows.sql
 * Cycle 7 Step 2 — Approval workflows schema.
 *
 * Six new tenant base tables for the M2 Approval Workflows module. The
 * Step 6 WorkflowEngineService is the sole writer to wsk_approval_requests
 * and wsk_approval_steps per ADR-012. Source modules submit via the REST
 * API and listen on the approval.request.resolved Kafka event.
 *
 *   wsk_workflow_templates  — per-(school, request_type) template that
 *                              defines the approval chain. is_active
 *                              flag controls runtime selection. UNIQUE
 *                              on (school_id, request_type) so each
 *                              school has one active template per
 *                              request type.
 *   wsk_workflow_steps      — ordered approval steps belonging to a
 *                              template. approver_type 4-value enum
 *                              SPECIFIC_USER / ROLE / MANAGER /
 *                              DEPARTMENT_HEAD. Multi-column approver
 *                              shape CHECK enforces SPECIFIC_USER and
 *                              ROLE require approver_ref while MANAGER
 *                              and DEPARTMENT_HEAD require it null.
 *                              is_parallel column ships now but the
 *                              engine is sequential-only this cycle —
 *                              parallel deferred per the plan.
 *   wsk_approval_requests   — one row per submission. status lifecycle
 *                              PENDING / APPROVED / REJECTED /
 *                              CANCELLED / WITHDRAWN. Soft polymorphic
 *                              reference_id and reference_table point
 *                              at the originating domain row. Both
 *                              columns nullable to support CUSTOM
 *                              workflows that have no domain row.
 *   wsk_approval_steps      — one row per active or completed step on
 *                              a request. status lifecycle AWAITING /
 *                              APPROVED / REJECTED / SKIPPED. Multi-
 *                              column actioned_chk keeps actioned_at in
 *                              sync with terminal status. Partial INDEX
 *                              on (approver_id, status) WHERE
 *                              status='AWAITING' is the approver's
 *                              pending-queue hot path.
 *   wsk_approval_comments   — append-only thread on a request.
 *                              is_requester_visible flag distinguishes
 *                              public comments from
 *                              approver-internal-only notes.
 *   wsk_workflow_escalations — IMMUTABLE audit. One row per escalation.
 *                              resolved_at and resolved_by are settable
 *                              once when the escalation is acted on
 *                              (the row is otherwise append-only — by
 *                              service-side discipline, not a DB
 *                              trigger). Schema-only this cycle. The
 *                              escalation timeout worker is deferred.
 *
 * Soft cross-schema refs per ADR-001 and ADR-020:
 *   wsk_workflow_steps.escalation_target_id  -> platform.platform_users(id)
 *   wsk_approval_requests.requester_id       -> platform.platform_users(id)
 *   wsk_approval_steps.approver_id           -> platform.platform_users(id)
 *   wsk_approval_comments.author_id          -> platform.platform_users(id)
 *   wsk_workflow_escalations.original_approver_id, escalated_to_id,
 *     resolved_by                            -> platform.platform_users(id)
 *
 * DB-enforced intra-tenant FKs (6 logical):
 *   wsk_workflow_steps.template_id          -> wsk_workflow_templates(id) CASCADE
 *   wsk_approval_requests.template_id       -> wsk_workflow_templates(id) NO ACTION
 *     We deliberately refuse to delete a template that has historical
 *     requests against it. Audit trail wins over cleanup ergonomics.
 *   wsk_approval_steps.request_id           -> wsk_approval_requests(id) CASCADE
 *   wsk_approval_comments.request_id        -> wsk_approval_requests(id) CASCADE
 *   wsk_workflow_escalations.request_id     -> wsk_approval_requests(id) NO ACTION
 *   wsk_workflow_escalations.step_id        -> wsk_approval_steps(id) NO ACTION
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header, no semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 6. The splitter
 * cuts on every semicolon regardless of quoting context including
 * inside block comments and inside default expressions.
 */

CREATE TABLE IF NOT EXISTS wsk_workflow_templates (
  id            UUID         PRIMARY KEY,
  school_id     UUID         NOT NULL,
  name          TEXT         NOT NULL,
  request_type  TEXT         NOT NULL,
  description   TEXT,
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wsk_workflow_templates_school_type_uq
  ON wsk_workflow_templates (school_id, request_type);

COMMENT ON TABLE wsk_workflow_templates IS
  'Per-(school, request_type) approval chain definition. Each school has at most one template per request type. The Step 6 WorkflowEngineService selects the active template at submission time.';

CREATE TABLE IF NOT EXISTS wsk_workflow_steps (
  id                     UUID         PRIMARY KEY,
  template_id            UUID         NOT NULL REFERENCES wsk_workflow_templates(id) ON DELETE CASCADE,
  step_order             INT          NOT NULL,
  approver_type          TEXT         NOT NULL,
  approver_ref           TEXT,
  is_parallel            BOOLEAN      NOT NULL DEFAULT false,
  timeout_hours          INT,
  escalation_target_id   UUID,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT wsk_workflow_steps_order_chk
    CHECK (step_order > 0),
  CONSTRAINT wsk_workflow_steps_timeout_chk
    CHECK (timeout_hours IS NULL OR timeout_hours > 0),
  CONSTRAINT wsk_workflow_steps_approver_type_chk
    CHECK (approver_type IN ('SPECIFIC_USER', 'ROLE', 'MANAGER', 'DEPARTMENT_HEAD')),
  CONSTRAINT wsk_workflow_steps_approver_shape_chk
    CHECK (
      (approver_type IN ('SPECIFIC_USER', 'ROLE') AND approver_ref IS NOT NULL)
      OR
      (approver_type IN ('MANAGER', 'DEPARTMENT_HEAD') AND approver_ref IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS wsk_workflow_steps_template_order_idx
  ON wsk_workflow_steps (template_id, step_order);

CREATE UNIQUE INDEX IF NOT EXISTS wsk_workflow_steps_template_order_uq
  ON wsk_workflow_steps (template_id, step_order);

COMMENT ON COLUMN wsk_workflow_steps.is_parallel IS
  'Reserved for parallel approval steps. The Step 6 engine ships sequential-only this cycle. Schema is forward-compatible.';

COMMENT ON COLUMN wsk_workflow_steps.approver_ref IS
  'Required for SPECIFIC_USER (a UUID encoded as TEXT) and ROLE (the role token). Null for MANAGER and DEPARTMENT_HEAD which the engine resolves dynamically at runtime.';

CREATE TABLE IF NOT EXISTS wsk_approval_requests (
  id                UUID         PRIMARY KEY,
  school_id         UUID         NOT NULL,
  template_id       UUID         NOT NULL REFERENCES wsk_workflow_templates(id),
  requester_id      UUID         NOT NULL,
  request_type      TEXT         NOT NULL,
  reference_id      UUID,
  reference_table   TEXT,
  status            TEXT         NOT NULL DEFAULT 'PENDING',
  submitted_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT wsk_approval_requests_status_chk
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN')),
  CONSTRAINT wsk_approval_requests_resolved_chk
    CHECK (
      (status = 'PENDING' AND resolved_at IS NULL)
      OR
      (status IN ('APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN') AND resolved_at IS NOT NULL)
    ),
  CONSTRAINT wsk_approval_requests_reference_shape_chk
    CHECK (
      (reference_id IS NULL AND reference_table IS NULL)
      OR
      (reference_id IS NOT NULL AND reference_table IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS wsk_approval_requests_active_idx
  ON wsk_approval_requests (school_id, status, request_type)
  WHERE status NOT IN ('APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN');

CREATE INDEX IF NOT EXISTS wsk_approval_requests_requester_idx
  ON wsk_approval_requests (requester_id, created_at DESC);

CREATE INDEX IF NOT EXISTS wsk_approval_requests_reference_idx
  ON wsk_approval_requests (reference_table, reference_id)
  WHERE reference_id IS NOT NULL;

COMMENT ON TABLE wsk_approval_requests IS
  'One row per approval submission. WorkflowEngineService is the sole writer per ADR-012. The reference_table and reference_id pair is a soft polymorphic ref to the originating domain row.';

CREATE TABLE IF NOT EXISTS wsk_approval_steps (
  id            UUID         PRIMARY KEY,
  request_id    UUID         NOT NULL REFERENCES wsk_approval_requests(id) ON DELETE CASCADE,
  step_order    INT          NOT NULL,
  approver_id   UUID         NOT NULL,
  status        TEXT         NOT NULL DEFAULT 'AWAITING',
  actioned_at   TIMESTAMPTZ,
  comments      TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT wsk_approval_steps_order_chk
    CHECK (step_order > 0),
  CONSTRAINT wsk_approval_steps_status_chk
    CHECK (status IN ('AWAITING', 'APPROVED', 'REJECTED', 'SKIPPED')),
  CONSTRAINT wsk_approval_steps_actioned_chk
    CHECK (
      (status = 'AWAITING' AND actioned_at IS NULL)
      OR
      (status IN ('APPROVED', 'REJECTED') AND actioned_at IS NOT NULL)
      OR
      (status = 'SKIPPED')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS wsk_approval_steps_request_order_uq
  ON wsk_approval_steps (request_id, step_order);

CREATE INDEX IF NOT EXISTS wsk_approval_steps_approver_pending_idx
  ON wsk_approval_steps (approver_id, status)
  WHERE status = 'AWAITING';

COMMENT ON COLUMN wsk_approval_steps.approver_id IS
  'The resolved approver at step activation. For ROLE-typed steps, the engine picks one role-holder when activating the step. For SPECIFIC_USER, this is the literal user. For MANAGER and DEPARTMENT_HEAD, the engine resolves from hr_employees or sis_departments at activation time.';

CREATE TABLE IF NOT EXISTS wsk_approval_comments (
  id                     UUID         PRIMARY KEY,
  request_id             UUID         NOT NULL REFERENCES wsk_approval_requests(id) ON DELETE CASCADE,
  author_id              UUID         NOT NULL,
  body                   TEXT         NOT NULL,
  is_requester_visible   BOOLEAN      NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wsk_approval_comments_request_idx
  ON wsk_approval_comments (request_id, created_at);

COMMENT ON COLUMN wsk_approval_comments.is_requester_visible IS
  'When false, the comment is approver-internal only and the requester does not see it on the approval detail page.';

CREATE TABLE IF NOT EXISTS wsk_workflow_escalations (
  id                      UUID         PRIMARY KEY,
  request_id              UUID         NOT NULL REFERENCES wsk_approval_requests(id),
  step_id                 UUID         NOT NULL REFERENCES wsk_approval_steps(id),
  original_approver_id    UUID         NOT NULL,
  escalated_to_id         UUID         NOT NULL,
  escalation_reason       TEXT         NOT NULL DEFAULT 'Approval step timed out',
  hours_overdue           NUMERIC(5,1) NOT NULL,
  escalated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  resolved_at             TIMESTAMPTZ,
  resolved_by             UUID,
  CONSTRAINT wsk_workflow_escalations_hours_chk
    CHECK (hours_overdue >= 0),
  CONSTRAINT wsk_workflow_escalations_resolved_chk
    CHECK (
      (resolved_at IS NULL AND resolved_by IS NULL)
      OR
      (resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS wsk_workflow_escalations_pending_idx
  ON wsk_workflow_escalations (escalated_to_id, resolved_at)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE wsk_workflow_escalations IS
  'Append-mostly audit. One row per escalation. resolved_at and resolved_by are settable once when the escalation is acted on. Otherwise no UPDATE / no DELETE per service-side discipline. Schema-only this cycle. The escalation timeout worker is deferred.';
