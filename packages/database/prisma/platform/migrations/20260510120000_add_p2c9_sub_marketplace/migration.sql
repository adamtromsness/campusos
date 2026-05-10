-- P2-9 Sub Marketplace (M82) — platform-portable substitute profiles per ADR-029.
--
-- Substitutes work across schools so the canonical profile, credentials,
-- availability and per-school preferences live in the platform schema.
-- Tenant sub_school_pool, sub_job_postings, sub_job_notifications,
-- sub_assignments, sub_ratings, sub_session_notes, sub_pay_rates and
-- sub_cancellation_policies (migrations 132 + 133) carry soft UUID refs to
-- platform_substitute_profiles.id per ADR-001/020 — no DB-enforced FK
-- across the schema boundary.
--
-- platform_substitute_profiles already exists from the ADR-014 forward-
-- compat skeleton (migration 20260426094416_add_identity_tables) but with
-- a different column shape — a single grade_range string, daily_rate,
-- background_check fields. The original column set is preserved (no
-- DROP COLUMN per CLAUDE.md "additive only" policy) and the P2-9 columns
-- (display_name, bio, grade_levels, subject_areas, years_experience,
-- is_available, profile_photo_s3_key, overall_rating, total_assignments)
-- are added alongside.
--
-- The existing max_distance_miles column maps to the plan's max_travel_miles
-- concept and is reused as-is rather than duplicated.
-- =====================================================================

-- ── platform_substitute_profiles — extend with P2-9 columns ──────────

ALTER TABLE "platform"."platform_substitute_profiles"
  ADD COLUMN IF NOT EXISTS "display_name" TEXT,
  ADD COLUMN IF NOT EXISTS "bio" TEXT,
  ADD COLUMN IF NOT EXISTS "grade_levels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "subject_areas" TEXT[],
  ADD COLUMN IF NOT EXISTS "years_experience" INTEGER,
  ADD COLUMN IF NOT EXISTS "is_available" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "profile_photo_s3_key" TEXT,
  ADD COLUMN IF NOT EXISTS "overall_rating" NUMERIC(2,1),
  ADD COLUMN IF NOT EXISTS "total_assignments" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "platform"."platform_substitute_profiles"
  DROP CONSTRAINT IF EXISTS "platform_substitute_profiles_years_chk";

ALTER TABLE "platform"."platform_substitute_profiles"
  ADD CONSTRAINT "platform_substitute_profiles_years_chk"
  CHECK (years_experience IS NULL OR years_experience >= 0);

ALTER TABLE "platform"."platform_substitute_profiles"
  DROP CONSTRAINT IF EXISTS "platform_substitute_profiles_rating_chk";

ALTER TABLE "platform"."platform_substitute_profiles"
  ADD CONSTRAINT "platform_substitute_profiles_rating_chk"
  CHECK (overall_rating IS NULL OR (overall_rating >= 1.0 AND overall_rating <= 5.0));

ALTER TABLE "platform"."platform_substitute_profiles"
  DROP CONSTRAINT IF EXISTS "platform_substitute_profiles_assignments_chk";

ALTER TABLE "platform"."platform_substitute_profiles"
  ADD CONSTRAINT "platform_substitute_profiles_assignments_chk"
  CHECK (total_assignments >= 0);

CREATE INDEX IF NOT EXISTS "platform_substitute_profiles_is_available_idx"
  ON "platform"."platform_substitute_profiles" ("is_available");

CREATE INDEX IF NOT EXISTS "platform_substitute_profiles_grade_levels_gin_idx"
  ON "platform"."platform_substitute_profiles" USING GIN ("grade_levels");

COMMENT ON COLUMN "platform"."platform_substitute_profiles"."display_name" IS
  'P2-9 — Public display name shown to schools in the marketplace search results. Allowed to differ from the iam_person legal first/last name (e.g. "Sarah J." instead of "Sarah Johnson").';
COMMENT ON COLUMN "platform"."platform_substitute_profiles"."grade_levels" IS
  'P2-9 — Non-empty TEXT[] of grade tokens the substitute will cover (e.g. ELEMENTARY, MIDDLE, HIGH or specific grade strings 1-12). Backed by a GIN index for the matching engine grade_levels && ARRAY[...] filter. Service layer enforces non-empty on writes.';
