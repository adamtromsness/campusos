/* ============================================================
 * Cycle 21 — Step 2: Work Orders + Preventive Maintenance
 * ============================================================
 *
 * 6 logical base tables for the M65 Facilities Management proactive
 * work surface. Two structural keystones in this migration:
 *
 *   1. fac_work_order_activity is IMMUTABLE per ADR-010 — no UPDATE
 *      and no DELETE methods on the service surface, append-only
 *      via WorkOrderService.recordActivity. CASCADE on parent
 *      work_order delete mirrors Cycle 8 tkt_ticket_activity.
 *
 *   2. fac_maintenance_checklist_results is IMMUTABLE per item once
 *      submitted. UNIQUE(task_id, checklist_item_id) keeps each
 *      checklist item answered at most once per task. The Step 6
 *      MaintenanceTaskService.submitResults inserts a follow-up
 *      fac_work_orders row whenever passed=false, in the same
 *      tenant tx, so the failure record stays immutable while the
 *      corrective work flows through the standard work order
 *      lifecycle.
 *
 * fac_work_orders.tkt_ticket_id is a DISPLAY-ONLY soft ref to the
 * Cycle 8 tkt_tickets table per ADR-033 — surfaces the originating
 * reactive ticket on the work order detail when an FM escalates a
 * ticket into a tracked work order. Nullable since most work orders
 * are FM-initiated, not ticket-originated.
 *
 * fac_work_orders.vendor_id is a DB-enforced FK to tkt_vendors so
 * the vendor catalogue is reused across Cycles 8 and 21.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op (CREATE TABLE IF NOT
 * EXISTS).
 * ============================================================ */

