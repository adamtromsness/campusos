/*
  REVIEW-P2C2 Round 2 closeout — vis_emergency_muster crash-idempotency
  hardening.

  The Round 2 reviewer noted that VisitorMusterConsumer relies on
  Kafka-side idempotency (processWithIdempotency claim-after-success)
  but the underlying schema has no UNIQUE constraint on (school_id,
  incident_id). A worker crash between the muster INSERT commit and
  the idempotency claim could allow a redelivered event to insert a
  duplicate muster row for the same incident.

  Fix: add a partial UNIQUE INDEX on (school_id, incident_id) where
  incident_id IS NOT NULL. The partial WHERE clause preserves the
  existing legitimate use case where a school runs a stand-alone
  fire drill that is NOT linked to an inc_incidents row (drill_type=
  FIRE_DRILL, incident_id NULL — the P2C1 demo seed contains exactly
  one such row). Multiple drills with NULL incident_id stay legal.

  The companion service-layer change (ON CONFLICT DO NOTHING in
  VisitorMusterConsumer) catches the duplicate at the schema level
  and treats it as an idempotent no-op so the consumer's claim
  succeeds.

  Splitter notes: provision-tenant.ts cuts on every literal
  semicolon and filters chunks that begin with a line comment. No
  semicolons appear inside any string literal or block comment here.
*/

CREATE UNIQUE INDEX IF NOT EXISTS vis_muster_school_incident_uq
  ON vis_emergency_muster (school_id, incident_id)
  WHERE incident_id IS NOT NULL;

COMMENT ON INDEX vis_muster_school_incident_uq IS
  'P2C2 Round 2 closeout — caps vis_emergency_muster at one row per (school_id, incident_id) for incident-linked musters. Partial WHERE incident_id IS NOT NULL keeps stand-alone drills (incident_id NULL) free to coexist.';
