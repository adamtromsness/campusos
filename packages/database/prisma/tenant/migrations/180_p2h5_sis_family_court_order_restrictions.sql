/*
 * P2-H5 DEFECT 4 — additive column on sis_family_relationships for
 * court-order-driven access restrictions. Codex peer review noted that
 * GuardianAuthorizationService loaded only sis_student_guardians but
 * the hardening plan called for court-order restrictions to drive
 * access decisions. This migration adds the JSONB column the guardian
 * authorization service consults; the existing custody_arrangement
 * column already encodes JOINT/SOLE_A/SOLE_B/OTHER, and the new
 * court_order_restrictions JSONB carries capability-specific blocks
 * such as {"financial_authority": false, "academic_records": false,
 * "health_records": false, "transport_contact": false,
 * "communications": false, "conference_attendance": false}. Missing
 * keys default to permissive (no restriction); only an explicit false
 * blocks the capability for the matching guardian. Schema-side default
 * is the empty object so existing rows keep working without backfill.
 *
 * No new tables — additive ALTER on the existing
 * sis_family_relationships table per the P2-H5 remit.
 */

ALTER TABLE sis_family_relationships
  ADD COLUMN IF NOT EXISTS court_order_restrictions JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN sis_family_relationships.court_order_restrictions IS
  'P2-H5 DEFECT 4 — capability-specific blocks imposed by a court order. Keys are capability tokens; values are booleans. false explicitly denies; missing/true does not restrict. GuardianAuthorizationService consults this alongside custody_arrangement.';
