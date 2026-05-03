/* 025_enr_period_allows_public_search.sql
 * Phase 2 polish — public enrollment search.
 *
 * One column on enr_enrollment_periods. allows_public_search defaults to
 * true so existing OPEN periods automatically appear in the unauth
 * GET /enrollment/search endpoint that powers the parent-facing Find
 * Schools surface. Schools running invitation-only admissions cycles
 * flip this to false so the period stays out of search results.
 *
 * Migration discipline. ADD COLUMN IF NOT EXISTS for idempotency. Block
 * comment header, no semicolons inside any string literal or comment per
 * the splitter trap from Cycles 4 through 6.
 */

ALTER TABLE enr_enrollment_periods
  ADD COLUMN IF NOT EXISTS allows_public_search BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN enr_enrollment_periods.allows_public_search IS
  'When true, this period surfaces in GET /enrollment/search. Set false for invitation-only admissions cycles.';
