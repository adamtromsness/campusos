/* 127_cls_hall_rubric_moments
 *
 * Phase 2 Cycle 7 (P2-7) sub-cycle a — Classroom Advanced.
 *
 * Plan reference — docs/campusos-p2c7-classroom-advanced.html Step 1.
 *
 * Plan migration number is 112 but slot 112 is taken (hr_pay_period_lockstep).
 * Used 127 per the established Cycle 4 onwards convention of using the next
 * available slot when the planned number is occupied.
 *
 * 8 new tables for the M21 .1 hall passes plus rubrics plus class moments
 * surface. No external service dependencies. Independently shippable.
 *
 *   cls_hall_pass_settings         — UNIQUE(school_id) per-school config.
 *                                    max_concurrent_passes_per_class,
 *                                    max_daily_passes_per_student,
 *                                    default_duration_minutes,
 *                                    destinations TEXT[] catalogue,
 *                                    require_teacher_approval boolean.
 *                                    HallPassService.assertWithinLimits
 *                                    reads this row before inserting any
 *                                    new active pass.
 *   cls_hall_passes                — 4-state lifecycle ACTIVE then RETURNED
 *                                    or OVERDUE or RECALLED. Issued by a
 *                                    teacher to a student in a class with a
 *                                    destination and an expected_return_at
 *                                    timestamp. The HallPassOverdueWorker
 *                                    cron flips ACTIVE rows whose
 *                                    expected_return_at has passed to
 *                                    OVERDUE and emits cls.hall_pass.overdue
 *                                    once per row. RETURNED + RECALLED
 *                                    rows are terminal. INDEX on
 *                                    (school_id, status) WHERE
 *                                    status='ACTIVE' is the hot path for
 *                                    the daily roster + the overdue scan.
 *                                    Multi-column returned_chk lockstep
 *                                    pins returned_at to NULL on ACTIVE
 *                                    and to NOT NULL on every terminal
 *                                    state.
 *   cls_rubrics                    — Reusable scoring rubric authored by
 *                                    a teacher. is_template flag marks
 *                                    rubrics shared across assignments.
 *                                    total_points is denormalised — the
 *                                    sum of criteria max_points lands
 *                                    here on every rubric write so the
 *                                    rubric list view does not have to
 *                                    join the criteria table.
 *   cls_rubric_criteria            — Per-rubric criterion. weight is the
 *                                    percentage of the total grade that
 *                                    this criterion contributes (the
 *                                    sum across criteria for a rubric
 *                                    SHOULD equal 100, validated app
 *                                    side as a non-blocking warning per
 *                                    the plan). performance_levels JSONB
 *                                    is an array of {level_name,
 *                                    description, points} shapes — the
 *                                    teacher picks one level per
 *                                    student per criterion in
 *                                    cls_rubric_scores.
 *   cls_rubric_scores              — Per-(submission, criterion, scorer)
 *                                    score row. UNIQUE(submission_id,
 *                                    criterion_id, scored_by) so a
 *                                    teacher (or peer) can score each
 *                                    criterion once per submission. The
 *                                    scored_by column is NOT a soft FK
 *                                    to hr_employees — it can be a
 *                                    student's iam_person.id when the
 *                                    P2-7b peer review feature ships.
 *                                    For P2-7a the only writers are
 *                                    teachers, so the scored_by row is
 *                                    always an iam_person.id with an
 *                                    hr_employees mirror (per ADR-055).
 *   cls_class_moments              — Per-(class) photo feed entry. The
 *                                    posted_by is a teacher. is_approved
 *                                    defaults to true for teacher-posted
 *                                    moments. The schema accommodates a
 *                                    future student-posted variant
 *                                    requiring approval — controlled by
 *                                    a future is_approved=false default
 *                                    on student writes (out of P2-7a
 *                                    scope).
 *   cls_class_moment_photos        — Per-moment photo. CASCADE on parent
 *                                    moment delete since a photo without
 *                                    its parent moment is meaningless.
 *                                    s3_key is the signed-URL pattern
 *                                    matching hr_employee_documents
 *                                    from Cycle 4.
 *   cls_class_moment_reactions     — Per-(moment, reacting user) emoji
 *                                    reaction. UNIQUE(moment_id,
 *                                    reacted_by) so a parent can react
 *                                    once per moment with one of three
 *                                    reaction types. Re-reacting changes
 *                                    the type via service-side ON
 *                                    CONFLICT DO UPDATE.
 *
 * 7 new intra-tenant FKs (CASCADE x 4 + NO ACTION x 3). 0 cross-schema
 * FKs. All cross-module refs to platform.iam_person and to hr_employees
 * follow the soft FK convention per ADR-001/020 + ADR-055.
 *
 * Splitter convention — no semicolons inside string literals or block
 * comment headers. Every comment uses periods, em-dashes, "and", or
 * "plus" connectives.
 */

