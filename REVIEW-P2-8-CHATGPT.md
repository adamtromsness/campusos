# REVIEW-P2-8-CHATGPT — Athletics Advanced Combined Peer Review

**Plan:** `docs/campusos-p2c8-athletics-advanced.html` (M66 Athletics .1; 18 ERD tables across 2 sub-cycles).
**Round 1 reviewed:** P2-8a `62ba7aa` + P2-8b `7d7c93d` (combined).
**Round 1 verdict:** **FAIL — 6 BLOCKING + 4 MAJOR.**
**Round 1 fix commit:** `e05b6ae`.
**Round 2 reviewed:** `e05b6ae`.
**Round 2 verdict:** **PASS — every dimension green.** Reviewer flagged 2 non-blocking follow-ups (controller metadata clarity for marketplace-admin routes; conference membership/schedule public-vs-admin DTO split) — both correctly carried as Phase 2 polish per the reviewer's gate decision.

Tagged `p2c8-complete` at `e05b6ae` and `p2c8-approved` at the closeout commit. **Cycle 8 ships clean.**

---

## Round 1 triage

| #   | Severity     | Title                                                                                         | Status                                                                                           |
| --- | ------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | **BLOCKING** | `ath.equipment.replacement_charge` is best-effort after commit                                | **FIXED**                                                                                        |
| 2   | **BLOCKING** | Equipment checkout accepts arbitrary `assigned_to_person_id` without school validation        | **FIXED**                                                                                        |
| 3   | **BLOCKING** | Tenant ADs can mutate platform/cross-school conference records + fabricate cross-school games | **FIXED**                                                                                        |
| 4   | **BLOCKING** | `ath.highlight_clip.portfolio_link_requested` is best-effort after commit                     | **FIXED**                                                                                        |
| 5   | **BLOCKING** | `ath.official.assignment.completed` is best-effort after commit                               | **FIXED**                                                                                        |
| 6   | **BLOCKING** | Tenant ADs can mutate canonical platform official profiles + availability                     | **FIXED**                                                                                        |
| 7   | MAJOR        | Team media `season_id` not school/programme validated                                         | **FIXED**                                                                                        |
| 8   | MAJOR        | Highlight clip consent needs age/guardian (COPPA under-13) policy                             | **FIXED**                                                                                        |
| 9   | MAJOR        | Official contact fields broadly returned                                                      | **FIXED**                                                                                        |
| 10  | MAJOR        | Conference membership/schedule list expose cross-school records broadly                       | DEFERRED — recommendation-class polish, current shape still sound; flagged on Phase 2 punch list |

---

## Per-fix detail

### BLOCKING 1 — Durable outbox for `ath.equipment.replacement_charge`

**Before:** `EquipmentService.returnCheckout` emitted `ath.equipment.replacement_charge` via best-effort `KafkaProducerService.emit` AFTER the tx committed, in a swallowed try/catch. A Kafka outage would leave the checkout flipped to RETURNED + DAMAGED with replacement_charge populated, but no billing event reaching Cycle 6 family billing.

**After:** Replaced post-commit emit with `OutboxService.enqueueInTx(tx, ...)` INSIDE the same tenant tx that flips the checkout. The envelope `eventId` is a **deterministic v5-shaped UUID** keyed on `checkoutId`:

```ts
export function deterministicReplacementChargeEventId(checkoutId: string): string {
  const hash = createHash('sha1')
    .update(checkoutId + ':ath.equipment.replacement_charge:v1')
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  // ...
}
```

Same v5 shape as P2-4a `deterministicPayrollEventId` + P2-6 `deterministicCreditNoteEventId` so a redelivered outbox row lands the same envelope and the Cycle 6 billing consumer's idempotency catches the dup cleanly.

