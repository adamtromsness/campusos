/* P2-H4 Step 5 Advisory ADV-04 (GPT SEC-03) - election results threshold.
 *
 * Small student elections (3 voters, 2 candidates) can have results
 * that effectively reveal who voted for whom. Add a configurable
 * minimum-vote threshold so the public results endpoint hides counts
 * when total votes < min_votes_for_results.
 *
 * Default 5 — chosen to be lower than the smallest practical class
 * count (typical primary class is 25+) and high enough to defeat the
 * "you voted last therefore the unaccounted-for tally is yours" attack
 * in a 4-voter scenario. Schools can raise this per election when the
 * cohort is larger.
 *
 * Splitter-safe additive migration. The ext_elections table already
 * exists (Cycle 17 migration 060). This migration is non-destructive
 * and idempotent across re-provisions.
 */

ALTER TABLE ext_elections
  ADD COLUMN IF NOT EXISTS min_votes_for_results INT NOT NULL DEFAULT 5;

ALTER TABLE ext_elections
  DROP CONSTRAINT IF EXISTS ext_elections_min_votes_chk;

ALTER TABLE ext_elections
  ADD CONSTRAINT ext_elections_min_votes_chk CHECK (min_votes_for_results >= 1);

COMMENT ON COLUMN ext_elections.min_votes_for_results IS 'P2-H4 ADV-04 - results endpoint hides vote counts when total votes are below this threshold. Defaults to 5 for small-cohort privacy. Admin can raise per election.';
