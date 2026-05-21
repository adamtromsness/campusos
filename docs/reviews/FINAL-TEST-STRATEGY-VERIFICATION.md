# Final Test Strategy Verification

Date: 2026-05-21
Commit: 59bedd1

## Verdict

**FAIL: exact skip-grep gate has one stale comment false positive.**

The full integration suite is green, runtime skips are exactly the 2 justified payment discount tests, CodeQL fixes are present, athletics roster scoping is fixed, shared specs are migrated, and global coverage is above 80%. However, the requested skip source grep returned 3 lines instead of the allowed 2 because `m84-payments/refunds-reversals.spec.ts` still contains a stale comment with `.skip'd`. It is not an executable skipped test, but it violates the literal "Only 2 results allowed" grep gate.

## Step 1 - Full Integration Suite

Command:

```bash
pnpm --filter @campusos/api test:integration
```

Result:

| Test Files | Total Tests | Passed | Failed | Skipped |
|---:|---:|---:|---:|---:|
| 277 | 7545 | 7543 | 0 | 2 |

Only runtime skipped spec: `test/integration/m84-payments/auto-invoice.spec.ts` with 2 skipped discount tests.

## Step 2 - CodeQL Fixes

### Poll Option Bounds

Command:

```bash
grep -n "MAX_POLL_OPTIONS" apps/api/src/modules/m103-groups/polls/poll.service.ts
```

Evidence:

```text
43:const MAX_POLL_OPTIONS = 50;
141:    if (input.options.length > MAX_POLL_OPTIONS) {
163:      const safeOptionCount = Math.min(input.options.length, MAX_POLL_OPTIONS);
226:    if (input.optionIds.length > MAX_POLL_OPTIONS) {
296:      const safeBallotCount = Math.min(input.optionIds.length, MAX_POLL_OPTIONS);
```

Status: **Confirmed.** Both loop sites use `Math.min(..., MAX_POLL_OPTIONS)`.

### Gift Card Randomness

Command:

```bash
grep -n "randomInt" apps/api/src/modules/m67-store/gift-cards/gift-card.service.ts
```

Evidence:

```text
7:import { randomInt } from 'crypto';
121:   * ambiguous characters I, O, 0, 1. Uses crypto.randomInt for
129:      out += allowed[randomInt(allowed.length)];
```

Status: **Confirmed.** Gift card code generation uses `crypto.randomInt`, not modulo selection.

## Step 3 - Skips

Command:

```bash
grep -rn "\.skip\|describe\.skip\|it\.skip\|test\.skip" \
  apps/api/test/integration/ | grep -v "expect.*skipped" | grep -v node_modules
```

Raw output:

```text
apps/api/test/integration/m84-payments/auto-invoice.spec.ts:566:    it.skip('SIBLING discount applies - DEFERRED (line_items total_chk forbids negative totals)', async () => {
apps/api/test/integration/m84-payments/auto-invoice.spec.ts:569:    it.skip('EARLY_PAYMENT discount applies - DEFERRED (line_items total_chk forbids negative totals)', async () => {});
apps/api/test/integration/m84-payments/refunds-reversals.spec.ts:680:    // reverse() to that UPDATE are .skip'd until the service is fixed
```

Assessment:

| Type | Count | Status |
|---|---:|---|
| Executable skipped tests | 2 | Justified payment discount tests |
| Unjustified executable skips | 0 | None found |
| Stale grep false positives | 1 | Needs cleanup |

The two executable skips are the expected payment discount tests in `auto-invoice.spec.ts`. The third line is a comment in `refunds-reversals.spec.ts`; the surrounding tests now run and pass, but the comment still trips the requested grep.

## Step 4 - Athletics Roster Scope

The exact requested glob did not match because the file is at `apps/api/src/modules/m66-athletics/roster.service.ts`, not under a child directory:

```text
grep: apps/api/src/modules/m66-athletics/*/roster*.service.ts: No such file or directory
```

Direct evidence from `RosterService.listForSeason`:

```text
138:  async listForSeason(seasonId: string): Promise<RosterResponseDto[]> {
145:    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
147:        SELECT_ROSTER +
148:          'JOIN ath_seasons s ON s.id = r.season_id ' +
149:          'JOIN ath_programmes p ON p.id = s.programme_id ' +
150:          'WHERE r.season_id = $1::uuid AND p.school_id = $2::uuid ' +
152:        seasonId,
153:        tenant.schoolId,
```

Status: **Confirmed.** `listForSeason` filters through `ath_programmes.school_id`.

The coverage run also passed:

```text
integration:m66-athletics/seasons > cross-school isolation > School A admin cannot list School B rosters (listForSeason filters via ath_programmes.school_id)
```

## Step 5 - Shared Specs Migrated

Commands:

```bash
find apps/api/src/shared -name "*.spec.ts" | wc -l
find apps/api/test/unit/shared -name "*.spec.ts" | wc -l
```

Results:

| Location | Count | Required | Status |
|---|---:|---:|---|
| `apps/api/src/shared` | 0 | 0 | Pass |
| `apps/api/test/unit/shared` | 14 | >=14 | Pass |

## Step 6 - Global Coverage

Command:

```bash
pnpm --filter @campusos/api exec vitest run \
  --config vitest.integration.config.ts --coverage \
  --coverage.include='src/modules/**' \
  --coverage.include='src/shared/**' \
  --coverage.exclude='**/*.dto.ts' --coverage.exclude='**/*.module.ts' \
  --coverage.exclude='**/index.ts' \
  --coverage.reporter=text-summary \
  test/integration
```

Coverage run result:

| Test Files | Total Tests | Passed | Failed | Skipped |
|---:|---:|---:|---:|---:|
| 277 | 7545 | 7543 | 0 | 2 |

Coverage summary:

| Metric | Covered / Total | Percentage | Meets 80% |
|---|---:|---:|---|
| Statements | 133784 / 152037 | 87.99% | Yes |
| Branches | 28154 / 33172 | 84.87% | Yes |
| Functions | 7424 / 8125 | 91.37% | Yes |
| Lines | 133784 / 152037 | 87.99% | Yes |

## Gate Checklist

| Gate | Status | Notes |
|---|---|---|
| Full integration suite: 0 failures | Pass | 7543 passed, 0 failed |
| Runtime skips <= 2 | Pass | Exactly 2 skipped |
| Only acceptable runtime skips | Pass | Both in payment discount tests |
| CodeQL poll loop cap | Pass | `Math.min(..., MAX_POLL_OPTIONS)` at both sites |
| CodeQL gift card randomness | Pass | `crypto.randomInt` used |
| 0 unjustified executable skips | Pass | No executable skips beyond the 2 justified payment tests |
| Exact skip grep returns only 2 lines | Fail | One stale `.skip'd` comment false positive |
| Athletics roster school scope | Pass | `p.school_id = tenant.schoolId` predicate present |
| Shared specs migrated out of `src/shared` | Pass | `src/shared`: 0, `test/unit/shared`: 14 |
| Global statement coverage >= 80% | Pass | 87.99% |

## Required Cleanup

1. Remove or reword the stale `.skip'd` comment at `apps/api/test/integration/m84-payments/refunds-reversals.spec.ts:680`.
2. Re-run the Step 3 grep. Expected output should contain only:
   - `apps/api/test/integration/m84-payments/auto-invoice.spec.ts:566`
   - `apps/api/test/integration/m84-payments/auto-invoice.spec.ts:569`

