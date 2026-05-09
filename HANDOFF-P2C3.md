# P2C3 — Health Advanced (M23 Health .1) — HANDOFF

**Status:** COMPLETE pending peer review.

**Plan:** `docs/campusos-p2c3-health-advanced.html`
**CAT:** `docs/p2c3-cat-script.md`
**Review notes:** `P2C3-REVIEW-NOTES.md`

## Step status

| # | Step | State |
|---|------|-------|
| 1 | Migration `109_hlth_advanced.sql` — 6 tables + access-log enum extension | DONE |
| 2 | Seed `seed-health-advanced.ts` + IAM HLT-006 grants | DONE |
| 3 | TelehealthProviderService + TelehealthSessionService | DONE |
| 4 | ImmunisationRequirementService + ComplianceService + nightly Worker | DONE |
| 5 | ScreeningReferralService | DONE |
| 6 | Health UI: telehealth + immunisation + screening referrals | DONE |
| 7 | Vertical-slice CAT script | DONE |
| 8 | State compliance CSV report endpoint | DONE |
| 9 | CI parity (format / lint:logs / vitest / API build / web build) | DONE |
| 10 | HANDOFF + CLAUDE.md + REVIEW notes | DONE |
| 11 | Git commit + push | PENDING |

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

- **`ImmunisationComplianceService`** — `dashboard()` /  `list({status, grade})` /
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

Vitest suite 104 → **122 tests passing** (13 spec files; +18 new).

## CI parity (Step 9)

| gate | result |
|------|--------|
| `pnpm format:check` | ✓ clean |
| `pnpm lint:logs` | ✓ 556 files clean |
| `pnpm --filter @campusos/api test` | ✓ 122/122 passing |
| `pnpm --filter @campusos/api build` | ✓ clean |
| `pnpm --filter @campusos/web build` | ✓ clean |

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
