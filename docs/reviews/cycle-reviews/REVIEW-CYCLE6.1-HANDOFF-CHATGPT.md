# Cycle 6.1 Architecture Review — Handoff for ChatGPT

**Reviewer:** ChatGPT (adversarial)
**Author of this brief:** Claude (CampusOS implementer)
**Cycle under review:** Cycle 6.1 — Profile & Household (Phase 2 polish, sub-cycle between 6 and 7)
**Branch:** `main`
**State at handoff:** Cycle 6.1 COMPLETE (Steps 1–8, all 8 done in a single day 2026-04-29). Cycles 0–6 COMPLETE + reviewed + post-review fixes landed (Cycle 6 APPROVED at `64993a8`).
**Verdict format requested:** same as Cycles 1–6 — `N PASS · N DEVIATION · N VIOLATION` with each item separately classified, plus a fix-priority order table.

You are doing a hostile architecture review of Cycle 6.1 the same way you did for Cycles 1–6. The Cycle 1 review caught 6 violations including a critical tenant-isolation race; the Cycle 2 review caught 2 BLOCKING issues (gradebook leak + at-most-once consumer); the Cycle 3 review caught 3 issues (consumer error swallowing, delivery worker SENT-as-in-flight, overly-broad `isManager()` scope); the Cycle 4 review caught 1 BLOCKING (leave-lifecycle concurrency) + 3 MAJOR (ON_LEAVE actor.employeeId, compliance dashboard auth split, deterministic event_id for republish); the Cycle 5 review caught 2 BLOCKING (room-booking conflict-and-INSERT race + room-change-request status race) + 2 MAJOR; the Cycle 6 review caught 5 BLOCKING + 3 MAJOR + several ACCEPTED-DEVIATIONs. Cycle 6.1 is smaller in scope than the prior cycles — no new ERD module, no new Kafka consumer (only one new emit topic with no consumer yet), no new tenant module — but the same standard applies. Be specific — name the file, line, ADR, and minimum fix.

---

## Scope of this review

**In scope** — every commit on `main` from `aad08f9 docs: rename Profile & Household mini-cycle to Cycle 6.1` (the Cycle 6.1 rename) backwards through the sequence:

```
aad08f9  docs: rename Profile & Household mini-cycle to Cycle 6.1
f3114bb  feat(profile-household-step7): Profile UI — tabbed pages + avatar menu
6c91b6c  feat(profile-household-step6): HouseholdsModule — role-based edit gate + iam.household.member_changed emit
7231c43  feat(profile-household-step5): ProfileModule — composed read + persona-aware patch
decd603  feat(profile-household-step4): seed — Chen household + personal fields + 15 demographics
0b489df  feat(profile-household-step3): permission catalogue — usr-001 read/write/admin
a555f31  feat(profile-household-step2): tenant schema — sis_student_demographics + sis_guardians employment
a1bbc05  feat(profile-household-step1): platform schema — iam_person + platform_families extensions
+ the Step 8 closeout commit (CAT script + handoff/CLAUDE.md polish + this review handoff).
```

Concretely the in-scope artifacts are:

