# P2C3 — Health Advanced (M23 Health .1) — HANDOFF

**Status:** COMPLETE + APPROVED at the closeout commit (REVIEW-P2C3
Round 3 — final verdict, 2026-05-09).

Tagged `p2c3-complete` at `4ad1dc2` (the Round 2 fix that earned PASS)
and `p2c3-approved` at the closeout commit. Round 3 returned PASS with
one non-blocking hardening note: tighten the guardian-link probe in
`getForStudent()` to school-scope through `sis_students` for shape
consistency with the student-self path. The closeout commit applies
that cleanup — `sis_student_guardians sg JOIN sis_guardians g` now
also JOINs `sis_students s ON s.id = sg.student_id` and adds
`WHERE s.school_id = $tenant.schoolId` so cross-school guardian-id
collisions collapse at the relationship gate rather than at the
later compliance-row read. Tests stay 133/133 — the existing fake
SQL probe matchers correctly identify the new join shape via the
`from sis_student_guardians` prefix.

**Plan:** `docs/campusos-p2c3-health-advanced.html`
**CAT:** `docs/p2c3-cat-script.md`
**Review notes:** `P2C3-REVIEW-NOTES.md`

## Step status

| #   | Step                                                                     | State |
| --- | ------------------------------------------------------------------------ | ----- |
| 1   | Migration `109_hlth_advanced.sql` — 6 tables + access-log enum extension | DONE  |
| 2   | Seed `seed-health-advanced.ts` + IAM HLT-006 grants                      | DONE  |
| 3   | TelehealthProviderService + TelehealthSessionService                     | DONE  |
| 4   | ImmunisationRequirementService + ComplianceService + nightly Worker      | DONE  |
| 5   | ScreeningReferralService                                                 | DONE  |
| 6   | Health UI: telehealth + immunisation + screening referrals               | DONE  |
| 7   | Vertical-slice CAT script                                                | DONE  |
| 8   | State compliance CSV report endpoint                                     | DONE  |
| 9   | CI parity (format / lint:logs / vitest / API build / web build)          | DONE  |
| 10  | HANDOFF + CLAUDE.md + REVIEW notes                                       | DONE  |
| 11  | Git commit + push                                                        | DONE  |
| 12  | REVIEW-P2C3 Round 1 fixes — 3 BLOCKING + 1 actionable MAJOR              | DONE  |
| 13  | REVIEW-P2C3 Round 2 fix — residual getForStudent privacy boundary        | DONE  |
| 14  | REVIEW-P2C3 Round 3 PASS + closeout — guardian-probe school-scope        | DONE  |

## What landed

### Schema (Step 1 — `packages/database/prisma/tenant/migrations/109_hlth_advanced.sql`)

6 new logical base tables under the existing `hlth_*` prefix from
Cycle 10:

1. **`hlth_telehealth_providers`** — per-school provider directory.
   2-value `is_active` flag, optional `booking_url`, `speciality`,
   `notes`. UNIQUE(school_id, provider_name) so the same school
   doesn't carry two rows for the same vendor.

2. **`hlth_telehealth_sessions`** — per-session state machine.
   5-value `status` CHECK SCHEDULED/IN_PROGRESS/COMPLETED/NO_SHOW/
   CANCELLED. **Multi-column `completed_chk`** keeps `started_at` +
   `ended_at` + `cancellation_reason` in lockstep with status —
   COMPLETED requires both timestamps; CANCELLED requires
   `cancellation_reason`; SCHEDULED/IN_PROGRESS/NO_SHOW reject
   timestamps. Soft `student_id` to `sis_students(id)` per
   ADR-001/020. `consent_received_at` is the parent-consent timestamp
   gating actual session start.

3. **`hlth_telehealth_documents`** — signed-S3-URL doc references.
   5-value `document_type` CHECK SESSION_NOTES/TREATMENT_PLAN/
   REFERRAL_LETTER/CONSENT/OTHER. CASCADE on parent session.

4. **`hlth_immunisation_requirements`** — per-(state, school)
   catalogue. `school_id IS NULL` rows are platform-tier defaults
   (clone-only — service refuses PATCH); `school_id IS NOT NULL`
   rows are tenant-tier overrides. UNIQUE INDEX on
   `(COALESCE(school_id, sentinel), state_code, vaccine_name)` so
   each state-vaccine pair can hold one default + N school overrides.
   Allowed exemption types stored as `TEXT[]` per ADR-001/020.

