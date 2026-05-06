/* 057_enr_onboarding.sql
 * Cycle 16 Step 3 — M81 Enrolment. Onboarding checklist system. The
 * keystone surface that ensures every new student is operationally
 * ready before day one. When the last mandatory task lands the
 * Step 7 OnboardingService re-emits enr.student.enrolled with the
 * full operational-ready payload.
 *
 * Tables (4):
 *   enr_onboarding_checklists                    School-level template.
 *                                                UNIQUE(school, name, type).
 *   enr_onboarding_tasks                         Template tasks. CASCADE
 *                                                on parent checklist.
 *   enr_student_onboarding_progress              Per-student rollup with
 *                                                tasks_total + tasks_completed
 *                                                counters and
 *                                                overall_status lifecycle.
 *   enr_student_onboarding_task_completions      Per-task tracking with
 *                                                multi-column completed_chk
 *                                                lockstep.
 *
 * Soft refs per ADR-001 / ADR-020. school_id, completed_by are soft
 * to platform tables. student_id soft to sis_students. Cross-cycle
 * resolves to a real row when SIS materialises the student record
 * from the enrolled application.
 *
 * Splitter discipline. This file is splitter-clean per the
 * Cycles 4-15 unbroken streak. Comment text contains no
 * statement-terminator characters.
 */

CREATE TABLE IF NOT EXISTS enr_onboarding_checklists (
  id             UUID PRIMARY KEY,
  school_id      UUID NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  admission_type TEXT NOT NULL DEFAULT 'STANDARD_INTAKE',
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT enr_onboarding_checklists_school_name_type_uq UNIQUE (school_id, name, admission_type),
  CONSTRAINT enr_onboarding_checklists_admission_type_chk
    CHECK (admission_type IN ('STANDARD_INTAKE','MID_YEAR_ADMISSION','TRANSFER_IN','RETURNING_STUDENT','INTERNATIONAL'))
);

CREATE INDEX IF NOT EXISTS enr_onboarding_checklists_school_active_idx
  ON enr_onboarding_checklists (school_id, is_active);

CREATE TABLE IF NOT EXISTS enr_onboarding_tasks (
  id                    UUID PRIMARY KEY,
  checklist_id          UUID NOT NULL REFERENCES enr_onboarding_checklists(id) ON DELETE CASCADE,
  task_name             TEXT NOT NULL,
  description           TEXT,
  task_category         TEXT NOT NULL,
  is_mandatory          BOOLEAN NOT NULL DEFAULT true,
  responsible_role      TEXT,
  sort_order            INT NOT NULL DEFAULT 0,
  due_days_before_start INT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT enr_onboarding_tasks_checklist_name_uq UNIQUE (checklist_id, task_name),
  CONSTRAINT enr_onboarding_tasks_category_chk
    CHECK (task_category IN ('ADMINISTRATIVE','HEALTH','IT','FACILITIES','TRANSPORT','COMMUNICATIONS','FINANCE')),
  CONSTRAINT enr_onboarding_tasks_sort_chk CHECK (sort_order >= 0)
);

CREATE INDEX IF NOT EXISTS enr_onboarding_tasks_checklist_sort_idx
  ON enr_onboarding_tasks (checklist_id, sort_order);

CREATE TABLE IF NOT EXISTS enr_student_onboarding_progress (
  id                UUID PRIMARY KEY,
  application_id    UUID NOT NULL REFERENCES enr_applications(id) ON DELETE CASCADE,
  checklist_id      UUID NOT NULL REFERENCES enr_onboarding_checklists(id) ON DELETE NO ACTION,
  student_id        UUID,
  started_date      DATE NOT NULL,
  target_start_date DATE NOT NULL,
  overall_status    TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  tasks_total       INT NOT NULL,
  tasks_completed   INT NOT NULL DEFAULT 0,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT enr_student_onboarding_progress_application_uq UNIQUE (application_id, checklist_id),
  CONSTRAINT enr_student_onboarding_progress_status_chk
    CHECK (overall_status IN ('IN_PROGRESS','COMPLETE','OVERDUE')),
  CONSTRAINT enr_student_onboarding_progress_tasks_total_chk CHECK (tasks_total >= 0),
  CONSTRAINT enr_student_onboarding_progress_tasks_completed_chk
    CHECK (tasks_completed >= 0 AND tasks_completed <= tasks_total),
  CONSTRAINT enr_student_onboarding_progress_completed_chk CHECK (
    (overall_status <> 'COMPLETE' AND completed_at IS NULL)
    OR
    (overall_status = 'COMPLETE' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS enr_student_onboarding_progress_status_idx
  ON enr_student_onboarding_progress (overall_status);

COMMENT ON TABLE enr_student_onboarding_progress IS
  'Cycle 16 Step 3. Per-(application, checklist) rollup. The Step 7 OfferService.respond hook auto-creates this row inside the same tenant tx that flips the offer to ACCEPTED. The Step 7 OnboardingService.completeTask flips overall_status=COMPLETE atomically when the last mandatory task lands and re-emits enr.student.enrolled with the full operational-ready payload.';

CREATE TABLE IF NOT EXISTS enr_student_onboarding_task_completions (
  id           UUID PRIMARY KEY,
  progress_id  UUID NOT NULL REFERENCES enr_student_onboarding_progress(id) ON DELETE CASCADE,
  task_id      UUID NOT NULL REFERENCES enr_onboarding_tasks(id) ON DELETE NO ACTION,
  status       TEXT NOT NULL DEFAULT 'PENDING',
  completed_by UUID,
  completed_at TIMESTAMPTZ,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT enr_student_onboarding_task_completions_progress_task_uq UNIQUE (progress_id, task_id),
  CONSTRAINT enr_student_onboarding_task_completions_status_chk
    CHECK (status IN ('PENDING','COMPLETED','WAIVED','OVERDUE')),
  CONSTRAINT enr_student_onboarding_task_completions_completed_chk CHECK (
    (status IN ('PENDING','OVERDUE') AND completed_at IS NULL AND completed_by IS NULL)
    OR
    (status IN ('COMPLETED','WAIVED') AND completed_at IS NOT NULL AND completed_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS enr_student_onboarding_task_completions_pending_idx
  ON enr_student_onboarding_task_completions (progress_id) WHERE status NOT IN ('COMPLETED','WAIVED');

COMMENT ON TABLE enr_student_onboarding_task_completions IS
  'Cycle 16 Step 3. Per-task completion tracking. Multi-column completed_chk lockstep keeps (status, completed_at, completed_by) consistent so the schema never sees a half-completed row. Partial INDEX(progress_id) WHERE status NOT IN COMPLETED/WAIVED is the open-tasks dashboard hot path.';
