-- CreateEnum
CREATE TYPE "platform"."PersonType" AS ENUM ('STAFF', 'STUDENT', 'GUARDIAN', 'VOLUNTEER', 'SUBSTITUTE', 'ALUMNI', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "platform"."AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'LOCKED', 'PENDING_VERIFICATION', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "platform"."AccountType" AS ENUM ('HUMAN', 'SERVICE_ACCOUNT');

-- CreateEnum
CREATE TYPE "platform"."MemberRole" AS ENUM ('PARENT', 'GUARDIAN', 'STUDENT', 'SIBLING', 'OTHER');

-- CreateEnum
CREATE TYPE "platform"."BackgroundCheckStatus" AS ENUM ('PENDING', 'PASSED', 'FLAGGED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "platform"."ProviderType" AS ENUM ('GOOGLE', 'MICROSOFT', 'SAML', 'OIDC', 'LOCAL', 'LDAP');

-- CreateEnum
CREATE TYPE "platform"."TrustLevel" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "platform"."SyncStatus" AS ENUM ('SYNCED', 'CONFLICT', 'PENDING');

-- CreateTable
CREATE TABLE "platform"."iam_person" (
    "id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "preferred_name" TEXT,
    "date_of_birth" DATE,
    "national_id_hash" TEXT,
    "person_type" "platform"."PersonType" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "merged_into_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iam_person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_users" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "account_status" "platform"."AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "account_type" "platform"."AccountType" NOT NULL DEFAULT 'HUMAN',
    "email" TEXT NOT NULL,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ,

    CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_students" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "date_of_birth" DATE,
    "national_id_hash" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "data_subject_is_self" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_families" (
    "id" UUID NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_family_members" (
    "id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "member_role" "platform"."MemberRole" NOT NULL,
    "is_primary_contact" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_family_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_volunteer_profiles" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "account_id" UUID,
    "phone" TEXT,
    "background_check_status" "platform"."BackgroundCheckStatus",
    "background_check_ref" TEXT,
    "background_check_date" DATE,
    "certifications" JSONB,
    "availability_notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_volunteer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_substitute_profiles" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "account_id" UUID,
    "phone" TEXT,
    "background_check_status" "platform"."BackgroundCheckStatus",
    "background_check_ref" TEXT,
    "background_check_date" DATE,
    "certifications" JSONB,
    "subject_qualifications" JSONB,
    "grade_range" TEXT,
    "max_distance_miles" INTEGER,
    "daily_rate" DECIMAL(8,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_substitute_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."iam_identity_provider" (
    "id" UUID NOT NULL,
    "school_id" UUID,
    "name" TEXT NOT NULL,
    "provider_type" "platform"."ProviderType" NOT NULL,
    "issuer_url" TEXT,
    "client_id_encrypted" TEXT,
    "metadata_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "trust_level" "platform"."TrustLevel" NOT NULL DEFAULT 'MEDIUM',
    "auto_provision_accounts" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iam_identity_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."iam_federated_identity" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "external_email" TEXT,
    "sync_status" "platform"."SyncStatus" NOT NULL DEFAULT 'SYNCED',
    "conflict_note" TEXT,
    "last_sync_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iam_federated_identity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "iam_person_national_id_hash_idx" ON "platform"."iam_person"("national_id_hash");

-- CreateIndex
CREATE INDEX "iam_person_person_type_is_active_idx" ON "platform"."iam_person"("person_type", "is_active");

-- CreateIndex
CREATE INDEX "iam_person_merged_into_id_idx" ON "platform"."iam_person"("merged_into_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_person_id_key" ON "platform"."platform_users"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_email_key" ON "platform"."platform_users"("email");

-- CreateIndex
CREATE INDEX "platform_users_person_id_idx" ON "platform"."platform_users"("person_id");

-- CreateIndex
CREATE INDEX "platform_users_email_idx" ON "platform"."platform_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_students_person_id_key" ON "platform"."platform_students"("person_id");

-- CreateIndex
CREATE INDEX "platform_students_national_id_hash_idx" ON "platform"."platform_students"("national_id_hash");

-- CreateIndex
CREATE INDEX "platform_family_members_person_id_idx" ON "platform"."platform_family_members"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_family_members_family_id_person_id_key" ON "platform"."platform_family_members"("family_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_volunteer_profiles_person_id_key" ON "platform"."platform_volunteer_profiles"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_substitute_profiles_person_id_key" ON "platform"."platform_substitute_profiles"("person_id");

-- CreateIndex
CREATE INDEX "iam_federated_identity_user_id_idx" ON "platform"."iam_federated_identity"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "iam_federated_identity_provider_id_external_id_key" ON "platform"."iam_federated_identity"("provider_id", "external_id");

-- AddForeignKey
ALTER TABLE "platform"."iam_person" ADD CONSTRAINT "iam_person_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "platform"."iam_person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."platform_users" ADD CONSTRAINT "platform_users_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "platform"."iam_person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."platform_students" ADD CONSTRAINT "platform_students_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "platform"."iam_person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."platform_family_members" ADD CONSTRAINT "platform_family_members_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "platform"."platform_families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."platform_family_members" ADD CONSTRAINT "platform_family_members_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "platform"."iam_person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."platform_volunteer_profiles" ADD CONSTRAINT "platform_volunteer_profiles_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "platform"."iam_person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."platform_substitute_profiles" ADD CONSTRAINT "platform_substitute_profiles_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "platform"."iam_person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."iam_identity_provider" ADD CONSTRAINT "iam_identity_provider_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "platform"."schools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."iam_federated_identity" ADD CONSTRAINT "iam_federated_identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform"."platform_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."iam_federated_identity" ADD CONSTRAINT "iam_federated_identity_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "platform"."iam_identity_provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
