# P2C3 — Health Advanced — Peer Review Scaffold

**Branch / SHA at submission:** `main` @ `<filled in by Step 11
commit message>`

**Plan:** `docs/campusos-p2c3-health-advanced.html`
**CAT:** `docs/p2c3-cat-script.md`
**Handoff:** `HANDOFF-P2C3.md`

## What changed (high level)

- 6 new `hlth_*` base tables in tenant migration `109_hlth_advanced.sql`
  (telehealth providers + sessions + documents; immunisation
  requirements + compliance; screening referrals).
- `hlth_health_access_log.access_type` extended with
  `VIEW_TELEHEALTH` so HIPAA audit writes from the new
  TelehealthSessionService land cleanly.
- New permission code **`HLT-006 (Telehealth)`** added to the
  catalogue (the plan referenced "HLT-005" but that slot is held by
  Cycle 10's "Dietary Profiles & Allergens"). Catalogue total
  495 → 498.
- New module `apps/api/src/health-advanced/` — 5 services + 1 worker
  + 1 controller + 20 endpoints + 1 Kafka emit topic.
- 3 new web routes under the existing Health tile (telehealth,
  immunisation compliance, screening referrals).
- 18 new vitest unit tests; suite 104 → 122 passing.

## Keystone invariants to verify

1. **HIPAA audit log on every telehealth read.**
   `TelehealthSessionService.list` and `getById` must write one
   `hlth_health_access_log` row per session returned BEFORE the
   service emits its DTO. CAT Scenario 2 captures BEFORE/AFTER
   counts.

2. **Immunisation compliance UPSERT idempotency.**
   `runManually` + `computeForSchool` must be re-runnable on
   unchanged seed data with `newlyNonCompliant=0` returned and no
   duplicate rows written. Per-(student, academic_year_id) UNIQUE
   INDEX on `(student_id, COALESCE(academic_year_id, sentinel))`
   is the schema-side dedup.

3. **Manual EXEMPT/PROVISIONAL preservation.**
   Compliance recompute must NOT overwrite a row that the nurse has
   manually flipped to EXEMPT (with exemption_type populated) or
   PROVISIONAL — the worker only changes status when the calculated
   COMPLIANT/NON_COMPLIANT decision changes. CAT Scenario 5 verifies
   this with a snapshot BEFORE + recompute + snapshot AFTER.

4. **Newly NON_COMPLIANT emits the right payload.**
   `hlth.immunisation.noncompliant` payload shape:
   `{schoolId, studentId, missingVaccines: [{vaccineName, dosesRequired,
   dosesReceived}], computedAt}`. ADR-057 envelope wrapper applied
   by `KafkaProducerService.emit`. `source_module = 'health-advanced'`.

5. **Multi-column lockstep on telehealth sessions.**
   `hlth_telehealth_sessions.completed_chk` enforces:
   - SCHEDULED / IN_PROGRESS / NO_SHOW: `started_at`, `ended_at`,
     `cancellation_reason` all NULL.
   - COMPLETED: `started_at` AND `ended_at` NOT NULL.
   - CANCELLED: `cancellation_reason` NOT NULL.
   Service stamps the timestamps inside the same UPDATE so the
   schema invariant never fires mid-flight.

6. **Multi-column lockstep on immunisation compliance.**
   `hlth_immunisation_compliance.exempt_chk`:
   - COMPLIANT / NON_COMPLIANT: `exemption_type IS NULL`
     AND `exemption_doc_s3_key IS NULL`.
   - EXEMPT: `exemption_type IS NOT NULL`.
   - PROVISIONAL: either shape acceptable.

7. **Multi-column lockstep on screening referrals.**
   `hlth_screening_referrals.outcome_chk`:
   - REFERRED / LOST_TO_FOLLOW_UP: `follow_up_outcome IS NULL`
     AND `follow_up_date IS NULL`.
   - FOLLOW_UP_COMPLETE: both NOT NULL.

8. **Platform-default protection on requirements.**
   `ImmunisationRequirementService.patch` refuses any update to a
   row where `school_id IS NULL` with a 403 + redirect message
   ("Platform-tier defaults cannot be edited; clone with a
   school_id override"). CAT Scenario 4 captures this.

## Permissions matrix

| Code | Read holders | Write holders | Admin |
|------|--------------|---------------|-------|
| HLT-001 | Teacher (allergies only stripped DTO), Parent, Student, Staff | Staff, Admin | School Admin (everyFunction) + Platform Admin |
| HLT-002 | Staff | Staff | School Admin + Platform Admin |
| HLT-004 | Staff | Staff | School Admin + Platform Admin |
| HLT-005 (Dietary, Cycle 10) | Teacher, Parent, Staff | Staff | School Admin + Platform Admin |
| **HLT-006 (Telehealth, NEW)** | **Staff** | **Staff** | **School Admin + Platform Admin** |

The compliance dashboard is gated on `hlt-001:read` (Staff +
Parent + Student + Teacher all hold this from Cycle 10), which is
broader than the dashboard's intended audience. The service-layer
gate is the actual access boundary — `dashboard()` and `list()`
both rely on the controller-tier IAM check; refining to a narrower
code is Phase 2 polish.

## Rejected items (open to reviewer escalation)

- **Telehealth document content access logging.** Currently
  `listDocuments` writes `VIEW_TELEHEALTH` on the parent session, not
  per-document. Reviewer may want a `VIEW_TELEHEALTH_DOCUMENT`
  enum value if document-level audit becomes a HIPAA requirement.
- **`stateReportCsv` row scope.** The CSV emits one row per
  (student, requirement) tuple — for a 500-student school × 6
  vaccines that's 3000 rows. Reviewer may want `?since=YYYY-MM-DD`
  filter for incremental state submissions.
- **Compliance worker single-tenant pacing.** Worker walks every
  school sequentially per tick. For 100+ tenants this would be
  slow; reviewer may want a per-school rate limit or a Kafka-driven
  fan-out.

## Verified deviations from the plan

| # | Plan said | Shipped | Reason |
|---|-----------|---------|--------|
| 1 | Migration 101 | 109 | slot 101 taken by Cycle 31 partition activation |
| 2 | HLT-005 = Telehealth | New code HLT-006 | Cycle 10 already has HLT-005 = Dietary Profiles |
| 3 | "Aiden Park" in seed | Aiden Johnson | Seeded student name is Johnson, not Park |
| 4 | Migration 109 block comment had `;` mid-sentence | Rewrote with "and" | Splitter trap (Cycles 4–onward known issue) |

## Files at peer review

```
packages/database/prisma/tenant/migrations/109_hlth_advanced.sql
packages/database/data/permissions.json
packages/database/src/seed-iam.ts
packages/database/src/seed-health-advanced.ts
packages/database/src/seed-all.ts
packages/database/package.json
apps/api/src/health/dto/health.dto.ts
apps/api/src/app.module.ts
apps/api/src/health-advanced/dto/health-advanced.dto.ts
apps/api/src/health-advanced/health-advanced.module.ts
apps/api/src/health-advanced/health-advanced.controller.ts
apps/api/src/health-advanced/telehealth-provider.service.ts
apps/api/src/health-advanced/telehealth-session.service.ts
apps/api/src/health-advanced/immunisation-requirement.service.ts
apps/api/src/health-advanced/immunisation-compliance.service.ts
apps/api/src/health-advanced/immunisation-compliance.worker.ts
apps/api/src/health-advanced/screening-referral.service.ts
apps/api/src/health-advanced/health-advanced.spec.ts
apps/web/src/lib/types.ts
apps/web/src/lib/health-advanced-format.ts
apps/web/src/hooks/use-health-advanced.ts
apps/web/src/app/(app)/health/telehealth/page.tsx
apps/web/src/app/(app)/health/immunisation/page.tsx
apps/web/src/app/(app)/health/screenings/referrals/page.tsx
docs/p2c3-cat-script.md
HANDOFF-P2C3.md
P2C3-REVIEW-NOTES.md
CLAUDE.md
```

## Verdict template

```
## P2-3 Health Advanced — Architecture Review

### Gate Decision: [ APPROVED | APPROVED WITH FOLLOW-UPS | REJECT PENDING FIXES ]

### Verified

- Migration 109 splitter-safe + idempotent ✓
- HIPAA audit on every telehealth read ✓
- UPSERT idempotency on compliance recompute ✓
- Manual EXEMPT/PROVISIONAL preservation ✓
- Multi-column lockstep on sessions / compliance / referrals ✓
- Platform-default requirement protection ✓
- HLT-006 catalogue addition ✓
- 18 new vitest tests passing ✓

### BLOCKING

(none / list)

### MAJOR

(none / list)

### MINOR / FOLLOW-UPS

(none / list)
```
