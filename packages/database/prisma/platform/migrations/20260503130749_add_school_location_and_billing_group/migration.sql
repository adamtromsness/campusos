-- AlterTable
ALTER TABLE "platform"."schools" ADD COLUMN     "full_address" TEXT,
ADD COLUMN     "latitude" DECIMAL(10,8),
ADD COLUMN     "longitude" DECIMAL(11,8),
ADD COLUMN     "shared_billing_group_id" UUID;

-- CreateIndex
CREATE INDEX "schools_shared_billing_group_id_idx" ON "platform"."schools"("shared_billing_group_id");
