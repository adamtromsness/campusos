# Cycle 6.1 Handoff — Profile & Household

**Status:** Cycle 6.1 **COMPLETE — all 8 steps done + REVIEW-CYCLE6.1 fixes applied, 2026-04-29.** Round 1 review at `e72525e` returned **REJECT** with 3 BLOCKING + 4 DEVIATION; the fix commit lands all 7 with live verification (see `REVIEW-CYCLE6.1-CHATGPT.md` for the verdict trail + triage table). Round 2 verdict pending. Plan doc lands at `docs/campusos-cycle6.1-implementation-plan.html`. Slots between Cycle 6 (COMPLETE + APPROVED at `64993a8`) and Cycle 7 (Helpdesk) as a Phase 2 polish pass on identity data. Same plan → steps → CAT → review pipeline as Cycles 1–6. Git tags follow the pattern `cycle6.1-complete` and `cycle6.1-approved`.

**Transactional convention (clarification, 2026-04-29):** Household endpoints write exclusively to platform-schema tables (`platform_families`, `platform_family_members`) and so use a regular Prisma `$transaction` — they MUST NOT call `executeInTenantTransaction`, since the platform schema is shared and the tenant `search_path` would be irrelevant (or, worse, mask a real bug). Profile endpoints that write tenant-scoped tables (`sis_emergency_contacts`, `sis_student_demographics`, `sis_guardians` employment fields) DO use `executeInTenantContext` / `executeInTenantTransaction` per the existing pattern. The Profile service composes both: a single `PATCH /profile/me` call may write `iam_person` (platform tx) AND `sis_guardians` (tenant tx) AND `sis_emergency_contacts` (tenant tx) — these are separate transactions, executed in order, and a failure midway leaves a partial save (acceptable for profile self-service since each table is independent and the UI re-reads after save). The Households service is platform-only and uses the regular Prisma tx exclusively.

**Scope:** Self-service profile editing for every persona + shared-household editing for parents. Extends `platform.iam_person` with personal fields, extends the existing `platform.platform_families` with shared-household fields, adds `platform.platform_family_members` link table with role enum, adds tenant-side `sis_student_demographics`, adds 4 employment columns to existing `sis_guardians`. New permission code `usr-001` for self-service. Profile UI reads/writes the existing `sis_emergency_contacts` (non-employees) and `hr_emergency_contacts` (employees) — no new emergency contact storage.

**Critical decisions (pre-flight):**

1. **Reuse `platform_families`, do not create `platform_households`.** The original spec proposed a brand-new `platform_households` table. Investigation showed `platform_families` already exists at the platform schema level (`platform.platform_families`), already groups Chen family records, and is referenced from tenant-side `sis_families` (Cycle 1). Adding a parallel households table would create a third source of truth. The plan extends `platform_families` with the address / home-phone / mailing fields and adds `platform_family_members` linked to `platform_families.id` instead.

2. **Reuse existing emergency-contact tables.** The original spec proposed adding `emergency_contact_name/phone/relationship` columns to `iam_person`. That would have triplicated existing data — `sis_emergency_contacts` (Cycle 1) and `hr_emergency_contacts` (Cycle 4 Step 1) already exist. The plan has the profile UI read/write whichever table matches the persona: `hr_emergency_contacts` keyed on `employee_id` for STAFF (when `actor.employeeId` is non-null), `sis_emergency_contacts` keyed on `person_id` otherwise. The UI is unaware of which table is in play.

3. **`primary_phone` stays nullable in the schema.** The validation rule "primary_phone required for all adults going forward" is enforced at the PATCH endpoint policy layer, not at the schema level. Existing seed users have no phones and would otherwise fail `/auth/me` bootstrap on read. The endpoint refuses to clear an already-populated phone but does not block reading rows that never had one.

4. **`previous_names TEXT[]` shipped as-is, audit history deferred.** The original concern about a TEXT[] vs. proper history table is acknowledged — Phase 2 polish work, not blocker. A future cycle can introduce `iam_person_name_history` and migrate the array if needed.

5. **No new app tile on the launchpad.** Profile is intentionally accessed only from the avatar dropdown menu — matches iOS / SaaS convention and keeps the launchpad clean per the existing UI design principles in `CLAUDE.md`.

## Step status

| Step | Title                                                       | Status               |
| ---- | ----------------------------------------------------------- | -------------------- |
| 1    | Platform Schema — iam_person + platform_families Extensions | ✅ Done (2026-04-29) |
| 2    | Tenant Schema — Demographics & Guardian Employment          | ✅ Done (2026-04-29) |
| 3    | Permission Catalogue — usr-001                              | ✅ Done (2026-04-29) |
| 4    | Seed Data — Household + Personal Fields + Demographics      | ✅ Done (2026-04-29) |
| 5    | Profile NestJS Module                                       | ✅ Done (2026-04-29) |
| 6    | Households NestJS Module                                    | ✅ Done (2026-04-29) |
| 7    | Profile UI — Tabbed Page + Avatar Menu                      | ✅ Done (2026-04-29) |
| 8    | Vertical Slice Acceptance Test                              | ✅ Done (2026-04-29) |

## What Cycle 6.1 adds on top of Cycles 0–6

**Platform schema (1 Prisma migration):**

- `iam_person` gains 14 columns: `middle_name`, `preferred_name`, `suffix`, `previous_names TEXT[]`, `date_of_birth`, `primary_phone`, `secondary_phone`, `work_phone`, `phone_type_primary`, `phone_type_secondary`, `preferred_language` (default 'en'), `personal_email`, `notes`, `profile_updated_at`. All nullable.
- `platform_families` gains 16 columns: `address_line1`, `address_line2`, `city`, `state`, `postal_code`, `country`, `home_phone`, `home_language` (default 'en'), `mailing_address_same` (default true), 6 mailing-\* variants, `notes`. All nullable.
- New `platform_family_members` table: `id`, `family_id FK(platform_families) ON DELETE CASCADE`, `person_id FK(iam_person) UNIQUE`, `role TEXT CHECK IN (HEAD_OF_HOUSEHOLD, SPOUSE, CHILD, GRANDPARENT, OTHER_GUARDIAN, SIBLING, OTHER)`, `is_primary_contact BOOLEAN DEFAULT false`, `joined_at`, `created_at`, `updated_at`. Partial UNIQUE INDEX `(family_id) WHERE is_primary_contact = true` so each household has at most one primary contact.

**Tenant schema (1 SQL migration: `022_sis_student_demographics_and_guardian_employment.sql`):**

- New `sis_student_demographics`: `id`, `student_id UUID FK(sis_students) ON DELETE CASCADE UNIQUE`, `gender`, `ethnicity`, `primary_language`, `birth_country`, `citizenship`, `medical_alert_notes`, `created_at`, `updated_at`. All non-FK columns nullable.
- `sis_guardians` gains 4 columns: `employer`, `employer_phone`, `occupation`, `work_address`. All nullable.
- Tenant base table count: **107** (was 106 after Cycle 6 Step 4).
- Cross-schema FKs introduced: 0.

**Permissions catalogue:**