CREATE TABLE IF NOT EXISTS cls_hall_pass_settings (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    max_concurrent_passes_per_class INT NOT NULL DEFAULT 3,
    max_daily_passes_per_student INT NOT NULL DEFAULT 5,
    default_duration_minutes INT NOT NULL DEFAULT 10,
    destinations TEXT[] NOT NULL DEFAULT ARRAY['Bathroom','Nurse','Office','Library','Other'],
    require_teacher_approval BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_hall_pass_settings_school_uq UNIQUE (school_id),
    CONSTRAINT cls_hall_pass_settings_concurrent_chk
      CHECK (max_concurrent_passes_per_class > 0),
    CONSTRAINT cls_hall_pass_settings_daily_chk
      CHECK (max_daily_passes_per_student > 0),
    CONSTRAINT cls_hall_pass_settings_duration_chk
      CHECK (default_duration_minutes > 0)
);

COMMENT ON TABLE cls_hall_pass_settings IS
  'Per-school config consumed by HallPassService.assertWithinLimits before inserting any new active pass. UNIQUE(school_id) so each school carries one row.';

COMMENT ON COLUMN cls_hall_pass_settings.destinations IS
  'TEXT[] catalogue of allowed destinations. The HallPassService validates the supplied destination is in this array on issue.';

CREATE TABLE IF NOT EXISTS cls_hall_passes (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    class_id UUID NOT NULL REFERENCES sis_classes(id) ON DELETE CASCADE,
    issued_by UUID NOT NULL,
    destination TEXT NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expected_return_at TIMESTAMPTZ NOT NULL,
    returned_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_hall_passes_status_chk
      CHECK (status IN ('ACTIVE','RETURNED','OVERDUE','RECALLED')),
    CONSTRAINT cls_hall_passes_returned_chk
      CHECK (
        (status = 'ACTIVE' AND returned_at IS NULL)
        OR (status = 'OVERDUE' AND returned_at IS NULL)
        OR (status = 'RETURNED' AND returned_at IS NOT NULL)
        OR (status = 'RECALLED' AND returned_at IS NOT NULL)
      ),
    CONSTRAINT cls_hall_passes_window_chk
      CHECK (expected_return_at > issued_at)
);