CREATE TABLE IF NOT EXISTS fac_work_orders (
  id                UUID PRIMARY KEY,
  school_id         UUID NOT NULL,
  work_order_type   TEXT NOT NULL,
  priority          TEXT NOT NULL,
  space_id          UUID,
  building_id       UUID,
  assigned_to_id    UUID,
  vendor_id         UUID,
  scheduled_date    DATE,
  completed_at      TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'OPEN',
  tkt_ticket_id     UUID,
  cost              NUMERIC(8,2),
  description       TEXT,
  notes             TEXT,
  created_by        UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_wo_type_chk CHECK (
    work_order_type IN ('REPAIR', 'INSTALLATION', 'INSPECTION_PREP', 'DEEP_CLEAN', 'RENOVATION')
  ),
  CONSTRAINT fac_wo_priority_chk CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  CONSTRAINT fac_wo_status_chk CHECK (
    status IN ('OPEN', 'IN_PROGRESS', 'VENDOR_ASSIGNED', 'ON_HOLD', 'COMPLETED', 'CANCELLED')
  ),
  CONSTRAINT fac_wo_completed_chk CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL)
    OR (status <> 'COMPLETED' AND completed_at IS NULL)
  ),
  CONSTRAINT fac_wo_cost_chk CHECK (cost IS NULL OR cost >= 0),
  CONSTRAINT fac_wo_space_fk FOREIGN KEY (space_id)
    REFERENCES fac_spaces(id) ON DELETE SET NULL,
  CONSTRAINT fac_wo_building_fk FOREIGN KEY (building_id)
    REFERENCES fac_buildings(id) ON DELETE SET NULL,
  CONSTRAINT fac_wo_vendor_fk FOREIGN KEY (vendor_id)
    REFERENCES tkt_vendors(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS fac_wo_school_status_idx
  ON fac_work_orders (school_id, status, scheduled_date);

CREATE INDEX IF NOT EXISTS fac_wo_assigned_idx
  ON fac_work_orders (assigned_to_id, status)
  WHERE assigned_to_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS fac_wo_priority_idx
  ON fac_work_orders (school_id, priority, status);

CREATE INDEX IF NOT EXISTS fac_wo_open_idx
  ON fac_work_orders (school_id, scheduled_date)
  WHERE status IN ('OPEN', 'IN_PROGRESS', 'VENDOR_ASSIGNED', 'ON_HOLD');

COMMENT ON TABLE fac_work_orders IS
  'Proactive facilities work order. 5-value type CHECK covers REPAIR / INSTALLATION / INSPECTION_PREP / DEEP_CLEAN / RENOVATION. 6-state lifecycle CHECK with multi-column completed_chk lockstep keeping completed_at populated only when status=COMPLETED. SET NULL on space + building + vendor preserves historical work orders past space retirement and vendor deactivation. assigned_to_id is a soft FK to hr_employees per ADR-001/020 (nullable for unassigned queue). tkt_ticket_id is a DISPLAY-ONLY soft ref to tkt_tickets per ADR-033 — populated when an FM escalates a Cycle 8 reactive ticket into a tracked proactive work order. vendor_id is a DB-enforced FK to the Cycle 8 tkt_vendors catalogue.';

COMMENT ON COLUMN fac_work_orders.tkt_ticket_id IS
  'DISPLAY-ONLY soft polymorphic ref to tkt_tickets(id) per ADR-033. Surfaces the originating reactive ticket on the work order detail page when applicable. NOT a DB-enforced FK because the cross-cycle reference is one-way and the originating ticket may be hard-deleted in some scenarios.';

COMMENT ON COLUMN fac_work_orders.assigned_to_id IS
  'Soft FK to hr_employees(id) per ADR-001/020. The FM custodian / technician on the job. Nullable so a work order can sit in the unassigned queue.';

COMMENT ON COLUMN fac_work_orders.created_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. The FM or admin who opened the work order. NOT NULL for audit.';

CREATE TABLE IF NOT EXISTS fac_work_order_activity (
  id              UUID PRIMARY KEY,
  work_order_id   UUID NOT NULL,
  actor_id        UUID NOT NULL,
  activity_type   TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_wo_activity_type_chk CHECK (
    activity_type IN ('STATUS_CHANGE', 'REASSIGNMENT', 'COMMENT', 'ATTACHMENT')
  ),
  CONSTRAINT fac_wo_activity_wo_fk FOREIGN KEY (work_order_id)
    REFERENCES fac_work_orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fac_wo_activity_wo_created_idx
  ON fac_work_order_activity (work_order_id, created_at ASC);

CREATE INDEX IF NOT EXISTS fac_wo_activity_actor_idx
  ON fac_work_order_activity (actor_id, created_at DESC);

COMMENT ON TABLE fac_work_order_activity IS
  'IMMUTABLE per ADR-010 — no UPDATE and no DELETE on the service surface, append-only via WorkOrderService.recordActivity. CASCADE on parent work order matches Cycle 8 tkt_ticket_activity. 4-value activity_type CHECK covers status changes, reassignments, comments, and attachments. metadata JSONB carries before/after state for STATUS_CHANGE and REASSIGNMENT, the body for COMMENT, and the s3 keys for ATTACHMENT.';

CREATE TABLE IF NOT EXISTS fac_preventive_maintenance_plans (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  frequency_months    INT NOT NULL,
  target_type         TEXT NOT NULL,
  target_id           UUID,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_pm_freq_chk CHECK (frequency_months > 0),
  CONSTRAINT fac_pm_target_chk CHECK (target_type IN ('BUILDING', 'SPACE', 'SYSTEM')),
  CONSTRAINT fac_pm_uq UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS fac_pm_school_active_idx
  ON fac_preventive_maintenance_plans (school_id, is_active);

COMMENT ON TABLE fac_preventive_maintenance_plans IS
  'Recurring preventive maintenance plan. UNIQUE(school_id, name) so the plan name is a stable handle. frequency_months > 0 CHECK. target_type 3-value CHECK with target_id soft polymorphic ref — BUILDING points at fac_buildings, SPACE at fac_spaces, SYSTEM at a free-form internal label captured in metadata (HVAC, plumbing, electrical, etc.).';

COMMENT ON COLUMN fac_preventive_maintenance_plans.target_id IS
  'Soft polymorphic FK per ADR-001/020 — points at fac_buildings(id) when target_type=BUILDING, fac_spaces(id) when target_type=SPACE, or NULL when target_type=SYSTEM. The Step 6 service resolves the target on read.';

CREATE TABLE IF NOT EXISTS fac_preventive_maintenance_checklist_items (
  id           UUID PRIMARY KEY,
  plan_id      UUID NOT NULL,
  item_name    TEXT NOT NULL,
  description  TEXT,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_pm_item_sort_chk CHECK (sort_order >= 0),
  CONSTRAINT fac_pm_item_uq UNIQUE (plan_id, item_name),
  CONSTRAINT fac_pm_item_plan_fk FOREIGN KEY (plan_id)
    REFERENCES fac_preventive_maintenance_plans(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fac_pm_item_plan_sort_idx
  ON fac_preventive_maintenance_checklist_items (plan_id, sort_order);

COMMENT ON TABLE fac_preventive_maintenance_checklist_items IS
  'Per-plan checklist item template. UNIQUE(plan_id, item_name) so the plan-side checklist is a clean catalogue. CASCADE on parent plan since the items are meaningless without their plan.';

CREATE TABLE IF NOT EXISTS fac_preventive_maintenance_tasks (
  id              UUID PRIMARY KEY,
  plan_id         UUID NOT NULL,
  scheduled_date  DATE NOT NULL,
  assigned_to     UUID,
  status          TEXT NOT NULL DEFAULT 'SCHEDULED',
  completed_at    TIMESTAMPTZ,
  completed_by    UUID,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_pm_task_status_chk CHECK (
    status IN ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE')
  ),
  CONSTRAINT fac_pm_task_completed_chk CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL AND completed_by IS NOT NULL)
    OR (status <> 'COMPLETED' AND completed_at IS NULL AND completed_by IS NULL)
  ),
  CONSTRAINT fac_pm_task_uq UNIQUE (plan_id, scheduled_date),
  CONSTRAINT fac_pm_task_plan_fk FOREIGN KEY (plan_id)
    REFERENCES fac_preventive_maintenance_plans(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fac_pm_task_plan_sched_idx
  ON fac_preventive_maintenance_tasks (plan_id, scheduled_date DESC);

CREATE INDEX IF NOT EXISTS fac_pm_task_assigned_status_idx
  ON fac_preventive_maintenance_tasks (assigned_to, status)
  WHERE assigned_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS fac_pm_task_overdue_idx
  ON fac_preventive_maintenance_tasks (scheduled_date)
  WHERE status IN ('SCHEDULED', 'IN_PROGRESS');

COMMENT ON TABLE fac_preventive_maintenance_tasks IS
  'Generated PM task instance. UNIQUE(plan_id, scheduled_date) so generate-tasks is idempotent — re-running for the same date range is a no-op. 4-value status CHECK with multi-column completed_chk keeping (status, completed_at, completed_by) consistent. assigned_to is a soft FK to hr_employees. The Step 6 MaintenanceTaskService cron flips overdue tasks to OVERDUE and emits fac.maintenance_task.overdue.';

CREATE TABLE IF NOT EXISTS fac_maintenance_checklist_results (
  id                  UUID PRIMARY KEY,
  task_id             UUID NOT NULL,
  checklist_item_id   UUID NOT NULL,
  passed              BOOLEAN NOT NULL,
  notes               TEXT,
  photo_s3_keys       TEXT[] NOT NULL DEFAULT '{}'::text[],
  follow_up_work_order_id UUID,
  submitted_by        UUID NOT NULL,
  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_pm_result_uq UNIQUE (task_id, checklist_item_id),
  CONSTRAINT fac_pm_result_task_fk FOREIGN KEY (task_id)
    REFERENCES fac_preventive_maintenance_tasks(id) ON DELETE CASCADE,
  CONSTRAINT fac_pm_result_item_fk FOREIGN KEY (checklist_item_id)
    REFERENCES fac_preventive_maintenance_checklist_items(id) ON DELETE NO ACTION,
  CONSTRAINT fac_pm_result_followup_fk FOREIGN KEY (follow_up_work_order_id)
    REFERENCES fac_work_orders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS fac_pm_result_task_idx
  ON fac_maintenance_checklist_results (task_id);

CREATE INDEX IF NOT EXISTS fac_pm_result_failed_idx
  ON fac_maintenance_checklist_results (task_id, submitted_at DESC)
  WHERE passed = false;

COMMENT ON TABLE fac_maintenance_checklist_results IS
  'IMMUTABLE per ADR-010 — no UPDATE on the service surface once submitted. UNIQUE(task_id, checklist_item_id) keeps each item answered at most once per task. CASCADE on parent task. NO ACTION on checklist_item_id preserves the audit even when an item is retired from the plan template (admin must reassign or archive). On passed=false the Step 6 MaintenanceTaskService.submitResults inserts a follow-up fac_work_orders row in the same tenant tx and writes its id back into follow_up_work_order_id. SET NULL on follow_up_work_order_id preserves the audit history when the follow-up work order is hard-deleted.';

COMMENT ON COLUMN fac_maintenance_checklist_results.submitted_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. The technician or custodian who submitted the result. NOT NULL for audit.';