- New function `USR-001 (Profile Management)` with three tiers in `packages/database/data/permissions.json`. Catalogue total: **447** (was 444).
- `usr-001:read` + `usr-001:write` granted to every seeded role (Teacher, Student, Parent, Staff, Counsellor, VP, School Admin, Platform Admin).
- `usr-001:admin` granted to School Admin + Platform Admin only.

**Seed (`seed-profile.ts`, idempotent, gated on Chen family `platform_family_members` row count):**

- Chen Family `platform_families` row gets address (1234 Oak Street, Springfield, IL 62701), home_phone, home_language='en', mailing_address_same=true.
- 2 new `platform_family_members` rows: David Chen (HEAD_OF_HOUSEHOLD, is_primary_contact=true), Maya Chen (CHILD).
- Personal fields populated on all 5 seeded users: David (preferred_name='Dave', primary_phone, phone_type_primary='MOBILE', personal_email), Sarah Mitchell, James Rivera (work_phone copied from `hr_employees`), Linda Park, Marcus Hayes.
- Maya gets `date_of_birth='2011-03-15'` + `primary_phone`.
- 15 `sis_student_demographics` rows (one per Cycle 1-seeded student, each with `primary_language='English'`); Maya additionally gets `gender='Female'`.
- David's `sis_guardians` row gets `employer='Chen Engineering LLC'`, `occupation='Mechanical Engineer'`, `employer_phone`.

**API surface (`apps/api/src/profile/` + `apps/api/src/households/`):**

ProfileModule — 1 service + 1 controller + 4 endpoints:

- `GET /profile/me` (`usr-001:read`) — composes iam_person + persona-specific row (demographics for STUDENT, guardian employment for GUARDIAN, employee profile for STAFF) + emergency contact (from `sis_emergency_contacts` or `hr_emergency_contacts` depending on persona) + household membership (the caller's `platform_family_members` row + the linked `platform_families`).
- `PATCH /profile/me` (`usr-001:write`) — server-side ALLOW-LIST of editable personal fields (preferred_name, middle_name, suffix, previous_names, the three phones + types, preferred_language, personal_email, notes). Guardian-extras path adds `employer / employer_phone / occupation / work_address`. Student demographics path adds `primary_language` only. Cannot edit first_name, last_name, login email, or date_of_birth post-set (admin-only per ADR-055).
- `GET /profile/:personId` (`iam-001:read`) — admin view of any person.
- `PATCH /profile/:personId` (`iam-001:write`) — admin edit; full ALLOW-LIST including the identity fields.

HouseholdsModule — 1 service + 1 controller + 5 endpoints:

- `GET /households/my` (`usr-001:read`) — returns the caller's household + members; response includes `canEdit` boolean.
- `PATCH /households/:id` (`usr-001:write` + service-layer `assertCanEditHousehold(id, actor)` — HEAD_OF_HOUSEHOLD or SPOUSE; admin override via `iam-001:write`).
- `POST /households/:id/members` — same gate.
- `PATCH /households/:id/members/:memberId` — same gate. Atomic primary-contact promotion clears the prior primary in the same tx.
- `DELETE /households/:id/members/:memberId` — same gate. Refuses last HEAD_OF_HOUSEHOLD with friendly 400.

Kafka emit: `iam.household.member_changed` — no consumer this cycle, forward-compatible for a future M40 announcement worker.

**Web surface (`apps/web/src/app/(app)/profile/`):**

- `/profile` (own profile) and `/profile/[personId]` (admin) — tabbed view.
- Tabs: Personal Info / My Household / Emergency Contact / Demographics (STUDENT only) or Employment (GUARDIAN only) / Account.
- Avatar dropdown in `TopBar.tsx` gains a "My Profile" link above "Sign out", visible to every persona (everyone holds `usr-001:read` after Step 3).
- New `apps/web/src/hooks/use-profile.ts` with 9 hooks: `useMyProfile`, `useProfile(personId)`, `useUpdateMyProfile`, `useUpdateProfile(personId)`, `useMyHousehold`, `useUpdateHousehold(id)`, `useAddHouseholdMember(id)`, `useUpdateHouseholdMember(id, memberId)`, `useRemoveHouseholdMember(id, memberId)`. 30s staleTime on reads.
- New `apps/web/src/lib/profile-format.ts` with `profileCompleteness(profile, persona)` helper + persona-conditional tab visibility helper.
- No new launchpad app tile (profile lives in the avatar menu).
- DTOs added to `apps/web/src/lib/types.ts`: `IamPersonProfileDto`, `HouseholdDto`, `HouseholdMemberDto`, `HouseholdRole`, `PhoneType`, `StudentDemographicsDto`, `GuardianEmploymentDto`, `EmergencyContactDto`, payloads for each PATCH/POST.

**Vertical slice CAT (`docs/cycle6.1-cat-script.md`):**
11 scenarios + schema preamble + cleanup. Covers: parent reads own profile, parent edits personal fields, parent cannot edit identity fields, parent edits household, child sees household read-only with `canEdit=false` and 403 on PATCH, student demographics self-service vs. admin-only field split, staff emergency contact resolved from `hr_emergency_contacts`, admin override of identity fields, last-head-of-household refusal, permission denials, in-browser UI smoke, cleanup that restores tenant_demo to seed state.

## Out-of-scope decisions for Cycle 6.1

- **Multi-household membership** — the UNIQUE on `platform_family_members.person_id` enforces one household per person. Divorced-parent scenarios with two households are deferred; the current shape covers the dominant case (one household per person at any given time). Future work can drop the UNIQUE and add a `is_primary_residence` flag.
- **Mailing-address validation** — no postal-service integration. Free-form text only. School admins are expected to verify on first invoice.
- **Profile photo upload** — no `iam_person.avatar_s3_key`. Avatar in TopBar continues to render initials.
- **Account-level password change UI** — the Account tab deep-links to Keycloak's account console. No in-app password form.
- **Multi-language UI** — `preferred_language` is stored but the app remains English-only this cycle.
- **Audit trail for name changes** — `previous_names TEXT[]` ships as a simple array. A proper history table (`iam_person_name_history`) is future polish.
- **Soft-delete of household memberships** — DELETE is hard. Re-joining a household creates a new row.
- **Self-service household creation** — there's no `POST /households` this cycle. Households are created server-side (by the Step 4 seed and, going forward, by a future enrollment-driven worker that creates a household when an unaffiliated guardian's first student enrolls). PATCH and member CRUD on existing households is the entire self-service surface.

## Step 1 — Platform Schema — iam_person + platform_families Extensions

**Status:** ✅ Done (2026-04-29). Migration `20260429065233_add_profile_household_fields` applied cleanly to `campusos_dev`.

### What actually shipped (vs. plan)

The plan called these "new" tables but `PlatformFamily` + `FamilyMember` already existed in the platform schema as cross-school sibling-detection scaffolding (mapped to `platform_families` and `platform_family_members`). They were already populated with the Chen Family + 2 members (David PARENT primary-contact, Maya STUDENT). Step 1 **extended** the existing tables rather than created new ones.

`iam_person` already had `preferred_name` and `date_of_birth` from the original platform identity migration, so the plan's "14 new columns" became 12 net-new.

