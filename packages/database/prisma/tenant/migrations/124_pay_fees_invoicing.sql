/* 124_pay_fees_invoicing
 *
 * Phase 2 Cycle 6 (P2-6) Step 2 — Fee Management plus Auto-Invoicing.
 *
 * Plan reference — docs/campusos-p2c6-payments-advanced.html Step 2.
 *
 * 3 new tables for the M84 .1 auto-invoicing surface plus
 * column additions to the existing Cycle 6 pay_fee_schedules:
 *
 *   pay_auto_invoice_rules           — per-school configuration of
 *                                      automated invoice generation.
 *                                      trigger_type fires the rule on
 *                                      ENROLMENT_CONFIRMED Kafka events
 *                                      from Cycle 6 enrollment, on
 *                                      TERM_START via the AutoInvoice
 *                                      Worker poll, on DATE_OF_MONTH
 *                                      via the same nightly poll, or on
 *                                      ACADEMIC_YEAR_START. fee_schedule_id
 *                                      is the line-item template applied
 *                                      to every generated invoice.
 *                                      applies_to_grade_level optionally
 *                                      narrows the audience.
 *   pay_invoice_generation_runs      — one row per batch of generated
 *                                      invoices. run_type distinguishes
 *                                      MANUAL_BATCH (admin clicks the
 *                                      Generate-from-schedule button) from
 *                                      AUTO_RULE_TRIGGERED (worker fires)
 *                                      from FEE_SCHEDULE_BULK (admin
 *                                      clicks Generate on a schedule
 *                                      directly). status follows
 *                                      QUEUED until RUNNING until
 *                                      COMPLETED or FAILED.
 *                                      invoices_created plus
 *                                      invoices_skipped plus
 *                                      invoices_failed sums to
 *                                      total_families_targeted at
 *                                      COMPLETED time.
 *   pay_discount_rules               — per-school discount catalogue.
 *                                      discount_type covers SIBLING,
 *                                      EARLY_PAYMENT, LOYALTY, BURSARY,
 *                                      STAFF_CHILD, CUSTOM.
 *                                      calculation_method is PERCENTAGE
 *                                      or FIXED_AMOUNT.
 *                                      sibling_order is an integer for
 *                                      the SIBLING type only — second
 *                                      child gets one rate, third
 *                                      gets another. applies_to_fee_category_id
 *                                      optionally scopes the discount.
 *
 * Plus column additions to pay_fee_schedules:
 *   - frequency TEXT — replaces the existing recurrence column at the
 *     application layer, with TERM added to the enum so school terms
 *     can drive billing. The existing recurrence stays for backwards
 *     compatibility and is mirrored.
 *   - due_date DATE — explicit due date for the canonical fee. The
 *     previous design left due dates to invoice creation but the
 *     auto-invoicing workflow needs the schedule to declare it.
 *   - applies_to_student_ids UUID[] — optional override for "this
 *     fee applies to these specific students only", overriding the
 *     grade_level audience filter. Lets admins target fee schedules
 *     at a hand-picked list (e.g. AP exam fees for the 12 students
 *     who registered).
 *
 * Splitter rules — no semicolons inside any block comment header,
 * single-quoted string, or COMMENT ON ... text. Use commas, em
 * dashes, or "and" in narrative text instead.
 */

/* pay_fee_schedules column augmentation. Splitter strips any statement
 * that starts with -- after trim, so block-comment headers are mandatory.
 */
ALTER TABLE pay_fee_schedules
  ADD COLUMN IF NOT EXISTS frequency TEXT,
  ADD COLUMN IF NOT EXISTS due_date DATE,
  ADD COLUMN IF NOT EXISTS applies_to_student_ids UUID[];

/* Backfill the new frequency column from the existing recurrence so
 * application code can read either. The CHECK on frequency adds TERM
 * to the existing 5 values via the splitter-safe DROP IF EXISTS plus
 * ADD pattern matching prior cycles.
 */
UPDATE pay_fee_schedules SET frequency = recurrence WHERE frequency IS NULL;

ALTER TABLE pay_fee_schedules
  DROP CONSTRAINT IF EXISTS pay_fee_schedules_frequency_chk;

ALTER TABLE pay_fee_schedules
  ADD CONSTRAINT pay_fee_schedules_frequency_chk
    CHECK (frequency IS NULL OR frequency IN ('ONE_TIME','MONTHLY','QUARTERLY','SEMESTER','TERM','ANNUAL'));

COMMENT ON COLUMN pay_fee_schedules.frequency IS
  'P2-6 cadence column. Mirrors recurrence and adds TERM to the allowed values. Application code should read frequency. recurrence stays populated for any Cycle 6 callers that have not migrated.';

COMMENT ON COLUMN pay_fee_schedules.due_date IS
  'Optional canonical due date for the schedule. AutoInvoiceService stamps the generated invoices with this date. NULL leaves the due date to be set at generation time.';

COMMENT ON COLUMN pay_fee_schedules.applies_to_student_ids IS
  'Optional UUID array. When non-NULL the schedule targets exactly these students. Overrides the grade_level audience filter. NULL means the audience is computed from grade_level instead.';

