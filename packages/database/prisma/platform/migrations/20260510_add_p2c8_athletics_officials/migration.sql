-- P2-8b — Athletics Officials Marketplace (ADR-063).
-- Officials are portable across schools — they live in the platform
-- schema so a single official can work games in multiple tenants
-- without per-school duplication. Tenant ath_official_assignments
-- rows carry a soft UUID ref per ADR-001/020 (no DB-enforced FK
-- across the schema boundary).

-- CreateTable
CREATE TABLE "platform"."platform_official_profiles" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "sports" TEXT[] NOT NULL,
    "certification_level" TEXT,
    "certification_body" TEXT,
    "certification_expiry" DATE,
    "years_experience" INTEGER,
    "max_travel_miles" INTEGER,
    "base_fee" DECIMAL(8,2),
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "bio" TEXT,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_official_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_official_availability" (
    "id" UUID NOT NULL,
    "official_profile_id" UUID NOT NULL,
    "available_date" DATE NOT NULL,
    "start_time" TIME(0),
    "end_time" TIME(0),
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_official_availability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_official_profiles_person_id_key" ON "platform"."platform_official_profiles"("person_id");

-- CreateIndex
CREATE INDEX "platform_official_profiles_is_available_idx" ON "platform"."platform_official_profiles"("is_available");

-- CreateIndex
CREATE UNIQUE INDEX "platform_official_availability_official_profile_id_available_date_start_time_key" ON "platform"."platform_official_availability"("official_profile_id", "available_date", "start_time");

-- CreateIndex
CREATE INDEX "platform_official_availability_available_date_is_available_idx" ON "platform"."platform_official_availability"("available_date", "is_available");

-- AddForeignKey
ALTER TABLE "platform"."platform_official_availability" ADD CONSTRAINT "platform_official_availability_official_profile_id_fkey" FOREIGN KEY ("official_profile_id") REFERENCES "platform"."platform_official_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Free-form CHECK to keep availability windows consistent.
ALTER TABLE "platform"."platform_official_availability"
  ADD CONSTRAINT "platform_official_availability_window_chk"
  CHECK (
    (start_time IS NULL AND end_time IS NULL)
    OR (start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
  );

ALTER TABLE "platform"."platform_official_profiles"
  ADD CONSTRAINT "platform_official_profiles_sports_chk"
  CHECK (cardinality(sports) > 0);

ALTER TABLE "platform"."platform_official_profiles"
  ADD CONSTRAINT "platform_official_profiles_years_chk"
  CHECK (years_experience IS NULL OR years_experience >= 0);

ALTER TABLE "platform"."platform_official_profiles"
  ADD CONSTRAINT "platform_official_profiles_travel_chk"
  CHECK (max_travel_miles IS NULL OR max_travel_miles >= 0);

ALTER TABLE "platform"."platform_official_profiles"
  ADD CONSTRAINT "platform_official_profiles_fee_chk"
  CHECK (base_fee IS NULL OR base_fee >= 0);

COMMENT ON TABLE "platform"."platform_official_profiles" IS
  'P2-8b — Athletics Officials Marketplace per ADR-063. Officials are portable across schools so the profile lives in the platform schema. Tenant ath_official_assignments rows carry a soft UUID ref to id per ADR-001/020 — no DB-enforced FK across the schema boundary. sports is a non-empty TEXT[] of sport tokens (BASKETBALL, FOOTBALL, SOCCER, etc). is_available is the global on/off switch the official toggles when not actively taking assignments.';

COMMENT ON TABLE "platform"."platform_official_availability" IS
  'P2-8b — Per-(official, date, slot) availability row. UNIQUE(official_profile_id, available_date, start_time) caps each official at one row per (date, start_time) tuple. start_time and end_time both nullable — a NULL pair means the official is available all day on that date. window_chk enforces the all-day or specific-window invariant. CASCADE on parent profile delete since availability without its profile is meaningless.';

COMMENT ON COLUMN "platform"."platform_official_profiles"."person_id" IS
  'DB-enforced UNIQUE on platform.iam_person(id). One official profile per person.';

COMMENT ON COLUMN "platform"."platform_official_profiles"."sports" IS
  'Non-empty TEXT[] of sport tokens. Free-form to accommodate region-specific sports without a central enum table.';

COMMENT ON COLUMN "platform"."platform_official_profiles"."base_fee" IS
  'Optional NUMERIC(8,2) — the official advertises a base fee per game; tenant ath_official_assignments.fee can override per assignment.';
