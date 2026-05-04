/* 028_tkt_categories_sla_vendors.sql
 * Cycle 8 Step 1 — Service Tickets configuration schema.
 *
 * Four new tenant base tables for the M60 Service Tickets module
 * configuration layer. The Step 2 migration adds the operational layer
 * (tickets, comments, attachments, tags, activity log, problems, problem
 * link table) on top of these.
 *
 *   tkt_categories       — Hierarchical ticket categories. Top-level
 *                          rows have parent_category_id NULL and
 *                          represent the broad domain like IT or
 *                          Facilities or HR Support. Child rows encode
 *                          the next layer of the tree. UNIQUE(school_id,
 *                          name) keeps the tree readable. The self-FK
 *                          uses NO ACTION so an admin must move or
 *                          deactivate child rows before deleting a
 *                          parent. is_active flags soft-deactivation
 *                          which the Step 4 ticket UI uses to hide
 *                          retired categories from new submissions
 *                          without dropping historical tickets that
 *                          reference them.
 *   tkt_subcategories    — Leaf-level classification with optional
 *                          auto-assignment hints. default_assignee_id
 *                          is a DB-enforced FK to hr_employees so the
 *                          Step 4 TicketService can look up the target
 *                          employee for direct assignment. Setting it
 *                          to NULL falls back to auto_assign_to_role
 *                          which the service resolves the same way the
 *                          Cycle 7 WorkflowEngineService resolves a
 *                          ROLE-typed approver. Both columns null means
 *                          the ticket lands in the queue unassigned.
 *                          UNIQUE(category_id, name).
 *   tkt_sla_policies     — Per-(category, priority) SLA target hours.
 *                          The clock is computed at read time from
 *                          tkt_tickets.created_at and the matching
 *                          policy row. response_hours and
 *                          resolution_hours are both INT NOT NULL with
 *                          a positive CHECK. UNIQUE(school_id,
 *                          category_id, priority) so each (category,
 *                          priority) pair has exactly one policy per
 *                          school. Priority is a 4-value enum CHECK
 *                          LOW / MEDIUM / HIGH / CRITICAL.
 *   tkt_vendors          — External vendor registry. vendor_type is a
 *                          9-value enum CHECK that lets the admin queue
 *                          filter and the assignment modal sort
 *                          vendors by speciality. is_preferred flags
 *                          the vendor a school normally calls first.
 *                          UNIQUE(school_id, vendor_name).
 *
 * Soft cross-schema refs per ADR-001 and ADR-020:
 *   tkt_categories.school_id      -> platform.schools(id)
 *   tkt_subcategories             — no cross-schema soft refs
 *   tkt_sla_policies.school_id    -> platform.schools(id)
 *   tkt_vendors.school_id         -> platform.schools(id)
 *
 * DB-enforced intra-tenant FKs (4 logical):
 *   tkt_categories.parent_category_id  -> tkt_categories(id) NO ACTION
 *     Refuses delete when child rows exist. Admin moves or deactivates
 *     children first.
 *   tkt_subcategories.category_id      -> tkt_categories(id) CASCADE
 *     Dropping a category drops its leaves. Historical tickets that
 *     reference the leaves keep working because the ticket FK to
 *     tkt_subcategories will be NO ACTION in Step 2 and admins are
 *     expected to deactivate rather than hard-delete.
 *   tkt_subcategories.default_assignee_id -> hr_employees(id) SET NULL
 *     If the seeded admin leaves the school, the auto-assignment
 *     gracefully falls back to the role-based path or unassigned
 *     instead of breaking the rule.
 *   tkt_sla_policies.category_id       -> tkt_categories(id) CASCADE
 *     SLA rows are meaningless without their category.
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header, no semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 7. The splitter
 * cuts on every semicolon regardless of quoting context including
 * inside block comments and inside default expressions.
 */