CREATE INDEX IF NOT EXISTS cls_hall_passes_school_active_idx
  ON cls_hall_passes(school_id, status) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS cls_hall_passes_student_issued_idx
  ON cls_hall_passes(student_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS cls_hall_passes_class_active_idx
  ON cls_hall_passes(class_id, status) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS cls_hall_passes_overdue_scan_idx
  ON cls_hall_passes(expected_return_at) WHERE status = 'ACTIVE';

COMMENT ON TABLE cls_hall_passes IS
  '4-state hall pass lifecycle. ACTIVE -> RETURNED or OVERDUE or RECALLED. Multi-column returned_chk lockstep keeps returned_at populated only for RETURNED and RECALLED terminal states. The HallPassOverdueWorker cron flips ACTIVE rows past expected_return_at to OVERDUE.';

COMMENT ON COLUMN cls_hall_passes.issued_by IS
  'Soft FK to hr_employees(id) per ADR-055. The teacher who issued the pass.';

COMMENT ON COLUMN cls_hall_passes.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020. Denormalised on the row so the scan partial INDEX can prune by school.';

CREATE TABLE IF NOT EXISTS cls_rubrics (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    created_by UUID NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    is_template BOOLEAN NOT NULL DEFAULT false,
    total_points NUMERIC(6,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_rubrics_total_chk CHECK (total_points >= 0),
    CONSTRAINT cls_rubrics_title_chk CHECK (length(trim(title)) > 0)
);

CREATE INDEX IF NOT EXISTS cls_rubrics_school_creator_idx
  ON cls_rubrics(school_id, created_by);

CREATE INDEX IF NOT EXISTS cls_rubrics_school_template_idx
  ON cls_rubrics(school_id) WHERE is_template = true;

COMMENT ON TABLE cls_rubrics IS
  'Reusable scoring rubric authored by a teacher. is_template flag marks rubrics shared across assignments. total_points denormalised from criteria so the rubric list does not need a join.';

COMMENT ON COLUMN cls_rubrics.created_by IS
  'Soft FK to hr_employees(id) per ADR-055. The teacher who created the rubric.';

CREATE TABLE IF NOT EXISTS cls_rubric_criteria (
    id UUID PRIMARY KEY,
    rubric_id UUID NOT NULL REFERENCES cls_rubrics(id) ON DELETE CASCADE,
    criterion_name TEXT NOT NULL,
    description TEXT,
    weight NUMERIC(5,2) NOT NULL,
    max_points NUMERIC(5,2) NOT NULL,
    sort_order INT NOT NULL,
    performance_levels JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_rubric_criteria_weight_chk
      CHECK (weight >= 0 AND weight <= 100),
    CONSTRAINT cls_rubric_criteria_max_chk CHECK (max_points >= 0),
    CONSTRAINT cls_rubric_criteria_sort_chk CHECK (sort_order >= 0),
    CONSTRAINT cls_rubric_criteria_name_chk
      CHECK (length(trim(criterion_name)) > 0)
);

CREATE INDEX IF NOT EXISTS cls_rubric_criteria_rubric_sort_idx
  ON cls_rubric_criteria(rubric_id, sort_order);

COMMENT ON TABLE cls_rubric_criteria IS
  'Per-rubric criterion. weight is the percentage of the rubric grade contributed by this criterion. SUM(weight) per rubric SHOULD equal 100 — validated app-side as a non-blocking warning. performance_levels is a JSONB array of {level_name, description, points} shapes.';

CREATE TABLE IF NOT EXISTS cls_rubric_scores (
    id UUID PRIMARY KEY,
    submission_id UUID NOT NULL REFERENCES cls_submissions(id) ON DELETE CASCADE,
    criterion_id UUID NOT NULL REFERENCES cls_rubric_criteria(id) ON DELETE CASCADE,
    scored_by UUID NOT NULL,
    points_awarded NUMERIC(5,2) NOT NULL,
    performance_level TEXT,
    feedback TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_rubric_scores_points_chk CHECK (points_awarded >= 0),
    CONSTRAINT cls_rubric_scores_uq
      UNIQUE (submission_id, criterion_id, scored_by)
);

CREATE INDEX IF NOT EXISTS cls_rubric_scores_submission_idx
  ON cls_rubric_scores(submission_id);

CREATE INDEX IF NOT EXISTS cls_rubric_scores_criterion_idx
  ON cls_rubric_scores(criterion_id);

COMMENT ON TABLE cls_rubric_scores IS
  'Per-(submission, criterion, scorer) score row. UNIQUE keystone caps each scorer at one row per criterion per submission so a teacher updates a score by patching the existing row, not by inserting a new one. The scored_by column is intentionally not a hard FK because the future P2-7b peer review feature lets students score peers — for P2-7a only teachers write, so scored_by is always an iam_person.id with an hr_employees mirror.';

COMMENT ON COLUMN cls_rubric_scores.scored_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020 + ADR-055. Teacher in P2-7a, future student peer in P2-7b.';

CREATE TABLE IF NOT EXISTS cls_class_moments (
    id UUID PRIMARY KEY,
    class_id UUID NOT NULL REFERENCES sis_classes(id) ON DELETE CASCADE,
    posted_by UUID NOT NULL,
    caption TEXT,
    posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_approved BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cls_class_moments_class_posted_idx
  ON cls_class_moments(class_id, posted_at DESC);

CREATE INDEX IF NOT EXISTS cls_class_moments_class_approved_idx
  ON cls_class_moments(class_id, posted_at DESC) WHERE is_approved = true;

COMMENT ON TABLE cls_class_moments IS
  'Per-(class) photo feed entry. is_approved defaults to true for teacher-posted moments. The schema accommodates a future student-posted variant requiring approval. Parent-visible row scope binds reads to enrolled students plus their guardians plus class teachers.';

COMMENT ON COLUMN cls_class_moments.posted_by IS
  'Soft FK to hr_employees(id) per ADR-055. The teacher who posted the moment.';

CREATE TABLE IF NOT EXISTS cls_class_moment_photos (
    id UUID PRIMARY KEY,
    moment_id UUID NOT NULL REFERENCES cls_class_moments(id) ON DELETE CASCADE,
    s3_key TEXT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    file_size_bytes INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_class_moment_photos_s3_chk
      CHECK (length(trim(s3_key)) > 0),
    CONSTRAINT cls_class_moment_photos_size_chk
      CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS cls_class_moment_photos_moment_idx
  ON cls_class_moment_photos(moment_id, sort_order);

COMMENT ON TABLE cls_class_moment_photos IS
  'Per-moment photo with signed-URL pattern matching hr_employee_documents. CASCADE on parent moment delete since a photo without its parent moment is meaningless.';

CREATE TABLE IF NOT EXISTS cls_class_moment_reactions (
    id UUID PRIMARY KEY,
    moment_id UUID NOT NULL REFERENCES cls_class_moments(id) ON DELETE CASCADE,
    reacted_by UUID NOT NULL,
    reaction_type TEXT NOT NULL DEFAULT 'LIKE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_class_moment_reactions_type_chk
      CHECK (reaction_type IN ('LIKE','LOVE','CELEBRATE')),
    CONSTRAINT cls_class_moment_reactions_uq
      UNIQUE (moment_id, reacted_by)
);

CREATE INDEX IF NOT EXISTS cls_class_moment_reactions_moment_idx
  ON cls_class_moment_reactions(moment_id);

COMMENT ON TABLE cls_class_moment_reactions IS
  'Per-(moment, reacting user) reaction. UNIQUE keystone caps each reader at one reaction per moment with one of three reaction types — LIKE, LOVE, or CELEBRATE. Re-reacting flips the type via service-side ON CONFLICT DO UPDATE.';

COMMENT ON COLUMN cls_class_moment_reactions.reacted_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. Parents react via the class feed, teachers react too.';
