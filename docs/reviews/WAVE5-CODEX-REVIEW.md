# Wave 5 Codex Review - Communications Integration Tests

Date: 2026-05-19

Scope:
- `m40-communications`
- `m41-meetings`
- `m42-publications`

## Step 1 - Full Suite Stability

Command:

```bash
pnpm --filter @campusos/api test:integration
```

Result: **FAILED**

| Total Tests | Passed | Failed | Skipped | Failed Suites |
|---:|---:|---:|---:|---:|
| 4509 | 4458 | 3 | 48 | 1 |

Failure details:

| Spec | Failure | Error Summary |
|---|---|---|
| `test/integration/m25-curriculum/gaps.spec.ts` | suite setup failed | `PrismaClientKnownRequestError` SQLSTATE `23505`: duplicate key `(name)=(CCSS-GAPS-TEST)` while inserting `platform.cur_standards_frameworks_platform` at line 102. |
| `test/integration/m21-classroom/class-moments.spec.ts` | `read > student enrolled in class can read` | `PrismaClientKnownRequestError` SQLSTATE `23505`: duplicate key `(person_id)=(019e0cf8-aaaa-7777-8888-000000000040)` while inserting `platform.platform_students` at line 173. |
| `test/integration/m00-platform/governance-sar.spec.ts` | `create > GUARDIAN linked to student can submit a SAR for that student` | `ForbiddenException`: `Only a linked guardian can submit a SAR on behalf of a child.` |
| `test/integration/m00-platform/governance-sar.spec.ts` | `list + getById > GUARDIAN list only sees own children SARs and own submissions` | `ForbiddenException`: `Only a linked guardian can submit a SAR on behalf of a child.` |

Gate decision: **coverage was not run** because Step 1 had failures.

## Step 2 - Per-Module Coverage

Not measured. The requested coverage step is gated on a full-suite run with 0 failures.

| Module | Target | Measured % | Meets Target? |
|---|---:|---:|---|
| `m40-communications` | 80% | Not measured | No - blocked by full-suite failures |
| `m41-meetings` | 80% | Not measured | No - blocked by full-suite failures |
| `m42-publications` | 80% | Not measured | No - blocked by full-suite failures |

## Step 3 - Quality Checks

Static review of Wave 5 integration specs was still completed.

| Check | m40-communications | m41-meetings | m42-publications |
|---|---|---|---|
| DB-backed, no mocks | PASS | PASS | PASS |
| Real state assertions with raw SQL | PASS | PASS | PASS |
| Cross-school isolation | PASS | PASS | PASS |
| Outbox verification | PASS: `msg.message.posted` | PASS: `mtg.meeting.scheduled` | N/A for requested topics; publication outbox also covered |
| Immutable publication versions | N/A | N/A | PASS |
| Meeting notes patch after approval rejected | N/A | PASS | N/A |
| Publication sections contributor/comment cross-school scoping | N/A | N/A | PASS |
| Old mock source specs removed | PASS | PASS | PASS |
| Leak asserted as expected behavior | None found | None found | None found |

Evidence:

- No `vi.fn()`, `vi.mock()`, `vi.spyOn()`, `mockResolved*`, or `mockImplementation*` matches were found in the three Wave 5 integration directories.
- No `*.spec.ts` files were found under `apps/api/src/modules/m40-communications`, `apps/api/src/modules/m41-meetings`, or `apps/api/src/modules/m42-publications`.
- Raw SQL assertions are widespread across all three modules via `$queryRawUnsafe` / `$executeRawUnsafe`.
- `m40-communications` cross-school isolation is covered in `messaging.spec.ts`: School B thread seeded, School A actor list excludes it and direct read returns `NotFoundException` (`apps/api/test/integration/m40-communications/messaging.spec.ts:355`). The same file verifies `msg.message.posted` outbox rows after posting (`apps/api/test/integration/m40-communications/messaging.spec.ts:403`).
- `m41-meetings` verifies `mtg.meeting.scheduled` outbox in `meeting-lifecycle.spec.ts` (`apps/api/test/integration/m41-meetings/meeting-lifecycle.spec.ts:87`) and School A cannot read/list/patch a School B meeting (`apps/api/test/integration/m41-meetings/meeting-lifecycle.spec.ts:629`).
- `m41-meetings` verifies approved meeting notes are locked: patching `notesText`, `isParentVisible`, or `parentVisibleSummary` after approval rejects, and raw SQL confirms `notes_text` remains unchanged (`apps/api/test/integration/m41-meetings/notes-approval.spec.ts:262`).
- `m42-publications` verifies immutable `pub_publication_versions`: INSERT succeeds, UPDATE variants fail, and DELETE fails with SQLSTATE `23001` / immutable error (`apps/api/test/integration/m42-publications/versions.spec.ts:145`).
- `m42-publications` verifies contributor and comment cross-school scoping through the section/publication relationship: add/remove contributor and create/resolve comment against a School B section from School A are rejected, with raw SQL confirming blocked mutation state where applicable (`apps/api/test/integration/m42-publications/sections.spec.ts:546`).

## Step 4 - Verdict

| Module | Target | Measured % | Meets Target? |
|---|---:|---:|---|
| `m40-communications` | 80% | Not measured | No - suite not green |
| `m41-meetings` | 80% | Not measured | No - suite not green |
| `m42-publications` | 80% | Not measured | No - suite not green |

Overall verdict: **FAIL**

Reason: the required PASS condition is `0 failures AND all 3 modules >=80% AND quality checks pass`. The Wave 5 quality checks pass by static review, but the full integration suite is not green, so coverage was correctly blocked and target compliance cannot be established.

## Prioritized Fix List

1. Fix suite data idempotency in `test/integration/m25-curriculum/gaps.spec.ts` for platform framework seed `CCSS-GAPS-TEST`; use upsert/delete-by-name/unique generated name so repeated or parallel runs cannot hit `23505`.
2. Fix suite data idempotency in `test/integration/m21-classroom/class-moments.spec.ts`; avoid inserting duplicate `platform.platform_students.person_id` or make the seed idempotent.
3. Fix `test/integration/m00-platform/governance-sar.spec.ts` guardian/student link setup or the service school-scope expectation so the linked guardian SAR scenarios pass.
4. Re-run `pnpm --filter @campusos/api test:integration`.
5. Only after the suite is green, run per-module coverage for `m40-communications`, `m41-meetings`, and `m42-publications`.
