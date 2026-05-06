# REVIEW-CYCLE22-CHATGPT

**Cycle:** 22 — IT Infrastructure (Wave 4 closeout).
**Round 1 verdict:** Reject pending fixes — 6 BLOCKING + 4 MAJOR.
**Round 1 commit:** `cycle22-complete` (`6638090`).
**Round 1 fix commit:** this commit.
**Live verification:** `tenant_demo` 2026-05-06.

## Triage table

| #        | Class  | Title                                                              | Disposition                                                                |
| -------- | ------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| BLOCKING | 1      | `GET /it/device-selections` exposes all selections to non-IT staff | Fixed in this commit — actor-aware row scope                               |
| BLOCKING | 2      | Asset assignment / document / damage / repair reads not row-scoped | Fixed in this commit — `assertCanAccessAsset` + per-endpoint actor scoping |
| BLOCKING | 3      | Asset assignment accepts any platform user                         | Fixed in this commit — `assertAccountInCurrentTenant` helper               |
| BLOCKING | 4      | Software licence assignment accepts arbitrary account IDs          | Fixed in this commit — same helper applied                                 |
| BLOCKING | 5      | Vault falls back to deterministic demo key                         | Fixed in this commit — fail-closed when `NODE_ENV=production`              |
| BLOCKING | 6      | Credential access log readable without matching credential tier    | Fixed in this commit — same tier-rank check as `getByIdWithPassword`       |
| MAJOR    | 7      | `IT-002:write` is overloaded across damage filing + fleet mgmt     | Phase 2 punch list item 34 — role-split work                               |
| MAJOR    | 8      | MDM sync/alert reads are broad fleet-wide list endpoints           | Phase 2 punch list item 35 — IT admin role split                           |
| MAJOR    | 9      | Procurement vendor school-context validation                       | Phase 2 punch list item 36                                                 |
| MAJOR    | 10     | Infrastructure metadata sensitivity                                | Phase 2 punch list item 37 — pre-pilot role split                          |
| Pass     | strong | Module wiring                                                      | ✓                                                                          |
| Pass     | strong | Schema discipline (FKs + lockstep CHECKs)                          | ✓                                                                          |
| Pass     | strong | Asset assignment lifecycle transactional safety                    | ✓                                                                          |
| Pass     | strong | Licence seat capacity transactional safety                         | ✓                                                                          |
| Pass     | strong | Credential read auditing in same tx                                | ✓ (apart from BLOCKING 6, now closed)                                      |

## Code-level fixes

### BLOCKING 1 — `GET /it/device-selections` row scope

`DeviceSelectionService.listSelections()` was actor-blind — every caller with `it-003:read` (Teacher, Student, Staff) saw every selection in the tenant. The endpoint now takes an optional `actor` parameter and applies row scope when supplied:

- **IT admin** (school admin OR `it-006:read` — the IT admin signal that distinguishes IT staff from generic teachers): every selection in the tenant.
- **STUDENT**: only `s.person_id = actor.personId`.
- **GUARDIAN**: only selections for children linked via `sis_student_guardians` + `sis_guardians` on the actor.
- **TEACHER + non-IT-admin staff**: empty list (the device-selection workflow is between the student/parent and IT staff).

