/*
 * 139_trn_parent_tracking_school_id.sql — REVIEW-P2C11 ROUND 1 BLOCKING 4.
 *
 * trn_parent_tracking_tokens was shipped in migration 138 without a
 * school_id column. The Round 1 peer review flagged the gap — the
 * unauthenticated public viewByToken path, the revokeToken admin path,
 * and the listForStudent reads were not school-defensive. Adding a
 * required school_id column lets every token mutation and the public
 * lookup carry a school predicate as defence in depth.
 *
 * Additive, idempotent. ALTER TABLE ADD COLUMN IF NOT EXISTS so a
 * re-provision is a no-op. Backfill carries the school from each
 * token's parent trn_routes row. Once backfilled the column flips to
 * NOT NULL via a DROP IF EXISTS plus ADD pattern so the migration is
 * splitter-safe and idempotent.
 *
 * No semicolons inside string literals or block comments.
 */

ALTER TABLE trn_parent_tracking_tokens
  ADD COLUMN IF NOT EXISTS school_id UUID;

UPDATE trn_parent_tracking_tokens t
SET school_id = r.school_id
FROM trn_routes r
WHERE t.route_id = r.id AND t.school_id IS NULL;

ALTER TABLE trn_parent_tracking_tokens
  ALTER COLUMN school_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS trn_token_school_idx
  ON trn_parent_tracking_tokens (school_id, expires_at)
  WHERE is_active = true;

COMMENT ON COLUMN trn_parent_tracking_tokens.school_id IS
  'School ownership of the token. Required for school-defensive lookups on the public viewByToken path (which is unauthenticated) and the admin revoke/list paths. Backfilled in migration 139 from trn_routes.school_id.';
