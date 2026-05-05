/* 042_svc_wellbeing_checkins_dedup.sql
 * REVIEW-CYCLE11.1 MAJOR 6 — duplicate-check-in guard.
 *
 * The Step 4 DeploymentService.activate() locks the deployment row and
 * only allows SCHEDULED to ACTIVE which prevents same-deployment
 * double-activation. The schema however did not enforce uniqueness on
 * (deployment_id, student_id), so a future backfill, repair job, or
 * manual insert path could land two PENDING check-ins for the same
 * (student, deployment) pair without the schema rejecting it. The
 * student would then see duplicate to-do rows on /wellbeing.
 *
 * Fix per REVIEW-CYCLE11.1 MAJOR 6 — partial UNIQUE INDEX on
 * (deployment_id, student_id) WHERE deployment_id IS NOT NULL. PARTIAL
 * because ad-hoc check-ins (deployment_id NULL) intentionally allow
 * multiple rows for the same student over time and the DISTINCT
 * predicate is the deployment scope. Concretely. The activate keystone
 * already enforces this via the lock, so the index is the schema-side
 * belt-and-braces.
 *
 * Migration discipline. Block-comment header with no semicolons inside
 * any string literal or comment per the splitter trap from Cycles 4
 * through 11.1.
 */

CREATE UNIQUE INDEX IF NOT EXISTS svc_wellbeing_checkins_deployment_student_uq
  ON svc_wellbeing_checkins (deployment_id, student_id)
  WHERE deployment_id IS NOT NULL;

COMMENT ON INDEX svc_wellbeing_checkins_deployment_student_uq IS
  'REVIEW-CYCLE11.1 MAJOR 6 — partial UNIQUE caps check-in rows at one per (deployment, student) pair. Ad-hoc check-ins with NULL deployment_id are intentionally outside the index.';