5. **`hlth_immunisation_compliance`** — materialised per-(student,
   academic_year_id) row maintained by the worker. UNIQUE INDEX on
   `(student_id, COALESCE(academic_year_id, sentinel))` so re-runs
   UPSERT idempotently. 4-value `status` CHECK COMPLIANT/
   NON_COMPLIANT/EXEMPT/PROVISIONAL. **Multi-column `exempt_chk`**
   pins exemption shape to one of three legal patterns: COMPLIANT/
   NON_COMPLIANT requires `exemption_type IS NULL` AND `exemption_doc_s3_key IS NULL`;
   EXEMPT requires `exemption_type IS NOT NULL`; PROVISIONAL accepts
   either shape. `missing_vaccines JSONB DEFAULT '[]'::jsonb` carries
   the per-vaccine breakdown the dashboard renders.

6. **`hlth_screening_referrals`** — referral tracker spawned from
   the existing `hlth_screenings` table. 4-value `referral_type`
   CHECK VISION/HEARING/SCOLIOSIS/OTHER. 3-value `status` CHECK
   REFERRED/FOLLOW_UP_COMPLETE/LOST_TO_FOLLOW_UP. **Multi-column
   `outcome_chk`** keeps `follow_up_outcome` + `follow_up_date`
   populated only when `status='FOLLOW_UP_COMPLETE'`. CASCADE on
   parent screening.

Plus: ALTER TABLE on `hlth_health_access_log` adds `VIEW_TELEHEALTH`
to the existing 9-value `access_type` CHECK so HIPAA audit rows
written by `TelehealthSessionService` land cleanly. Used the
splitter-safe `DROP CONSTRAINT IF EXISTS … ; ADD CONSTRAINT …`
pattern. **Splitter trap fix:** the original block-comment header
contained "school_id NULL = state-level default; school_id NOT NULL"
— rewrote with "and" to dodge the well-known `;`-in-string
splitter trap from prior cycles.

**Migration number collision:** plan said 101, but slot 101 was
taken by the Cycle 31 partition activation work. Used 109. Tenant
logical base table count: 195 → **201** (was 195 after P2C2).

15 schema assertions all green on first provision attempt after
audit. **Eighteenth migration in a row to clear the splitter trap
on first attempt after audit.**

### Permission catalogue (Step 2 — `packages/database/data/permissions.json`)

The plan referred to "HLT-005 Telehealth" but the live catalogue
already has `HLT-005 = "Dietary Profiles & Allergens"` (Cycle 10).
Added a **new code `HLT-006 (Telehealth)`** under group "Health &
Wellness" instead of clobbering the existing one. Catalogue
permission count: 495 → **498** (149 + 1 functions × 3 tiers).

`seed-iam.ts` updated:

- Staff role gains `HLT-006:read+write` (covers the school nurse
  persona — the operator scheduling sessions, verifying consent,
  attaching documents).
- School Admin and Platform Admin retain admin-tier on every code
  via the existing `everyFunction` wildcard — no per-role grant
  needed.
- Other personas (Teacher / Student / Parent) intentionally
  **NOT** granted any HLT-006 tier — telehealth coordination is a
  health-staff workflow.

The existing HLT-001/HLT-002/HLT-004 grants from Cycle 10 cover the
immunisation + screening surfaces (compliance gated on hlt-001:read;
recompute + state report gated on hlt-001:admin via everyFunction;
screening referrals gated on hlt-004:read/write).

### Seed (Step 2 — `packages/database/src/seed-health-advanced.ts`)

Idempotent, gated on `hlth_telehealth_providers` row count. Wired
as `seed:health-advanced` and appended to `seed-all`.

- 2 providers (BetterMynd — Mental Health; School Telehealth Network
  — Pediatrics).
- 2 sessions (1 SCHEDULED for Maya next week; 1 COMPLETED for Aiden
  Johnson last week with consent timestamp + ended_at populated per
  the lockstep rule).
- 1 telehealth document (SESSION_NOTES on the COMPLETED session).
- 6 Kansas immunisation requirements as platform defaults
  (school_id IS NULL): DTaP × 5, MMR × 2, IPV × 4, Varicella × 2,
  HepB × 3, Tdap × 1. 5 of 6 allow MEDICAL/RELIGIOUS exemption;
  Tdap allows none.
