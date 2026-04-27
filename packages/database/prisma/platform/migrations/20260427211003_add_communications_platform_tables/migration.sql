-- CreateEnum
CREATE TYPE "platform"."PushPlatform" AS ENUM ('IOS', 'ANDROID', 'WEB');

-- CreateTable
CREATE TABLE "platform"."platform_push_tokens" (
    "id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "device_id" TEXT NOT NULL,
    "platform" "platform"."PushPlatform" NOT NULL,
    "token" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_push_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_dlq_messages" (
    "id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "partition" INTEGER NOT NULL,
    "kafka_offset" BIGINT NOT NULL,
    "consumer_group" TEXT NOT NULL,
    "event_id" TEXT,
    "tenant_id" UUID,
    "payload" JSONB NOT NULL,
    "headers" JSONB,
    "error_message" TEXT NOT NULL,
    "error_class" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "first_failed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_failed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,
    "resolved_by" UUID,
    "resolution" TEXT,

    CONSTRAINT "platform_dlq_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_push_tokens_platform_user_id_is_active_idx" ON "platform"."platform_push_tokens"("platform_user_id", "is_active");

-- CreateIndex
CREATE INDEX "platform_push_tokens_token_idx" ON "platform"."platform_push_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "platform_push_tokens_platform_user_id_device_id_key" ON "platform"."platform_push_tokens"("platform_user_id", "device_id");

-- CreateIndex
CREATE INDEX "platform_dlq_messages_topic_last_failed_at_idx" ON "platform"."platform_dlq_messages"("topic", "last_failed_at" DESC);

-- CreateIndex
CREATE INDEX "platform_dlq_messages_consumer_group_last_failed_at_idx" ON "platform"."platform_dlq_messages"("consumer_group", "last_failed_at" DESC);

-- CreateIndex
CREATE INDEX "platform_dlq_messages_tenant_id_last_failed_at_idx" ON "platform"."platform_dlq_messages"("tenant_id", "last_failed_at" DESC);

-- CreateIndex
CREATE INDEX "platform_dlq_messages_resolved_at_idx" ON "platform"."platform_dlq_messages"("resolved_at");
