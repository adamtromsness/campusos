-- REVIEW-FINAL P4 — platform_reference_health
-- Soft-FK orphan-detection registry + scan log. The
-- ReferenceHealthScannerWorker periodically counts orphans for each
-- registered (source_schema, source_table, source_column → target_schema,
-- target_table) tuple and writes one row per scan. Operators query this
-- via the platform admin dashboard.
CREATE TABLE IF NOT EXISTS "platform"."platform_reference_health" (
  "id" UUID NOT NULL,
  "source_schema" TEXT NOT NULL,
  "source_table" TEXT NOT NULL,
  "source_column" TEXT NOT NULL,
  "target_schema" TEXT NOT NULL,
  "target_table" TEXT NOT NULL,
  "target_column" TEXT NOT NULL DEFAULT 'id',
  "total_rows" INTEGER NOT NULL,
  "orphan_count" INTEGER NOT NULL,
  "sample_orphan_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "scanned_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "scan_duration_ms" INTEGER NOT NULL,
  CONSTRAINT "platform_reference_health_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "platform_reference_health_source_scanned_idx"
  ON "platform"."platform_reference_health" ("source_schema", "source_table", "scanned_at" DESC);

CREATE INDEX IF NOT EXISTS "platform_reference_health_orphan_count_idx"
  ON "platform"."platform_reference_health" ("orphan_count" DESC, "scanned_at" DESC);

-- REVIEW-FINAL P2 — platform_outbox
-- Transactional outbox for safety-critical Kafka events. Callers write
-- outbox rows inside their tenant transaction; OutboxPublisherWorker
-- polls, publishes via KafkaProducerService, and marks published_at on
-- success. Failure leaves the row for the next poll up to MAX_OUTBOX_ATTEMPTS.
CREATE TABLE IF NOT EXISTS "platform"."platform_outbox" (
  "id" UUID NOT NULL,
  "topic" TEXT NOT NULL,
  "envelope" JSONB NOT NULL,
  "message_key" TEXT,
  "tenant_id" UUID,
  "source_module" TEXT NOT NULL,
  "published_at" TIMESTAMPTZ,
  "failed_at" TIMESTAMPTZ,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "platform_outbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "platform_outbox_pending_idx"
  ON "platform"."platform_outbox" ("created_at");

CREATE INDEX IF NOT EXISTS "platform_outbox_tenant_idx"
  ON "platform"."platform_outbox" ("tenant_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "platform_outbox_failed_idx"
  ON "platform"."platform_outbox" ("failed_at");
