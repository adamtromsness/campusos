/* 024_sis_child_link_requests.sql
 * Phase 2 polish — Add Child to Account workflow.
 *
 * One new tenant base table sis_child_link_requests. Lets a guardian submit
 * a request to link an existing sis_students row to their own guardian
 * record (LINK_EXISTING) or to add a brand-new child (ADD_NEW). The link
 * is NOT active until a school admin approves the request. This prevents
 * an attacker who knows a child name plus DOB from claiming someone
 * else as their kid.
 *
 * Two request shapes:
 *   LINK_EXISTING — existing_student_id is the target sis_students row.
 *                    new_child_* columns must be NULL.
 *   ADD_NEW       — existing_student_id must be NULL. The five
 *                    new_child_* columns describe the new child. On
 *                    APPROVE the service creates an iam_person row plus
 *                    platform_students plus sis_students plus the
 *                    sis_student_guardians link plus
 *                    platform_family_members for the requesting guardian.
 *
 * Multi-column CHECK enforces the LINK_EXISTING / ADD_NEW shapes are
 * mutually exclusive and that ADD_NEW always carries the four required
 * fields first_name / last_name / dob / grade_level. Gender stays
 * optional.
 *
 * Lifecycle status PENDING / APPROVED / REJECTED. Multi-column CHECK keeps
 * reviewed_by and reviewed_at all-set or all-null together — PENDING
 * requires both NULL, APPROVED and REJECTED require both NOT NULL.
 *
 * Soft FKs:
 *   requesting_guardian_id -> sis_guardians(id)
 *   existing_student_id    -> sis_students(id)
 *   reviewed_by            -> platform.platform_users(id)
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header, no semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 6.
 */

CREATE TABLE IF NOT EXISTS sis_child_link_requests (
  id                       UUID         PRIMARY KEY,
  school_id                UUID         NOT NULL,
  requesting_guardian_id   UUID         NOT NULL REFERENCES sis_guardians(id) ON DELETE CASCADE,
  request_type             TEXT         NOT NULL,
  existing_student_id      UUID         REFERENCES sis_students(id) ON DELETE CASCADE,
  new_child_first_name     TEXT,
  new_child_last_name      TEXT,
  new_child_date_of_birth  DATE,
  new_child_gender         TEXT,
  new_child_grade_level    TEXT,
  status                   TEXT         NOT NULL DEFAULT 'PENDING',
  reviewed_by              UUID,
  reviewed_at              TIMESTAMPTZ,
  reviewer_notes           TEXT,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT sis_child_link_requests_request_type_chk
    CHECK (request_type IN ('LINK_EXISTING', 'ADD_NEW')),
  CONSTRAINT sis_child_link_requests_status_chk
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  CONSTRAINT sis_child_link_requests_shape_chk
    CHECK (
      (request_type = 'LINK_EXISTING'
        AND existing_student_id IS NOT NULL
        AND new_child_first_name IS NULL
        AND new_child_last_name IS NULL
        AND new_child_date_of_birth IS NULL
        AND new_child_gender IS NULL
        AND new_child_grade_level IS NULL)
      OR
      (request_type = 'ADD_NEW'
        AND existing_student_id IS NULL
        AND new_child_first_name IS NOT NULL
        AND new_child_last_name IS NOT NULL
        AND new_child_date_of_birth IS NOT NULL
        AND new_child_grade_level IS NOT NULL)
    ),
  CONSTRAINT sis_child_link_requests_reviewed_chk
    CHECK (
      (status = 'PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL)
      OR
      (status IN ('APPROVED', 'REJECTED') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS sis_child_link_requests_status_idx
  ON sis_child_link_requests (status, created_at);

CREATE INDEX IF NOT EXISTS sis_child_link_requests_guardian_idx
  ON sis_child_link_requests (requesting_guardian_id, created_at);

COMMENT ON TABLE sis_child_link_requests IS
  'Guardian-submitted requests to link an existing student or add a new child. Status PENDING until admin approves or rejects. The actual link rows in sis_student_guardians and platform_family_members are only written on APPROVE.';

COMMENT ON COLUMN sis_child_link_requests.request_type IS
  'LINK_EXISTING when the parent picks an existing sis_students row from search. ADD_NEW when the parent fills in new child details. The shape_chk constraint enforces mutually exclusive column population per the request_type.';