- **1 Prisma migration on `platform`:** `packages/database/prisma/platform/migrations/20260429065233_add_profile_household_fields/migration.sql` — extends `iam_person` (+12 columns + 2 phone_type CHECK constraints), `platform_families` (+17 household columns), `platform_family_members` (+joined_at/updated_at + UNIQUE on person_id + ON DELETE CASCADE on family_id FK + partial UNIQUE INDEX on `(family_id) WHERE is_primary_contact=true`), and the `MemberRole` enum (+5 new values: HEAD_OF_HOUSEHOLD/SPOUSE/CHILD/GRANDPARENT/OTHER_GUARDIAN). The 5 original enum values stay for backwards compat with the never-built `FamilyMemberSyncWorker`.
- **1 SQL migration on tenant:** `packages/database/prisma/tenant/migrations/022_sis_student_demographics_and_guardian_employment.sql` — new `sis_student_demographics` (10 columns, FK CASCADE on `sis_students`, UNIQUE on `student_id`) + 4 new employment columns on `sis_guardians` (employer/employer_phone/occupation/work_address — all nullable, no CHECKs). Tenant logical base table count: **107** (was 106 after Cycle 6 Step 4). 0 cross-schema FKs.
- **1 new permission code:** `USR-001 (Profile Management)` in `packages/database/data/permissions.json` under group "User Profile & Household" → 149 functions × 3 tiers = 447 permissions (was 444). `seed-iam.ts` rolePermsSpec grants `usr-001:read+write` to Teacher / Parent / Student / Staff; School Admin + Platform Admin get all three tiers via `everyFunction`. **Catalog correction caught during smoke:** the plan originally referenced `iam-001:read/write` on the admin endpoints but `IAM-001` does not exist in the catalogue. Admin endpoints corrected to `usr-001:admin` before Step 5 shipped.
- **1 new seed:** `packages/database/src/seed-profile.ts` (idempotent, gated on whether Chen Family already has a HEAD_OF_HOUSEHOLD member; wired as `seed:profile`). Five sections: A) Chen Family `platform_families` shared-household fields populated; B) Chen members migrated PARENT→HEAD_OF_HOUSEHOLD + STUDENT→CHILD; C) iam_person personal fields on 6 accounts (David/Sarah/James/Linda/Marcus + Maya); D) 15 `sis_student_demographics` rows with `primary_language='English'` (Maya additionally `gender='Female'`); E) David's `sis_guardians` employment populated.
- **2 new NestJS modules under `apps/api/src/`:**
  - `profile/` — ProfileService + ProfileController + DTOs + module. **4 endpoints**: `GET /profile/me` and `PATCH /profile/me` (`usr-001:read`/`write`); `GET /profile/:personId` and `PATCH /profile/:personId` (`usr-001:admin`). Service composes platform `iam_person` + login email + household membership with persona-conditional tenant data (`sis_student_demographics` for STUDENT, `sis_guardians` employment for GUARDIAN, dual-table emergency contact: `hr_emergency_contacts` for STAFF / `sis_emergency_contacts` for STUDENT / null for everyone else). Self-service ALLOW-LIST excludes identity fields; admin path adds them. Tx model: platform writes (iam_person.update) on the platform PrismaClient + tenant writes inside one `executeInTenantTransaction` callback for atomicity (the two transactions are sequential, not nested — by design).
  - `households/` — HouseholdsService + HouseholdsController + DTOs + module. **6 endpoints**: `GET /households/my`, `GET /households/:id`, `PATCH /households/:id`, `POST /households/:id/members`, `PATCH /households/:id/members/:memberId`, `DELETE /households/:id/members/:memberId`. The plan said 5; added the `GET /households/:id` for arbitrary-by-id reads with row-scope to member-or-admin. Authorization is **role-based** (HEAD_OF_HOUSEHOLD or SPOUSE) + admin override via `usr-001:admin`. Every state-change opens a regular `prisma.$transaction` (NOT `executeInTenantTransaction` — household tables live in the platform schema), takes `SELECT ... FOR UPDATE` on `platform_families.id`, runs the membership gate inside the same tx, then mutates. Atomic primary-contact promotion: when `isPrimaryContact=true` lands, the service explicitly clears any existing primary in the same tx so the partial UNIQUE INDEX never fires. Refuses last-HEAD demotion + self-eviction without admin. Member-side mutations emit `iam.household.member_changed` via `KafkaProducerService.emit({sourceModule:'iam'})`; address-only PATCH does NOT emit. **No consumer** in this cycle — the topic is forward-compatible for a future M40 announcement worker.
- **2 new web routes under `apps/web/src/app/(app)/profile/`:** `/profile` (self-service, 987 B static) + `/profile/[personId]` (admin, 1.23 kB dynamic) sharing `apps/web/src/components/profile/ProfileTabs.tsx` (PersonalInfo / Household / EmergencyContact / Demographics for STUDENT / Employment for GUARDIAN / Account tabs, persona-conditional via `profileTabs(personType)`). New `apps/web/src/lib/profile-format.ts` with `profileCompleteness(profile)` 0–100% formula + label maps. New `apps/web/src/hooks/use-profile.ts` with 9 hooks. Avatar dropdown in `TopBar.tsx` gains "My Profile" link above "Sign out" for any user with `usr-001:read` (= every persona). **No new launchpad tile** — profile is intentionally accessed only via the avatar menu per the design principle "launchpad, not dashboard."
- **1 vertical-slice CAT:** `docs/cycle6.1-cat-script.md` — schema preamble + 11 scenarios + cleanup, all verified live against `tenant_demo` 2026-04-29.

**Out of scope** — anything that already shipped before Cycle 6.1 (Cycles 0–6, including the Cycle 6 review fixes at `64993a8`). Don't re-flag known accepted DEVIATIONs from prior cycles unless Cycle 6.1 introduces a NEW instance of the same anti-pattern.

---

## Architectural conventions Cycle 6.1 promised to honour

