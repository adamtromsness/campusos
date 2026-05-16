/* 174_grp_poll_voter_checks.sql
 *
 * REVIEW-P2C28 Round 1 BLOCKING 1 fix — anonymous poll repeat-voting
 * prevention via a separate voter-check table that mirrors the Cycle
 * 17 ext_election_voter_check pattern.
 *
 * The structural anonymity contract on grp_poll_votes stays intact —
 * anonymous polls still write voter_id=NULL. The new grp_poll_voter
 * _checks table records WHO voted on a given poll without linking to
 * HOW they voted. PRIMARY KEY(poll_id, voter_id) prevents repeat
 * anonymous ballots at the schema layer. PollService.vote inserts
 * the voter-check row first inside the same tenant tx as the vote
 * rows — a duplicate hits the PK and rolls the entire vote back.
 *
 * For non-anonymous polls the existing partial UNIQUE INDEX on
 * grp_poll_votes (poll_id, voter_id, option_id) WHERE voter_id IS
 * NOT NULL remains the canonical dedup gate — the service still
 * writes a voter-check row alongside for uniformity, so reads can
 * always answer "did this user vote?" with one lookup.
 *
 * Soft cross-schema refs per ADR-001 / ADR-020:
 *   grp_poll_voter_checks.poll_id     -> grp_group_polls(id) CASCADE
 *   grp_poll_voter_checks.voter_id    -> platform.platform_users(id) SOFT
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS. Splitter-safe — no
 * semicolons inside any string literal or comment.
 */

CREATE TABLE IF NOT EXISTS grp_poll_voter_checks (
  poll_id     UUID         NOT NULL REFERENCES grp_group_polls(id) ON DELETE CASCADE,
  voter_id    UUID         NOT NULL,
  voted_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, voter_id)
);

CREATE INDEX IF NOT EXISTS grp_poll_voter_checks_voter_idx
  ON grp_poll_voter_checks (voter_id);

COMMENT ON TABLE grp_poll_voter_checks IS
  'Records WHO voted on a given poll without linking to HOW they voted. Anonymous polls still write grp_poll_votes with voter_id=NULL — the structural anonymity contract is preserved. The PK on (poll_id, voter_id) prevents repeat anonymous ballots at the schema layer.';
