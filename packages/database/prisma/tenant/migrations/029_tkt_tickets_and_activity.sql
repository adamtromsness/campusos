/* 029_tkt_tickets_and_activity.sql
 * Cycle 8 Step 2 — Service Tickets operational schema.
 *
 * Seven new tenant base tables for the M60 Service Tickets module
 * operational layer. Builds on top of the Step 1 configuration tables
 * (tkt_categories / tkt_subcategories / tkt_sla_policies / tkt_vendors).
 * The Step 4 TicketService is the request-path writer for tickets and
 * comments. Activity rows are written by a private recordActivity
 * helper called from every lifecycle path so the audit log captures
 * every state change without requiring callers to remember.
 *
 *   tkt_tickets               — One row per support ticket. status
 *                                lifecycle 7-value enum OPEN /
 *                                IN_PROGRESS / VENDOR_ASSIGNED /
 *                                PENDING_REQUESTER / RESOLVED / CLOSED
 *                                / CANCELLED. priority 4-value enum
 *                                LOW / MEDIUM / HIGH / CRITICAL with
 *                                DEFAULT MEDIUM. Multi-column
 *                                resolved_chk keeps resolved_at and
 *                                closed_at in lockstep with status.
 *                                Multi-column assignee_or_vendor_chk
 *                                rejects a ticket that has both an
 *                                internal assignee_id AND an external
 *                                vendor_id set. Multi-column
 *                                vendor_pair_chk keeps vendor_id and
 *                                vendor_assigned_at all-set or
 *                                all-null together so a stray
 *                                timestamp without a vendor cannot
 *                                ship. requester_id is a soft ref to
 *                                platform_users per ADR-001 and
 *                                ADR-020. location_id is a soft ref
 *                                to sch_rooms so Room 101 lookups
 *                                join through Cycle 5 scheduling.
 *   tkt_ticket_comments       — Append-only thread on a ticket.
 *                                is_internal flag distinguishes
 *                                staff-only notes from comments the
 *                                requester sees. CASCADE on ticket
 *                                so deleting a ticket drops its
 *                                thread.
 *   tkt_ticket_attachments    — Signed-S3-URL pattern matching
 *                                hr_employee_documents from Cycle 4.
 *                                CASCADE on ticket.
 *   tkt_ticket_tags           — Free-form admin tags for filtering.
 *                                UNIQUE(ticket_id, tag) so a single
 *                                tag cannot land twice on the same
 *                                ticket. CASCADE on ticket.
 *   tkt_ticket_activity       — IMMUTABLE audit log per ADR-010
 *                                pattern (service-side discipline,
 *                                no DB trigger). 7-value
 *                                activity_type enum STATUS_CHANGE /
 *                                REASSIGNMENT / COMMENT / ATTACHMENT
 *                                / ESCALATION / VENDOR_ASSIGNMENT /
 *                                SLA_BREACH. metadata JSONB carries
 *                                the before and after of each
 *                                lifecycle transition (e.g. status
 *                                old to new, assignee old to new).
 *                                CASCADE on ticket since the audit
 *                                is meaningless without the parent
 *                                row and tickets are not expected
 *                                to be hard-deleted in production.
 *   tkt_problems              — Root-cause grouping for related
 *                                tickets. status lifecycle 4-value
 *                                enum OPEN / INVESTIGATING /
 *                                KNOWN_ERROR / RESOLVED. Multi-column
 *                                resolved_chk enforces KNOWN_ERROR
 *                                requires root_cause and RESOLVED
 *                                requires root_cause + resolution +
 *                                resolved_at. Multi-column
 *                                assigned_or_vendor_chk mirrors the
 *                                ticket-level mutex.
 *   tkt_problem_tickets       — Many-to-many link between problems
 *                                and tickets. UNIQUE(problem_id,
 *                                ticket_id). Double-CASCADE so
 *                                deleting either side drops the link.
 *
 * Soft cross-schema refs per ADR-001 and ADR-020:
 *   tkt_tickets.requester_id        -> platform.platform_users(id)
 *   tkt_tickets.location_id         -> sch_rooms(id)  (intra-tenant
 *                                       but kept soft because rooms
 *                                       are managed by the Cycle 5
 *                                       module and a ticket should
 *                                       survive a room being retired)
 *   tkt_ticket_comments.author_id   -> platform.platform_users(id)
 *   tkt_ticket_attachments.uploaded_by -> platform.platform_users(id)
 *   tkt_ticket_activity.actor_id    -> platform.platform_users(id)
 *   tkt_problems.created_by         -> platform.platform_users(id)
 *
 * DB-enforced intra-tenant FKs (14 logical):
 *   tkt_tickets.category_id      -> tkt_categories(id) NO ACTION
 *     Refuses delete when historical tickets exist. Admin
 *     deactivates rather than hard-deletes.
 *   tkt_tickets.subcategory_id   -> tkt_subcategories(id) NO ACTION
 *     Same audit-trail rule. Admins flip is_active=false on the leaf.
 *   tkt_tickets.assignee_id      -> hr_employees(id) SET NULL
 *     Employee leaving the school does not break historical tickets.
 *   tkt_tickets.vendor_id        -> tkt_vendors(id) SET NULL
 *     Vendor deactivated does not break historical tickets.
 *   tkt_tickets.sla_policy_id    -> tkt_sla_policies(id) SET NULL
 *     SLA policy edits do not break historical tickets. The clock
 *     is computed against the policy as it stood at creation time
 *     for live tickets, and historical breach status is captured
 *     by the resolved_at timestamp anyway.
 *   tkt_ticket_comments.ticket_id     -> tkt_tickets(id) CASCADE
 *   tkt_ticket_attachments.ticket_id  -> tkt_tickets(id) CASCADE
 *   tkt_ticket_tags.ticket_id         -> tkt_tickets(id) CASCADE
 *   tkt_ticket_activity.ticket_id     -> tkt_tickets(id) CASCADE
 *   tkt_problems.category_id     -> tkt_categories(id) NO ACTION
 *   tkt_problems.assigned_to_id  -> hr_employees(id) SET NULL
 *   tkt_problems.vendor_id       -> tkt_vendors(id) SET NULL
 *   tkt_problem_tickets.problem_id -> tkt_problems(id) CASCADE
 *   tkt_problem_tickets.ticket_id  -> tkt_tickets(id) CASCADE
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header, no semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 7. The splitter
 * cuts on every semicolon regardless of quoting context including
 * inside block comments and inside default expressions.
 */

