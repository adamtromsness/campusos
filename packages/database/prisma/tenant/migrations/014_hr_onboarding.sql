/* 014_hr_onboarding.sql
 * Cycle 4 Step 4 — Onboarding templates, checklists, and task tracking.
 *
 * Three tables:
 *   hr_onboarding_templates  — per-school template catalogue. Optional
 *                                position_id scope (NULL = generic template
 *                                for any new hire). UNIQUE(school_id, name).
 *   hr_onboarding_checklists — instantiated checklist per new hire. One per
 *                                employee per template. Status lifecycle
 *                                NOT_STARTED -> IN_PROGRESS -> COMPLETED.
 *                                started_at and completed_at materialised
 *                                by the Step 7 OnboardingService when the
 *                                first or last task flips state.
 *   hr_onboarding_tasks      — individual task rows on a checklist. 5
 *                                category values (DOCUMENT, TRAINING,
 *                                SYSTEM_ACCESS, ORIENTATION, OTHER) and 4
 *                                status values (PENDING, IN_PROGRESS,
 *                                COMPLETED, SKIPPED). due_days_from_start
 *                                lets the UI compute a per-task due date
 *                                from the parent checklist's started_at.
 *
 * DB-enforced FKs:
 *   hr_onboarding_templates.position_id   -> hr_positions(id) (no cascade)
 *   hr_onboarding_checklists.employee_id  -> hr_employees(id) ON DELETE CASCADE
 *   hr_onboarding_checklists.template_id  -> hr_onboarding_templates(id)
 *   hr_onboarding_tasks.checklist_id      -> hr_onboarding_checklists(id) ON DELETE CASCADE
 *
 * Block-comment style required per the splitter quirk. No semicolons inside
 * any string literal or block comment — splitter cuts on every semicolon.
 * Idempotent — safe to re-run.
 */
CREATE TABLE IF NOT EXISTS hr_onboarding_templates (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    position_id UUID REFERENCES hr_positions(id),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_onboarding_templates_school_name_uq UNIQUE (school_id, name)
);
CREATE INDEX IF NOT EXISTS hr_onboarding_templates_school_active_idx ON hr_onboarding_templates(school_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS hr_onboarding_templates_position_idx ON hr_onboarding_templates(position_id) WHERE position_id IS NOT NULL;
COMMENT ON COLUMN hr_onboarding_templates.position_id IS 'NULL means the template can be assigned to any new hire. Set to scope it to a specific position.';
CREATE TABLE IF NOT EXISTS hr_onboarding_checklists (
    id UUID PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    template_id UUID NOT NULL REFERENCES hr_onboarding_templates(id),
    status TEXT NOT NULL DEFAULT 'NOT_STARTED',
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    assigned_by UUID,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_onboarding_checklists_status_chk CHECK (status IN ('NOT_STARTED','IN_PROGRESS','COMPLETED')),
    CONSTRAINT hr_onboarding_checklists_employee_template_uq UNIQUE (employee_id, template_id),
    CONSTRAINT hr_onboarding_checklists_started_chk CHECK (
        (status = 'NOT_STARTED' AND started_at IS NULL AND completed_at IS NULL)
        OR
        (status = 'IN_PROGRESS' AND started_at IS NOT NULL AND completed_at IS NULL)
        OR
        (status = 'COMPLETED' AND started_at IS NOT NULL AND completed_at IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS hr_onboarding_checklists_employee_idx ON hr_onboarding_checklists(employee_id, status);
CREATE INDEX IF NOT EXISTS hr_onboarding_checklists_template_idx ON hr_onboarding_checklists(template_id);
COMMENT ON COLUMN hr_onboarding_checklists.assigned_by IS 'Soft FK to platform.platform_users(id) per ADR-055 — the admin who created the checklist for the new hire.';
COMMENT ON COLUMN hr_onboarding_checklists.started_at IS 'Materialised by OnboardingService (Step 7) when the first task flips to IN_PROGRESS. The parent state machine CHECK keeps started_at in sync with status.';
CREATE TABLE IF NOT EXISTS hr_onboarding_tasks (
    id UUID PRIMARY KEY,
    checklist_id UUID NOT NULL REFERENCES hr_onboarding_checklists(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL DEFAULT 'OTHER',
    is_required BOOLEAN NOT NULL DEFAULT true,
    due_days_from_start INT,
    sort_order INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PENDING',
    completed_at TIMESTAMPTZ,
    completed_by UUID,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_onboarding_tasks_category_chk CHECK (category IN ('DOCUMENT','TRAINING','SYSTEM_ACCESS','ORIENTATION','OTHER')),
    CONSTRAINT hr_onboarding_tasks_status_chk CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','SKIPPED')),
    CONSTRAINT hr_onboarding_tasks_due_days_chk CHECK (due_days_from_start IS NULL OR due_days_from_start >= 0),
    CONSTRAINT hr_onboarding_tasks_completed_chk CHECK (
        (status IN ('COMPLETED','SKIPPED') AND completed_at IS NOT NULL)
        OR
        (status NOT IN ('COMPLETED','SKIPPED') AND completed_at IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS hr_onboarding_tasks_checklist_idx ON hr_onboarding_tasks(checklist_id, sort_order);
CREATE INDEX IF NOT EXISTS hr_onboarding_tasks_checklist_status_idx ON hr_onboarding_tasks(checklist_id, status);
COMMENT ON COLUMN hr_onboarding_tasks.due_days_from_start IS 'Days after the checklist started_at by which this task should be completed. NULL means no per-task deadline. App-layer derives the absolute due date.';
COMMENT ON COLUMN hr_onboarding_tasks.completed_by IS 'Soft FK to platform.platform_users(id) per ADR-055 — the user who marked the task complete.';