The `personType === 'STAFF'` short-circuit was insufficient because Teachers are also `STAFF` (they're in `hr_employees`). The new `it-006:read` permission lookup is the actual IT-admin signal — granted to Staff role for IT admins per the Cycle 22 IAM seed but not held by Teacher.

The internal helpers (`createSelection` / `approveSelection` / `rejectSelection`) call `listSelections({ personId })` without an actor — they bypass row scope on purpose because they have already validated row access via their own checks.

The controller passes the resolved actor through:

```typescript
@Get('it/device-selections')
@RequirePermission('it-003:read')
async listSelections(
  @Req() req: AuthedRequest,
  @Query('status') status?: string,
  @Query('personId') personId?: string,
): Promise<DeviceSelectionDto[]> {
  return this.selections.listSelections({ status, personId }, await this.resolveActor(req));
}
```

**Live verified on `tenant_demo` 2026-05-06**:

- principal (school admin) — 1 row (the seeded Aiden ENROLMENT selection).
- counsellor (Staff with `it-006:read`) — 1 row.
- teacher (Staff persona but NO `it-006:read`) — **0 rows**.
- student (Maya — no seeded selection of her own) — 0 rows.

### BLOCKING 2 — asset subresource read row scope

`GET /it/assets/:id/assignments`, `GET /it/assets/:id/documents`, `GET /it/damage-reports`, `GET /it/repairs` were not row-scoped. Three new helpers in `assets.service.ts`:

- `isItAdminActor(permCheck, actor)` — returns true for school admin OR holders of `it-006:read` (the IT admin signal).
- `assertCanAccessAsset(tenantPrisma, permCheck, assetId, actor)` — IT admin sees any asset; non-admin actors must have an active assignment for the asset; throws collapsed 404 otherwise.
- Same `it-006:read` gate applied inside `DamageReportService.list()` and `RepairRecordService.list()`.

`AssignmentService.listForAsset(assetId, actor?)` and `AssetDocumentService.listForAsset(assetId, actor?)` now take an optional actor and gate via `assertCanAccessAsset`. Internal callers (post-mutation re-reads in `assignAsset` / `returnAssignment` / `createDocument`) omit the actor and bypass the gate because they have already verified IT admin scope upstream.

`DamageReportService.list({}, actor?)`:

- IT admin: every damage report in the tenant.
- Non-IT-admin: only reports they filed (`d.reported_by = actor.accountId`) OR reports on assets currently assigned to them (`tech_asset_assignments.assigned_to_id = actor.accountId AND returned_at IS NULL`).

`RepairRecordService.list({}, actor?)`:

- IT admin: full list.
- Non-IT-admin: empty list. Repair details (vendor, cost, resolution notes) are IT-internal.

The controller passes the actor through on all four endpoints.

**Side-fix during smoke**: `RepairRecordService` was reading non-existent columns `r.cost_estimate` / `r.final_cost` / `r.notes`. The actual schema has `cost` / `resolution_notes`. The `list` SELECT, `create` INSERT, and `patch` SET clauses all rewritten to use the real column names; the DTO contract is preserved by surfacing `cost` as `costEstimate` (when status PENDING / IN_REPAIR) or `finalCost` (when status COMPLETED / UNREPAIRABLE). This was a latent bug in the original Cycle 22 build that the row-scope smoke surfaced.

**Live verified on `tenant_demo` 2026-05-06**:

- `/assets/:rivera_asset/assignments` → principal 200, Rivera 200 (own), Maya 404, student 404 on Rivera's asset.
- `/assets/:maya_asset/documents` → teacher Rivera 404 (not own).
- `/it/damage-reports` → principal 1 row, teacher 1 row (Rivera filed the seeded MODERATE report so it's visible per "reports they filed"), student 0.
- `/it/repairs` → principal 1, teacher 0 (IT-internal).

### BLOCKING 3 — asset assignment cross-tenant validation

`AssignmentService.assignAsset()` was validating only that `input.assigneeId` existed in `platform.platform_users` — no tenant scope. New shared helper `assertAccountInCurrentTenant(tenantPrisma, accountId, fieldName)` exported from `assets.service.ts` validates the supplied `platform_users.id` has a current-tenant projection in `sis_students` (via `platform_students.person_id` chain) OR `sis_guardians.person_id` OR `hr_employees.person_id`. Mirrors the Cycle 6.1 `ProfileService.assertTargetInCurrentTenant` pattern + Cycle 14 messaging participant validation.

The pre-existing platform_users existence check was redundant once the projection check is in place; the helper is the single gate.

**Live verified on `tenant_demo` 2026-05-06**:

- bogus UUID → 400.
- `admin@` Platform Admin (no `hr_employees` / no `sis_students` / no `sis_guardians` projection in `tenant_demo`) → **400 "assigneeId does not match a user in this school"**.
- Maya student (has `sis_students` projection via `platform_students.person_id`) → 201.

### BLOCKING 4 — licence assignment cross-tenant validation

`LicenceService.assignSeat()` reused the same helper. Side-by-side with the existing `lockRows.is_active` check inside the locked tx; the new check happens before the tx opens.

**Live verified on `tenant_demo` 2026-05-06**:

- bogus UUID → 400.
- `admin@` Platform Admin → **400**.

### BLOCKING 5 — vault key fail-closed in production

`licences.service.ts` module-load block now throws when `process.env.NODE_ENV === 'production'` and `process.env.IT_VAULT_KEY` is missing. Development and test continue to use the deterministic demo seed string so the seeded ciphertext decrypts cleanly through the same module — production deployments must set `IT_VAULT_KEY` (a separate key from the student-data key per ADR-065).

```typescript
const NODE_ENV = process.env.NODE_ENV || 'development';
if (NODE_ENV === 'production' && !process.env.IT_VAULT_KEY) {
  throw new Error(
    'IT_VAULT_KEY is required in production — falling back to a deterministic seed key would defeat ADR-065.',
  );
}
```

**Live verified on `tenant_demo` 2026-05-06**:

- `NODE_ENV=production` with no `IT_VAULT_KEY` → process throws at module load with the documented error message.
- `NODE_ENV=production` with `IT_VAULT_KEY=<value>` → boots cleanly.

### BLOCKING 6 — credential access log tier check

`CredentialVaultService.accessLog(id, actor)` was checking `it-005:read` + `STAFF`/admin status only. It now also loads the credential's `access_tier` from `tech_credential_vault` and applies the same tier-rank check as `getByIdWithPassword` — a STANDARD or ELEVATED operator who cannot decrypt a CRITICAL credential cannot see who accessed it either. Defends against metadata leakage around privileged credentials.

```typescript
const credTier = credRows[0]!.access_tier as AccessTier;
const myTier = await this.actorTier(actor);
if (tierRank(myTier) < tierRank(credTier)) {
  throw new ForbiddenException(
    'Insufficient access tier — this credential requires ' + credTier + ' tier',
  );
}
```

**Live verified on `tenant_demo` 2026-05-06**:

- principal (school admin = CRITICAL tier) reading CRITICAL credential's log → 200.
- counsellor (Staff with `it-005:write` — ELEVATED tier) reading CRITICAL credential's log → **403 "Insufficient access tier — this credential requires CRITICAL tier"**.
- counsellor reading ELEVATED credential's log → 200 (tier-equal access).

## Phase 2 follow-ups (carried)

- **Item 34** — `IT-002:write` overloaded for damage filing + fleet management. Pre-pilot, split into a dedicated damage-reporting permission distinct from fleet management to allow Teacher to file damage reports without inheriting category management.
- **Item 35** — MDM sync/alert reads are fleet-wide. Today's seed only grants `IT-006:read` to Staff (IT admin), but a dedicated IT Administrator role split before pilot will narrow this further.
- **Item 36** — Procurement vendor validation should also confirm the vendor's school context. The DB FK ensures the vendor row exists; the service should additionally check `tkt_vendors.school_id`.
- **Item 37** — Infrastructure metadata sensitivity. Before pilot, lock `IT-006` read/write to a dedicated IT Administrator role rather than the generic Staff role.

These join the existing Wave 2-4 Phase 2 punch list (items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / 33) for the broader role-split work before real-school onboarding.

## Verdict trail

- 2026-05-06 11:00 — `cycle22-complete` (6638090) submitted for review.
- 2026-05-06 — Round 1 verdict: **Reject pending fixes** (6 BLOCKING + 4 MAJOR).
- 2026-05-06 — All 6 BLOCKING fixes landed in this commit, live-verified on `tenant_demo`.
- 4 MAJORs carried as Phase 2 punch list items 34 / 35 / 36 / 37.

**Cycle 22 ships clean to Round 2.** Tagging `cycle22-approved` on this commit after Round 2 APPROVED.