- 10 compliance rows for the existing seeded students:
  - 7 COMPLIANT (empty `missing_vaccines`)
  - 2 NON_COMPLIANT (1 missing MMR dose, 1 missing IPV dose)
  - 1 EXEMPT (RELIGIOUS, with `exemption_doc_s3_key` set)
- 3 screening referrals from the seeded `hlth_screenings` rows:
  - Maya VISION → REFERRED to local optometrist, follow-up 2026-05-15
  - Ethan HEARING → REFERRED, follow-up 2026-05-20 (intentionally
    overdue at the time of the CAT run)
  - Aiden SCOLIOSIS → FOLLOW_UP_COMPLETE with NORMAL outcome

**Bug caught + fixed:** initial draft tried to look up "Aiden Park"
but the seeded student is "Aiden Johnson". Fixed before commit.

### Backend (Steps 3 + 4 + 5)

`apps/api/src/health-advanced/` — new module with **5 services + 1
worker + 1 controller + 20 endpoints + 1 Kafka emit topic
(`hlth.immunisation.noncompliant`)**:

- **`TelehealthProviderService`** — list / getById / create / patch +
  `loadActiveOrFail` helper for FK resolution. Gated on hlt-006:read
  / write.

- **`TelehealthSessionService`** — schedule / list / getById / patch
  / recordConsent / listDocuments / uploadDocument. **HIPAA keystone:
  every list + getById writes one `hlth_health_access_log` row per
  session returned with `access_type='VIEW_TELEHEALTH'` BEFORE the
  service returns its DTO** — matches the Cycle 10 audit-log
  contract. Multi-column lockstep enforced at the service: COMPLETED
  status auto-stamps `ended_at`; CANCELLED requires `cancellationReason`;
  SCHEDULED/IN_PROGRESS reject already-completed transitions.