CREATE TABLE IF NOT EXISTS tkt_tickets (
  id                    UUID         PRIMARY KEY,
  school_id             UUID         NOT NULL,
  category_id           UUID         NOT NULL REFERENCES tkt_categories(id),
  subcategory_id        UUID         REFERENCES tkt_subcategories(id),
  requester_id          UUID         NOT NULL,
  assignee_id           UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  vendor_id             UUID         REFERENCES tkt_vendors(id) ON DELETE SET NULL,
  vendor_reference      TEXT,
  vendor_assigned_at    TIMESTAMPTZ,
  title                 TEXT         NOT NULL,
  description           TEXT,
  priority              TEXT         NOT NULL DEFAULT 'MEDIUM',
  status                TEXT         NOT NULL DEFAULT 'OPEN',
  sla_policy_id         UUID         REFERENCES tkt_sla_policies(id) ON DELETE SET NULL,
  location_id           UUID,
  first_response_at     TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tkt_tickets_priority_chk
    CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  CONSTRAINT tkt_tickets_status_chk
    CHECK (status IN ('OPEN', 'IN_PROGRESS', 'VENDOR_ASSIGNED', 'PENDING_REQUESTER', 'RESOLVED', 'CLOSED', 'CANCELLED')),
  CONSTRAINT tkt_tickets_assignee_or_vendor_chk
    CHECK (assignee_id IS NULL OR vendor_id IS NULL),
  CONSTRAINT tkt_tickets_vendor_pair_chk
    CHECK (
      (vendor_id IS NULL AND vendor_assigned_at IS NULL)
      OR
      (vendor_id IS NOT NULL AND vendor_assigned_at IS NOT NULL)
    ),
  CONSTRAINT tkt_tickets_resolved_chk
    CHECK (
      (status IN ('OPEN', 'IN_PROGRESS', 'VENDOR_ASSIGNED', 'PENDING_REQUESTER') AND resolved_at IS NULL AND closed_at IS NULL)
      OR
      (status = 'RESOLVED' AND resolved_at IS NOT NULL AND closed_at IS NULL)
      OR
      (status = 'CLOSED' AND resolved_at IS NOT NULL AND closed_at IS NOT NULL)
      OR
      (status = 'CANCELLED' AND resolved_at IS NULL AND closed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS tkt_tickets_school_status_idx
  ON tkt_tickets (school_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS tkt_tickets_assignee_status_idx
  ON tkt_tickets (assignee_id, status)
  WHERE assignee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tkt_tickets_vendor_status_idx
  ON tkt_tickets (vendor_id, status)
  WHERE vendor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tkt_tickets_requester_idx
  ON tkt_tickets (requester_id, created_at DESC);

COMMENT ON TABLE tkt_tickets IS
  'One row per support ticket. The Step 4 TicketService is the request-path writer. Lifecycle transitions lock the row with SELECT FOR UPDATE inside executeInTenantTransaction per the convention. SLA breach is computed from created_at and the linked tkt_sla_policies row at read time, not stored as a countdown.';

COMMENT ON COLUMN tkt_tickets.assignee_id IS
  'Internal employee assigned to resolve the ticket. Mutually exclusive with vendor_id via tkt_tickets_assignee_or_vendor_chk so a ticket lives in exactly one assignee queue.';

COMMENT ON COLUMN tkt_tickets.vendor_reference IS
  'Vendor work order or case number. Nullable even when vendor_id is set because some vendors do not issue a reference number.';

COMMENT ON COLUMN tkt_tickets.location_id IS
  'Soft ref to sch_rooms(id). Kept soft so a ticket survives a room being retired in Cycle 5 scheduling.';

CREATE TABLE IF NOT EXISTS tkt_ticket_comments (
  id            UUID         PRIMARY KEY,
  ticket_id     UUID         NOT NULL REFERENCES tkt_tickets(id) ON DELETE CASCADE,
  author_id     UUID         NOT NULL,
  body          TEXT         NOT NULL,
  is_internal   BOOLEAN      NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tkt_ticket_comments_ticket_idx
  ON tkt_ticket_comments (ticket_id, created_at);

COMMENT ON COLUMN tkt_ticket_comments.is_internal IS
  'When true, the comment is staff-only and the requester does not see it on the ticket detail page. The Step 5 CommentService filters internal rows server-side for non-staff readers.';

CREATE TABLE IF NOT EXISTS tkt_ticket_attachments (
  id              UUID         PRIMARY KEY,
  ticket_id       UUID         NOT NULL REFERENCES tkt_tickets(id) ON DELETE CASCADE,
  s3_key          TEXT         NOT NULL,
  filename        TEXT,
  content_type    TEXT,
  file_size_bytes BIGINT,
  uploaded_by     UUID         NOT NULL,
  uploaded_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tkt_ticket_attachments_size_chk
    CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS tkt_ticket_attachments_ticket_idx
  ON tkt_ticket_attachments (ticket_id, uploaded_at);

CREATE TABLE IF NOT EXISTS tkt_ticket_tags (
  id          UUID         PRIMARY KEY,
  ticket_id   UUID         NOT NULL REFERENCES tkt_tickets(id) ON DELETE CASCADE,
  tag         TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tkt_ticket_tags_ticket_tag_uq
  ON tkt_ticket_tags (ticket_id, tag);

CREATE INDEX IF NOT EXISTS tkt_ticket_tags_tag_idx
  ON tkt_ticket_tags (tag);

CREATE TABLE IF NOT EXISTS tkt_ticket_activity (
  id              UUID         PRIMARY KEY,
  ticket_id       UUID         NOT NULL REFERENCES tkt_tickets(id) ON DELETE CASCADE,
  actor_id        UUID,
  activity_type   TEXT         NOT NULL,
  metadata        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tkt_ticket_activity_type_chk
    CHECK (activity_type IN (
      'STATUS_CHANGE', 'REASSIGNMENT', 'COMMENT', 'ATTACHMENT',
      'ESCALATION', 'VENDOR_ASSIGNMENT', 'SLA_BREACH'
    ))
);

CREATE INDEX IF NOT EXISTS tkt_ticket_activity_ticket_idx
  ON tkt_ticket_activity (ticket_id, created_at);

COMMENT ON TABLE tkt_ticket_activity IS
  'Immutable audit log per ADR-010 pattern. The Step 5 recordActivity helper is the sole writer. No UPDATE, no DELETE by service-side discipline (no DB trigger so emergency operator action remains possible). actor_id is nullable so system-driven entries like SLA_BREACH from a future cron worker can land without an actor.';

COMMENT ON COLUMN tkt_ticket_activity.metadata IS
  'JSONB freeform. STATUS_CHANGE rows carry {from: status, to: status}. REASSIGNMENT rows carry {from_assignee_id, to_assignee_id}. VENDOR_ASSIGNMENT rows carry {vendor_id, vendor_reference}. SLA_BREACH rows carry {breach_type: response or resolution, hours_overdue}.';

CREATE TABLE IF NOT EXISTS tkt_problems (
  id                UUID         PRIMARY KEY,
  school_id         UUID         NOT NULL,
  title             TEXT         NOT NULL,
  description       TEXT         NOT NULL,
  category_id       UUID         NOT NULL REFERENCES tkt_categories(id),
  status            TEXT         NOT NULL DEFAULT 'OPEN',
  root_cause        TEXT,
  resolution        TEXT,
  workaround        TEXT,
  assigned_to_id    UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  vendor_id         UUID         REFERENCES tkt_vendors(id) ON DELETE SET NULL,
  created_by        UUID         NOT NULL,
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tkt_problems_status_chk
    CHECK (status IN ('OPEN', 'INVESTIGATING', 'KNOWN_ERROR', 'RESOLVED')),
  CONSTRAINT tkt_problems_assigned_or_vendor_chk
    CHECK (assigned_to_id IS NULL OR vendor_id IS NULL),
  CONSTRAINT tkt_problems_resolved_chk
    CHECK (
      (status IN ('OPEN', 'INVESTIGATING') AND resolved_at IS NULL)
      OR
      (status = 'KNOWN_ERROR' AND root_cause IS NOT NULL AND resolved_at IS NULL)
      OR
      (status = 'RESOLVED' AND root_cause IS NOT NULL AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS tkt_problems_school_status_idx
  ON tkt_problems (school_id, status);

CREATE INDEX IF NOT EXISTS tkt_problems_category_idx
  ON tkt_problems (category_id);

COMMENT ON TABLE tkt_problems IS
  'Root-cause grouping for related tickets. The Step 5 ProblemService.resolve admin endpoint batch-flips every linked tkt_tickets row that is still OPEN or IN_PROGRESS to RESOLVED in the same transaction and emits one tkt.ticket.resolved event per ticket.';

COMMENT ON CONSTRAINT tkt_problems_resolved_chk ON tkt_problems IS
  'Lifecycle invariants. KNOWN_ERROR requires root_cause set so the workaround field is meaningful. RESOLVED requires root_cause + resolution + resolved_at all populated together.';

CREATE TABLE IF NOT EXISTS tkt_problem_tickets (
  id          UUID         PRIMARY KEY,
  problem_id  UUID         NOT NULL REFERENCES tkt_problems(id) ON DELETE CASCADE,
  ticket_id   UUID         NOT NULL REFERENCES tkt_tickets(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tkt_problem_tickets_pair_uq
  ON tkt_problem_tickets (problem_id, ticket_id);

CREATE INDEX IF NOT EXISTS tkt_problem_tickets_ticket_idx
  ON tkt_problem_tickets (ticket_id);

COMMENT ON TABLE tkt_problem_tickets IS
  'Many-to-many link between tkt_problems and tkt_tickets. Double-CASCADE because the link row has no meaning without either side.';
