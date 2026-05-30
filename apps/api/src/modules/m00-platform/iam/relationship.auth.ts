import type { ResolvedActor } from './actor-context.service';

/**
 * Family-structure edit authorisation (Family Structure on Profiles spec,
 * Step 1). A single predicate used by every mutation endpoint and mirrored
 * to the UI as a `canEdit` flag (rendering hint only — the server still
 * enforces it).
 *
 * Edit is parent/guardian-only:
 *   - The caller's account must be a GUARDIAN (iam_person.person_type).
 *     Students (even adult / editing self), staff, and school admins are
 *     never editors here — an admin's only mutation is the separate
 *     verify action.
 *   - AND the caller is either the profile owner (a parent editing their
 *     own structure — spouse/children) or an active guardian of the
 *     profile person.
 *
 * "Active guardian of" is the union of the household link (a parent who
 * manages the child's account) and a current parent/guardian relationship
 * in the graph (LEGAL_GUARDIAN / BIOLOGICAL_* / ADOPTIVE_* / STEP_* with
 * end_date IS NULL) — see RelationshipService.isActiveGuardianOf. The
 * household path is what lets a parent record the child's FIRST
 * relationship before any graph edge exists.
 *
 * The guardian lookup is async + DB-backed, so it's injected rather than
 * imported — keeps this predicate pure and unit-testable.
 */

/** iam_person.person_type value that denotes a parent/guardian account. */
const GUARDIAN_PERSON_TYPE = 'GUARDIAN';

export function isParentGuardianAccount(actor: ResolvedActor): boolean {
  return actor.personType === GUARDIAN_PERSON_TYPE;
}

export async function canEditFamilyStructure(
  actor: ResolvedActor,
  profilePersonId: string,
  isActiveGuardianOf: (callerPersonId: string, targetPersonId: string) => Promise<boolean>,
): Promise<boolean> {
  if (!isParentGuardianAccount(actor)) return false;
  if (actor.personId === profilePersonId) return true;
  return isActiveGuardianOf(actor.personId, profilePersonId);
}
