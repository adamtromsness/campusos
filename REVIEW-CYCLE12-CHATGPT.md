# REVIEW-CYCLE12 — Cycle 12 (Library) Architecture Review

**Reviewer verdict:** Round 1 against `cycle12-complete` at `41b8736` returned **Reject pending fixes**. 4 BLOCKING items + 3 MAJOR follow-ups (tracked as Phase 2 punch list per the reviewer's gate decision).

**Round 2 status:** all 4 BLOCKING fixes landed in the closeout commit, verified live on `tenant_demo` 2026-05-05. Resubmitting for review at the new HEAD of `main` after CI green.

## Round 1 finding triage

| #   | Severity | Reviewer claim                                                                                                                                                        | Verdict   | Status                                                                                                                                               |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | BLOCKING | `GET /library/checkouts/:id` returns any checkout by UUID without checking caller is patron or librarian                                                              | **VALID** | ✅ Fixed                                                                                                                                             |
| 2   | BLOCKING | `GET /library/holds/:id` returns any hold by UUID without checking caller is patron or librarian                                                                      | **VALID** | ✅ Fixed                                                                                                                                             |
| 3   | BLOCKING | Barcode lookup leaks active-checkout patron identity to all `lib-001:read` callers (students, parents, teachers, general staff)                                       | **VALID** | ✅ Fixed                                                                                                                                             |
| 4   | BLOCKING | `CheckoutService.resolvePatronType` accepts any `platform.platform_students` row regardless of tenant; `HoldService.placeHold` cross-patron path lacks the same check | **VALID** | ✅ Fixed                                                                                                                                             |
| 5   | MAJOR    | Teachers can moderate any student review (lib-003:write granted to Teacher = list-author + review-moderator)                                                          | **VALID** | Deferred to Phase 2 punch list per reviewer gate decision                                                                                            |
| 6   | MAJOR    | `ReadingLogService` allows STAFF/ADMIN to read any student's log via `?studentId=` (broad demo Staff role)                                                            | **VALID** | Deferred to Phase 2 punch list per reviewer gate decision                                                                                            |
| 7   | MAJOR    | `HoldService.placeHold` duplicate-hold pre-check + INSERT lacks partial UNIQUE index or advisory lock; concurrent submissions could both pass                         | **VALID** | Deferred to Phase 2 punch list — non-blocking; race window is tiny and harmless (worst case: 2 PENDING holds for same patron, librarian cancels one) |

The reviewer flagged 4 strong passes that stay green: module wiring is correct; schema discipline is strong (14 lib\_\* tables, 20 intra-tenant FKs, 0 cross-schema FKs, ADR-001/020 soft integrity); checkout + return concurrency are well handled (FOR UPDATE locks, post-commit Kafka emit); `FineService.getById` was already correctly row-scoped + 404'd non-owner patrons; student review and reading-log write paths are sound.

## Closeout fixes (commit at HEAD of `main`)

### BLOCKING 1 — `GET /library/checkouts/:id` row scope

`CheckoutService.getById(id)` was loading the row by UUID and returning it without checking caller affiliation. Students hold `LIB-002:read` per the seed (patrons see own checkouts via the row-scoped `list` endpoint), so any student who obtained or guessed another checkout UUID could fetch the row including patron identity, item title, due date, status, and renewal count.

Fix: `getById(id, actor?)` now takes an optional actor parameter. When the controller path supplies it, the service applies row scope after the load:

```ts
async getById(id: string, actor?: ResolvedActor): Promise<CheckoutResponseDto> {
  const rows = await /* … load by id … */;
  if (rows.length === 0) throw new NotFoundException('Checkout ' + id);
  const dto = rowToCheckoutDto(rows[0]!);
  if (actor) {
    const isLibrarian = await this.hasLibrarianScope(actor);
    if (!isLibrarian && dto.patronId !== actor.personId) {
      // Don't-leak-existence: a 404 here makes uuid probing useless.
      throw new NotFoundException('Checkout ' + id);
    }
  }
  return dto;
}
```

The actor-less overload remains for internal post-mutation reloads — `checkout()`, `returnCheckout()`, and `renew()` already pass authorisation, and they call `getById(checkoutId)` to return the freshly-mutated DTO without re-checking permissions on a row they just wrote.

Controller `GET /library/checkouts/:id` resolves the actor and passes it through:

```ts
async getById(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
  const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
  return this.checkouts.getById(id, actor);
}
```

**Verified live on `tenant_demo` 2026-05-05:**

- Maya GETs own checkout (The Giver) → 200 with patronName=Maya Chen
- Maya GETs Ethan's checkout → **404 don't-leak-existence**
- Principal GETs Ethan's checkout → 200 (librarian scope)
- Maya GETs random non-existent UUID → 404 (matches the don't-leak path)

### BLOCKING 2 — `GET /library/holds/:id` row scope

Identical pattern to BLOCKING 1. `HoldService.getById(id, actor?)` now applies row scope after load; controller resolves and passes the actor; non-owner patrons get a 404 don't-leak-existence response.

**Verified live on `tenant_demo` 2026-05-05:**

- Maya GETs Ethan's PENDING hold → **404 don't-leak-existence**
- Principal GETs Ethan's hold → 200 with patronName=Ethan Rodriguez
- Maya places own hold + GETs it → 200 with patronName=Maya Chen

### BLOCKING 3 — barcode lookup leaks patron identity

`GET /library/copies/barcode/:barcode` is gated on `lib-001:read` (catalogue browse, held by every authenticated persona) but the response inlined the full `activeCheckout` shape including `checkoutId`, `patronId`, `patronName`, dates, and renewal count. A student or parent scanning or guessing a barcode could discover who currently has any item.

Fix: split the response by librarian scope. Catalogue-only readers continue to see the full copy + item + pendingHoldsCount + a new `isCheckedOut` boolean (derived from `copy.is_available`) — they can still tell the book is on loan without learning who has it. Librarians (lib-002:write) and admins see the full circulation-desk shape with `activeCheckout` populated.

```ts
async lookupByBarcode(barcode: string, actor?: ResolvedActor) {
  // ... load copy + item + holds ...
  const isLibrarian = actor ? await this.isLibrarian(actor) : false;
  let activeCheckout: ActiveCheckoutDto | null = null;
  if (isLibrarian) {
    // ... query lib_checkouts + iam_person and populate activeCheckout ...
  }
  return { copy, item, activeCheckout, pendingHoldsCount, isCheckedOut: !copy.isAvailable };
}
```

`BarcodeLookupResponseDto` gains the `isCheckedOut: boolean` field and the docstring on `activeCheckout` documents the split. Controller resolves the actor and passes it through; the OpenAPI summary spells out the librarian-only shape so future readers (and Swagger consumers) understand the contract.

The reviewer accepted both alternatives ("strip patron details for catalogue readers" or "move the endpoint to lib-002:write"). Strip wins because the patron-facing UI on `/library/catalogue/[id]` and the search bar both rely on the `isCheckedOut` signal to render an "On loan" badge — moving the endpoint to lib-002:write would force every catalogue UI to call a second endpoint to learn availability.

**Verified live on `tenant_demo` 2026-05-05:**

- Principal scans LIB-FIC-001 (Maya's active checkout) → activeCheckout.patronName=Maya Chen, dueDate=2026-05-14, isCheckedOut=true
- Student scans same → **activeCheckout=None, isCheckedOut=true** (knows it's out, doesn't know who has it)
- Parent scans same → **activeCheckout=None, isCheckedOut=true**
- Teacher scans same → **activeCheckout=None, isCheckedOut=true**
- Student scans LIB-FIC-002 (available copy) → activeCheckout=None, isCheckedOut=false (no leak — the copy is on shelf)

### BLOCKING 4 — cross-tenant patron validation

`CheckoutService.resolvePatronType()` was checking `EXISTS (SELECT 1 FROM platform.platform_students WHERE person_id = $1)` to determine STUDENT, but `platform.platform_students` is a cross-tenant table — a person enrolled at School B but not at School A would still resolve as STUDENT in School A's tenant. The librarian could then create a `lib_checkouts.patron_id` row pointing at a person who doesn't belong to the school. STAFF was already tenant-scoped via `hr_employees` (a tenant-local table). `HoldService.placeHold()` had the same gap on the cross-patron `patronId` parameter.

Fix: tighten the STUDENT branch to require a current-tenant `sis_students` row, and add a shared `assertPatronInCurrentTenant(personId)` helper:

```ts
async resolvePatronType(personId: string): Promise<PatronType | null> {
  return this.tenantPrisma.executeInTenantContext(async (client) => {
    const rows = await client.$queryRawUnsafe(
      'SELECT ' +
        '(EXISTS (' +
        '  SELECT 1 FROM sis_students s ' +
        '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        '  WHERE ps.person_id = $1::uuid' +
        ')) AS is_student, ' +
        '(EXISTS (SELECT 1 FROM hr_employees WHERE person_id = $1::uuid)) AS is_staff',
      personId,
    );
    // ...
  });
}

async assertPatronInCurrentTenant(personId: string): Promise<PatronType> {
  const patronType = await this.resolvePatronType(personId);
  if (!patronType) {
    throw new BadRequestException(
      'Patron is neither a student nor a staff member in this school',
    );
  }
  return patronType;
}
```

`CheckoutService.checkout()` calls `assertPatronInCurrentTenant` directly (replacing the old null-check). `HoldService.placeHold()` injects `CheckoutService` and calls the helper on the cross-patron path:

```ts
// Self-service path (patronId = actor.personId) is implicitly tenant-scoped
// because the Auth + Tenant guard chain already proved the actor belongs.
if (input.patronId && input.patronId !== actor.personId) {
  await this.checkouts.assertPatronInCurrentTenant(input.patronId);
}
```

The error message stays generic ("Patron is neither a student nor a staff member in this school") so a librarian probing IDs cannot distinguish "exists in another tenant" from "doesn't exist anywhere".

**Verified live on `tenant_demo` 2026-05-05:**

- Sanity check: Platform Admin (`admin@`) person_id is in `platform.iam_person` but has 0 rows in `tenant_demo.sis_students` and 0 in `tenant_demo.hr_employees`
- Principal POSTs `/library/checkouts` with that person_id → **400 "Patron is neither a student nor a staff member in this school"**
- Principal POSTs `/library/holds` with that person_id (cross-patron path) → **400 same message**
- Self-service hold for Maya (no explicit patronId) → 201 (default actor.personId path is unaffected)
- Cross-patron hold for Ethan (real tenant student) → 201 (the genuine on-behalf path still works)

## MAJOR follow-ups carried to Phase 2 punch list

Per the reviewer's gate decision: "the review-moderation and reading-log staff-scope issues should remain tracked as role-model hardening before pilot."

- **Item 5 — teacher review moderation scope.** Teachers hold `LIB-003:write` to author reading lists; `ReviewService.hasModeratorScope` interprets any non-student actor with that perm as a moderator who can hide/unhide reviews. Real schools likely want a separate `LIB-005:moderate` permission (or constrain teacher moderation to class-scoped reviews). Joins the broader Counsellor / Nurse / Librarian role-split punch list (Cycles 9 + 10 + 11 + 12).

- **Item 6 — STAFF reading-log breadth.** `ReadingLogService.list({ studentId })` allows any STAFF + ADMIN actor with `lib-003:read` (which Staff doesn't have today, so this is largely admin-only at present) to read any student's log. Pre-pilot should narrow to "librarian scope OR teacher of an enrolled class" depending on the UI surface.

- **Item 7 — hold duplicate race.** `HoldService.placeHold` does a check-then-insert without an advisory lock or partial UNIQUE on `(catalogue_item_id, patron_id) WHERE status IN ('PENDING','READY')`. Two concurrent submissions could both pass the pre-check. The race window is tiny and the worst-case is "patron has 2 PENDING holds for the same item until the librarian cancels one" — non-blocking but worth a tenant migration adding the partial UNIQUE before pilot.

These three follow-ups are tracked in `CLAUDE.md`'s Wave 2 Phase 2 punch list and will be folded into a future role-model hardening sweep before real-school onboarding.

## Verification checklist (Round 2)

- [x] BLOCKING 1 — checkout row scope verified live (own → 200, other → 404, librarian → 200)
- [x] BLOCKING 2 — hold row scope verified live (own → 200, other → 404, librarian → 200)
- [x] BLOCKING 3 — barcode patron-identity strip verified across 4 personas (librarian sees full shape, student/parent/teacher see activeCheckout=null + isCheckedOut=true)
- [x] BLOCKING 4 — cross-tenant patron validation verified live (Platform Admin person_id rejected on both checkout + hold-on-behalf; self-service hold + valid librarian-on-behalf both still work)
- [x] `pnpm --filter @campusos/api build` clean
- [x] `pnpm format:check` clean
- [x] `pnpm test` 7/7 pass
- [x] `tenant_demo` restored to post-Step-4 seed shape exactly (locations=3, items=5, copies=11, checkouts=3, holds=1, fines=1, programmes=1, progress=1, logs=2, lists=1, list_items=3, reviews=1)

## Re-review request

Please re-review at the new HEAD of `main` after CI green. The four BLOCKING fixes are minimal-scope and verified live; the three MAJOR follow-ups are tracked as Phase 2 punch list per the reviewer's stated gate decision.