COMMENT ON COLUMN "platform"."platform_substitute_profiles"."subject_areas" IS
  'P2-9 — Optional TEXT[] of subject specialisms (MATHS, SCIENCE, etc).';
COMMENT ON COLUMN "platform"."platform_substitute_profiles"."is_available" IS
  'P2-9 — Global on/off toggle the substitute flips when temporarily not taking jobs. Distinct from is_active (account active) and from per-date availability rows in platform_sub_availability.';
COMMENT ON COLUMN "platform"."platform_substitute_profiles"."overall_rating" IS
  'P2-9 — Materialised AVG of all sub_ratings rows where rater_type=SCHOOL_RATES_SUB. Re-computed by RatingService on every new SCHOOL_RATES_SUB rating insert.';
COMMENT ON COLUMN "platform"."platform_substitute_profiles"."total_assignments" IS
  'P2-9 — Materialised count of CHECKED_OUT assignments. Re-computed by the AssignmentService on every check-out.';
COMMENT ON COLUMN "platform"."platform_substitute_profiles"."max_distance_miles" IS
  'P2-9 alias of the planned max_travel_miles concept — column retained from ADR-014 forward-compat (migration 20260426094416). Service code reads it as maxTravelMiles.';


-- ── platform_sub_credentials ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "platform"."platform_sub_credentials" (
    "id" UUID NOT NULL,
    "substitute_id" UUID NOT NULL,
    "credential_type" TEXT NOT NULL,
    "credential_name" TEXT NOT NULL,
    "issuing_body" TEXT,
    "issue_date" DATE,
    "expiry_date" DATE,
    "document_s3_key" TEXT,
    "verification_status" TEXT NOT NULL DEFAULT 'PENDING',
    "verified_by" UUID,
    "verified_at" TIMESTAMPTZ,
    "verification_notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_sub_credentials_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_sub_credentials_type_chk" CHECK ("credential_type" IN ('TEACHING_LICENSE', 'SAFEGUARDING', 'FIRST_AID', 'BACKGROUND_CHECK', 'SPECIALIST_QUALIFICATION', 'OTHER')),
    CONSTRAINT "platform_sub_credentials_status_chk" CHECK ("verification_status" IN ('PENDING', 'VERIFIED', 'EXPIRED')),
    CONSTRAINT "platform_sub_credentials_dates_chk" CHECK ("issue_date" IS NULL OR "expiry_date" IS NULL OR "expiry_date" >= "issue_date"),
    CONSTRAINT "platform_sub_credentials_verified_chk" CHECK (
      ("verification_status" <> 'VERIFIED' AND "verified_at" IS NULL AND "verified_by" IS NULL)
      OR ("verification_status" = 'VERIFIED' AND "verified_at" IS NOT NULL AND "verified_by" IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS "platform_sub_credentials_sub_idx"
  ON "platform"."platform_sub_credentials" ("substitute_id", "credential_type", "verification_status", "expiry_date");

CREATE INDEX IF NOT EXISTS "platform_sub_credentials_verified_idx"
  ON "platform"."platform_sub_credentials" ("substitute_id")
  WHERE "verification_status" = 'VERIFIED';

CREATE INDEX IF NOT EXISTS "platform_sub_credentials_expiring_idx"
  ON "platform"."platform_sub_credentials" ("expiry_date")
  WHERE "verification_status" = 'VERIFIED' AND "expiry_date" IS NOT NULL;

ALTER TABLE "platform"."platform_sub_credentials"
  DROP CONSTRAINT IF EXISTS "platform_sub_credentials_substitute_id_fkey";

ALTER TABLE "platform"."platform_sub_credentials"
  ADD CONSTRAINT "platform_sub_credentials_substitute_id_fkey"
  FOREIGN KEY ("substitute_id") REFERENCES "platform"."platform_substitute_profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMENT ON TABLE "platform"."platform_sub_credentials" IS
  'P2-9 — Substitute credential record. credential_type 6-value CHECK (TEACHING_LICENSE, SAFEGUARDING, FIRST_AID, BACKGROUND_CHECK, SPECIALIST_QUALIFICATION, OTHER). verification_status 3-value (PENDING, VERIFIED, EXPIRED) with verified_chk lockstep keeping verified_at and verified_by populated only on VERIFIED. The matching engine joins via the partial index WHERE verification_status=VERIFIED. Expiry alerting (60 + 30 day windows) is a Phase 2 backlog cron job.';


-- ── platform_sub_availability ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "platform"."platform_sub_availability" (
    "id" UUID NOT NULL,
    "substitute_id" UUID NOT NULL,
    "availability_type" TEXT NOT NULL,
    "day_of_week" SMALLINT,
    "specific_date" DATE,
    "start_time" TIME(0),
    "end_time" TIME(0),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_sub_availability_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_sub_availability_type_chk" CHECK ("availability_type" IN ('RECURRING', 'SPECIFIC', 'BLOCKED')),
    CONSTRAINT "platform_sub_availability_dow_chk" CHECK ("day_of_week" IS NULL OR ("day_of_week" >= 0 AND "day_of_week" <= 6)),
    CONSTRAINT "platform_sub_availability_shape_chk" CHECK (
      ("availability_type" = 'RECURRING' AND "day_of_week" IS NOT NULL AND "specific_date" IS NULL)
      OR ("availability_type" IN ('SPECIFIC', 'BLOCKED') AND "specific_date" IS NOT NULL AND "day_of_week" IS NULL)
    ),
    CONSTRAINT "platform_sub_availability_window_chk" CHECK (
      ("start_time" IS NULL AND "end_time" IS NULL)
      OR ("start_time" IS NOT NULL AND "end_time" IS NOT NULL AND "end_time" > "start_time")
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "platform_sub_availability_recurring_uq"
  ON "platform"."platform_sub_availability" ("substitute_id", "day_of_week", "start_time")
  WHERE "availability_type" = 'RECURRING';

CREATE UNIQUE INDEX IF NOT EXISTS "platform_sub_availability_specific_uq"
  ON "platform"."platform_sub_availability" ("substitute_id", "specific_date", "start_time")
  WHERE "availability_type" IN ('SPECIFIC', 'BLOCKED');

CREATE INDEX IF NOT EXISTS "platform_sub_availability_lookup_idx"
  ON "platform"."platform_sub_availability" ("substitute_id", "availability_type");

ALTER TABLE "platform"."platform_sub_availability"
  DROP CONSTRAINT IF EXISTS "platform_sub_availability_substitute_id_fkey";

ALTER TABLE "platform"."platform_sub_availability"
  ADD CONSTRAINT "platform_sub_availability_substitute_id_fkey"
  FOREIGN KEY ("substitute_id") REFERENCES "platform"."platform_substitute_profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMENT ON TABLE "platform"."platform_sub_availability" IS
  'P2-9 — Per-substitute availability row. availability_type 3-value CHECK (RECURRING, SPECIFIC, BLOCKED). RECURRING uses day_of_week (0=Sun..6=Sat) and recurs every week. SPECIFIC and BLOCKED use specific_date and override the RECURRING grid for that date. The shape_chk enforces the keystone day_of_week/specific_date mutex. The matching engine resolves availability for a given (substitute, date) by checking BLOCKED first (NOT EXISTS subquery) — a BLOCKED row for the exact date wins over any matching RECURRING row.';


-- ── platform_sub_preferences ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "platform"."platform_sub_preferences" (
    "id" UUID NOT NULL,
    "substitute_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "preference_type" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_sub_preferences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_sub_preferences_type_chk" CHECK ("preference_type" IN ('PREFERRED', 'BLOCKED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "platform_sub_preferences_sub_school_uq"
  ON "platform"."platform_sub_preferences" ("substitute_id", "school_id");

CREATE INDEX IF NOT EXISTS "platform_sub_preferences_school_idx"
  ON "platform"."platform_sub_preferences" ("school_id", "preference_type");

ALTER TABLE "platform"."platform_sub_preferences"
  DROP CONSTRAINT IF EXISTS "platform_sub_preferences_substitute_id_fkey";

ALTER TABLE "platform"."platform_sub_preferences"
  ADD CONSTRAINT "platform_sub_preferences_substitute_id_fkey"
  FOREIGN KEY ("substitute_id") REFERENCES "platform"."platform_substitute_profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMENT ON TABLE "platform"."platform_sub_preferences" IS
  'P2-9 — Per-(substitute, school) preference. preference_type 2-value CHECK (PREFERRED, BLOCKED). The reason column is private — visible to the substitute only, not the school the preference targets. The matching engine excludes BLOCKED schools from notification fan-out and prioritises PREFERRED pairs. school_id is a soft UUID ref to platform.schools(id) per ADR-001/020.';
