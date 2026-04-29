/* 020_pay_family_accounts_and_fees.sql
 * Cycle 6 Step 3 — Payments foundation. Family accounts, fee catalogue,
 * fee schedules, and the per-school Stripe Connect account.
 *
 * Five tables forming the billing-engine substrate. Step 4 will land
 * pay_invoices, pay_invoice_line_items, pay_payments, pay_ledger_entries
 * (annually RANGE-partitioned), pay_refunds, pay_payment_plans, and
 * pay_payment_plan_installments on top.
 *
 *   pay_family_accounts          — per-(school, account_holder) billing
 *                                  aggregate. account_holder_id is a soft
 *                                  UUID ref to platform.iam_person — the
 *                                  primary guardian on the account. 3-state
 *                                  status ACTIVE / SUSPENDED / CLOSED.
 *                                  payment_authorisation_policy controls
 *                                  whether only the account holder or any
 *                                  authorised guardian can submit payments
 *                                  ACCOUNT_HOLDER_ONLY / ANY_AUTHORISED.
 *                                  account_number is a school-issued ref
 *                                  string with UNIQUE(school_id,
 *                                  account_number) so the school can address
 *                                  the account by number on a paper invoice.
 *                                  UNIQUE(school_id, account_holder_id) is
 *                                  the one-account-per-guardian-per-school
 *                                  invariant the PaymentAccountWorker relies
 *                                  on for idempotent insert-or-link.
 *   pay_family_account_students  — link table from a family account to the
 *                                  students it bills for. UNIQUE(family
 *                                  _account_id, student_id) so the same
 *                                  student is linked at most once. ON DELETE
 *                                  CASCADE on the family account (link is
 *                                  meaningless without parent) and ON DELETE
 *                                  CASCADE on the student (consistent with
 *                                  every other sis_students child table).
 *                                  added_by is a soft UUID ref to the
 *                                  platform user who created the link
 *                                  (PaymentAccountWorker writes the
 *                                  enrolling-student account id).
 *   pay_fee_categories           — per-school fee taxonomy. Tuition,
 *                                  Registration, Activity, Technology, etc.
 *                                  is_active flag flips a category off
 *                                  without deleting it (preserves history
 *                                  on existing fee schedules and invoices).
 *                                  UNIQUE(school_id, name).
 *   pay_fee_schedules            — what the school charges. Per-(school,
 *                                  academic_year, name). Optional grade_level
 *                                  scoping (NULL means all grades, matching
 *                                  the Cycle 5 sch_periods.day_of_week
 *                                  convention). amount NUMERIC(10,2) with
 *                                  >= 0 CHECK — schools cannot encode a
 *                                  negative-amount discount through the fee
 *                                  schedule, that goes through the future
 *                                  pay_discount_rules table. is_recurring
 *                                  is a UI hint for ANNUAL/MONTHLY/etc —
 *                                  recurrence is the authoritative cadence.
 *                                  Five-state recurrence enum ONE_TIME /
 *                                  MONTHLY / QUARTERLY / SEMESTER / ANNUAL.
 *                                  DB-enforced FK to sis_academic_years
 *                                  (no cascade — admin closes out the year
 *                                  before deleting it) and to
 *                                  pay_fee_categories (no cascade — admin
 *                                  flips is_active=false rather than hard
 *                                  delete a category that has schedules
 *                                  attached).
 *   pay_stripe_accounts          — per-school Stripe Connect managed
 *                                  account. UNIQUE on school_id (one
 *                                  Stripe account per school) and on
 *                                  stripe_account_id (a single Stripe acct
 *                                  cannot be reused across schools). The
 *                                  whole table is stubbed in Cycle 6 — the
 *                                  PaymentService accepts Stripe references
 *                                  but does not make actual Stripe API
 *                                  calls. Real Stripe wiring is Phase 3
 *                                  ops work.
 *
 * Five new intra-tenant DB-enforced FKs:
 *   pay_family_account_students.family_account_id  CASCADE
 *   pay_family_account_students.student_id         CASCADE
 *   pay_fee_schedules.academic_year_id             NO ACTION (admin closes year first)
 *   pay_fee_schedules.fee_category_id              NO ACTION (admin inactivates category instead)
 *
 * Cross-schema refs (school_id, account_holder_id, added_by) stay soft
 * per ADR-001/020/055. No PG ENUM types — TEXT plus CHECK in lockstep
 * with the application DTOs. Block-comment style and no semicolons
 * inside any string literal or block comment per the splitter trap.
 *
 * Idempotent — safe to re-run.
 */
