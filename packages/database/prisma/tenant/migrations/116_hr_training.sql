/* 116_hr_training
 *
 * Phase 2 Cycle 4 sub-cycle c (P2-4c) Step 8 — Training & Certifications.
 *
 * Plan reference — docs/campusos-p2c4-hr-advanced.html Step 8.
 * Adds 5 tables:
 *
 *   hr_training_programmes      — per-school training catalogue. Marks
 *                                 mandatory + renewal cadence in months.
 *   hr_training_events          — instances of a programme (one row per
 *                                 scheduled session). 3-value status CHECK.
 *   hr_training_completions     — per-(event, employee) completion record.
 *                                 UNIQUE keystone for idempotency under
 *                                 retry. Carries score + passed flag.
 *   hr_certification_types      — per-school catalogue of certification
 *                                 names (the school defines its own
 *                                 typology beyond the Cycle 4 enum).
 *   hr_employee_certifications  — flexible per-employee certification
 *                                 records keyed on the type catalogue.
 *                                 Coexists with Cycle 4 hr_staff_certifications
 *                                 (which uses a 10-value enum). New flow
 *                                 (training-driven auto-issue, custom
 *                                 school types) lands here.
 *
 * Splitter rules — no semicolons inside any block comment header,
 * single-quoted string, or COMMENT ON ... text.
 */

CREATE TABLE IF NOT EXISTS hr_training_programmes (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_mandatory BOOLEAN NOT NULL DEFAULT false,
    renewal_months INT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_training_programmes_school_name_uq UNIQUE (school_id, name),
    CONSTRAINT hr_training_programmes_renewal_chk
      CHECK (renewal_months IS NULL OR renewal_months > 0)
);

CREATE INDEX IF NOT EXISTS hr_training_programmes_school_idx
  ON hr_training_programmes(school_id, is_active);

CREATE TABLE IF NOT EXISTS hr_training_events (
    id UUID PRIMARY KEY,
    programme_id UUID NOT NULL REFERENCES hr_training_programmes(id) ON DELETE CASCADE,
    school_id UUID NOT NULL,
    title TEXT NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    duration_minutes INT,
    location TEXT,
    facilitator TEXT,
    max_participants INT,
    status TEXT NOT NULL DEFAULT 'SCHEDULED',
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_training_events_status_chk
      CHECK (status IN ('SCHEDULED', 'COMPLETED', 'CANCELLED')),
    CONSTRAINT hr_training_events_duration_chk
      CHECK (duration_minutes IS NULL OR duration_minutes > 0),
    CONSTRAINT hr_training_events_max_chk
      CHECK (max_participants IS NULL OR max_participants > 0),
    CONSTRAINT hr_training_events_completed_chk
      CHECK (
        (status = 'COMPLETED' AND completed_at IS NOT NULL)
        OR (status <> 'COMPLETED' AND completed_at IS NULL)
      ),
    CONSTRAINT hr_training_events_cancelled_chk
      CHECK (
        (status = 'CANCELLED' AND cancelled_at IS NOT NULL
         AND cancellation_reason IS NOT NULL
         AND length(trim(cancellation_reason)) > 0)
        OR (status <> 'CANCELLED' AND cancelled_at IS NULL)
      )
);

CREATE INDEX IF NOT EXISTS hr_training_events_programme_idx
  ON hr_training_events(programme_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS hr_training_events_school_status_idx
  ON hr_training_events(school_id, status);

CREATE TABLE IF NOT EXISTS hr_training_completions (
    id UUID PRIMARY KEY,
    event_id UUID NOT NULL REFERENCES hr_training_events(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    school_id UUID NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    score NUMERIC(5,2),
    passed BOOLEAN NOT NULL DEFAULT true,
    notes TEXT,
    recorded_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_training_completions_event_employee_uq UNIQUE (event_id, employee_id),
    CONSTRAINT hr_training_completions_score_chk
      CHECK (score IS NULL OR (score >= 0 AND score <= 100))
);

CREATE INDEX IF NOT EXISTS hr_training_completions_employee_idx
  ON hr_training_completions(employee_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS hr_certification_types (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    issuing_body TEXT,
    description TEXT,
    validity_months INT,
    is_required BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_certification_types_school_name_uq UNIQUE (school_id, name),
    CONSTRAINT hr_certification_types_validity_chk
      CHECK (validity_months IS NULL OR validity_months > 0)
);

CREATE INDEX IF NOT EXISTS hr_certification_types_school_idx
  ON hr_certification_types(school_id, is_active);

CREATE TABLE IF NOT EXISTS hr_employee_certifications (
    id UUID PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    certification_type_id UUID NOT NULL REFERENCES hr_certification_types(id) ON DELETE NO ACTION,
    school_id UUID NOT NULL,
    issued_at DATE NOT NULL,
    expires_at DATE,
    document_s3_key TEXT,
    reference_number TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    revoked_at TIMESTAMPTZ,
    revoked_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_employee_certifications_status_chk
      CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED')),
    CONSTRAINT hr_employee_certifications_dates_chk
      CHECK (expires_at IS NULL OR expires_at >= issued_at),
    CONSTRAINT hr_employee_certifications_revoked_chk
      CHECK (
        (status = 'REVOKED' AND revoked_at IS NOT NULL
         AND revoked_reason IS NOT NULL AND length(trim(revoked_reason)) > 0)
        OR (status <> 'REVOKED' AND revoked_at IS NULL)
      )
);

CREATE INDEX IF NOT EXISTS hr_employee_certifications_employee_idx
  ON hr_employee_certifications(employee_id, status);
CREATE INDEX IF NOT EXISTS hr_employee_certifications_expiry_idx
  ON hr_employee_certifications(school_id, expires_at)
  WHERE expires_at IS NOT NULL AND status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS hr_employee_certifications_type_idx
  ON hr_employee_certifications(certification_type_id);

COMMENT ON TABLE hr_training_programmes IS
  'P2-4c — per-school training catalogue. is_mandatory drives compliance dashboards. renewal_months controls auto-recertification cadence.';
COMMENT ON TABLE hr_training_completions IS
  'P2-4c — per-(event, employee) completion. UNIQUE keystone — second insert returns 23505. hr.training.completed Kafka emit fires on insert via OutboxService.enqueueInTx.';
COMMENT ON TABLE hr_employee_certifications IS
  'P2-4c — flexible per-employee certification record. Coexists with the Cycle 4 hr_staff_certifications enum-based table. New training auto-issue + custom school types land here.';
