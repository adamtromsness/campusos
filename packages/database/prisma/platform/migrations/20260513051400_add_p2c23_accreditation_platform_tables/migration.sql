-- P2-23 Step 1 — Platform schema: acc_frameworks_platform + acc_standards_platform
-- M85 Accreditation: national/international frameworks seeded once and shared
-- across every tenant. School-custom frameworks live in tenant acc_frameworks.
-- The evidence/self-study/action-plan tables resolve standard_id via SOFT
-- INTEGRITY against either platform OR tenant per ADR-001/020.

-- CreateTable
CREATE TABLE "platform"."acc_frameworks_platform" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "organisation" TEXT NOT NULL,
    "description" TEXT,
    "version" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_frameworks_platform_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."acc_standards_platform" (
    "id" UUID NOT NULL,
    "framework_id" UUID NOT NULL,
    "standard_code" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "standard_text" TEXT NOT NULL,
    "guidance_notes" TEXT,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acc_standards_platform_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "acc_frameworks_platform_name_key" ON "platform"."acc_frameworks_platform"("name");

-- CreateIndex
CREATE UNIQUE INDEX "acc_frameworks_platform_abbreviation_key" ON "platform"."acc_frameworks_platform"("abbreviation");

-- CreateIndex
CREATE UNIQUE INDEX "acc_standards_platform_framework_id_standard_code_key" ON "platform"."acc_standards_platform"("framework_id", "standard_code");

-- CreateIndex
CREATE INDEX "acc_standards_platform_framework_id_domain_sort_order_idx" ON "platform"."acc_standards_platform"("framework_id", "domain", "sort_order");

-- AddForeignKey
ALTER TABLE "platform"."acc_standards_platform" ADD CONSTRAINT "acc_standards_platform_framework_id_fkey" FOREIGN KEY ("framework_id") REFERENCES "platform"."acc_frameworks_platform"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMENT ON TABLE "platform"."acc_frameworks_platform" IS
  'P2-23 platform-seeded accreditation frameworks (AdvancED/Cognia, IB, CIS, NEASC, WASC, SACS, MSA). Schools adopt via tenant acc_school_framework_adoptions. School-custom frameworks live in tenant acc_frameworks. Updated only by the idempotent platform seeder.';

COMMENT ON TABLE "platform"."acc_standards_platform" IS
  'P2-23 platform-seeded standards under acc_frameworks_platform. domain + sort_order organise the standards within a framework. The evidence/self-study/action-plan tables resolve standard_id via SOFT INTEGRITY against either platform OR tenant custom standards per ADR-001/020.';
