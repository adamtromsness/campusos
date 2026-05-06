/*
 * 067_trn_review_cycle19_indexes.sql — Cycle 19 REVIEW fixes.
 *
 * Belt-and-braces schema-side gates added in response to the Cycle 19
 * peer review:
 *
 *   F3 — partial UNIQUE on trn_route_run_logs(route_id, run_date)
 *        WHERE status='IN_PROGRESS' so two drivers cannot start
 *        concurrent runs for the same route on the same date. The
 *        Step 7 service-layer check (route lock + actor.employeeId
 *        match) is the primary gate. The schema is the safety net.
 *
 *   F4 — partial UNIQUE on trn_student_assignments(student_id)
 *        WHERE is_override=false AND academic_year_id IS NULL.
 *        Belt-and-braces against the NULL-year ambiguity in the
 *        existing partial UNIQUE(student_id, academic_year_id).
 *        The service layer now requires academic_year_id for every
 *        permanent assignment, but if a future schema or repair
 *        path lands a NULL-year permanent row we still cap it at
 *        one per student.
 *
 * No semicolons inside string literals or block comments.
 */

CREATE UNIQUE INDEX IF NOT EXISTS trn_runs_active_uq
  ON trn_route_run_logs (route_id, run_date)
  WHERE status = 'IN_PROGRESS';

COMMENT ON INDEX trn_runs_active_uq IS
  'F3 belt-and-braces. Caps active runs at one per (route, date) so the Step 7 RunLogService duplicate-run service-layer check is backed by a schema-side UNIQUE. The unique violation is translated to a friendly 400 by the service.';

CREATE UNIQUE INDEX IF NOT EXISTS trn_assignments_permanent_null_year_uq
  ON trn_student_assignments (student_id)
  WHERE is_override = false AND academic_year_id IS NULL;

COMMENT ON INDEX trn_assignments_permanent_null_year_uq IS
  'F4 belt-and-braces. The primary partial UNIQUE on (student_id, academic_year_id) WHERE is_override=false allows multiple NULL-year rows because PostgreSQL treats NULLs as distinct. This second index caps the NULL-year permanent case at one row per student. The Step 5 service requires academic_year_id for every permanent assignment so this index should never reject a legitimate insert in production.';
