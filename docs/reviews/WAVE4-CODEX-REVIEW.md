# Wave 4 Codex Review

Date: 2026-05-19

Scope:
- `m20-sis`
- `m21-classroom`
- `m22-scheduling`
- `m81-enrolment`
- `m25-curriculum`

## Step 1 - Full Suite Stability

Command run:

```bash
pnpm --filter @campusos/api test:integration
```

Result: **FAIL**

| Total Tests | Passed | Failed | Skipped |
|---:|---:|---:|---:|
| 3817 | 3807 | 1 | 9 |

Vitest summary:

```text
Test Files  1 failed | 150 passed (151)
Tests       1 failed | 3807 passed | 9 skipped (3817)
Duration    469.93s
```

Failing spec:

| Spec | Test | Error Summary |
|---|---|---|
| `apps/api/test/integration/m20-sis/attendance.spec.ts` | `integration:m20-sis/attendance > AttendanceService > student persona: getClassAttendance only sees own row` | `PrismaClientKnownRequestError`, raw SQL failed with PostgreSQL `23505`: `Key (person_id)=(019e0cf8-aaaa-7777-8888-000000000040) already exists.` The failing insert is at `attendance.spec.ts:300`, inserting `TEST_STUDENT_PERSON_ID` into `platform.platform_students` without conflict handling. |

Blocking conclusion: **Do not proceed to coverage until Step 1 has 0 failures.**

## Step 2 - Per-Module Coverage

Coverage was **not measured** because Step 1 failed. This follows the requested gate: "Do NOT proceed to coverage until 0 failures."

| Module | Target | Measured % | Suite Green? | Meets Target? |
|---|---:|---:|---|---|
| `m20-sis` | 80% | Blocked | No | Unknown |
| `m21-classroom` | 80% | Blocked | Blocked by full suite | Unknown |
| `m22-scheduling` | 80% | Blocked | Blocked by full suite | Unknown |
| `m81-enrolment` | 80% | Blocked | Blocked by full suite | Unknown |
| `m25-curriculum` | 80% | Blocked | Blocked by full suite | Unknown |

## Step 3 - Quality Checks

Static checks were performed where they did not violate the coverage gate.

| Check | `m20-sis` | `m21-classroom` | `m22-scheduling` | `m81-enrolment` | `m25-curriculum` |
|---|---|---|---|---|---|
| DB-backed, no DB mocks | Pass: no `vi.fn`/`vi.mock` hits in integration folder | Pass | Pass | Pass | Pass |
| Real state assertions | Pass: raw SQL assertions present | Pass | Pass | Pass | Pass |
| Cross-school isolation | Pass, but suite has unrelated failing m20 test | Pass | Pass | **Defect**: some tests document current leakage instead of expecting `NotFoundException`/empty | Pass |
| Codex hardening findings | Pass by static evidence | N/A | N/A | N/A | Pass by static evidence |
| Key domain scenarios | Present by static evidence, but suite not green | Present by static evidence | Present by static evidence | Present by static evidence plus cross-school defect below | Present by static evidence |
| Old mock specs removed | Pass | Pass | Pass | Pass | Pass |

### Static Evidence

- No `vi.fn`, `vi.mock`, `vi.spyOn`, `mockResolved`, or `mockImplementation` matches were found under the five Wave 4 integration directories.
- Raw SQL usage is extensive across the five Wave 4 integration directories via `$queryRawUnsafe` / `$executeRawUnsafe`, supporting DB-backed setup and DB-state assertions.
- No old `*.spec.ts` files remain inside:
  - `apps/api/src/modules/m20-sis/`
  - `apps/api/src/modules/m21-classroom/`
  - `apps/api/src/modules/m22-scheduling/`
  - `apps/api/src/modules/m81-enrolment/`
  - `apps/api/src/modules/m25-curriculum/`

### Defects

1. **Critical stability defect: m20 attendance integration test is not idempotent.**
   - `apps/api/test/integration/m20-sis/attendance.spec.ts:300`
   - The test inserts `TEST_STUDENT_PERSON_ID` into `platform.platform_students`, but that `person_id` already exists when the full suite runs.
   - The failure blocks coverage and final PASS verdict.

2. **Cross-school isolation defect: m81 application lifecycle tests assert current leakage.**
   - `apps/api/test/integration/m81-enrolment/application-lifecycle.spec.ts` documents that `ApplicationService.list()` and `getById()` do not scope by `tenant.schoolId`.
   - The tests currently expect School A to see/fetch School B applications. The requested quality bar requires NotFoundException or empty results.

3. **Cross-school isolation defect: m81 enrolment periods tests assert current leakage.**
   - `apps/api/test/integration/m81-enrolment/enrolment-periods.spec.ts` documents that `EnrollmentPeriodService.list()` / `getById()` do not scope by `tenant.schoolId`.
   - The test currently expects School A list results to include School B periods.

## Codex Hardening Findings

Static audit found coverage for the required Codex hardening scenarios:

- `m20-sis/custom-fields`: cross-school `entityId` rejection is covered in `custom-fields.spec.ts`.
- `m20-sis/student-notes`: cross-school `create` / `listForStudent` / student existence school validation paths are covered in `student-notes.spec.ts`.
- `m25-curriculum/maps`: cross-school map/unit/standard/lesson/reorder findings are covered across `maps-crud.spec.ts`, `standards-alignment.spec.ts`, and `lessons.spec.ts`.

## Verdict

**FAIL**

PASS criteria were not met:

- Full suite has 1 failure.
- Coverage was blocked and therefore cannot prove all five modules are at least 80%.
- m81 enrolment has cross-school isolation tests that document production leakage instead of asserting rejection/empty results.
- Old mock specs are removed.
- Codex hardening findings appear covered by static audit.

## Prioritized Fix List

1. Fix `m20-sis/attendance.spec.ts` idempotency by reusing or upserting the `platform.platform_students` row for `TEST_STUDENT_PERSON_ID`, or cleaning that row deterministically before insertion without breaking other tests.
2. Re-run `pnpm --filter @campusos/api test:integration` and require 0 failures.
3. Fix `ApplicationService.list()` / `getById()` in `m81-enrolment` to scope by `school_id`; then flip the BUG tests to expect empty list / `NotFoundException`.
4. Fix `EnrollmentPeriodService.list()` / `getById()` in `m81-enrolment` to scope by `school_id`; then flip the BUG test to expect School B rows absent from School A context.
5. After the full suite is green, run the requested per-module coverage loop and update this review with measured statement totals, covered statements, and percentages.