- **`ImmunisationRequirementService`** — list (filtered by stateCode
  with platform default + school override merged) / getById / create
  / patch + `loadActiveForCompute(stateCode)` for the compliance
  worker. Patch on a row where `school_id IS NULL` returns 403
  ("Platform-tier defaults cannot be edited; clone with a school_id
  override"). UNIQUE catch surfaces friendly 400.

- **`ImmunisationComplianceService`** — `dashboard()` / `list({status, grade})` /
  `getForStudent(studentId)` / `runManually({studentId?})` /
  `computeForSchool()` / `stateReportCsv()`. **Two structural keystones**:
  (1) **UPSERT idempotency**: per-(student, academic_year_id) row
  flips between COMPLIANT/NON_COMPLIANT on every recompute; a re-run
  on unchanged seed data writes `computed = N, newlyNonCompliant = 0`.
  (2) **Manual flag preservation**: rows manually set to EXEMPT or
  PROVISIONAL by the nurse are preserved across recompute — the
  worker only flips status when the calculated COMPLIANT/NON_COMPLIANT
  decision changes. Newly NON_COMPLIANT rows emit
  `hlth.immunisation.noncompliant` AFTER the tx commits with payload
  `{schoolId, studentId, missingVaccines, computedAt}` — the future
  Cycle 14 (Communications fan-out) consumer is the natural home for
  parent / nurse notification routing.

- **`ImmunisationComplianceWorker`** — nightly cron-style worker
  registered in `HealthAdvancedModule.onModuleInit`. Walks every
  active school via `platform.schools + platform_tenant_routing` and
  calls `compliance.computeForSchool()` per tenant. Configurable via
  env: `IMMUNISATION_COMPLIANCE_DISABLED=true` to skip in test/dev,
  `INTERVAL_MS` (default 86_400_000 = 24h), `WARMUP_MS` (default
  60_000 = 1m grace before first tick).

- **`ScreeningReferralService`** — `createFromScreening(screeningId)`
  / `list({status, referralType, studentId})` / `getById` /
  `patch` (FOLLOW_UP_COMPLETE requires both `followUpDate` AND
  `followUpOutcome`; LOST_TO_FOLLOW_UP just flips status; the schema
  `outcome_chk` is the belt-and-braces at the DB layer) / `overdue()`
  (status=REFERRED with follow_up_date in the past). Sets parent
  screening's `follow_up_required=true` on referral creation so the
  Cycle 10 dashboard light flips on.

`HealthAdvancedModule` imports `HealthRecordsModule` to reuse the
existing `HealthAccessLogService` for HIPAA writes; `TenantModule` +
`IamModule` + `KafkaModule` + `RolesModule` standard. Wired into
`AppModule` between `IncidentsModule` and the global guards.

### Web UI (Step 6)

3 new routes under the existing `Health` launchpad tile (no new
tile):

- **`/health/telehealth`** — provider directory + scheduling. Add-
  provider form (hlt-006:write only) + schedule-session form +
  sessions table with status pills and per-row Mark-complete /
  Cancel-with-reason actions.

- **`/health/immunisation`** — compliance dashboard. 5-stat header
  card with auto-tone compliance % colour (rose < 85% / amber 85–94%
  / emerald ≥ 95%) + non-compliant student list with missing-vaccines
  detail + admin-only Recompute button + Export-state-CSV link
  (anchor to `/api/v1/health/immunisation/compliance/report`) +
  Kansas requirements table at the bottom.

- **`/health/screenings/referrals`** — referral tracker. Overdue
  callout at top (rose-tinted, status=REFERRED with follow_up_date
  in the past). Status + type filter chips. Per-row Record-outcome
  inline editor (outcome dropdown + date input + Save / Lost-to-
  follow-up).

3 new format helpers in `apps/web/src/lib/health-advanced-format.ts`
(label maps + pill class maps + isOverdue / formatDateOnly /
formatDateTime). 20+ new React Query hooks in
`apps/web/src/hooks/use-health-advanced.ts`.

**Type-naming carry-over from Cycle 11 collision:** ReferralStatus /
ReferralType / ReferralOutcome already exist in `types.ts` as the
Cycle 11 Counselling Referral enums. P2C3 uses
`ScreeningReferralStatus` / `ScreeningReferralType` /
`ScreeningReferralOutcome` to namespace the screening-domain
variants without clobbering Counselling.

### Tests

`apps/api/src/health-advanced/health-advanced.spec.ts` — 18 unit
tests covering all keystones with a stubbed `TenantPrismaService`
that captures SQL + args:

- TelehealthSessionService: SCHEDULED list paths, HIPAA audit row
  per-session-returned, COMPLETED stamps endedAt, CANCELLED requires
  reason.
- ImmunisationComplianceService: UPSERT idempotency under re-run,
  EXEMPT/PROVISIONAL preservation, newly NON_COMPLIANT emits
  `hlth.immunisation.noncompliant`, dashboard rollup math counts
  EXEMPT as in-compliance.
- ScreeningReferralService: FOLLOW_UP_COMPLETE rejects without
  outcome, accepts with outcome+date, overdue path filters
  status=REFERRED.

Vitest suite 104 → **122 tests passing** at the original Step 9 cut.
After the REVIEW-P2C3 Round 1 fixes (Step 12 below), the suite grew
to **126 passing tests** (+4: CANCELLED-without-reason rejection,
CANCELLED-with-reason happy path, controller permission-metadata
gate for school-wide compliance, and the expanded
`hlth.immunisation.noncompliant` payload contract test). The Round 2
follow-up (Step 13) added **7 more tests** for the per-student
compliance access matrix — total **133 passing tests**.

## REVIEW-P2C3 Round 2 fix log (Step 13)

Round 2 against `bef641e` returned **FAIL** with 1 residual BLOCKING:
`getForStudent()` allowed any non-GUARDIAN actor with `hlt-001:read`
to fetch a student's full immunisation compliance record by UUID.
Since teachers hold `hlt-001:read` from Cycle 10 (allergies summary),
they could read arbitrary students' compliance — a health-data
privacy violation despite the Round 1 narrowing of the school-wide
endpoints.

**Fix.** `ImmunisationComplianceService.getForStudent(studentId, actor)`
rewritten with explicit per-actor-type gating inside one
`executeInTenantContext` block:

- **School admin**: full access (bypasses both relationship + HLT-007).
- **GUARDIAN**: SQL probe through `sis_student_guardians` +
  `sis_guardians.person_id = actor.personId` against the supplied
  `studentId` (unchanged — the only path that already worked).
- **STUDENT**: SQL probe through `sis_students` JOIN
  `platform.platform_students ps ON ps.id = s.platform_student_id`
  matching `ps.person_id = actor.personId` AND `s.school_id = $tenant`
  AND `s.id = $studentId` — covers the cross-school edge case where
  a student id from a different tenant won't resolve.
- **STAFF (or anything else)**: requires one of `hlt-007:read` /
  `hlt-007:write` / `hlt-007:admin`. Generic teachers without HLT-007
  fall through to `404 Compliance record not found` —
  don't-leak-existence per the convention.
- **Anything else**: 404.

The controller-level gate stays at `hlt-001:read` because parents +
students legitimately reach this endpoint without holding HLT-007;
the service layer is now the actual access boundary, and `hlt-001:read`
is no longer a pass-through for staff actors.

7 new regression tests assert the full access matrix:

- Teacher (STAFF, no HLT-007) → 404.
- Staff with HLT-007:read → 200 (any student).
- Guardian linked via `sis_student_guardians` → 200 (linked child).
- Guardian unlinked → 404.
- Student fetching own row → 200.
- Student fetching another student → 404.
- School admin (no HLT-007, no relationship) → 200 (admin bypass).

Tests use a fake `permissions.hasAnyPermissionInTenant` whose `codes`
arg is inspected to grant `hlt-007:*` only when the test opts in,
plus a SQL fake that returns the link probe rows or the compliance
row depending on which SELECT is hit.

CI parity green: format:check + lint:logs (556 files clean) +
vitest 133/133 + API + web build all clean.

## REVIEW-P2C3 Round 1 fix log (Step 12)

Round 1 against `ffab646` returned **FAIL** with 3 BLOCKING + 4
MAJOR. The closeout fix commit lands all 3 BLOCKING + the actionable
MAJOR (school-scoped student validation in telehealth scheduling +
post-insert reload). Remaining MAJORs (compliance row uniqueness
including `school_id` for shared-schema future-proofing; ID-only
post-insert reloads in places not flagged in the BLOCKINGs;
integration-level authorization tests beyond the controller metadata
assertions) move to the Phase 2 backlog per the reviewer's gate
decision.

### BLOCKING #1 — narrowing school-wide immunisation compliance

`GET /health/immunisation/compliance`, `/dashboard`, and `/report`
were gated on `hlt-001:read`, which Parent / Student / Teacher all
hold via Cycle 10 grants. The reviewer correctly flagged this as a
school-wide health-data privacy violation.

**Fix.** New permission code `HLT-007 (Immunisation Compliance)`
added to `packages/database/data/permissions.json`. Catalogue
498 → **501** (1 new function × 3 tiers). `seed-iam.ts` grants
`HLT-007:read+write` to Staff (the school-nurse persona); School
Admin and Platform Admin pick up admin-tier through `everyFunction`.
Parent / Student / Teacher are intentionally NOT granted any
HLT-007 tier.

Controller endpoints re-gated:

- `GET /health/immunisation/compliance` → `hlt-007:read`
- `GET /health/immunisation/compliance/dashboard` → `hlt-007:read`
- `GET /health/immunisation/compliance/report` → `hlt-007:read`
- `POST /health/immunisation/compliance/run` → `hlt-007:admin`

The narrower per-student endpoint
`GET /health/immunisation/compliance/:studentId` keeps `hlt-001:read`
because the service-layer `getForStudent(studentId, actor)` already
enforces guardian-link verification via `sis_student_guardians` for
non-admin GUARDIAN actors and STAFF / nurse pass-through; non-linked
callers get a collapsed 404. `assertAdmin` in the service was
re-pointed at `hlt-007:admin` to match.

Two new regression tests in `health-advanced.spec.ts` use
`Reflect.getMetadata(PERMISSIONS_KEY, ...)` on the controller proto
to assert the gating contract — future renames cannot silently fall
back to the broader code.

### BLOCKING #2 — `hlth.immunisation.noncompliant` event contract

Implementation emitted `sourceModule: 'health'` (should be
`'health-advanced'`) and a payload of `{studentId, schoolId,
sourceRefId, detectedAt}` (should be `{schoolId, studentId,
missingVaccines, computedAt}`). The `void this.emitNoncompliant(...)`
call also lived inside the `executeInTenantTransaction` callback,
which is the same transaction-boundary ambiguity P2C2 was flagged
for.

**Fix.** `computeForSchool` now collects
`{studentId, missingVaccines, computedAt}` tuples inside the tx,
returns `{computed, pending}` from the tx callback, and chains a
`.then(async ({computed, pending}) => {...})` block that emits each
event AFTER the tx resolves. The emit shape is now exactly:

```ts
await kafka.emit({
  topic: 'hlth.immunisation.noncompliant',
  key: studentId,
  sourceModule: 'health-advanced',
  payload: { schoolId, studentId, missingVaccines, computedAt },
});
```

Existing emit-shape test rewritten to assert `sourceModule`,
`schoolId`, `studentId`, `missingVaccines` array shape (vaccineName

- dosesRequired + dosesReceived), and a parseable `computedAt`
  timestamp.

### BLOCKING #3 — CANCELLED telehealth sessions require a reason

Migration 109 only enforced `cancelled_at NOT NULL` for `CANCELLED`,
not a non-empty `cancellation_reason`. The service layer also
allowed cancellation without a reason.

**Fix at the service layer (`telehealth-session.service.ts`):**

```ts
if (target === 'CANCELLED') {
  const reason = input.cancellationReason?.trim();
  if (!reason) {
    throw new BadRequestException('CANCELLED telehealth sessions require cancellationReason.');
  }
  sets.push('cancelled_at = now()');
  push('cancellation_reason', reason);
}
```

**Fix at the schema layer (new migration
`110_hlth_telehealth_cancelled_reason.sql`):** splitter-safe DROP +
ADD pattern tightens `hlth_th_sessions_cancelled_chk` to require
`cancellation_reason IS NOT NULL AND length(trim(cancellation_reason)) > 0`
when status is CANCELLED, and to require both columns NULL when
status is anything else. The ALTER is idempotent across re-provisions.

Two new regression tests cover the CANCELLED-without-reason
rejection (both empty + whitespace-only) and a CANCELLED-with-reason
happy path that verifies the UPDATE statement carries
`cancelled_at = now()` + the reason argument.

### MAJOR — school-scoped student validation in telehealth schedule

`TelehealthSessionService.schedule()` validated the student id with
`SELECT id FROM sis_students WHERE id = $1::uuid`. Tenant schemas
physically isolate one school per tenant today, but P2 reviews have
consistently required explicit `school_id` validation on direct-
object references for defence-in-depth.

**Fix.** Validator now reads
`SELECT id FROM sis_students WHERE school_id = $1::uuid AND id = $2::uuid`.
The post-insert reload at the end of `schedule()` was also tightened
from `WHERE s.id = $1::uuid` to
`WHERE s.school_id = $1::uuid AND s.id = $2::uuid` for consistency
with the rest of the isolation pattern.

## CI parity (Step 9)

| gate                                | result                                                 |
| ----------------------------------- | ------------------------------------------------------ |
| `pnpm format:check`                 | ✓ clean                                                |
| `pnpm lint:logs`                    | ✓ 556 files clean                                      |
| `pnpm --filter @campusos/api test`  | ✓ 133/133 passing (Round 1: 122 → 126; Round 2: → 133) |
| `pnpm --filter @campusos/api build` | ✓ clean                                                |
| `pnpm --filter @campusos/web build` | ✓ clean                                                |

## Reviewer attention items (carried to Phase 2 backlog)

1. **`hlth.immunisation.noncompliant` consumer** — the Kafka emit
   lands cleanly but no consumer fans the event out to a parent /
   nurse notification. Cycle 14 Communications + a Phase 2 polish
   item are the natural home.
2. **Telehealth document upload** — uses the signed-S3-URL pattern
   from Cycle 4 `hr_employee_documents`. Actual S3 wiring is Phase 3
   ops; dev mode stores the key string only.
3. **Multi-state CSV column maps** — the state-report CSV
   hard-codes Kansas column ordering. The endpoint accepts
   `?stateCode=` query param to switch catalogues but downstream
   state-specific column maps land when a second state onboards.
4. **Live-run verification** — the CAT script
   (`docs/p2c3-cat-script.md`) carries copy-paste shell blocks but
   was not executed against `tenant_demo` in this build run. Live
   verification is recommended before the peer review verdict tags
   `p2c3-approved`.

## Migration history

- `109_hlth_advanced.sql` — splitter audit caught one stray `;` in
  the block-comment header ("school_id NULL = state-level default;
  school_id NOT NULL"). Rewrote with "and" before first provision
  attempt. First-attempt clean.
- IAM seed: added HLT-006 grant to Staff role. Effective access
  cache rebuild reports +2 perms on every active Staff persona
  (counsellor + vp).

## Tenant base table count

195 → **201** (after P2C2's 195; +6 new logical `hlth_*` tables;
the `hlth_health_access_log` ALTER doesn't change the count).
