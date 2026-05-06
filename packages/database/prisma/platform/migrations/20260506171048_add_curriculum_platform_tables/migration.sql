-- CreateTable
CREATE TABLE "platform"."cur_standards_frameworks_platform" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT,
    "region" TEXT,
    "version" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cur_standards_frameworks_platform_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."cur_standards_platform" (
    "id" UUID NOT NULL,
    "framework_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "grade_band" TEXT,
    "domain" TEXT,
    "cluster" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cur_standards_platform_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cur_standards_frameworks_platform_name_key" ON "platform"."cur_standards_frameworks_platform"("name");

-- CreateIndex
CREATE INDEX "cur_standards_platform_framework_id_grade_band_idx" ON "platform"."cur_standards_platform"("framework_id", "grade_band");

-- CreateIndex
CREATE UNIQUE INDEX "cur_standards_platform_framework_id_code_key" ON "platform"."cur_standards_platform"("framework_id", "code");

-- AddForeignKey
ALTER TABLE "platform"."cur_standards_platform" ADD CONSTRAINT "cur_standards_platform_framework_id_fkey" FOREIGN KEY ("framework_id") REFERENCES "platform"."cur_standards_frameworks_platform"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- GIN index for full-text search across code + description (Cycle 23 KEYSTONE)
-- Prisma cannot express tsvector indexes natively so this is appended manually.
-- Backs the Step 4 StandardService GIN search.
CREATE INDEX "cur_standards_platform_search_idx"
  ON "platform"."cur_standards_platform"
  USING GIN (to_tsvector('english', code || ' ' || description));

COMMENT ON TABLE "platform"."cur_standards_frameworks_platform" IS
  'Cycle 23 platform-seeded national frameworks (CCSS ELA, CCSS Math, NGSS). Schools adopt via tenant cur_school_framework_adoptions. School-custom frameworks live in tenant cur_standards_frameworks. Updated only by platform migrations.';

COMMENT ON TABLE "platform"."cur_standards_platform" IS
  'Cycle 23 platform-seeded standards under cur_standards_frameworks_platform. The GIN index on to_tsvector(code || description) backs the Step 4 StandardService search. Updated only by platform migrations.';
