-- Persona registration review FIX 1.
--
-- platform_users.managed_by_person_id was shipped as a soft UUID
-- column. Codex flagged the missing referential-integrity constraint
-- — a parent-managed minor account that loses its parent silently
-- becomes an orphan with no way for the API to detect it.
--
-- ON DELETE RESTRICT means we refuse to delete an iam_person that is
-- still listed as the manager of a minor account. The (extremely
-- rare) parent-deletion flow has to clear managed_by_person_id first
-- — either by reassigning the minor to a different guardian or by
-- ageing the minor up to self-service. Either way it's an explicit
-- decision, not a silent orphaning.
--
-- Idempotent: re-running on an environment that already has the
-- constraint is a no-op.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_users_managed_by_person_id_fkey'
  ) THEN
    ALTER TABLE platform.platform_users
      ADD CONSTRAINT platform_users_managed_by_person_id_fkey
      FOREIGN KEY (managed_by_person_id)
      REFERENCES platform.iam_person(id)
      ON DELETE RESTRICT;
  END IF;
END $$;