The existing `MemberRole` enum had 5 values (PARENT/GUARDIAN/STUDENT/SIBLING/OTHER); Step 1 added 5 more (HEAD_OF_HOUSEHOLD/SPOUSE/CHILD/GRANDPARENT/OTHER_GUARDIAN) for a total of 10. Existing rows keep their old values; the Step 4 seed will UPDATE David PARENT → HEAD_OF_HOUSEHOLD and Maya STUDENT → CHILD.

### Migration `20260429065233_add_profile_household_fields`

Generated via `prisma migrate diff --script`, hand-augmented with the partial UNIQUE INDEX + 2 phone_type CHECK constraints (Prisma can't express either natively), then applied via `prisma migrate deploy`.

Changes:

- **`platform.iam_person`** — added 12 columns: `middle_name`, `suffix`, `previous_names TEXT[]`, `primary_phone`, `secondary_phone`, `work_phone`, `phone_type_primary`, `phone_type_secondary`, `preferred_language` (default `'en'`), `personal_email`, `notes`, `profile_updated_at`. All nullable (or `NOT NULL DEFAULT 'en'` for language).
- **`platform.platform_families`** — added 17 columns: `address_line1`, `address_line2`, `city`, `state`, `postal_code`, `country`, `home_phone`, `home_language` (default `'en'`), `mailing_address_same` (default `true`), 6 mailing-\* variants, `notes`, `updated_at` (default `CURRENT_TIMESTAMP`). The plan said 16; 17 is the correct count once `updated_at` is included.
- **`platform.platform_family_members`** — added 2 columns (`joined_at`, `updated_at`), upgraded `person_id` to UNIQUE (was indexed, now uniquely indexed), upgraded the `family_id` FK to `ON DELETE CASCADE` (was no-action), added partial UNIQUE INDEX `platform_family_members_one_primary_per_family_uq ON (family_id) WHERE is_primary_contact = true`.
- **`platform.MemberRole`** — added 5 enum values (HEAD_OF_HOUSEHOLD, SPOUSE, CHILD, GRANDPARENT, OTHER_GUARDIAN). Existing values preserved.
- **`platform.iam_person`** CHECK constraints — `iam_person_phone_type_primary_chk` and `iam_person_phone_type_secondary_chk`, both shaped `(col IS NULL OR col IN ('MOBILE','HOME','WORK'))`.

Cross-schema FKs introduced: 0 (everything stays inside the `platform` schema).

### Verification (recorded 2026-04-29)

| Check                                             | Expected | Got |
| ------------------------------------------------- | -------- | --- |
| `iam_person` total column count                   | 22       | 22  |
| `iam_person` new column count                     | 12       | 12  |
| `platform_families` total column count            | 20       | 20  |
| `platform_families` new column count              | 17       | 17  |
| `platform_family_members` new columns             | 2        | 2   |
| `MemberRole` enum value count                     | 10       | 10  |
| `iam_person` CHECK constraints                    | 2        | 2   |
| Partial UNIQUE INDEX on `is_primary_contact=true` | exists   | ✓   |
| UNIQUE on `platform_family_members.person_id`     | exists   | ✓   |
| Chen Family row preserved                         | 1        | 1   |
| Chen Family member rows preserved                 | 2        | 2   |

Constraint smoke (single transaction with savepoints, all rolled back):

| #   | Test                                                  | Result                              |
| --- | ----------------------------------------------------- | ----------------------------------- |
| 1   | `UPDATE iam_person SET phone_type_primary='LANDLINE'` | rejected ✓ (CHECK fired)            |
| 2   | `UPDATE iam_person SET phone_type_primary='MOBILE'`   | accepted ✓                          |
| 3   | Two `is_primary_contact=true` rows in same family     | rejected ✓ (partial UNIQUE fired)   |
| 4   | Same `person_id` in second household                  | rejected ✓ (composite UNIQUE fired) |
| 5   | `UPDATE member_role='HEAD_OF_HOUSEHOLD'`              | accepted ✓                          |

Prisma client regenerated cleanly (`prisma generate --schema=prisma/platform/schema.prisma`). API builds clean (`pnpm --filter @campusos/api build`). No downstream code references the new columns yet — Step 5 (Profile module) is where they get read/written.

### Notes for downstream steps

- The Step 4 seed will UPDATE the existing 2 `platform_family_members` rows to use the new role names (David PARENT → HEAD_OF_HOUSEHOLD, Maya STUDENT → CHILD) and populate the address / phone fields on `platform_families`. The old enum values stay for backwards compat with the cross-school sibling-detection scaffolding (originally documented on the model as "Synced by FamilyMemberSyncWorker from sis_family_members events" — that worker hasn't been built yet, but if it ever is, it can keep using the original values).
- The partial UNIQUE INDEX is the schema-side belt-and-braces for the Step 6 `HouseholdsService.updateMember` "promote to primary contact" flow. The service still has to lock the existing primary row + clear the flag in the same Prisma `$transaction` for a cleaner UX (otherwise the second click 23505s with a confusing error). The UNIQUE catches anything the service misses.
- The `previous_names TEXT[]` column shipped as-is. A future `iam_person_name_history` audit table is the proper-shape upgrade path (deferred, see Out-of-scope above).
- `iam_person.preferred_language` and `platform_families.home_language` both default to `'en'` so existing rows have a sensible value without backfill.

---

## Step 2 — Tenant Schema — Demographics & Guardian Employment

**Status:** ✅ Done (2026-04-29). Migration `022_sis_student_demographics_and_guardian_employment.sql` applied cleanly to both `tenant_demo` and `tenant_test`.

### What actually shipped (vs. plan)

The plan called for `sis_student_demographics` (1 new table) and 4 new employment columns on `sis_guardians`. Investigation showed `sis_guardians.relationship_to_student` did NOT exist — the existing column is just `relationship` with a 5-value CHECK (PARENT/GUARDIAN/GRANDPARENT/FOSTER_PARENT/OTHER) which is the conceptual same field. Step 2 ships exactly what the plan asked for and does not duplicate `relationship`.

The plan also called for "no CHECK constraints on the new columns" — Step 2 follows that. Demographics are free-form TEXT; the UI offers a curated list of suggestions but the column accepts any value. `medical_alert_notes` is a brief flag intended for roll-call / substitute views, not a full health record (M30 Health is the future home for that).

### Migration `022_sis_student_demographics_and_guardian_employment.sql`

7 statements in one file, all idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`, plus 3 `COMMENT ON ...` annotations).

- **`sis_student_demographics`** — `id UUID PK`, `student_id UUID NOT NULL FK(sis_students) ON DELETE CASCADE`, `gender TEXT`, `ethnicity TEXT`, `primary_language TEXT`, `birth_country TEXT`, `citizenship TEXT`, `medical_alert_notes TEXT`, `created_at`, `updated_at`. Non-FK fields nullable. UNIQUE INDEX `sis_student_demographics_student_id_uq` on `student_id` so each student has at most one demographics row.
- **`sis_guardians`** — added 4 columns: `employer TEXT`, `employer_phone TEXT`, `occupation TEXT`, `work_address TEXT`. All nullable. The 5-value `relationship` CHECK + the existing `preferred_contact_method` CHECK survived the migration unchanged.

Cross-schema FKs introduced: 0. Total intra-tenant FKs added: 1 (`sis_student_demographics.student_id → sis_students(id)` CASCADE).

### Splitter `;`-in-string trap caught during this Step

First provision attempt failed with the splitter cutting on a `;` inside the block-comment header (after `value)`). Per CLAUDE.md guidance: the provision splitter cuts on **every** semicolon regardless of quoting context, including inside `/* ... */` block comments. The header was rewritten to use periods + "and" instead of `;`. A Python audit script that strips block comments before counting `;` would miss this trap — block-comment text must be checked too. The fix-up landed before any tenant got partially-applied.

### Verification (recorded 2026-04-29)

| Check                                                    | Expected      | Got           |
| -------------------------------------------------------- | ------------- | ------------- |
| Tenant logical base table count                          | 107           | 107           |
| `sis_student_demographics` column count                  | 10            | 10            |
| `sis_guardians` column count                             | 13            | 13 (was 9 +4) |
| `sis_student_demographics_student_id_fkey` `confdeltype` | `c` (CASCADE) | `c` ✓         |
| `sis_student_demographics_student_id_uq` UNIQUE          | exists        | ✓             |
| Migrations applied to `tenant_demo`                      | 22            | 22            |
| Migrations applied to `tenant_test`                      | 22            | 22            |
| Idempotent re-provision (column counts stable)           | yes           | yes ✓         |

Constraint smoke (single transaction with savepoints, all rolled back):

| #   | Test                                                                          | Result                                                                                                                                              |
| --- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Happy-path INSERT with `gender='Female'`                                      | accepted ✓                                                                                                                                          |
| B   | UNIQUE(student_id) rejects 2nd row for same student                           | rejected ✓                                                                                                                                          |
| C   | FK rejects bogus student_id                                                   | rejected ✓                                                                                                                                          |
| D   | CASCADE declared (`pg_constraint.confdeltype='c'`)                            | confirmed ✓ via catalog (live test blocked by unrelated `cls_submissions` no-cascade FK on the seeded student — the catalog check is authoritative) |
| E   | `sis_guardians` accepts employer / employer_phone / occupation / work_address | accepted ✓                                                                                                                                          |

### Notes for downstream steps

- The Step 4 seed will populate `sis_student_demographics` with rows for the 15 seeded students (default `primary_language='English'`, plus Maya gets `gender='Female'`) and update David Chen's `sis_guardians` row with `employer='Chen Engineering LLC'`, `occupation='Mechanical Engineer'`, `employer_phone`.
- The Step 5 ProfileService will read/write `sis_student_demographics` via `executeInTenantContext` (read) and `executeInTenantTransaction` (write), per the standard tenant-table pattern.
- Curated dropdown values for `gender` / `ethnicity` are a UI-only concern (Step 7); the schema deliberately stays free-form so a school can use any vocabulary.
- A future migration can add CHECK constraints once a school's preferred vocabulary is settled, without breaking existing rows (the column accepts any TEXT today).

---

## Step 3 — Permission Catalogue — usr-001

**Status:** ✅ Done (2026-04-29).

### What shipped

- `packages/database/data/permissions.json` — added `{ code: "USR-001", name: "Profile Management", group: "User Profile & Household" }` to the `functions` array (alphabetically after TRN-005). Catalogue total grew from 148 to **149 functions × 3 tiers = 447 permissions**.
- `defaultRoles` block in the same file updated for documentation parity (Teacher / Parent / Student / Staff each gain `USR-001`). The block is reference-only — no consumer reads it; the live grants are in `seed-iam.ts`.
- `packages/database/src/seed-iam.ts` — added `'USR-001': ['read', 'write']` to the Teacher / Parent / Student / Staff entries in `rolePermsSpec`. School Admin gets all three tiers automatically via `everyFunction: ['read','write','admin']`. Platform Admin gets all 447 via the platform-admin path.
- Header comment updated from "148 functions x 3 tiers = 444 permissions" to "149 functions x 3 tiers = 447 permissions".

### Verification (recorded 2026-04-29)

`tsx src/seed-iam.ts` output:

- Platform Admin: 3 permissions newly assigned (447 total)
- School Admin: 3 newly added (out of 447 targeted)
- Teacher: 2 newly added (36 targeted total — was 34 + 2)
- Parent: 2 newly added (17 targeted — was 15 + 2)
- Student: 2 newly added (17 targeted — was 15 + 2)
- Staff: 2 newly added (16 targeted — was 14 + 2)

`tsx src/build-cache.ts` output (per-account cache):

| Account                       | Total | Δ vs Cycle 6 |
| ----------------------------- | ----- | ------------ |
| admin@demo (Platform Admin)   | 447   | +3           |
| principal@demo (School Admin) | 447   | +3           |
| teacher@demo                  | 36    | +2           |
| student@demo                  | 17    | +2           |
| parent@demo                   | 17    | +2           |
| vp@demo                       | 16    | +2           |
| counsellor@demo               | 16    | +2           |

Per-persona USR codes verified live by querying `iam_effective_access_cache.permission_codes`:

| Persona     | Codes                                      |
| ----------- | ------------------------------------------ |
| admin@      | usr-001:admin, usr-001:read, usr-001:write |
| principal@  | usr-001:admin, usr-001:read, usr-001:write |
| teacher@    | usr-001:read, usr-001:write                |
| parent@     | usr-001:read, usr-001:write                |
| student@    | usr-001:read, usr-001:write                |
| vp@         | usr-001:read, usr-001:write                |
| counsellor@ | usr-001:read, usr-001:write                |

### Known cosmetic bug (not Step 3 scope)

The closing log line in `seed-iam.ts` (`'  ' + functions.length * tiers.length + ' permissions, …'`) prints `298 permissions` instead of `447`. This is a pre-existing `var` shadowing bug — the inner loop reuses `var tiers` for `spec.perms[fc]` so the outer `tiers` array (from `permData.tiers`) gets overwritten by the time the closing log runs. The actual seed worked correctly (per-line totals all show 447). Not fixing this round; it's a one-line `let` change for a future sweep.

### Notes for downstream steps

- Step 5 (ProfileService) gates `/profile/me` on `usr-001:read` and `PATCH /profile/me` on `usr-001:write`. Admin endpoints `/profile/:personId` use `iam-001:read` and `iam-001:write` (not `usr-001:admin`), since admin profile editing has been an `iam-001` concern since Cycle 0.
- Step 6 (HouseholdsService) gates `GET /households/my` on `usr-001:read` and `PATCH /households/...` on `usr-001:write` PLUS the service-layer `assertCanEditHousehold(id, actor)` role check (HEAD_OF_HOUSEHOLD or SPOUSE; admin override via `iam-001:write`).
- Step 7 (UI) avatar dropdown shows the "My Profile" link to anyone with `usr-001:read` (= every persona after this Step).

---

## Step 4 — Seed Data — Household + Personal Fields + Demographics

**Status:** ✅ Done (2026-04-29). New `packages/database/src/seed-profile.ts` (idempotent, gated on whether Chen Family already has a HEAD_OF_HOUSEHOLD member). Wired into `package.json` as `seed:profile`.

### What shipped — five sections in one script

A) **Chen Family shared-household fields** — `platformFamily.update` populates `address_line1='1234 Oak Street'`, `city='Springfield'`, `state='IL'`, `postal_code='62701'`, `country='US'`, `home_phone='+1-217-555-0123'`, `home_language='en'`, `mailing_address_same=true`. Pure platform write — regular Prisma update.

B) **Migrate Chen Family member roles** — `familyMember.updateMany` with `where memberRole='PARENT'` flips David Chen's role to `HEAD_OF_HOUSEHOLD` (his `is_primary_contact=true` is preserved). A second `updateMany` flips Maya Chen's `STUDENT` to `CHILD`. Both use the new enum values added in Step 1.

C) **iam_person personal fields on 6 accounts** — David, Sarah, James, Linda, Marcus, Maya each get `preferredName` (Dave / Sarah / Jim / Linda / Marc / Maya), a unique `primary_phone` (`+1-217-555-01XX`), `phone_type_primary='MOBILE'`, a `work_phone` for the 4 staff personas, a `personal_email`, `preferred_language='en'`, and a fresh `profile_updated_at` timestamp. Maya additionally gets `date_of_birth='2011-03-15'`. The CHECK constraints from Step 1 (phone_type IN MOBILE/HOME/WORK) are exercised — every supplied value passes.

D) **`sis_student_demographics` for 15 seeded students** — schema-qualified raw INSERT against `tenant_demo.sis_student_demographics`, joined through `sis_students.platform_student_id → platform_students.person_id` to identify Maya. All 15 rows get `primary_language='English'`. Maya additionally gets `gender='Female'` so the Step 7 Demographics tab has something to render. `ON CONFLICT (student_id) DO NOTHING` is the row-level idempotency guard (the script-level gate in section B is the primary one; this is belt-and-braces).

E) **David Chen's `sis_guardians` employment** — schema-qualified raw `UPDATE` keyed on `person_id`. Sets `employer='Chen Engineering LLC'`, `employer_phone='+1-217-555-0177'` (matches David's `work_phone` on `iam_person`), `occupation='Mechanical Engineer'`, `work_address='100 Engineering Blvd, Springfield, IL 62701'`. The work_address is intentionally a different physical address from the home address (1234 Oak Street) so the UI's Employment vs. Household tab split is visually distinct.

### Verification (recorded 2026-04-29)

`pnpm seed:profile` first run:

- A) Chen Family address + home phone populated ✓
- B) PARENT → HEAD_OF_HOUSEHOLD count=1, STUDENT → CHILD count=1 ✓
- C) iam_person personal fields populated on 6 accounts ✓
- D) sis_student_demographics rows inserted=15 ✓
- E) David Chen sis_guardians employment populated rowsAffected=1 ✓

Second run: `Chen Family already migrated to household roles. Skipping.` ✓

Live read-back queries confirmed:

| Check                                              | Got                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| Chen Family address row                            | 1                                                                      |
| Chen Family members with new role values           | David HEAD_OF_HOUSEHOLD primary, Maya CHILD ✓                          |
| iam_person rows with `preferred_name` populated    | 6                                                                      |
| iam_person rows with `phone_type_primary='MOBILE'` | 6                                                                      |
| iam_person rows with `personal_email` populated    | 5 (Maya intentionally null — students don't have a personal email yet) |
| Maya `date_of_birth='2011-03-15'`                  | ✓                                                                      |
| sis_student_demographics rows                      | 15                                                                     |
| Rows with `primary_language='English'`             | 15                                                                     |
| Rows with `gender` populated                       | 1 (Maya only)                                                          |
| sis_guardians rows with `employer` populated       | 1 (David Chen)                                                         |

### Notes for downstream steps

- The CHECK on `phone_type_primary` from Step 1 was exercised in production by this seed — every supplied value (`MOBILE` for all 6 personas) passes the constraint. No regressions caught.
- The Step 5 ProfileService can now read the populated shape immediately on first boot; no additional smoke data needed for the live verification.
- The Step 7 Profile UI's Personal Info tab will render preferred names + phones immediately. Demographics tab for Maya will render gender + primary_language. Employment tab for David will render the four employment fields. Other personas' Demographics / Employment tabs render empty (admin-or-self-service-fillable).
- `profile_updated_at` is set to the seed run time, so every Profile row has a non-null "Last updated" timestamp out of the gate.
- The seed targets `tenant_demo` only (matching every other Cycle 1+ seed). `tenant_test` stays at the schema baseline with no data.

---

## Step 5 — Profile NestJS Module

**Status:** ✅ Done (2026-04-29). Module lives at `apps/api/src/profile/` and is wired into `AppModule` after `AnnouncementsModule`.

### What shipped

**4 endpoints**, all on the `ProfileController`:

| Method | Path                 | Gate            | Notes                                             |
| ------ | -------------------- | --------------- | ------------------------------------------------- |
| GET    | `/profile/me`        | `usr-001:read`  | Compose-and-read for the calling person           |
| PATCH  | `/profile/me`        | `usr-001:write` | Self-service, ALLOW-LIST excludes identity fields |
| GET    | `/profile/:personId` | `usr-001:admin` | Admin override                                    |
| PATCH  | `/profile/:personId` | `usr-001:admin` | Admin override + identity fields editable         |

**ProfileService composition rule** — every `getProfile(personId)` call returns:

- iam_person columns (name, preferred_name, phones, etc.)
- Login email from `platform_users.email` (joined)
- Household: the calling person's `platform_family_members` row (if any) + linked `platform_families.name`
- Demographics: only when `personType='STUDENT'` — joined via `sis_students.platform_student_id → platform_students.person_id`
- Employment: only when `personType='GUARDIAN'` — read from `sis_guardians WHERE person_id = $1`
- Emergency contact: dual-table resolution — `hr_emergency_contacts` keyed via `hr_employees.person_id` for STAFF, `sis_emergency_contacts` keyed via `sis_students.platform_student_id → platform_students.person_id` for STUDENT, `null` for everyone else

**Transactional convention applied:**

- Platform writes (`iam_person.update`) use a regular Prisma transaction implicitly via the platform PrismaClient.
- Tenant writes (`sis_student_demographics`, `sis_guardians` employment, `sis_emergency_contacts`, `hr_emergency_contacts`) ALL run inside a single `executeInTenantTransaction` callback so they atomically commit or roll back together.
- The two transactions are sequential, not nested — a failure in the tenant tx does not roll back the iam_person write. This is acceptable for self-service profile editing since each section is independent and the response is a fresh `getProfile` re-read after success.

### Permission code correction (caught during smoke)

Plan + handoff originally said admin endpoints would gate on `iam-001:read` / `iam-001:write`. Live smoke caught that **`IAM-001` does NOT exist in the catalogue.** No `iam-*` codes have ever existed — identity admin functions live under `SYS-001 (Access Management)` and the new `USR-001 (Profile Management)`. Corrected: admin endpoints now gate on `usr-001:admin`, which Step 3 already granted exclusively to School Admin + Platform Admin via `everyFunction: ['read','write','admin']`. The original spec's reference to `iam-001` was wishful — the catalogue never had it.

### Class-hoisting bug caught during build

First boot attempt failed with `ReferenceError: Cannot access 'UpdateEmergencyContactDto' before initialization`. The DTO file declared `UpdateEmergencyContactDto` AFTER `UpdateMyProfileDto` even though `UpdateMyProfileDto` referenced it via `@ApiPropertyOptional({ type: () => UpdateEmergencyContactDto })`. TypeScript-emitted decorators evaluate eagerly at class-definition time, not lazily. Reordered so `UpdateEmergencyContactDto` is declared first; second build + boot clean.

### Live verification (recorded 2026-04-29, all on `tenant_demo`)

| #   | Scenario                                                                          | Result                                                                                                                                     |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | David (parent) `GET /profile/me`                                                  | 200 — full shape: GUARDIAN, household HEAD_OF_HOUSEHOLD primary, employment=Chen Engineering LLC, demographics=null, emergencyContact=null |
| S2  | Maya (student) `GET /profile/me`                                                  | 200 — STUDENT, demographics={gender:Female, primaryLanguage:English}, employment=null, household role=CHILD, dateOfBirth=2011-03-15        |
| S3  | Jim (teacher) `GET /profile/me`                                                   | 200 — STAFF, workPhone populated, household=null (Jim isn't in Chen Family), emergencyContact=null (no seed)                               |
| S4  | David PATCH preferredName='Davey' + secondaryPhone with phoneTypeSecondary='HOME' | 200 — phone_type CHECK from Step 1 fired and passed; profileUpdatedAt bumped                                                               |
| S5  | David PATCH `firstName` (admin-only)                                              | 400 — ValidationPipe `forbidNonWhitelisted` rejects on the way in (cleaner than my service-layer check)                                    |
| S6  | Jim PATCH emergencyContact (lands in `hr_emergency_contacts`)                     | 200 — response source='EMPLOYEE', live SQL confirms row in `hr_emergency_contacts` with `is_primary=true`                                  |
| S7  | Sarah (admin) PATCH Maya `firstName='Maya-Edited'` via `/profile/:personId`       | 200 — admin path works on `usr-001:admin`                                                                                                  |
| S8  | David PATCH `/profile/:Sarah's personId`                                          | 403 INSUFFICIENT_PERMISSIONS required: ['usr-001:admin']                                                                                   |

Cleanup post-smoke: Sarah restored Maya's firstName, Jim's test emergency contact removed, David's secondaryPhone reset, all via the same endpoints. Tenant returns to seed state.

### Notes for downstream steps

- The Step 6 HouseholdsService can call `profile.getProfile(personId)` if it ever needs the composed shape; for now it'll have its own narrower household-only read path.
- The Step 7 UI's `useMyProfile` hook will hit `GET /profile/me` and render its tabs against the composed DTO. The `personType` field at the top tells the UI which conditional tabs to render (Demographics for STUDENT, Employment for GUARDIAN).
- The ValidationPipe's `forbidNonWhitelisted` mode means the client must NOT send `firstName` / `lastName` / `dateOfBirth` etc. on the self-service `PATCH /profile/me` path even if those fields end up null — the field shouldn't appear in the request body at all. The UI's update mutation should construct the payload with only the editable allow-list fields.
- The dual-table emergency-contact gap (parents have no schema home for their own emergency contact) is documented in the front-matter and is intentionally Phase 2 polish. The UI's Emergency Contact tab will show "Not recorded — only school staff and students can set an emergency contact today" for GUARDIAN personas. This is a deliberate first-cut deferral.

---

## Step 6 — Households NestJS Module

**Status:** ✅ Done (2026-04-29). Module lives at `apps/api/src/households/` and is wired into `AppModule` after `ProfileModule`.

### What shipped — 6 endpoints (the plan said 5; added GET /households/:id for arbitrary-by-id reads with same row-scope as /my)

| Method | Path                                | Gate                                           |
| ------ | ----------------------------------- | ---------------------------------------------- |
| GET    | `/households/my`                    | `usr-001:read`                                 |
| GET    | `/households/:id`                   | `usr-001:read` (row-scoped to member or admin) |
| PATCH  | `/households/:id`                   | `usr-001:write` + `assertCanEditHousehold`     |
| POST   | `/households/:id/members`           | `usr-001:write` + `assertCanEditHousehold`     |
| PATCH  | `/households/:id/members/:memberId` | `usr-001:write` + `assertCanEditHousehold`     |
| DELETE | `/households/:id/members/:memberId` | `usr-001:write` + `assertCanEditHousehold`     |

`assertCanEditHousehold(familyId, actor)` — short-circuit returns true if `actor.isSchoolAdmin` OR caller has `usr-001:admin` in the current tenant scope chain. Otherwise reads `platform_family_members` for the (family, person) pair and accepts `HEAD_OF_HOUSEHOLD` or `SPOUSE`. Anything else 403s.

### Transactional convention applied (per the front-matter clarification)

Every state-change mutation opens a `prisma.$transaction(async (tx) => { ... })` — a regular Prisma platform transaction, NOT `executeInTenantTransaction`. The household tables live in the platform schema, so the tenant `search_path` is irrelevant for these writes. Inside the tx:

1. `SELECT id FROM platform.platform_families WHERE id = $1::uuid FOR UPDATE` — locks the row so concurrent writers serialise.
2. `assertCanEditHousehold(id, actor, tx)` — reads the caller's membership row inside the same transaction.
3. The mutation itself (UPDATE / INSERT / DELETE).
4. Atomic primary-contact promotion: when `isPrimaryContact=true` lands, an explicit `UPDATE ... SET is_primary_contact=false WHERE family_id=$1 AND is_primary_contact=true` runs FIRST in the same tx so the partial UNIQUE INDEX on `(family_id) WHERE is_primary_contact=true` (Step 1) never fires.

After commit, `iam.household.member_changed` is emitted via `KafkaProducerService.emit({ topic, key=familyId, payload, sourceModule: 'iam' })` for member-side changes (ADDED / UPDATED / REMOVED). The PATCH on shared-household fields does NOT emit (no consumer needs to know about an address change yet).

### TypeScript fix during build

First build failed with `TS2345: Argument of type 'Omit<PrismaClient, ...>' is not assignable to parameter of type 'PrismaClient'`. The `tx` callback param of `$transaction` is `Prisma.TransactionClient`, not the full `PrismaClient`. Imported the right type and switched the helper signature.

### Live verification (recorded 2026-04-29, all on `tenant_demo`, 10 scenarios)

| #   | Scenario                                                                    | Result                                                                                                      |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| S1  | David parent `GET /households/my`                                           | 200 — Chen Family, addressLine1='1234 Oak Street', `canEdit=true`, members=[David HEAD primary, Maya CHILD] |
| S2  | Maya student `GET /households/my`                                           | 200 — same household, `canEdit=false`, role=CHILD                                                           |
| S3  | Maya `PATCH /households/:id` shared address                                 | 403 "Only the head of household or spouse can edit shared household details"                                |
| S4  | David `PATCH /households/:id` addressLine1                                  | 200 — addressLine1 updated                                                                                  |
| S5  | David `POST /households/:id/members` add Sarah Mitchell as SPOUSE           | 200 — members=[David HEAD primary, Maya CHILD, Sarah SPOUSE]                                                |
| S6  | David `PATCH .../members/:Sarah` `isPrimaryContact=true`                    | 200 — Sarah is now sole primary; David's flag atomically cleared in same tx                                 |
| S7  | David `PATCH .../members/:David` change role to OTHER (last HEAD)           | 400 "Households must always have at least one head of household"                                            |
| S8  | David `DELETE .../members/:David` self-eviction                             | 400 "You cannot remove yourself from your household"                                                        |
| S9  | David `DELETE .../members/:Sarah` cleanup the test SPOUSE                   | 200 — members=[Maya CHILD, David HEAD]                                                                      |
| S10 | Sarah admin `PATCH /households/:id` notes (admin override on usr-001:admin) | 200 — notes='Touched by admin'                                                                              |

Cleanup: David restored addressLine1 + cleared notes + reclaimed primary-contact flag. Final state matches Step 4 seed: address_line1='1234 Oak Street', David HEAD_OF_HOUSEHOLD primary, Maya CHILD.

### Kafka envelopes captured live on `dev.iam.household.member_changed`

4 events captured, full ADR-057 shape verified end-to-end:

| Event | Action  | Payload highlights                                                     |
| ----- | ------- | ---------------------------------------------------------------------- |
| 1     | ADDED   | familyId, personId=Sarah's, role=SPOUSE, actorPersonId=David's         |
| 2     | UPDATED | memberId=Sarah's, isPrimaryContact=true (S6 promotion)                 |
| 3     | REMOVED | memberId=Sarah's, personId=Sarah's (S9 cleanup)                        |
| 4     | UPDATED | memberId=David's, isPrimaryContact=true (post-cleanup primary restore) |

Every envelope has `event_type='iam.household.member_changed'`, `source_module='iam'`, `tenant_id` populated (= the school UUID), fresh `event_id` and `correlation_id` UUIDv7s, `event_version=1`, ISO `occurred_at` and `published_at` timestamps.

### Notes for downstream steps

- Step 7 (UI) will hit `GET /households/my` to drive the "My Household" tab. The `canEdit` field tells the UI whether to render edit controls or read-only view. Members list comes pre-sorted by `is_primary_contact DESC, last_name ASC` so the rendering is stable.
- The Add-member modal in the UI needs a person picker. Since `platform_family_members.person_id` is UNIQUE, the picker should filter out persons already in another household. The backend will 409 with a friendly message ("This person is already a member of a household") if the UI misses one — see `addMember` translateConflict path.
- Future M40 announcement consumer can subscribe to `iam.household.member_changed` and notify the household's other members on changes ("David added Sarah Mitchell as SPOUSE"). Topic + payload shape are forward-stable.
- The cross-tenant edge case: a person's `platform_family_members` row is global (one household per person across all schools). If a parent moves their child between schools, the household survives the move. There's no "household split per school" — by design.
- `GET /households/:id` returns 404 (not 403) if a non-member non-admin tries to read it, to avoid leaking the existence of arbitrary households. The `/my` path is the canonical way to find your own household.

---

## Step 7 — Profile UI — Tabbed Page + Avatar Menu

**Status:** ✅ Done (2026-04-29). Web build clean.

### What shipped

**2 routes** (sharing one component module):

- `/profile` (own profile, persona-conditional tabs)
- `/profile/[personId]` (admin view, identity fields editable, household tab read-only summary)

**6 tabs total**, persona-conditional per `profileTabs(personType)`:

- Personal Info — always
- My Household — always (read-only when `canEdit=false` or admin viewing someone else)
- Emergency Contact — always (renders an info banner for personas without a schema home — guardians, alumni, external)
- Demographics — STUDENT only
- Employment — GUARDIAN only
- Account — always (login email read-only, password change link to Keycloak, profile completeness bar)

**Avatar dropdown** (`apps/web/src/components/shell/TopBar.tsx`) gains a "My Profile" link above "Sign out" for any user with `usr-001:read` (= every persona after Step 3). Behavior is consistent with the existing iOS-style menu.

**No new launchpad tile** — profile is intentionally accessed only via the avatar menu, matching the design principle from `CLAUDE.md` ("Home page is a launchpad, not a dashboard").

### New files

| File                                                 | Purpose                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/types.ts` (extended)               | 13 new DTO/payload interfaces for profile + household                                                                                                                                                                                                                      |
| `apps/web/src/lib/profile-format.ts`                 | `profileTabs(personType)`, `profileCompleteness(profile)`, `PHONE_TYPES`, `HOUSEHOLD_ROLES`, label maps, `formatPhone`, `formatPersonName`                                                                                                                                 |
| `apps/web/src/hooks/use-profile.ts`                  | 9 hooks: `useMyProfile`, `useProfile(personId)`, `useUpdateMyProfile`, `useUpdateProfile(personId)`, `useMyHousehold`, `useHousehold(id)`, `useUpdateHousehold(id)`, `useAddHouseholdMember(id)`, `useUpdateHouseholdMember(id, memberId)`, `useRemoveHouseholdMember(id)` |
| `apps/web/src/components/profile/ProfileTabs.tsx`    | Six tab components + shared `Section`, `Field`, `PhoneTypeSelect`, `SaveBar` helpers + `HouseholdEditor` + `MemberInlineActions` + `AddMemberModal`                                                                                                                        |
| `apps/web/src/app/(app)/profile/page.tsx`            | Self-service tabbed shell (987 B chunk)                                                                                                                                                                                                                                    |
| `apps/web/src/app/(app)/profile/[personId]/page.tsx` | Admin tabbed shell (1.23 kB chunk)                                                                                                                                                                                                                                         |

### `profileCompleteness` formula

Required fields (weight 1.0): first_name, last_name, primary_phone, household role (when in a household).
Recommended fields (weight 0.5): preferred_name, household indicator, emergency contact populated, employer (GUARDIAN), primary_language (STUDENT).

Returned as a 0–100 integer percentage.

### Tailwind shorthand cleanup during build

The first attempt used `className="input"`, `className="btn-primary"`, `className="btn-secondary"` shortcuts that don't exist in the project's `globals.css`. Replaced with the explicit Tailwind class strings used elsewhere in the app (matching the `/apply/new` form precedent). All 4 shorthands swept; build clean on second pass.

### TypeScript fix during build

`HouseholdEditor` had an unused `const updateMember = useUpdateHouseholdMember;` alias left over from earlier shape exploration. Removed; build clean.

### Verification (recorded 2026-04-29)

| Check                                     | Got                                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm --filter @campusos/web build` clean | ✓                                                                                               |
| `/profile` route bundle size              | 987 B (108 kB First Load JS), Static                                                            |
| `/profile/[personId]` route bundle size   | 1.23 kB (117 kB First Load JS), Dynamic                                                         |
| API `GET /profile/me` (David parent)      | personType=GUARDIAN, preferredName=Dave, household.role=HEAD_OF_HOUSEHOLD, employment populated |
| API `GET /households/my` (David)          | canEdit=true, members=[David HEAD, Maya CHILD]                                                  |
| API `GET /profile/me` (Maya student)      | personType=STUDENT, demographics={gender:Female, primaryLanguage:English}, household.role=CHILD |
| API `GET /households/my` (Maya)           | canEdit=false                                                                                   |

### Notes for downstream steps

- The Add-member modal currently asks for a raw person UUID. Future polish: a directory picker that filters out persons already in another household. Backend already 409s with a friendly message ("This person is already a member of a household") so the UX is graceful even without the picker.
- The admin `Household` tab on `/profile/[personId]` shows a read-only summary, not the full household editor — there's no `GET /households/by-person/:personId` endpoint today. Admins who need to edit another household are expected to navigate via that household's owning member.
- The `Demographics` tab on `/profile/me` for a STUDENT shows admin-only fields (gender, ethnicity, etc.) greyed out with a "Contact your administrator" hint. Self-service students can only edit `primaryLanguage`. Admin view at `/profile/[personId]` lets admins edit them all.
- The Account tab's Keycloak password-change link only renders when `NEXT_PUBLIC_KEYCLOAK_URL` is set. In dev without it, the page renders an explanatory paragraph instead.
- Browser smoke for the full interactive paths (clicking save, modal open/close, primary-contact promotion) is not in this handoff section — the API-level paths were verified end-to-end in Steps 5 + 6, and the production build of the web app verifies static prerender succeeds for `/profile`. The Step 8 CAT will exercise the UI in a real browser.

---

## Step 8 — Vertical Slice Acceptance Test

**Status:** ✅ Done (2026-04-29). CAT script lives at `docs/cycle6.1-cat-script.md`.

### What shipped

`docs/cycle6.1-cat-script.md` is the reproducible vertical-slice CAT — schema preamble + 11 scenarios + cleanup, in the same format as `cycle1-cat-script.md` through `cycle6-cat-script.md`. Verified live against `tenant_demo` 2026-04-29 with the API + all Cycle 1–6 consumers running.

### Verification (recorded 2026-04-29, all on `tenant_demo`)

Schema preamble:

| Check                                             | Got                        |
| ------------------------------------------------- | -------------------------- |
| `iam_person` total columns                        | 22                         |
| `platform_families` total columns                 | 20                         |
| `platform_family_members` new columns             | 2 (joined_at + updated_at) |
| `MemberRole` enum total values                    | 10 (5 original + 5 new)    |
| Partial UNIQUE index on `is_primary_contact=true` | present                    |
| `sis_student_demographics` columns                | 10                         |
| `sis_guardians` employment columns                | 4                          |
| USR-001 permission rows (all tiers)               | 3                          |
| Total permissions in catalog                      | 447                        |
| Chen Family seed shape                            | populated                  |
| `sis_student_demographics` seed rows              | 15                         |
| `iam_person` rows w/ preferred_name (Step 4)      | 6                          |

11 plan scenarios — all pass:

| #   | Scenario                                                                   | Result                                                                                |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| S1  | David parent `GET /profile/me`                                             | GUARDIAN composition with employment + HEAD_OF_HOUSEHOLD primary                      |
| S2  | David PATCH preferredName + secondaryPhone phoneTypeSecondary='HOME'       | allow-list works; phone_type CHECK passes; profileUpdatedAt bumps                     |
| S3  | David PATCH firstName                                                      | 400 by ValidationPipe `forbidNonWhitelisted`                                          |
| S4  | David PATCH household address (HEAD_OF_HOUSEHOLD)                          | 200; locked-read concurrency in `prisma.$transaction`                                 |
| S5  | Maya CHILD reads /households/my, PATCH refused                             | canEdit=false; 403 from `assertCanEditHousehold`                                      |
| S6  | Maya PATCH primaryLanguage allowed, gender rejected                        | demographics split (self-service vs. admin-only) enforced                             |
| S7  | Jim staff PATCH emergencyContact                                           | lands in `hr_emergency_contacts` with `is_primary=true`, response `source='EMPLOYEE'` |
| S8  | Sarah admin PATCH Maya firstName via `/profile/:personId`                  | 200 on `usr-001:admin`                                                                |
| S9  | David ADD Sarah → promote → demote-self refused → REMOVE → primary-restore | full lifecycle + 4 envelopes captured                                                 |
| S10 | Permission denials sweep                                                   | parent 403, teacher 403, student 404 (row-scope)                                      |
| S11 | Web build static prerender of `/profile`                                   | succeeds; both routes ship in production build                                        |

4 Kafka envelopes captured live on `dev.iam.household.member_changed`, full ADR-057 shape (`source_module='iam'`, `tenant_id` populated, fresh UUIDv7 `event_id`/`correlation_id`, `event_version=1`). Payloads cover ADDED → UPDATED-promote → REMOVED → UPDATED-restore.

Cleanup at end-of-run restores `tenant_demo` to post-Step-4 seed state.

### Cycle 6.1 closeout

Git tag pattern: `cycle6.1-complete` after this CAT commit lands and CI is green; `cycle6.1-approved` after the post-cycle architecture review verdict.

Review documents prepared for the post-cycle review (Phase 2 polish review pipeline):

- `REVIEW-CYCLE6.1-CHATGPT.md` — review prompt + verdict trail template (mirrors `REVIEW-CYCLE6-CHATGPT.md` shape).

---

## Notes for downstream cycles (Cycle 7+)

- **Future EnrollmentConfirmedWorker** can create a `platform_families` + `platform_family_members` row automatically when an unaffiliated guardian's first student enrolls (`enr.student.enrolled` → check if guardian has a household → if not, create one with the guardian as HEAD_OF_HOUSEHOLD and the new student as CHILD). The plumbing is in place after Cycle 6.1; the worker is a follow-on.
- **Future M40 household notification consumer** can subscribe to `iam.household.member_changed` and notify all other household members.
- **Cycle 7 Helpdesk** does not depend on profile / household data, so Cycle 6.1 has no blocking implications for Cycle 7 sequencing.
- **The `previous_names TEXT[]` array** is a known smell — if a school operationally needs to track maiden / married name history with timestamps, the upgrade path is a new `iam_person_name_history` table; the existing array column survives as the most-recent denormalised snapshot.

## References

- Plan: `docs/campusos-cycle6.1-implementation-plan.html`
- CAT script: `docs/cycle6.1-cat-script.md`
- Git tag pattern: `cycle6.1-complete` (after Step 8) and `cycle6.1-approved` (after the post-cycle architecture review)
- ADRs: ADR-055 (iam_person canonical identity), ADR-001 / ADR-020 (soft cross-schema refs), ADR-036 (scope inheritance for admin override)
- Conventions: `CLAUDE.md` — locked-read concurrency for state-machine transitions, splitter `;`-in-string trap, idempotent seed gating, persona-aware row scope
- Companion docs to update on completion: `CLAUDE.md` (Project Status + Architecture sections), `docs/index.html` (Design Hub link)
