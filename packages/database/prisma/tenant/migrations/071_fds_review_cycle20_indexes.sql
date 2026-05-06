/* ============================================================
 * Cycle 20 — REVIEW-CYCLE20 follow-up indexes
 * ============================================================
 *
 * Two schema-level adjustments in support of REVIEW-CYCLE20 fixes.
 *
 *   1. UNIQUE on fds_student_allergen_alerts.source_health_alert_id so the
 *      Phase 1 manual sync (and the future Cycle-10 Kafka consumer) can
 *      upsert deterministically by source health alert id. Previously the
 *      sync used ON CONFLICT DO NOTHING which silently dropped severity /
 *      display-name / is_active changes coming from the Health module.
 *
 *   2. Partial UNIQUE on fds_usda_reimbursement_claims (school_id, month_year)
 *      WHERE academic_year_id IS NULL. The base UNIQUE constraint
 *      (school_id, academic_year_id, month_year) does not catch duplicate
 *      claims for the same (school, month) when academic_year_id is NULL
 *      because PostgreSQL UNIQUE indexes treat NULLs as distinct. Real
 *      operational guidance is to require academicYearId at the service
 *      layer, but this index is defence-in-depth.
 *
 * Splitter-safe additive idempotent migration (no DO blocks, no
 * embedded semicolons inside string literals or block comments).
 * ============================================================ */

ALTER TABLE fds_student_allergen_alerts
  DROP CONSTRAINT IF EXISTS fds_alert_source_uq;

ALTER TABLE fds_student_allergen_alerts
  ADD CONSTRAINT fds_alert_source_uq UNIQUE (source_health_alert_id);

CREATE UNIQUE INDEX IF NOT EXISTS fds_claim_null_year_uq
  ON fds_usda_reimbursement_claims (school_id, month_year)
  WHERE academic_year_id IS NULL;