CREATE TABLE IF NOT EXISTS pay_family_accounts (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    account_holder_id UUID NOT NULL,
    account_number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    payment_authorisation_policy TEXT NOT NULL DEFAULT 'ACCOUNT_HOLDER_ONLY',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_family_accounts_school_holder_uq UNIQUE (school_id, account_holder_id),
    CONSTRAINT pay_family_accounts_school_number_uq UNIQUE (school_id, account_number),
    CONSTRAINT pay_family_accounts_status_chk CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
    CONSTRAINT pay_family_accounts_auth_policy_chk CHECK (payment_authorisation_policy IN ('ACCOUNT_HOLDER_ONLY','ANY_AUTHORISED'))
);
CREATE INDEX IF NOT EXISTS pay_family_accounts_school_status_idx ON pay_family_accounts(school_id, status);
CREATE INDEX IF NOT EXISTS pay_family_accounts_holder_idx ON pay_family_accounts(account_holder_id);
COMMENT ON COLUMN pay_family_accounts.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN pay_family_accounts.account_holder_id IS 'Soft FK to platform.iam_person(id) — the primary guardian on the account. UNIQUE(school_id, account_holder_id) enforces at most one family account per (school, guardian) which is the invariant the PaymentAccountWorker relies on for idempotent insert-or-link on enr.student.enrolled.';
COMMENT ON COLUMN pay_family_accounts.account_number IS 'School-issued ref string addressable on a paper invoice. UNIQUE(school_id, account_number) keeps numbers unambiguous within a school.';
COMMENT ON COLUMN pay_family_accounts.status IS 'Lifecycle. ACTIVE accepts new charges and payments. SUSPENDED blocks new charges (read-only). CLOSED is terminal — student left the school, balance settled. Service layer enforces the transitions.';
COMMENT ON COLUMN pay_family_accounts.payment_authorisation_policy IS 'ACCOUNT_HOLDER_ONLY restricts the Pay Now action to the account holder iam_person. ANY_AUTHORISED widens to any guardian on the related sis_student_guardians row with portal access. Service layer enforces the policy.';
CREATE TABLE IF NOT EXISTS pay_family_account_students (
    id UUID PRIMARY KEY,
    family_account_id UUID NOT NULL REFERENCES pay_family_accounts(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    added_by UUID,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_family_account_students_account_student_uq UNIQUE (family_account_id, student_id)
);
CREATE INDEX IF NOT EXISTS pay_family_account_students_account_idx ON pay_family_account_students(family_account_id);
CREATE INDEX IF NOT EXISTS pay_family_account_students_student_idx ON pay_family_account_students(student_id);
COMMENT ON COLUMN pay_family_account_students.added_by IS 'Soft FK to platform.platform_users(id) — the auth account that wrote the link. PaymentAccountWorker stores the enrolling user id when creating the link in response to enr.student.enrolled.';
CREATE TABLE IF NOT EXISTS pay_fee_categories (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_fee_categories_school_name_uq UNIQUE (school_id, name)
);
CREATE INDEX IF NOT EXISTS pay_fee_categories_school_idx ON pay_fee_categories(school_id) WHERE is_active = true;
COMMENT ON COLUMN pay_fee_categories.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN pay_fee_categories.is_active IS 'Inactivate (do not delete) a category that has fee schedules or invoices attached. The pay_fee_schedules.fee_category_id FK is no-cascade so a hard delete would fail loudly anyway.';
CREATE TABLE IF NOT EXISTS pay_fee_schedules (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    academic_year_id UUID NOT NULL REFERENCES sis_academic_years(id),
    fee_category_id UUID NOT NULL REFERENCES pay_fee_categories(id),
    name TEXT NOT NULL,
    description TEXT,
    grade_level TEXT,
    amount NUMERIC(10,2) NOT NULL,
    is_recurring BOOLEAN NOT NULL DEFAULT false,
    recurrence TEXT NOT NULL DEFAULT 'ANNUAL',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_fee_schedules_school_year_name_uq UNIQUE (school_id, academic_year_id, name),
    CONSTRAINT pay_fee_schedules_amount_chk CHECK (amount >= 0),
    CONSTRAINT pay_fee_schedules_recurrence_chk CHECK (recurrence IN ('ONE_TIME','MONTHLY','QUARTERLY','SEMESTER','ANNUAL'))
);
CREATE INDEX IF NOT EXISTS pay_fee_schedules_school_year_idx ON pay_fee_schedules(school_id, academic_year_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS pay_fee_schedules_category_idx ON pay_fee_schedules(fee_category_id);
CREATE INDEX IF NOT EXISTS pay_fee_schedules_grade_idx ON pay_fee_schedules(school_id, academic_year_id, grade_level) WHERE grade_level IS NOT NULL;
COMMENT ON COLUMN pay_fee_schedules.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN pay_fee_schedules.academic_year_id IS 'DB-enforced FK to sis_academic_years(id) — both intra-tenant. No cascade on year delete. Admin closes out the year before deleting it.';
COMMENT ON COLUMN pay_fee_schedules.fee_category_id IS 'DB-enforced FK to pay_fee_categories(id) — both intra-tenant. No cascade on category delete. Admin flips pay_fee_categories.is_active=false rather than hard delete a category that has fee schedules attached.';
COMMENT ON COLUMN pay_fee_schedules.grade_level IS 'NULL means the schedule applies to every grade in the academic year. Specific grade scopes the schedule to that grade only — used for grade-tiered tuition (Grade 9 vs Grade 12).';
COMMENT ON COLUMN pay_fee_schedules.amount IS 'NUMERIC(10,2) so a single fee can be up to 99,999,999.99. Non-negative — discounts are a separate concern that goes through pay_discount_rules in a future cycle.';
COMMENT ON COLUMN pay_fee_schedules.recurrence IS 'Authoritative cadence. ONE_TIME is registration-style, ANNUAL is the default tuition cadence, MONTHLY / QUARTERLY / SEMESTER are the installment-style cadences the future pay_payment_plans table will materialise into invoice runs.';
CREATE TABLE IF NOT EXISTS pay_stripe_accounts (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL UNIQUE,
    stripe_account_id TEXT NOT NULL UNIQUE,
    onboarding_complete BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON COLUMN pay_stripe_accounts.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020. UNIQUE — one Stripe Connect managed account per school.';
COMMENT ON COLUMN pay_stripe_accounts.stripe_account_id IS 'Stripe Connect account id (acct_...). UNIQUE — a single Stripe account cannot be reused across schools. Stubbed in Cycle 6 — the PaymentService accepts the reference but does not make Stripe API calls. Real Stripe wiring is Phase 3 ops work.';
COMMENT ON COLUMN pay_stripe_accounts.onboarding_complete IS 'False until the school finishes Stripe Connect onboarding (KYC, bank account, etc). PaymentService refuses CARD payments for schools whose Stripe account is not onboarding_complete=true.';
