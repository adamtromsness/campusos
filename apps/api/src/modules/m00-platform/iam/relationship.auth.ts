/**
 * Family-structure edit authorisation (Family Structure on Profiles spec,
 * Step 1). A single predicate used by every mutation endpoint and mirrored
 * to the UI as a `canEdit` flag (rendering hint only — the server still
 * enforces it).
 *
 * Edit is parent/guardian-only, keyed off the caller's DERIVED personas
 * (the persona model, not iam_person.person_type — a self-registered
 * parent's person_type need not be GUARDIAN). A user may hold several
 * personas at once (e.g. Parent + Substitute); they're edit-eligible if
 * ANY persona is a parent/guardian-type persona. PARENT is the only such
 * persona the model defines — STUDENT / STAFF / SUBSTITUTE / ALUMNI /
 * COMMUNITY are not. So a Substitute (or Student, or School Admin) on its
 * own never grants edit; an admin's only mutation is the separate verify.
 *
 * AND the caller must be either the profile owner or an active guardian
 * of the profile person (RelationshipService.isActiveGuardianOf —
 * household link ∪ a current parent/guardian relationship in the graph).
 *
 * The guardian lookup is async + DB-backed, so it's injected rather than
 * imported — keeps this predicate pure and unit-testable.
 */

/** Persona types whose holder may edit family structure. */
export const EDIT_ELIGIBLE_PERSONAS = new Set<string>(['PARENT']);

export interface EditAuthSubject {
  personId: string;
  // The caller's active persona types (platform_personas.type), e.g.
  // ['PARENT', 'SUBSTITUTE'].
  personaTypes: string[];
}

export function isEditEligibleAccount(personaTypes: string[]): boolean {
  return personaTypes.some((p) => EDIT_ELIGIBLE_PERSONAS.has(p));
}

export async function canEditFamilyStructure(
  caller: EditAuthSubject,
  profilePersonId: string,
  isActiveGuardianOf: (callerPersonId: string, targetPersonId: string) => Promise<boolean>,
): Promise<boolean> {
  if (!isEditEligibleAccount(caller.personaTypes)) return false;
  if (caller.personId === profilePersonId) return true;
  return isActiveGuardianOf(caller.personId, profilePersonId);
}
