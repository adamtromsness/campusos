-- CreateEnum
CREATE TYPE "platform"."AssignmentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "platform"."AssignmentSource" AS ENUM ('MANUAL', 'HR_SYNC', 'SIS_DERIVED', 'GUARDIAN_RELATIONSHIP', 'WORKFLOW_APPROVAL', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "platform"."AssignmentChangeType" AS ENUM ('CREATED', 'ACTIVATED', 'SUSPENDED', 'REVOKED', 'EXPIRED', 'EXTENDED', 'SOURCE_UPDATED');

-- CreateEnum
CREATE TYPE "platform"."AccessChangeEventType" AS ENUM ('ACCOUNT_CREATED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_REACTIVATED', 'ACCOUNT_LOCKED', 'ROLE_GRANTED', 'ROLE_REVOKED', 'ROLE_SUSPENDED', 'ROLE_EXPIRED', 'GUARDIAN_ACCESS_PROVISIONED', 'GUARDIAN_ACCESS_REVOKED', 'MFA_ENROLLED', 'MFA_REMOVED', 'EMERGENCY_ACCESS_GRANTED', 'EMERGENCY_ACCESS_REVOKED');

-- CreateEnum
CREATE TYPE "platform"."AuthEventType" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILURE', 'MFA_CHALLENGE_ISSUED', 'MFA_CHALLENGE_PASSED', 'MFA_CHALLENGE_FAILED', 'SESSION_CREATED', 'SESSION_TERMINATED', 'TOKEN_REFRESHED', 'TOKEN_REVOKED', 'ACCOUNT_LOCKED_AUTO');

-- CreateTable
CREATE TABLE "platform"."roles" (
    "id" UUID NOT NULL,
    "school_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."permissions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."role_permissions" (
    "id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."iam_scope_type" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "allows_child_scopes" BOOLEAN NOT NULL DEFAULT true,
    "is_system" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "iam_scope_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."iam_scope" (
    "id" UUID NOT NULL,
    "scope_type_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "entity_table" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "parent_scope_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iam_scope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."iam_role_assignment" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "scope_id" UUID NOT NULL,
    "effective_from" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMPTZ,
    "status" "platform"."AssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "platform"."AssignmentSource" NOT NULL,
    "source_ref_id" UUID,
    "assigned_by" UUID,
    "approval_request_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iam_role_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."iam_role_assignment_history" (
    "id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "changed_by" UUID,
    "change_type" "platform"."AssignmentChangeType" NOT NULL,
    "previous_status" "platform"."AssignmentStatus",
    "new_status" "platform"."AssignmentStatus",
    "previous_effective_to" TIMESTAMPTZ,
    "new_effective_to" TIMESTAMPTZ,
    "reason" TEXT,
    "changed_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "iam_role_assignment_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."iam_relationship_access_rule" (
    "id" UUID NOT NULL,
    "relationship_type" TEXT NOT NULL,
    "target_role_id" UUID NOT NULL,
    "scope_derivation" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iam_relationship_access_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."iam_effective_access_cache" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "scope_id" UUID NOT NULL,
    "permission_codes" TEXT[],
    "computed_at" TIMESTAMPTZ NOT NULL,
    "assignment_version_hash" TEXT NOT NULL,

    CONSTRAINT "iam_effective_access_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."iam_access_change_event" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "event_type" "platform"."AccessChangeEventType" NOT NULL,
    "actor_id" UUID,
    "scope_id" UUID,
    "role_id" UUID,
    "assignment_id" UUID,
    "metadata" JSONB,
    "event_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "iam_access_change_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."iam_auth_event" (
    "id" UUID NOT NULL,
    "account_id" UUID,
    "provider_id" UUID,
    "event_type" "platform"."AuthEventType" NOT NULL,
    "ip_address_hash" TEXT,
    "user_agent_hash" TEXT,
    "session_id" UUID,
    "failure_reason" TEXT,
    "event_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "iam_auth_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."iam_service_principal" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iam_service_principal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_school_id_name_key" ON "platform"."roles"("school_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "platform"."permissions"("code");

-- CreateIndex
CREATE INDEX "permissions_resource_action_idx" ON "platform"."permissions"("resource", "action");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_id_permission_id_key" ON "platform"."role_permissions"("role_id", "permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "iam_scope_type_code_key" ON "platform"."iam_scope_type"("code");

-- CreateIndex
CREATE INDEX "iam_scope_parent_scope_id_idx" ON "platform"."iam_scope"("parent_scope_id");

-- CreateIndex
CREATE INDEX "iam_scope_entity_id_idx" ON "platform"."iam_scope"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "iam_scope_scope_type_id_entity_id_key" ON "platform"."iam_scope"("scope_type_id", "entity_id");

-- CreateIndex
CREATE INDEX "iam_role_assignment_account_id_status_idx" ON "platform"."iam_role_assignment"("account_id", "status");

-- CreateIndex
CREATE INDEX "iam_role_assignment_scope_id_role_id_status_idx" ON "platform"."iam_role_assignment"("scope_id", "role_id", "status");

-- CreateIndex
CREATE INDEX "iam_role_assignment_effective_to_idx" ON "platform"."iam_role_assignment"("effective_to");

-- CreateIndex
CREATE INDEX "iam_role_assignment_history_assignment_id_changed_at_idx" ON "platform"."iam_role_assignment_history"("assignment_id", "changed_at");

-- CreateIndex
CREATE INDEX "iam_effective_access_cache_account_id_idx" ON "platform"."iam_effective_access_cache"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "iam_effective_access_cache_account_id_scope_id_key" ON "platform"."iam_effective_access_cache"("account_id", "scope_id");

-- CreateIndex
CREATE INDEX "iam_access_change_event_account_id_event_at_idx" ON "platform"."iam_access_change_event"("account_id", "event_at" DESC);

-- CreateIndex
CREATE INDEX "iam_access_change_event_event_type_event_at_idx" ON "platform"."iam_access_change_event"("event_type", "event_at" DESC);

-- CreateIndex
CREATE INDEX "iam_auth_event_account_id_event_at_idx" ON "platform"."iam_auth_event"("account_id", "event_at" DESC);

-- CreateIndex
CREATE INDEX "iam_auth_event_event_type_event_at_idx" ON "platform"."iam_auth_event"("event_type", "event_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "iam_service_principal_name_key" ON "platform"."iam_service_principal"("name");

-- AddForeignKey
ALTER TABLE "platform"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "platform"."roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "platform"."permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."iam_scope" ADD CONSTRAINT "iam_scope_scope_type_id_fkey" FOREIGN KEY ("scope_type_id") REFERENCES "platform"."iam_scope_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."iam_scope" ADD CONSTRAINT "iam_scope_parent_scope_id_fkey" FOREIGN KEY ("parent_scope_id") REFERENCES "platform"."iam_scope"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."iam_role_assignment" ADD CONSTRAINT "iam_role_assignment_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "platform"."roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."iam_role_assignment" ADD CONSTRAINT "iam_role_assignment_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "platform"."iam_scope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."iam_effective_access_cache" ADD CONSTRAINT "iam_effective_access_cache_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "platform"."iam_scope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