/* pay_auto_invoice_rules */
CREATE TABLE IF NOT EXISTS pay_auto_invoice_rules (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    trigger_type TEXT NOT NULL,
    fee_schedule_id UUID NOT NULL REFERENCES pay_fee_schedules(id),
    trigger_day_of_month INT,
    trigger_term_offset_days INT,
    applies_to_grade_level TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_run_at TIMESTAMPTZ,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_auto_invoice_rules_school_name_uq UNIQUE (school_id, name),
    CONSTRAINT pay_auto_invoice_rules_trigger_type_chk
      CHECK (trigger_type IN ('ENROLMENT_CONFIRMED','TERM_START','DATE_OF_MONTH','ACADEMIC_YEAR_START')),
    CONSTRAINT pay_auto_invoice_rules_dom_chk
      CHECK (trigger_day_of_month IS NULL OR (trigger_day_of_month BETWEEN 1 AND 28))
);

CREATE INDEX IF NOT EXISTS pay_auto_invoice_rules_school_active_idx
  ON pay_auto_invoice_rules(school_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS pay_auto_invoice_rules_trigger_idx
  ON pay_auto_invoice_rules(trigger_type) WHERE is_active = true;

COMMENT ON COLUMN pay_auto_invoice_rules.trigger_day_of_month IS
  'For trigger_type DATE_OF_MONTH only. Capped at 28 to stay safe across all months. Outside that range the rule is a no-op.';

COMMENT ON COLUMN pay_auto_invoice_rules.trigger_term_offset_days IS
  'For trigger_type TERM_START only. Negative values fire that many days BEFORE the term starts. Positive values fire AFTER. NULL means fire on the term start date itself.';

/* pay_invoice_generation_runs */
CREATE TABLE IF NOT EXISTS pay_invoice_generation_runs (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    run_type TEXT NOT NULL,
    fee_schedule_id UUID REFERENCES pay_fee_schedules(id),
    auto_rule_id UUID REFERENCES pay_auto_invoice_rules(id),
    academic_year_id UUID REFERENCES sis_academic_years(id),
    initiated_by UUID,
    total_families_targeted INT NOT NULL DEFAULT 0,
    invoices_created INT NOT NULL DEFAULT 0,
    invoices_skipped INT NOT NULL DEFAULT 0,
    invoices_failed INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'QUEUED',
    error_summary TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_invoice_gen_runs_run_type_chk
      CHECK (run_type IN ('MANUAL_BATCH','AUTO_RULE_TRIGGERED','FEE_SCHEDULE_BULK')),
    CONSTRAINT pay_invoice_gen_runs_status_chk
      CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
    CONSTRAINT pay_invoice_gen_runs_counts_chk
      CHECK (invoices_created >= 0 AND invoices_skipped >= 0 AND invoices_failed >= 0
             AND total_families_targeted >= 0),
    CONSTRAINT pay_invoice_gen_runs_completed_chk
      CHECK (
        (status IN ('QUEUED','RUNNING') AND completed_at IS NULL)
        OR (status IN ('COMPLETED','FAILED') AND completed_at IS NOT NULL)
      )
);

CREATE INDEX IF NOT EXISTS pay_invoice_gen_runs_school_status_idx
  ON pay_invoice_generation_runs(school_id, status);

CREATE INDEX IF NOT EXISTS pay_invoice_gen_runs_school_created_idx
  ON pay_invoice_generation_runs(school_id, created_at DESC);

COMMENT ON COLUMN pay_invoice_generation_runs.error_summary IS
  'Populated on FAILED status with a short error message. Detailed per-family failures land in structured logs not in this column.';

/* pay_discount_rules */
CREATE TABLE IF NOT EXISTS pay_discount_rules (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    discount_type TEXT NOT NULL,
    calculation_method TEXT NOT NULL,
    value NUMERIC(8,2) NOT NULL,
    applies_to_fee_category_id UUID REFERENCES pay_fee_categories(id),
    sibling_order INT,
    minimum_invoice_amount NUMERIC(10,2),
    academic_year_id UUID REFERENCES sis_academic_years(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_discount_rules_school_name_uq UNIQUE (school_id, name),
    CONSTRAINT pay_discount_rules_discount_type_chk
      CHECK (discount_type IN ('SIBLING','EARLY_PAYMENT','LOYALTY','BURSARY','STAFF_CHILD','CUSTOM')),
    CONSTRAINT pay_discount_rules_calc_chk
      CHECK (calculation_method IN ('PERCENTAGE','FIXED_AMOUNT')),
    CONSTRAINT pay_discount_rules_value_chk CHECK (value > 0),
    CONSTRAINT pay_discount_rules_sibling_chk
      CHECK (
        (discount_type = 'SIBLING' AND sibling_order IS NOT NULL AND sibling_order >= 2)
        OR (discount_type <> 'SIBLING' AND sibling_order IS NULL)
      ),
    CONSTRAINT pay_discount_rules_min_chk
      CHECK (minimum_invoice_amount IS NULL OR minimum_invoice_amount >= 0)
);

CREATE INDEX IF NOT EXISTS pay_discount_rules_school_active_idx
  ON pay_discount_rules(school_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS pay_discount_rules_school_type_idx
  ON pay_discount_rules(school_id, discount_type) WHERE is_active = true;

COMMENT ON COLUMN pay_discount_rules.sibling_order IS
  'For SIBLING discount_type only. The Nth child enrolled in the family gets this discount. 2 is the second child, 3 is the third, and so on. Multi-column sibling_chk pins the column to the SIBLING type.';

COMMENT ON COLUMN pay_discount_rules.minimum_invoice_amount IS
  'Optional minimum invoice subtotal for the discount to apply. NULL means no minimum.';
