/* 121_enr_withdrawal_task_templates
 *
 * Phase 2 Cycle 5 (P2-5) Step 8 — configurable per-school exit
 * task template.
 *
 * Plan reference — docs/campusos-p2c5-enrolment-advanced.html Step 8.
 *
 * The plan calls for the template to live in
 * platform.platform_tenant_configs but that table does not exist
 * in the current schema. Decision — keep the template tenant-scoped
 * since the data it carries is per-school operational config
 * (which department names a school assigns, which optional tasks
 * the school adds beyond the 7-task default). A future
 * cross-school org-level default could lift this into platform
 * scope without a service-side rewrite.
 *
 *   enr_withdrawal_task_templates — one row per task per template
 *                                   per school. The default
 *                                   template carries name='DEFAULT'
 *                                   and ships the 7 baseline
 *                                   department tasks. Schools
 *                                   override by inserting
 *                                   additional rows or marking
 *                                   defaults inactive.
 *
 * Splitter rules — no semicolons inside any block comment header,
 * single-quoted string, or COMMENT ON ... text.
 */

CREATE TABLE IF NOT EXISTS enr_withdrawal_task_templates (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    template_name TEXT NOT NULL DEFAULT 'DEFAULT',
    task_name TEXT NOT NULL,
    task_category TEXT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_required BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT enr_wtt_school_template_task_uq UNIQUE (school_id, template_name, task_name),
    CONSTRAINT enr_wtt_category_chk
      CHECK (task_category IN (
        'ADMINISTRATIVE',
        'FINANCE',
        'IT',
        'FACILITIES',
        'TRANSPORT',
        'RECORDS'
      ))
);

CREATE INDEX IF NOT EXISTS enr_wtt_school_template_idx
  ON enr_withdrawal_task_templates(school_id, template_name, sort_order)
  WHERE is_active = true;

COMMENT ON TABLE enr_withdrawal_task_templates IS
  'Configurable per-school checklist used by WithdrawalService.create to auto-create the enr_withdrawal_exit_tasks rows. Each row is one task. The default template name is DEFAULT and ships 7 baseline tasks the seed populates per school on first read.';