- **ADR-055 — `iam_person` is the canonical FK for human identity.** The 12 new columns are personal-projection data on the canonical row; no new identity table introduced. Identity fields (first_name, last_name, dateOfBirth post-set, login email) are admin-only on the PATCH path.
- **ADR-001 / ADR-020 — soft cross-schema refs.** 0 cross-schema FKs introduced. The new tenant table `sis_student_demographics` references `sis_students(id)` which is intra-tenant. The household tables are entirely platform-schema; the household → tenant bridge happens by reading `platform_family_members` from a tenant context (not via FK).
- **Tenant transaction discipline (CLAUDE.md "Tenant isolation under pooling").** Profile endpoints that write tenant-side use `executeInTenantContext` / `executeInTenantTransaction`. Household endpoints write platform-only and so use a regular `prisma.$transaction`, NOT `executeInTenantTransaction` — the tenant `search_path` is irrelevant for platform writes; SET LOCAL there would mask bugs. This split is documented in HANDOFF-CYCLE6.1.md front-matter.
- **State-machine row locking.** Every state-change in HouseholdsService opens `prisma.$transaction`, runs `SELECT ... FOR UPDATE` on `platform_families.id` BEFORE the membership read, runs the gate check inside the same tx, then mutates. Same pattern as Cycle 4–6 reviews mandated.
- **Atomic primary-contact promotion.** When `isPrimaryContact=true` lands on a member PATCH, the service runs `UPDATE ... SET is_primary_contact=false WHERE family_id=$1 AND is_primary_contact=true` BEFORE the UPDATE on the new row, all in the same tx. The partial UNIQUE INDEX on `(family_id) WHERE is_primary_contact=true` is the schema-side belt-and-braces.
- **ADR-057 envelope shape.** `iam.household.member_changed` emits go through `KafkaProducerService.emit({sourceModule:'iam', ...})`. 4 envelopes captured live in the CAT (S9.a–f) — every one has `event_type='iam.household.member_changed'`, `source_module='iam'`, `tenant_id` populated, fresh UUIDv7 `event_id` + `correlation_id`, `event_version=1`, ISO `occurred_at`/`published_at`.
- **Persona-aware row scope.** Profile reads compose persona-conditional payloads (Demographics for STUDENT, Employment for GUARDIAN, dual-table emergency contact for STAFF/STUDENT, null for everyone else). Self-service PATCH on `/profile/me` is implicitly self-scoped (acts on `actor.personId`). Admin endpoints `/profile/:personId` and `/households/:id` are gated on `usr-001:admin` plus the HouseholdsService row-scope (returns 404 instead of 403 for non-member non-admin to avoid leaking household existence).

---

## Specific things to test hostilely

I (the implementer) am explicitly worried about these and have not been able to fully prove them safe under load. Hammer them.

1. **Concurrent primary-contact promotion** — two HEADs racing to promote two different members to primary at the same instant. The service's "explicit clear before INSERT" pattern is correct in single-tx, but if both transactions read the same baseline state and both try to clear-then-set, do they serialise on the `SELECT … FOR UPDATE` of `platform_families.id`? Or does the partial UNIQUE INDEX raise 23505 to one of them while the other's clear-then-set leaves an inconsistent state?

2. **Concurrent ADD member where `person_id` is UNIQUE.** Two parents try to add the same outside-person to two different households simultaneously. `platform_family_members.person_id` is UNIQUE (Step 1) so only one INSERT can succeed. The second one raises 23505 — does the service translate that to a friendly 409 or does it leak the raw error? The service has a `try/catch` around the INSERT; verify the error-code matching is correct (`P2010` from Prisma + `'unique constraint'` substring match). What does Prisma actually throw for a UNIQUE violation on a raw `$executeRawUnsafe`? Could be a different code than expected.

3. **DELETE last HEAD via concurrent races.** Household has two HEADs. Admin A removes HEAD #1 (allowed — second still exists). Admin B simultaneously removes HEAD #2. Both transactions see two HEADs at gate-check time. Both pass. Both DELETE. The household ends up with zero HEADs. Is the `count >= 1` check inside the same `SELECT … FOR UPDATE` window? If the two admins lock different member rows (not the family row), the family-level invariant fails.

4. **Role-edit refusal of a SPOUSE who has NO active HEAD_OF_HOUSEHOLD.** Possible from data drift if a HEAD was hard-deleted somewhere upstream. The service's last-HEAD guard is "count >= 2 if you're demoting THIS HEAD." But if there's already only one HEAD and a SPOUSE tries to upgrade themselves to HEAD, that path isn't blocked — verify it's actually accepted (the SPOUSE shouldn't be blocked from self-promotion to HEAD; but should anyone be auto-promoted?).

5. **Profile update transaction split.** A single `PATCH /profile/me` may write iam_person (platform tx) THEN sis_guardians (tenant tx) THEN emergency_contact (tenant tx — or admin path: sis_student_demographics tenant tx). The two transactions are sequential. If the iam_person commit succeeds and the tenant tx fails, the user sees a partial save. Is this acceptable? The handoff says yes (each section is independent and the UI re-reads after save), but a hostile read should ask: does the failure mode confuse the UI's "Saved!" toast?