CREATE TABLE IF NOT EXISTS tkt_categories (
  id                    UUID         PRIMARY KEY,
  school_id             UUID         NOT NULL,
  parent_category_id    UUID         REFERENCES tkt_categories(id),
  name                  TEXT         NOT NULL,
  icon                  TEXT,
  is_active             BOOLEAN      NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tkt_categories_school_name_uq
  ON tkt_categories (school_id, name);

CREATE INDEX IF NOT EXISTS tkt_categories_parent_idx
  ON tkt_categories (parent_category_id)
  WHERE parent_category_id IS NOT NULL;

COMMENT ON TABLE tkt_categories IS
  'Hierarchical ticket categories. Top-level rows have parent_category_id NULL. The Step 2 tkt_tickets table references this table for the requester picked category. UNIQUE(school_id, name) is enforced across the full tree, so a child cannot share a name with a sibling or a top-level row.';

COMMENT ON COLUMN tkt_categories.parent_category_id IS
  'NULL for top-level categories like IT or Facilities. Set to the parent id for nested sub-categories. Self-FK is NO ACTION so a delete of a parent with children is refused at the DB layer.';

CREATE TABLE IF NOT EXISTS tkt_subcategories (
  id                       UUID         PRIMARY KEY,
  category_id              UUID         NOT NULL REFERENCES tkt_categories(id) ON DELETE CASCADE,
  name                     TEXT         NOT NULL,
  default_assignee_id      UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  auto_assign_to_role      TEXT,
  is_active                BOOLEAN      NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tkt_subcategories_category_name_uq
  ON tkt_subcategories (category_id, name);

CREATE INDEX IF NOT EXISTS tkt_subcategories_default_assignee_idx
  ON tkt_subcategories (default_assignee_id)
  WHERE default_assignee_id IS NOT NULL;

COMMENT ON TABLE tkt_subcategories IS
  'Leaf-level classification under a category. Auto-assignment is optional. When default_assignee_id is set the Step 4 TicketService assigns the new ticket directly. When auto_assign_to_role is set the service resolves a holder of the role using the same ROLE resolution helper as the Cycle 7 WorkflowEngineService. When both are null the ticket lands in the admin queue unassigned.';

COMMENT ON COLUMN tkt_subcategories.auto_assign_to_role IS
  'Role token like SCHOOL_ADMIN. Resolved at submission time the same way the workflow engine resolves a ROLE-typed approver. Falls back to first matching role-holder when more than one exists.';

CREATE TABLE IF NOT EXISTS tkt_sla_policies (
  id                  UUID         PRIMARY KEY,
  school_id           UUID         NOT NULL,
  category_id         UUID         NOT NULL REFERENCES tkt_categories(id) ON DELETE CASCADE,
  priority            TEXT         NOT NULL,
  response_hours      INT          NOT NULL,
  resolution_hours    INT          NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tkt_sla_policies_priority_chk
    CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  CONSTRAINT tkt_sla_policies_response_chk
    CHECK (response_hours > 0),
  CONSTRAINT tkt_sla_policies_resolution_chk
    CHECK (resolution_hours > 0),
  CONSTRAINT tkt_sla_policies_order_chk
    CHECK (resolution_hours >= response_hours)
);

CREATE UNIQUE INDEX IF NOT EXISTS tkt_sla_policies_school_category_priority_uq
  ON tkt_sla_policies (school_id, category_id, priority);

CREATE INDEX IF NOT EXISTS tkt_sla_policies_category_idx
  ON tkt_sla_policies (category_id);

COMMENT ON TABLE tkt_sla_policies IS
  'Per-(school, category, priority) SLA target hours. The Step 4 SlaService.computeSlaBreach helper reads response_hours and resolution_hours and computes breach status from tkt_tickets.created_at and now(). The clock is not stored as a countdown.';

COMMENT ON CONSTRAINT tkt_sla_policies_order_chk ON tkt_sla_policies IS
  'Resolution must take at least as long as the response window. Prevents a misconfigured policy where the ticket is breached on resolution before it can be breached on response.';

CREATE TABLE IF NOT EXISTS tkt_vendors (
  id              UUID         PRIMARY KEY,
  school_id       UUID         NOT NULL,
  vendor_name     TEXT         NOT NULL,
  vendor_type     TEXT         NOT NULL,
  contact_name    TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
  website         TEXT,
  is_preferred    BOOLEAN      NOT NULL DEFAULT false,
  notes           TEXT,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tkt_vendors_type_chk
    CHECK (vendor_type IN ('IT_REPAIR', 'FACILITIES_MAINTENANCE', 'CLEANING', 'ELECTRICAL', 'PLUMBING', 'HVAC', 'SECURITY', 'GROUNDS', 'OTHER'))
);

CREATE UNIQUE INDEX IF NOT EXISTS tkt_vendors_school_name_uq
  ON tkt_vendors (school_id, vendor_name);

CREATE INDEX IF NOT EXISTS tkt_vendors_school_active_idx
  ON tkt_vendors (school_id, is_active);

CREATE INDEX IF NOT EXISTS tkt_vendors_preferred_idx
  ON tkt_vendors (school_id, is_preferred)
  WHERE is_preferred = true;

COMMENT ON TABLE tkt_vendors IS
  'External vendor registry. The Step 4 TicketService loads this table for the assignment modal, sorting by is_preferred DESC then vendor_name. The Step 2 tkt_tickets.vendor_id FK references this table when a ticket is escalated to an external vendor.';

COMMENT ON COLUMN tkt_vendors.is_preferred IS
  'Schools mark one vendor per type as the default first call. The Step 8 admin UI sorts the assignment dropdown with preferred vendors at the top.';
