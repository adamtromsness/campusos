# Wave 7 Integration Test Review

Date: 2026-05-20

Scope: `m64-clubs`, `m66-athletics`, `m103-groups`, `m100-engagement`, `m101-events`, `m102-alumni`, `m85-accreditation`.

## Step 1 - Full Suite Stability

Command:

```bash
pnpm --filter @campusos/api test:integration
```

Result: PASS

| Total Tests | Passed | Failed | Skipped |
|---:|---:|---:|---:|
| 6317 | 6300 | 0 | 17 |

Vitest summary: `Test Files 251 passed (251)`, `Tests 6300 passed | 17 skipped (6317)`.

## Step 2 - Per-Module Coverage

Initial combined coverage loop hit a transient Prisma `P1001` connection failure before test execution; Docker showed Postgres healthy, and each module was rerun individually with successful coverage summaries below.

| Module | Statements Covered | Total Statements | Measured % |
|---|---:|---:|---:|
| `m64-clubs` | 2236 | 2283 | 97.94% |
| `m66-athletics` | 5751 | 6129 | 93.83% |
| `m103-groups` | 2953 | 3029 | 97.49% |
| `m100-engagement` | 1931 | 2096 | 92.12% |
| `m101-events` | 2042 | 2084 | 97.98% |
| `m102-alumni` | 1655 | 1694 | 97.69% |
| `m85-accreditation` | 1356 | 1401 | 96.78% |

## Step 3 - Quality Checks

| Check | m64-clubs | m66-athletics | m103-groups | m100-engagement | m101-events | m102-alumni | m85-accreditation |
|---|---|---|---|---|---|---|---|
| DB-backed, no mocks | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Raw SQL state assertions | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Cross-school isolation | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Old source `*.spec.ts` removed | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| No Wave 7 test asserts leakage as expected behavior | PASS | PASS | PASS | PASS | PASS | PASS | PASS |

Evidence:

- `rg "vi\.fn|vi\.mock"` over Wave 7 integration tests returned no hits.
- Raw SQL assertions are present across the Wave 7 suites (`$queryRawUnsafe`, `$executeRawUnsafe`, `SELECT`, `INSERT`, `UPDATE`, `DELETE`).
- Cross-school tests exist in every module: clubs/elections/field-trips, athletics games/seasons/recruiting/streams/equipment/media, groups, engagement surveys/conferences/scoring, events lifecycle/ticketing/revenue, alumni profiles/news/campaigns, and accreditation services/controllers.
- Source module directories contain no remaining `*.spec.ts` files.

### Required Scenario Checks

| Scenario | Status | Evidence |
|---|---|---|
| Election anonymity: `ext_votes` has no `voter_id` column | PASS | `m64-clubs/elections.spec.ts` checks information schema and asserts no `voter_id`. |
| Double-vote prevention via `ext_election_voter_check` | PASS | `m64-clubs/elections.spec.ts` covers double-vote rejection and verifies voter-check rows. |
| `min_votes_for_results` suppresses small election results | PASS | `m64-clubs/elections.spec.ts` covers `< min voters` suppressed and `>= min voters` returned. |
| Ticket sales atomic update | PASS | `m101-events/orders.service.ts` uses `UPDATE ... WHERE quantity_sold + $qty <= quantity`; ticketing tests cover decrement and sold-out rejection. |
| Gate scanning atomic update | PASS | `m101-events/gate.service.ts` uses `UPDATE ... WHERE status = 'VALID'`; ticketing tests cover valid scan and double-scan `ALREADY_SCANNED`. |
| Conference booking atomic update | PASS | `m100-engagement/conference-booking.service.ts` uses `UPDATE ... WHERE status = 'AVAILABLE'`; conference tests verify `AVAILABLE -> BOOKED`. |
| Engagement score component view restricted to `ENG-001:admin` | PASS | `m100-engagement/scoring.spec.ts` asserts admin sees components and non-admin readers get stripped components. |
| `@StudentOwned` on recruiting profiles | PASS | `m66-athletics/recruiting.controller.ts` has `@StudentOwned`; recruiting tests reject a student writing another student's profile. |
| `GRP-002` / `GRP-003` permissions tested | DEFECT | Source decorators exist, but Wave 7 tests do not explicitly assert `grp-002`/`grp-003` guard behavior. Controller tests call methods directly, so Nest permission guards are bypassed. |

Out-of-scope note: a full-repo grep still finds an existing non-Wave-7 `m81-enrolment` test named as a read-side leak bug. That does not affect this Wave 7 module verdict, but it remains a suite hygiene concern.

## Step 4 - Verdict

| Module | Target | Measured % | Meets Target? |
|---|---:|---:|---|
| `m64-clubs` | 80% | 97.94% | YES |
| `m66-athletics` | 80% | 93.83% | YES |
| `m103-groups` | 80% | 97.49% | YES |
| `m100-engagement` | 80% | 92.12% | YES |
| `m101-events` | 80% | 97.98% | YES |
| `m102-alumni` | 80% | 97.69% | YES |
| `m85-accreditation` | 80% | 96.78% | YES |

Overall verdict: FAIL

Reason: full suite is green and all seven modules exceed 80%, but the quality bar is not fully met because `GRP-002`/`GRP-003` permission behavior is not explicitly tested through a guard-aware path.

## Prioritized Fix List

1. Add guard-aware integration tests for `m103-groups` advanced controller routes requiring `grp-002:read`, `grp-002:write`, `grp-003:read`, and `grp-003:write`.
2. Assert both allowed and denied actors for those permission codes, preferably through the same request/controller harness used for other permission-protected integration surfaces.
3. Rename or tighten any misleading cross-school test names/comments that imply expected leakage while the assertion actually runs under the owning school context.
