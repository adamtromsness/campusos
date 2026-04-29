-- Profile + Household Mini-Cycle Step 1
-- Extends platform.iam_person with personal fields, platform.platform_families
-- with shared-household fields, and platform.platform_family_members with
-- joined_at + updated_at + per-person UNIQUE + 5 new MemberRole values.
-- Adds CHECK constraints on iam_person.phone_type_primary/secondary and a
-- partial UNIQUE INDEX so each household has at most one primary contact.

-- AlterEnum
ALTER TYPE "platform"."MemberRole" ADD VALUE 'HEAD_OF_HOUSEHOLD';
ALTER TYPE "platform"."MemberRole" ADD VALUE 'SPOUSE';
ALTER TYPE "platform"."MemberRole" ADD VALUE 'CHILD';
ALTER TYPE "platform"."MemberRole" ADD VALUE 'GRANDPARENT';
ALTER TYPE "platform"."MemberRole" ADD VALUE 'OTHER_GUARDIAN';

-- DropForeignKey (re-added below with ON DELETE CASCADE)
ALTER TABLE "platform"."platform_family_members" DROP CONSTRAINT "platform_family_members_family_id_fkey";

-- DropIndex (replaced by UNIQUE on person_id below — UNIQUE implies index)
DROP INDEX "platform"."platform_family_members_person_id_idx";

-- AlterTable iam_person — add 12 personal fields
ALTER TABLE "platform"."iam_person"
  ADD COLUMN "middle_name"          TEXT,
  ADD COLUMN "suffix"               TEXT,
  ADD COLUMN "previous_names"       TEXT[],
  ADD COLUMN "primary_phone"        TEXT,
  ADD COLUMN "secondary_phone"      TEXT,
  ADD COLUMN "work_phone"           TEXT,
  ADD COLUMN "phone_type_primary"   TEXT,
  ADD COLUMN "phone_type_secondary" TEXT,
  ADD COLUMN "preferred_language"   TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN "personal_email"       TEXT,
  ADD COLUMN "notes"                TEXT,
  ADD COLUMN "profile_updated_at"   TIMESTAMPTZ;

-- AlterTable platform_families — add 16 shared-household fields
ALTER TABLE "platform"."platform_families"
  ADD COLUMN "address_line1"        TEXT,
  ADD COLUMN "address_line2"        TEXT,
  ADD COLUMN "city"                 TEXT,
  ADD COLUMN "state"                TEXT,
  ADD COLUMN "postal_code"          TEXT,
  ADD COLUMN "country"              TEXT,
  ADD COLUMN "home_phone"           TEXT,
  ADD COLUMN "home_language"        TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN "mailing_address_same" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "mailing_line1"        TEXT,
  ADD COLUMN "mailing_line2"        TEXT,
  ADD COLUMN "mailing_city"         TEXT,
  ADD COLUMN "mailing_state"        TEXT,
  ADD COLUMN "mailing_postal_code"  TEXT,
  ADD COLUMN "mailing_country"      TEXT,
  ADD COLUMN "notes"                TEXT,
  ADD COLUMN "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable platform_family_members — add joined_at + updated_at
ALTER TABLE "platform"."platform_family_members"
  ADD COLUMN "joined_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex (UNIQUE on person_id — one household per person)
CREATE UNIQUE INDEX "platform_family_members_person_id_key" ON "platform"."platform_family_members"("person_id");

-- AddForeignKey (re-add with ON DELETE CASCADE)
ALTER TABLE "platform"."platform_family_members"
  ADD CONSTRAINT "platform_family_members_family_id_fkey"
  FOREIGN KEY ("family_id") REFERENCES "platform"."platform_families"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECK constraints — phone_type enum on iam_person
ALTER TABLE "platform"."iam_person"
  ADD CONSTRAINT "iam_person_phone_type_primary_chk"
  CHECK ("phone_type_primary" IS NULL OR "phone_type_primary" IN ('MOBILE', 'HOME', 'WORK'));

ALTER TABLE "platform"."iam_person"
  ADD CONSTRAINT "iam_person_phone_type_secondary_chk"
  CHECK ("phone_type_secondary" IS NULL OR "phone_type_secondary" IN ('MOBILE', 'HOME', 'WORK'));

-- Partial UNIQUE INDEX — at most one primary contact per household.
-- Prisma cannot express this natively, so it lives in raw SQL here.
CREATE UNIQUE INDEX "platform_family_members_one_primary_per_family_uq"
  ON "platform"."platform_family_members" ("family_id")
  WHERE "is_primary_contact" = true;