**Verification:** spec test `BLOCKING 1 — replacement_charge emit lands in outbox with deterministic event_id` asserts `emits[0]!.topic === 'ath.equipment.replacement_charge'` AND `emits[0]!.eventId` matches `^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.

---

### BLOCKING 2 — Equipment checkout assignee school validation

**Before:** `EquipmentService.checkout()` validated equipment school ownership but accepted `input.assignedToPersonId` directly into `ath_equipment_checkouts.assigned_to_person_id`. A School A AD could issue equipment to a known `iam_person` UUID from School B or to an unrelated platform person.

**After:** New private `assertAssigneeInCurrentSchool(client, assigneePersonId)` helper joins through:

- `sis_students.platform_student_id → platform_students.person_id` for current-school students, OR
- `hr_employees.person_id` for current-school staff

Bogus / cross-school UUIDs return `400 "assignedToPersonId does not match a student or staff member in this school"` BEFORE the INSERT.

**Verification:** spec test `BLOCKING 2 — checkout to a person not in current school is rejected` asserts the rejection. The check correctly excludes guardians (equipment is issued to students or staff, not parents).

---

### BLOCKING 3 — Conference catalogue + cross-school schedule authority

**Before:** Any school AD with `ath-003:write` could create or patch a shared conference record AND create `ath_conference_schedules` entries with arbitrary `homeSchoolId` and `awaySchoolId`. A School A AD could fabricate a "School B vs School C" game.

**After:**

- New `ConferenceService.hasCatalogueAdminScope(actor)` checks the actor holds `sys-001:admin` OR `ath-003:admin` at PLATFORM scope specifically (via Cycle 31 `permissionCheckService.resolvePlatformScope()` + `hasAnyPermission`). School Admin's role assignments live at SCHOOL scope; only Platform Admin holds an assignment at PLATFORM scope.
- `create` + `patch` re-gated from `hasConferenceScope` (school AD) to `hasCatalogueAdminScope`.
- `addScheduleEntry` requires either platform-tier authority OR `homeSchoolId === tenant.schoolId OR awaySchoolId === tenant.schoolId`. A tenant AD cannot fabricate a cross-school game involving two foreign schools.
- `seasonId` validation added — must belong to a season whose programme's `school_id = tenant.schoolId`.

**Verification:** 3 spec tests:

- `non-admin (no ath-003:write) is rejected with Forbidden on create`
- `school admin (tenant-scope auth) is rejected on conference catalogue create` — confirms BLOCKING 3 keystone (tenant ADs cannot author the catalogue)
- `tenant AD cannot schedule School B vs School C (cross-school fabrication)` — confirms the cross-school gate

---

### BLOCKING 4 — Durable outbox for `ath.highlight_clip.portfolio_link_requested`

**Before:** `GameStreamService.addClipToPortfolio` set `added_to_portfolio = true` then emitted `ath.highlight_clip.portfolio_link_requested` via best-effort post-commit `kafka.emit`. A Kafka outage would leave Athletics with an "added to portfolio" record, while Cycle 24 portfolio never received the request.

**After:** Replaced post-commit emit with `OutboxService.enqueueInTx(tx, ...)` inside the same tx. Deterministic event_id via `deterministicHighlightLinkEventId(clipId)` — same v5 shape as the rest of the cycle's helpers.

**Verification:** spec test `BLOCKING 4 — portfolio link emit carries deterministic event_id (v5-shaped UUID)` asserts the eventId is set + v5-shaped. The existing emit-shape test `CONSENTED happy path emits ath.highlight_clip.portfolio_link_requested` now runs against the outbox mock instead of the kafka mock, locking the durable contract.

---

### BLOCKING 5 — Durable outbox for `ath.official.assignment.completed`

**Before:** `OfficialService.transitionAssignment` COMPLETED branch flipped the assignment to COMPLETED then emitted `ath.official.assignment.completed` via best-effort post-commit `kafka.emit`. A Kafka outage would leave the assignment terminal but downstream AP would never receive the completion request.

**After:** Replaced post-commit emit with `OutboxService.enqueueInTx(tx, ...)` inside the same tx. Deterministic event_id via `deterministicAssignmentCompletedEventId(assignmentId)`.

**Verification:** spec test `BLOCKING 5 — assignment.completed emit carries deterministic event_id` asserts the deterministic v5-shape. Existing `COMPLETED transition emits ath.official.assignment.completed` test rewritten against the outbox mock.

---

### BLOCKING 6 — Platform official profile + availability mutation gate

**Before:** `OfficialService.createProfile`, `updateProfile`, `createAvailability` were gated on `hasOfficialAdminScope(actor)` which accepts school admin OR tenant `ath-003:write`. A School A AD could change a shared official's certification, base fee, sport list, or availability — affecting all schools that use that official.

**After:** New `OfficialService.hasMarketplaceAdminScope(actor)` checks `sys-001:admin` OR `ath-003:admin` at PLATFORM scope specifically:

```ts
async hasMarketplaceAdminScope(actor: ResolvedActor): Promise<boolean> {
  const platformScope = await this.permissions.resolvePlatformScope();
  if (!platformScope) return false;
  return this.permissions.hasAnyPermission(actor.accountId, platformScope, [
    'sys-001:admin',
    'ath-003:admin',
  ]);
}
```

`createProfile`, `updateProfile`, `createAvailability` re-gated from `hasOfficialAdminScope` to `hasMarketplaceAdminScope`. School ADs continue to post assignments + submit ratings under `ath-003:write`; only the canonical platform record is now reserved for Platform Admin / marketplace admin.

**Verification:** 2 spec tests:

- `BLOCKING 6 — school AD (tenant ath-003:write only) rejected on platform official profile create` — confirms the gate fires
- `BLOCKING 6 — platform admin (PLATFORM-scope auth) can create official profile` — confirms the gate allows the right caller

---

### MAJOR 1 — Team media `season_id` validation

`TeamMediaService.createAsset` now validates `seasonId` (when supplied) belongs to the current school via the `ath_seasons → ath_programmes.school_id = tenant.schoolId` chain. When both `programmeId` and `seasonId` are supplied, the season must also belong to that programme — both validations done in a single SQL query for efficiency. Bogus or cross-school season IDs return `400 "seasonId does not match a season in this school"`.

### MAJOR 2 — Under-13 COPPA consent gate

`GameStreamService.recordClipConsent` extended with an age check that fires only on the student-self path (admin-on-behalf and linked-guardian paths bypass since both are legally valid for under-13). For the student-self branch:

```ts
const ageRows = await t.$queryRawUnsafe<Array<{ age_years: number | null }>>(
  'SELECT EXTRACT(YEAR FROM age(p.date_of_birth))::int AS age_years ' +
    'FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id JOIN platform.iam_person p ON p.id = ps.person_id ' +
    'WHERE s.id = $1::uuid',
  studentId,
);
if (ageRows[0]?.age_years !== null && ageRows[0]!.age_years! < 13) {
  throw new ForbiddenException(
    'COPPA: students under 13 cannot self-consent to highlight clip publication. A linked guardian or admin must record consent on their behalf.',
  );
}
```

DOB lives on `iam_person`, reached via the `sis_students → platform_students → iam_person` chain (consistent with the rest of the codebase's identity model per ADR-055).

### MAJOR 3 — Official contact field strip for non-AD readers

`OfficialService.listProfiles` + `getProfileById` now take an optional `actor` parameter and pass each row through `stripContactsIfNeeded(actor, dto)` before returning. The strip clears `contactEmail` + `contactPhone` for readers without `ath-003:write` (assignment authority). Public marketplace browse readers (other school staff with `ath-003:read` only) get the public shape: certification + sports + base fee + bio + average rating, but not direct contact details.

### MAJOR 4 — DEFERRED to recommendation-class polish

The reviewer's MAJOR 4 ("Conference membership and schedule list expose cross-school records broadly") notes that a future public-vs-admin DTO split may be needed if internal notes / operational fields are added later. Today's shape is acceptable for the public conference view — no internal fields are returned. Carried as a Phase 2 polish item.

---

## CI parity (Round 1 fix verification)

- `pnpm format:check` — clean
- `pnpm lint:logs` — 679 files clean
- `pnpm --filter @campusos/api build` — clean (nest build)
- `pnpm --filter @campusos/web build` — clean
- `pnpm --filter @campusos/api exec vitest run` — **436/436 passing** (was 428 before fixes; +8 BLOCKING regression tests across both spec files)
- `pnpm --filter @campusos/api exec vitest run src/athletics/` — **38/38 passing** (17 P2-8a + 21 P2-8b)

---

## Conditions for PASS — checklist

1. ✅ **Move `ath.equipment.replacement_charge` to platform outbox** — fixed via `OutboxService.enqueueInTx` inside the return tx + deterministic event_id.
2. ✅ **Validate equipment checkout assignees against current-school student/staff** — fixed via `assertAssigneeInCurrentSchool` JOIN through sis_students + hr_employees; refuses guardians + cross-school refs.
3. ✅ **Restrict conference catalogue and cross-school schedule mutation** — `hasCatalogueAdminScope` requires PLATFORM-scope authority; `addScheduleEntry` requires home/away school === tenant unless catalogue admin.
4. ✅ **Move `ath.highlight_clip.portfolio_link_requested` to platform outbox** — fixed via `OutboxService.enqueueInTx` + deterministic event_id.
5. ✅ **Move `ath.official.assignment.completed` to platform outbox** — fixed via `OutboxService.enqueueInTx` + deterministic event_id.
6. ✅ **Split official-profile/availability mutation from tenant `ath-003:write`** — `hasMarketplaceAdminScope` requires PLATFORM-scope `sys-001:admin` OR `ath-003:admin`.
7. ✅ **Add regression tests for all six blockers** — 8 new pinned tests across `athletics-advanced.spec.ts` + `athletics-advanced-b.spec.ts`.

Awaiting Round 2 verdict.