6. **Emergency contact dual-table write race.** Two PATCHes on the same `/profile/me` from the same STAFF user landing at the same time. Both try to "demote any existing primary then INSERT/UPDATE the new row." The partial UNIQUE INDEX `(employee_id) WHERE is_primary=true` on `hr_emergency_contacts` is the safety net, but does the service pre-clear concurrent-safely? Is it inside a `SELECT FOR UPDATE` on `hr_employees.id` or just relying on the partial UNIQUE?

7. **Maya's CHILD-can't-edit-household demotion path.** S9.b promotes Sarah to primary, atomically clearing David's primary flag. David is now a non-primary HEAD. If David then tries to remove himself, S9.d catches it. But what about a multi-tab scenario where David has already been promoted in tab A (now non-primary) and clicks "make me primary again" in stale tab B (which thinks he's still HEAD primary)? The PATCH would land idempotently. No bug, just verify.

8. **`MemberRole` enum compatibility.** The original 5 values stay for "backwards compat with the cross-school sibling-detection scaffolding." Verify that no production code path can ever read an `OTHER_GUARDIAN` row and crash on missing label, OR read a legacy `PARENT` row in a context that expects only the new values. The `HOUSEHOLD_ROLE_LABELS` map in `apps/web/src/lib/profile-format.ts` lists only the 7 NEW values. If an old PARENT row leaks through, the UI will render `undefined`.

9. **`previous_names TEXT[]` empty-string slip.** The DTO's `@IsArray()` + `@IsString({ each: true })` + `@ArrayMaxSize(20)` doesn't reject empty strings inside the array. A user could PATCH `previousNames: ['']` and persist a row with a junk empty-string name.

10. **`sis_emergency_contacts` is keyed on `student_id`, not `person_id`.** The handoff explicitly notes guardians have no emergency-contact storage today. But did the implementer accidentally write to the wrong table for some persona? Spot-check the dual-table router: a STUDENT must hit `sis_emergency_contacts`, a STAFF (with `actor.employeeId`) must hit `hr_emergency_contacts`. What about a STAFF persona who is ALSO a guardian (e.g. a teacher who is also Maya's parent)? `personType` is the only branch — does the precedence rule say "STAFF wins over GUARDIAN"?

11. **`profileCompleteness` formula.** It claims to weight required at 1.0 and recommended at 0.5. But it's reading household.role + household.id as TWO separate "in-household" recommended units (lines 99–101 of `profile-format.ts`). That double-counts the same fact. Likely cosmetic but check the math.

12. **The `seed-iam.ts` cosmetic 298-bug carry-over.** Pre-existing `var` shadowing prints "298 permissions" at the end of seed. Cycle 6.1 left it untouched. Verify it's still cosmetic.

---

## Reference materials

- **Plan:** `docs/campusos-cycle6.1-implementation-plan.html` — 8-step implementation plan.
- **Handoff:** `HANDOFF-CYCLE6.1.md` — detailed step-by-step what-shipped record, including every "caught during smoke" issue. The front-matter has the 5 critical pre-flight decisions (reuse `platform_families` not new `platform_households`, reuse existing emergency-contact tables, `primary_phone` stays nullable in schema, `previous_names TEXT[]` shipped as-is, no new launchpad tile) — those are NOT under review (they're settled design choices).
- **CAT:** `docs/cycle6.1-cat-script.md` — the live verification record that closed Step 8.
- **Prior reviews to cross-reference:** `REVIEW-CYCLE6-CHATGPT.md` (8 fixes mandated), `REVIEW-CYCLE5-CHATGPT.md`, `REVIEW-CYCLE4-CHATGPT.md`, `REVIEW-CYCLE3-CHATGPT.md`, `REVIEW-CYCLE2-CHATGPT.md`, `REVIEW-CYCLE1-CHATGPT.md`. The patterns flagged in those reviews (locked-read + atomic state transitions, ADR-057 envelope, idempotency, tenant search_path discipline) are the conventions Cycle 6.1 promised to follow.
- **Conventions index:** `CLAUDE.md` § "Conventions" + § "Architecture" + the "Profile & Household Mini-Cycle" entry under Phase 3.

---

## Output requested

Same format as Cycles 1–6 reviews:

1. **Verdict trail header** — round number, SHA, verdict (`APPROVED` or `REJECT pending N actionable fixes`), date.
2. **Triage table** for every finding — number, reviewer's claim, triage (`VALID — BLOCKING / MAJOR / MINOR`, `WRONG`, `ACCEPTED-DEVIATION`), with file:line and minimum fix.
3. **Strong passes** list — patterns Cycle 6.1 got right that should be highlighted.
4. **Round 2 verification** (after fixes land) — re-run against the fix commit's SHA, mark each accepted finding as fixed (with the diff/file:line of the fix), record the final `APPROVED` verdict.

If the review verdict is APPROVED on Round 1 (no fixes needed), say so explicitly and tag the cycle.
