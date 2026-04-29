# Cycle 6.1 Architecture Review — ChatGPT (Adversarial)

**Reviewer:** ChatGPT
**Scope:** Full Cycle 6.1 (Profile & Household — `iam_person` + `platform_families` + `platform_family_members` extensions in Step 1, `sis_student_demographics` + `sis_guardians` employment in Step 2, `usr-001` permission in Step 3, seed in Step 4, ProfileModule in Step 5, HouseholdsModule in Step 6, Profile UI + avatar dropdown in Step 7, vertical-slice CAT in Step 8). The reviewer's brief is `REVIEW-CYCLE6.1-HANDOFF-CHATGPT.md`.
**Round 1 SHA under review:** `e72525e` (Cycle 6.1 COMPLETE through Step 8 + review prep)
**Round 1 verdict:** **REJECT** — pending 3 BLOCKING + 4 DEVIATION fixes
**Round 2 SHA under review:** _(will be set when the fix commit lands)_
**Final verdict:** _(TBD — Round 2 verification pending)_

**Verdict trail:**

| Round | Date           | SHA                | Verdict                                                 |
| ----: | -------------- | ------------------ | ------------------------------------------------------- |
|     1 | April 29, 2026 | `e72525e`          | **REJECT** pending 3 BLOCKING + 4 DEVIATION (see below) |
|     2 | April 29, 2026 | _(fix commit SHA)_ | _(TBD — Round 2 verification)_                          |

---

## Round 1 — Result: 3 BLOCKING · 4 DEVIATION · 8 PASS

The reviewer's verdict at `e72525e`: "**Reject pending fixes.** The implementation is close, but I would not approve it yet. The main issue is that Cycle 6.1 introduced **platform-schema profile/household admin reads and writes** without enough tenant-scoped row authorization."

The reviewer flagged 3 BLOCKING violations + 4 MAJOR/MINOR deviations + 8 strong passes. Ground-truthing each finding against `e72525e` (every finding accepted as VALID — the review caught real bugs):

### Triage table

|   # | Reviewer's claim                                                                                                                                                                                                                                                                                                                                                                  | Triage (Claude)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Admin profile endpoints can read/update any `iam_person` by UUID — `GET /profile/:personId` and `PATCH /profile/:personId` require `usr-001:admin` but never validate that the target person is in the caller's tenant. A school admin who guesses or obtains another tenant's person UUID could read/edit canonical identity.                                                    | **VALID — BLOCKING.** `apps/api/src/profile/profile.controller.ts:38-52` calls `profile.getProfile(personId)` and `profile.updateAdminProfile(personId, dto)` directly with no tenant-membership check. The service-layer `loadIamPerson` at `apps/api/src/profile/profile.service.ts:235` reads `platform.iam_person WHERE p.id = $1` unconditionally. With school-admin `usr-001:admin` granted by the IAM scope chain, the gate passes for any school admin acting against any iam_person. |
|   2 | Admin household override can read/update platform households across tenants — `HouseholdsService.hasAdmin()` accepts `actor.isSchoolAdmin` or `usr-001:admin` but `platform_families` is platform-scoped and the queries don't validate tenant affiliation. School admin from school A could mutate school B's household by guessing the UUID.                                    | **VALID — BLOCKING.** `apps/api/src/households/households.service.ts:407-411` (Round 1) returned true on permission alone. `platform_families` is intentionally cross-school for sibling detection (see `PlatformFamily` model comment at `packages/database/prisma/platform/schema.prisma:247`), so admin authority must be tenant-scoped on top.                                                                                                                                            |
|   3 | STAFF emergency contact upsert has a primary-contact race — service demotes existing primary then selects/updates or inserts. No lock on the employee row. Two concurrent PATCHes for a staff user with no emergency contact can both pass the existence check; one INSERT succeeds and the other hits the partial UNIQUE INDEX raw error. For an existing row, last writer wins. | **VALID — BLOCKING.** `apps/api/src/profile/profile.service.ts:488-491` reads `hr_employees` without `FOR UPDATE`. The schema's partial UNIQUE INDEX `(employee_id) WHERE is_primary = true` is the schema-side fallback but the raw 23505 leaks past the service.                                                                                                                                                                                                                            |
|   4 | `previousNames` allows empty strings — DTO validates array/string/max size but not non-empty/trimmed. `previousNames: ['']` persists junk.                                                                                                                                                                                                                                        | **VALID — MAJOR.** `apps/api/src/profile/dto/profile.dto.ts:106-111` (Round 1) had `@IsString({ each: true })` only. Empty strings pass `@IsString`.                                                                                                                                                                                                                                                                                                                                          |
|   5 | Legacy `MemberRole` values can render as `undefined` — DB enum keeps PARENT/GUARDIAN/STUDENT for cross-school sibling-detection back-compat, but the frontend `HOUSEHOLD_ROLE_LABELS` map covers only the 7 new values.                                                                                                                                                           | **VALID — MAJOR.** `apps/web/src/lib/profile-format.ts:21-29` (Round 1) was `Record<HouseholdRole, string>` with the 7 active values only. The 3 legacy values (PARENT, GUARDIAN, STUDENT — SIBLING + OTHER overlap) would render `undefined`.                                                                                                                                                                                                                                                |
|   6 | Profile update intentionally split across platform + tenant transactions — handoff accepts partial saves. Acceptable for Cycle 6.1 but UI should not show generic "saved" success unless the final re-read confirms all sections persisted.                                                                                                                                       | **VALID — MAJOR.** `apps/api/src/profile/profile.service.ts:209-233` (Round 1) ran `iamPerson.update` on the platform PrismaClient, then opened a separate `executeInTenantTransaction`. If the iam_person commit succeeded and the tenant tx threw, the user saw an error toast while half the data had committed. The handoff documented this as acceptable; the reviewer flagged it as fixable.                                                                                            |
|   7 | Add-member UNIQUE conflict translation may be brittle — service catches `code === 'P2010'` or `/unique constraint/i` regex. Raw Prisma errors for `$executeRawUnsafe` can vary across driver versions. Better to also check Postgres SQLSTATE `23505` from Prisma metadata.                                                                                                       | **VALID — MINOR.** `apps/api/src/households/households.service.ts:221` (Round 1) checked only `code === 'P2010'` and a regex on the message. A SQLSTATE-aware check (`err.meta?.code === '23505'`) is more reliable.                                                                                                                                                                                                                                                                          |

