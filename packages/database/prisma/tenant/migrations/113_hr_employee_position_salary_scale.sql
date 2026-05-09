/* P2-4b carry-over from REVIEW-P2-4a MAJOR #1.

   The P2-4a payroll worker picks the first active grade's first
   salary scale for every employee, which is a stub the reviewer
   accepted on the basis that the real per-employee salary-scale
   assignment lands in P2-4b. This migration adds the additive
   column + index. PayrollService.resolveEmployeesForProcessing
   now reads each employee's currently-effective primary position
   and joins through to its salary_scale_id — employees without an
   assigned scale are skipped (counted as skipped in the
   process result) instead of being silently materialised at the
   wrong rate.

   Splitter-safe DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT pattern
   for the FK so re-provisioning lands cleanly. Idempotent. */

ALTER TABLE hr_employee_positions
  ADD COLUMN IF NOT EXISTS salary_scale_id UUID;

ALTER TABLE hr_employee_positions
  DROP CONSTRAINT IF EXISTS hr_emp_positions_salary_scale_fk;

ALTER TABLE hr_employee_positions
  ADD CONSTRAINT hr_emp_positions_salary_scale_fk
    FOREIGN KEY (salary_scale_id)
    REFERENCES hr_salary_scales(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS hr_emp_positions_salary_scale_idx
  ON hr_employee_positions(salary_scale_id)
  WHERE salary_scale_id IS NOT NULL;

COMMENT ON COLUMN hr_employee_positions.salary_scale_id IS
  'Per-position salary scale assignment. SET NULL when the scale is retired so the position survives. PayrollService.resolveEmployeesForProcessing reads this to compute gross pay — positions without a scale are skipped during payroll runs.';
