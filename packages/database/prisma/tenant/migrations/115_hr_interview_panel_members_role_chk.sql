/* 115_hr_interview_panel_members_role_chk
 *
 * REVIEW-P2-4b MAJOR #1 closeout. Migration 114 created
 * hr_interview_panel_members.role_in_panel as a free-text TEXT
 * column even though the cycle handoff documented a 3-value CHECK
 * (CHAIR, MEMBER, OBSERVER). The seed only writes those three
 * values today, but the schema layer never rejected garbage. This
 * migration adds the CHECK using the splitter-safe DROP IF EXISTS
 * + ADD pattern documented in CLAUDE.md so re-provisions stay
 * idempotent.
 *
 * Splitter rules followed — no semicolons inside the block comment
 * header, em-dashes used in any prose. NULL stays accepted because
 * future panel-member rows may omit role.
 */

ALTER TABLE hr_interview_panel_members
  DROP CONSTRAINT IF EXISTS hr_interview_panel_members_role_chk;

ALTER TABLE hr_interview_panel_members
  ADD CONSTRAINT hr_interview_panel_members_role_chk
  CHECK (role_in_panel IS NULL OR role_in_panel IN ('CHAIR', 'MEMBER', 'OBSERVER'));

COMMENT ON CONSTRAINT hr_interview_panel_members_role_chk
  ON hr_interview_panel_members IS
  'REVIEW-P2-4b MAJOR #1 — restrict role_in_panel to CHAIR / MEMBER / OBSERVER. NULL allowed for un-roled members.';