### Strong passes (Round 1)

These are unchanged at `e72525e`:

- Cycle 6.1 reuses `platform_families` instead of creating a competing household table (HANDOFF-CYCLE6.1.md front-matter pre-flight decision #1).
- Tenant migration `022_sis_student_demographics_and_guardian_employment.sql` introduces 0 cross-schema FKs.
- `sis_student_demographics → sis_students` is intra-tenant FK with CASCADE — correct.
- Household state changes lock `platform_families` with `SELECT ... FOR UPDATE` before mutation.
- Primary-contact promotion explicitly clears the old primary inside the same transaction (atomic primary-contact swap).
- `usr-001` permission code added to the catalogue and granted to the expected roles (Step 3).
- Profile/Household modules registered in `AppModule` between AnnouncementsModule and KafkaModule.
- Household member changes emit `iam.household.member_changed` through `KafkaProducerService.emit` with the ADR-057 envelope (verified live in CAT S9).

---

## Round 2 — Fixes applied

The fix commit lands all 7 findings (3 BLOCKING + 4 DEVIATION), plus a related 404-leak tightening on the household admin path that surfaced during the BLOCKING-2 verification.

### Fix BLOCKING 1 — Tenant-scope admin profile reads/writes

**Mechanism:** Added `assertTargetInCurrentTenant(personId)` at `apps/api/src/profile/profile.service.ts:180-194`. Both admin endpoints now call it before reading/writing iam_person:

```ts
private async assertTargetInCurrentTenant(personId: string): Promise<void> {
  const rows = await this.tenant.executeInTenantContext(async (tx) => {
    return tx.$queryRawUnsafe<{ found: number }[]>(
      'SELECT 1 AS found WHERE ' +
        'EXISTS (SELECT 1 FROM sis_students s ' +
        '        JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        '        WHERE ps.person_id = $1::uuid) ' +
        'OR EXISTS (SELECT 1 FROM sis_guardians WHERE person_id = $1::uuid) ' +
        'OR EXISTS (SELECT 1 FROM hr_employees WHERE person_id = $1::uuid) LIMIT 1',
      personId,
    );
  });
  if (rows.length === 0) {
    throw new NotFoundException('Person not found');
  }
}
```

The target person must have at least one of: `sis_students`, `sis_guardians`, `hr_employees` row in the current tenant. If none, 404 (not 403) to avoid leaking the existence of platform-side `iam_person` rows. New endpoint method `getAdminProfile(personId)` calls the assert before delegating to `getProfile`; `updateAdminProfile` calls the assert before `applyUpdate`. Controller updated to route `GET /profile/:personId` through `getAdminProfile`.

**Live verification:**

| Test                                                         | Expected | Got   |
| ------------------------------------------------------------ | -------- | ----- |
| Sarah school admin GETs Maya (in tenant — sis_students row)  | 200      | 200 ✓ |
| Sarah GETs admin@ (Platform Admin — no tenant projection)    | 404      | 404 ✓ |
| Sarah PATCHes admin@ — admin@'s profile must be unhijackable | 404      | 404 ✓ |

### Fix BLOCKING 2 — Tenant-scope admin household override

**Mechanism:** `HouseholdsService.hasAdmin(actor, familyId)` at `apps/api/src/households/households.service.ts:438-471` now requires BOTH the IAM permission AND household-tenant affiliation. New `householdAffiliatedWithCurrentTenant(familyId)` helper:

```ts
private async householdAffiliatedWithCurrentTenant(familyId: string): Promise<boolean> {
  const rows = await this.tenant.executeInTenantContext(async (tx) => {
    return tx.$queryRawUnsafe<{ found: number }[]>(
      'SELECT 1 AS found WHERE EXISTS (' +
        '  SELECT 1 FROM platform.platform_family_members fm ' +
        '  WHERE fm.family_id = $1::uuid AND (' +
        '    EXISTS (SELECT 1 FROM sis_students s ' +
        '            JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        '            WHERE ps.person_id = fm.person_id) ' +
        '    OR EXISTS (SELECT 1 FROM sis_guardians WHERE person_id = fm.person_id) ' +
        '    OR EXISTS (SELECT 1 FROM hr_employees WHERE person_id = fm.person_id)' +
        '  )' +
        ') LIMIT 1',
      familyId,
    );
  });
  return rows.length > 0;
}
```

Households are "affiliated with the current tenant" iff at least one member has a `sis_students` / `sis_guardians` / `hr_employees` row in the calling tenant. All four `hasAdmin` call sites (`getHouseholdById`, `removeMember`, `assertCanEditHousehold`, `canEdit`) updated to pass `familyId`.

**Companion 404-leak tightening:** `assertCanEditHousehold` now distinguishes "not a member of this household at all" from "member but wrong role". Non-member-non-admin returns 404 (not 403) — matches the BLOCKING-2 intent of not leaking household existence to outsiders. The existing 403 is preserved when a real member tries to edit without HEAD/SPOUSE role (cleaner UX since they know it's their household).

**Live verification:**

| Test                                                                    | Expected | Got                                        |
| ----------------------------------------------------------------------- | -------- | ------------------------------------------ |
| Sarah PATCHes Chen Family (members have tenant projection)              | 200      | 200 ✓                                      |
| Sarah GETs phantom family (admin@ as only member, no tenant projection) | 404      | 404 ✓                                      |
| Sarah PATCHes phantom family                                            | 404      | 404 ✓ (was 403 before the leak-tightening) |
| Sarah POSTs new member into phantom family                              | 404      | 404 ✓                                      |

### Fix BLOCKING 3 — STAFF emergency contact concurrency

**Mechanism:** Both `upsertEmergencyContact` paths (STAFF + STUDENT) now lock the parent row with `FOR UPDATE` before any reads/writes. STAFF: `SELECT id FROM hr_employees WHERE person_id = $1 LIMIT 1 FOR UPDATE`. STUDENT: `SELECT … FROM sis_students s JOIN platform_students ps … LIMIT 1 FOR UPDATE OF s`.

If the partial UNIQUE INDEX `(employee_id) WHERE is_primary = true` somehow fires anyway (race window we missed), a new try/catch translates the 23505 into a friendly 409 ConflictException via the `isUniqueViolation()` helper that checks `err.code === 'P2010'`, `err.meta?.code === '23505'`, or the message regex.

**Live verification (5 parallel PATCHes for the same staff user, each setting `isPrimary=true`):**

| Test                                                    | Expected                              | Got                                            |
| ------------------------------------------------------- | ------------------------------------- | ---------------------------------------------- |
| 5 parallel PATCH /profile/me with new emergencyContact  | All 200, or 200 + some 409, never 500 | 5 × 200 ✓ (FOR UPDATE serialised them)         |
| Final DB state: hr_emergency_contacts row count for Jim | exactly 1                             | 1 ✓                                            |
| Final DB state: is_primary=true                         | exactly 1 row                         | 1 ✓ (last writer wins; no orphan primary rows) |

### Fix MAJOR 4 — `previousNames` empty-string rejected

**Mechanism:** `apps/api/src/profile/dto/profile.dto.ts` adds `@MinLength(1, { each: true })` and `@MaxLength(100, { each: true })` to the `previousNames` field on `UpdateMyProfileDto`.

**Live verification:**

| Test                                | Expected                                                                            | Got   |
| ----------------------------------- | ----------------------------------------------------------------------------------- | ----- |
| PATCH `previousNames: ['']`         | 400 with `each value in previousNames must be longer than or equal to 1 characters` | 400 ✓ |
| PATCH `previousNames: ['Old Name']` | 200                                                                                 | 200 ✓ |

### Fix MAJOR 5 — Legacy MemberRole labels covered

**Mechanism:** Added `LegacyHouseholdRole` + `AnyHouseholdRole` types in `apps/web/src/lib/types.ts` covering PARENT / GUARDIAN / STUDENT. `HOUSEHOLD_ROLE_LABELS` in `apps/web/src/lib/profile-format.ts` now keyed on `AnyHouseholdRole` and includes "(legacy)" suffix on the 3 deprecated values so they render visibly when leaked. The `HOUSEHOLD_ROLES` array (used as the dropdown source) stays at the 7 active values — no UI surface offers legacy values for new selection.

### Fix MAJOR 6 — Atomic profile update across schemas

**Mechanism:** `applyUpdate` at `apps/api/src/profile/profile.service.ts:199-247` now wraps BOTH the iam_person update AND the tenant writes (demographics + guardian employment + emergency contact) inside a single `executeInTenantTransaction` callback:

```ts
await this.tenant.executeInTenantTransaction(async (tx) => {
  if (Object.keys(personPatch).length > 0) {
    personPatch.profileUpdatedAt = new Date();
    await tx.iamPerson.update({ where: { id: personId }, data: personPatch });
  }
  if (personRow.person_type === 'STUDENT') await this.upsertDemographics(tx, ...);
  if (personRow.person_type === 'GUARDIAN') await this.upsertGuardianEmployment(tx, ...);
  if (dto.emergencyContact) await this.upsertEmergencyContact(tx, ...);
});
```

`executeInTenantTransaction` opens a Prisma `$transaction` on the platform PrismaClient and runs `SET LOCAL search_path TO tenant_X, platform, public` inside it. The same connection writes both `platform.iam_person` and `tenant_X.sis_*` atomically. A failure in any section rolls back the entire profile update. The "Saved!" toast is now trustworthy.

**Static verification:**

| Check                                                      | Expected | Got |
| ---------------------------------------------------------- | -------- | --- |
| `this.platform.iamPerson.update` call sites in applyUpdate | 0        | 0 ✓ |
| `tx.iamPerson.update` call sites (inside tenant tx)        | 1        | 1 ✓ |

### Fix MINOR 7 — Robust UNIQUE conflict translation

**Mechanism:** Added `isUniqueViolation(err)` helper in both `profile.service.ts` and `households.service.ts`. Checks `err.code === 'P2010'` OR `err.meta?.code === '23505'` OR `/unique constraint/i.test(message)`. The 23505 SQLSTATE check is the most reliable — it works regardless of Prisma driver version. `households.service.ts::addMember` catch updated to use the helper. The new BLOCKING-3 try/catch in `profile.service.ts::upsertEmergencyContact` also uses it.

---

## Strong passes (preserved at the fix commit)

All 8 strong passes from Round 1 remain intact:

- ✅ Reuses `platform_families` instead of creating a competing household table.
- ✅ 0 cross-schema FKs.
- ✅ `sis_student_demographics → sis_students` intra-tenant FK with CASCADE.
- ✅ Household state changes lock `platform_families` with `FOR UPDATE`.
- ✅ Primary-contact promotion explicitly clears the old primary inside the same tx.
- ✅ `usr-001` permission code in catalogue + granted to expected roles.
- ✅ Profile/Households modules registered in `AppModule`.
- ✅ Household member changes emit `iam.household.member_changed` through ADR-057 envelope path.

Plus three **new** strong passes from the fix commit:

- ✅ Admin profile endpoints tenant-scoped via `assertTargetInCurrentTenant`.
- ✅ Admin household override tenant-scoped via `householdAffiliatedWithCurrentTenant`.
- ✅ Profile updates atomic across platform + tenant schemas in a single tx.

---

## Round 2 verdict

_(To be filled in by the reviewer after re-running the diff against the fix commit. Implementer's expectation: Round 2 returns **APPROVED** since all 3 BLOCKING and all 4 DEVIATION findings are fixed with live verification. The git tag `cycle6.1-approved` lands on the fix commit at that point.)_

---

## Notes for downstream cycles

After Cycle 6.1 ships APPROVED:

- Tag `cycle6.1-complete` on the Step 8 CAT commit (`e72525e`, already pushed).
- Tag `cycle6.1-approved` on the fix commit.
- Update `CLAUDE.md` Project Status entry to "**APPROVED at <fix SHA>**".
- The `householdAffiliatedWithCurrentTenant` and `assertTargetInCurrentTenant` helpers establish the pattern for any future admin endpoint that operates on platform-scoped data — bookmark them as the canonical tenant-scope guard for cross-schema admin paths.
- Future Cycle 7 (Helpdesk) does not depend on Cycle 6.1 outputs; the Cycle 7 work can start immediately after Cycle 6.1 is APPROVED.
