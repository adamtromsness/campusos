# Waves 1-3 Final Verification

Date: 2026-05-18

## Step 1 - Full Suite Stability

Command:

```bash
pnpm --filter @campusos/api test:integration
```

Result: GREEN

Notes:
- Initial sandboxed run could not connect to local Postgres (`Prisma P1001` / sandbox `EPERM` on `127.0.0.1:5432`).
- Docker services were confirmed running; the suite was rerun outside the sandbox so Vitest could reach local Postgres.

Summary:
- Total tests: 2252
- Passed: 2243
- Failed: 0
- Skipped: 9
- Spec files: 80 passed / 0 failed

Skipped tests:
- `test/integration/m84-payments/auto-invoice.spec.ts`
  - `SIBLING discount applies - DEFERRED`: skipped because `line_items total_chk` forbids negative totals.
  - `EARLY_PAYMENT discount applies - DEFERRED`: skipped because `line_items total_chk` forbids negative totals.
- `test/integration/m27-student-services/types-mtss-agency-longitudinal.spec.ts`
  - Entire `recordDiscussion` describe block skipped: `blocked by svc_mtss_tiers.tier_level service-side SELECT bug`.
  - Skipped cases:
    - `records MAINTAIN discussion (mapped to NO_CHANGE outcome)`
    - `records ESCALATE (mapped to TIER_UP)`
    - `records DE_ESCALATE (mapped to TIER_DOWN)`
    - `cross-school student -> BadRequest`
    - `missing meeting -> NotFound`
    - `duplicate student on same meeting -> BadRequest`
    - `listDiscussions returns rows for the meeting`

No failing spec files.

## Step 2 - Per-Module Coverage

All requested coverage commands completed with 0 test failures.

| Module | Statements Covered / Total | Measured % |
|--------|----------------------------|------------|
| `m83-finance` | 3548 / 4250 | 83.48% |
| `m84-payments` | 3666 / 4839 | 75.75% |
| `m86-procurement` | 2239 / 2660 | 84.17% |
| `m00-platform/auth` | 89 / 249 | 35.74% |
| `m00-platform/iam` | 610 / 662 | 92.14% |
| `m00-platform/configuration` | 896 / 1183 | 75.73% |
| `m00-platform/governance` | 2195 / 2692 | 81.53% |
| `m23-health` | 3398 / 4806 | 70.70% |
| `m27-student-services` | 4107 / 5669 | 72.44% |
| `m87-safety` | 1747 / 2164 | 80.73% |

## Step 3 - Verdict Table

| Module | Target | Measured % | Suite Green? | Meets Target? |
|--------|--------|------------|--------------|---------------|
| `m83-finance` | >=95% | 83.48% | Yes | No |
| `m84-payments` | >=95% | 75.75% | Yes | No |
| `m86-procurement` | >=80% | 84.17% | Yes | Yes |
| `m00-platform/auth` | >=95% | 35.74% | Yes | No |
| `m00-platform/iam` | >=95% | 92.14% | Yes | No |
| `m00-platform/configuration` | >=95% | 75.73% | Yes | No |
| `m00-platform/governance` | >=95% | 81.53% | Yes | No |
| `m23-health` | >=90% | 70.70% | Yes | No |
| `m27-student-services` | >=90% | 72.44% | Yes | No |
| `m87-safety` | >=90% | 80.73% | Yes | No |

Overall verdict: FAIL

Reason: full suite has 0 failures, but 9 of 10 measured modules are below target.

## Step 4 - Quality Spot Check

Random sample command:

```bash
rg --files apps/api/test/integration | rg '(m83-finance|m84-payments|m86-procurement|m00-platform|m23-health|m27-student-services|m87-safety|procurement)' | shuf -n 5
```

Sampled files:

| File | Result | Evidence |
|------|--------|----------|
| `test/integration/m84-payments/lunch-accounts.spec.ts` | SOUND | Real `TenantPrismaService` instantiated at lines 49, 55-57. Raw SQL state assertion via `rawClient.$queryRawUnsafe` count at lines 276-280. Cross-school isolation tests at lines 374-393 and 396+. No `vi.fn()` / `vi.mock()` DB mocking found. |
| `test/integration/m27-student-services/alert.spec.ts` | DEFECT | Real `TenantPrismaService` instantiated at lines 36, 42. Cross-school block exists at lines 449-470, with companion `m27-student-services/cross-school.spec.ts` covering canonical isolation. No `vi.fn()` / `vi.mock()` DB mocking found. Defect: sampled file has raw SQL setup via `$executeRawUnsafe`, but no raw SQL state assertion (`$queryRaw*`) in the file. |
| `test/integration/m87-safety/incident-lifecycle.spec.ts` | SOUND | Real `TenantPrismaService` instantiated at lines 60, 76. Raw SQL state assertions through `countIncidents()` / `readOutboxFor()` at lines 166-180. Cross-school isolation tests at lines 278-292 and additional cases later in file. No `vi.fn()` / `vi.mock()` DB mocking found. |
| `test/integration/m83-finance/gl-posting.spec.ts` | SOUND | Real `TenantPrismaService` instantiated at lines 57, 62-63. Raw SQL state assertions at lines 109-113 and 120-124. Cross-school isolation test begins at line 294. No `vi.fn()` / `vi.mock()` DB mocking found. |
| `test/integration/m00-platform/tenant-isolation.spec.ts` | SOUND | Real `TenantPrismaService` instantiated at lines 31, 35. Raw SQL state assertions at lines 72-80 and 354-358. Cross-school tenant/search-path isolation test begins at line 340. No `vi.fn()` / `vi.mock()` DB mocking found. |

