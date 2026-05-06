/* 055_enr_period_status_extension.sql
 * Cycle 16 Step 1 — M81 Enrolment. Extend the enr_enrollment_periods
 * status CHECK to include OFFERS_ISSUED and COMPLETED so the Step 5
 * service can drive the full period lifecycle the Cycle 16 plan
 * specifies. Cycle 6 shipped the table with a 3-value CHECK
 * UPCOMING/OPEN/CLOSED — Cycle 16 extends that to 5 values.
 *
 * Splitter discipline. This file is splitter-clean per the
 * Cycles 4-15 unbroken streak. Comment text contains no
 * statement-terminator characters.
 */

ALTER TABLE enr_enrollment_periods DROP CONSTRAINT IF EXISTS enr_enrollment_periods_status_chk;

ALTER TABLE enr_enrollment_periods
  ADD CONSTRAINT enr_enrollment_periods_status_chk
  CHECK (status IN ('UPCOMING','OPEN','OFFERS_ISSUED','CLOSED','COMPLETED'));
