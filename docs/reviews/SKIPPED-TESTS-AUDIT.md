# Skipped Tests Audit

Date: 2026-05-20

Scope:

- Runtime skipped tests from `pnpm --filter @campusos/api test:integration --reporter=verbose`
- Source skip markers under `apps/api/test/integration/`
- Runtime-conditional skip markers under `apps/api/test/integration/` and `apps/api/src/shared/__tests__/`

## Step 1 - Runtime Count

Requested command:

```bash
pnpm --filter @campusos/api test:integration --reporter=verbose 2>&1 | grep -i "skip"
```

The piped form produced no per-test skip lines because Vitest's verbose reporter does not emit skipped tests with the literal word `skip` in this output path. I reran the same verbose suite unfiltered to capture the final summary.

Verbose run summary:

| Total Tests | Passed | Failed | Skipped |           Test Files |
| ----------: | -----: | -----: | ------: | -------------------: |
|        5231 |   5157 |     57 |      17 | 212 passed, 7 failed |

Skip count: **17**

Note: this verbose run exited non-zero because of unrelated fixture/concurrency failures in `m41-meetings/field-trip-eval`, `m64-clubs/field-trips`, and one `m84-payments/invoice-lifecycle` test. The skipped-test audit below is source-reconciled against the 17 skipped tests.

## Step 2 - Source Skip Inventory

The source grep found these actual skip sites:

- `apps/api/test/integration/m84-payments/auto-invoice.spec.ts`: 2 explicit `it.skip`
- `apps/api/test/integration/m65-facilities/controllers.spec.ts`: 1 explicit `it.skip`, plus 2 skipped `describe` blocks containing 6 tests
- `apps/api/test/integration/m27-student-services/types-mtss-agency-longitudinal.spec.ts`: 1 skipped `describe` block containing 7 tests
- `apps/api/test/integration/m63-food-service/dietary-eligibility.spec.ts`: 1 explicit `it.skip`

False positives excluded:

- `m84-payments/refunds-reversals.spec.ts` contains a stale comment mentioning `.skip`, but the referenced reversal tests are active and marked `[Finding 7 FIXED]`.
- Several `Exit`, `SKIPPED`, and `DEFERRED` strings are domain/test-name text, not skip markers.

## Step 3 - Per-Skip Assessment

|   # | File:Line                                                                                   | Test Name                                                                                  | Skip Reason (from code/comment)                                                                                                                                              | Justified? | Recommendation                                                                                                       |
| --: | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
|   1 | `apps/api/test/integration/m84-payments/auto-invoice.spec.ts:566`                           | `SIBLING discount applies — DEFERRED (line_items total_chk forbids negative totals)`       | Comment says discount paths emit negative `pay_invoice_line_items.total`, but schema check `total >= 0` rejects them; fix requires schema design change or service refactor. | Yes        | Track explicitly, then choose schema relaxation for discount lines or positive discount representation.              |
|   2 | `apps/api/test/integration/m84-payments/auto-invoice.spec.ts:569`                           | `EARLY_PAYMENT discount applies — DEFERRED (line_items total_chk forbids negative totals)` | Same design conflict as #1.                                                                                                                                                  | Yes        | Track with #1 and enable both tests when the discount representation is resolved.                                    |
|   3 | `apps/api/test/integration/m65-facilities/controllers.spec.ts:302`                          | `work orders + plans + tasks endpoints`                                                    | No reason in code.                                                                                                                                                           | No         | Unskip and fix, or delete if superseded by `work-orders-assets.spec.ts` / controller-specific specs.                 |
|   4 | `apps/api/test/integration/m65-facilities/controllers.spec.ts:361`                          | `cleaning routes endpoints`                                                                | Parent `describe.skip('FacilitiesAdvancedController')`; no reason in code.                                                                                                   | No         | Remove the skipped duplicate or merge any missing assertions into `advanced-controllers.spec.ts`.                    |
|   5 | `apps/api/test/integration/m65-facilities/controllers.spec.ts:409`                          | `zone inspections endpoints`                                                               | Parent `describe.skip('FacilitiesAdvancedController')`; no reason in code.                                                                                                   | No         | Remove the skipped duplicate or merge any missing assertions into `advanced-controllers.spec.ts`.                    |
|   6 | `apps/api/test/integration/m65-facilities/controllers.spec.ts:422`                          | `supply audit endpoints`                                                                   | Parent `describe.skip('FacilitiesAdvancedController')`; no reason in code.                                                                                                   | No         | Remove the skipped duplicate or merge any missing assertions into `advanced-controllers.spec.ts`.                    |
|   7 | `apps/api/test/integration/m65-facilities/controllers.spec.ts:452`                          | `fire drill endpoints`                                                                     | Parent `describe.skip('FacilitiesAssetsController')`; no reason in code.                                                                                                     | No         | Remove the skipped duplicate or merge any missing assertions into `assets-controller.spec.ts`.                       |
|   8 | `apps/api/test/integration/m65-facilities/controllers.spec.ts:474`                          | `asset category + asset endpoints`                                                         | Parent `describe.skip('FacilitiesAssetsController')`; no reason in code.                                                                                                     | No         | Remove the skipped duplicate or merge any missing assertions into `assets-controller.spec.ts`.                       |
|   9 | `apps/api/test/integration/m65-facilities/controllers.spec.ts:512`                          | `energy endpoints`                                                                         | Parent `describe.skip('FacilitiesAssetsController')`; no reason in code.                                                                                                     | No         | Remove the skipped duplicate or merge any missing assertions into `assets-controller.spec.ts`.                       |
|  10 | `apps/api/test/integration/m27-student-services/types-mtss-agency-longitudinal.spec.ts:347` | `records MAINTAIN discussion (mapped to NO_CHANGE outcome)`                                | Parent skip says blocked by `svc_mtss_tiers.tier_level` service-side SELECT bug. No tracking issue is referenced.                                                            | No         | Create/attach tracking issue, fix the SELECT bug, then unskip the whole `recordDiscussion` block.                    |
|  11 | `apps/api/test/integration/m27-student-services/types-mtss-agency-longitudinal.spec.ts:365` | `records ESCALATE (mapped to TIER_UP)`                                                     | Same parent bug reason as #10; no tracking issue referenced.                                                                                                                 | No         | Track and fix with #10.                                                                                              |
|  12 | `apps/api/test/integration/m27-student-services/types-mtss-agency-longitudinal.spec.ts:378` | `records DE_ESCALATE (mapped to TIER_DOWN)`                                                | Same parent bug reason as #10; no tracking issue referenced.                                                                                                                 | No         | Track and fix with #10.                                                                                              |
|  13 | `apps/api/test/integration/m27-student-services/types-mtss-agency-longitudinal.spec.ts:391` | `cross-school student → BadRequest`                                                        | Same parent bug reason as #10; no tracking issue referenced.                                                                                                                 | No         | Track and fix with #10; this is also a cross-school coverage path and should not remain skipped.                     |
|  14 | `apps/api/test/integration/m27-student-services/types-mtss-agency-longitudinal.spec.ts:405` | `missing meeting → NotFound`                                                               | Same parent bug reason as #10; no tracking issue referenced.                                                                                                                 | No         | Track and fix with #10.                                                                                              |
|  15 | `apps/api/test/integration/m27-student-services/types-mtss-agency-longitudinal.spec.ts:414` | `duplicate student on same meeting → BadRequest`                                           | Same parent bug reason as #10; no tracking issue referenced.                                                                                                                 | No         | Track and fix with #10.                                                                                              |
|  16 | `apps/api/test/integration/m27-student-services/types-mtss-agency-longitudinal.spec.ts:427` | `listDiscussions returns rows for the meeting`                                             | Same parent bug reason as #10; no tracking issue referenced.                                                                                                                 | No         | Track and fix with #10.                                                                                              |
|  17 | `apps/api/test/integration/m63-food-service/dietary-eligibility.spec.ts:266`                | `upsertFromAlertEvent inserts alert`                                                       | No reason in code.                                                                                                                                                           | No         | Unskip and fix, or delete if fully superseded by `allergy-alert-consumer.spec.ts`; do not leave an unexplained skip. |

## Step 4 - Summary

Total skipped tests: **17**

Justified: **2**

- `m84-payments/auto-invoice.spec.ts:566`
- `m84-payments/auto-invoice.spec.ts:569`

Unjustified: **15**

- `m65-facilities/controllers.spec.ts:302`
- `m65-facilities/controllers.spec.ts:361`
- `m65-facilities/controllers.spec.ts:409`
- `m65-facilities/controllers.spec.ts:422`
- `m65-facilities/controllers.spec.ts:452`
- `m65-facilities/controllers.spec.ts:474`
- `m65-facilities/controllers.spec.ts:512`
- `m27-student-services/types-mtss-agency-longitudinal.spec.ts:347`
- `m27-student-services/types-mtss-agency-longitudinal.spec.ts:365`
- `m27-student-services/types-mtss-agency-longitudinal.spec.ts:378`
- `m27-student-services/types-mtss-agency-longitudinal.spec.ts:391`
- `m27-student-services/types-mtss-agency-longitudinal.spec.ts:405`
- `m27-student-services/types-mtss-agency-longitudinal.spec.ts:414`
- `m27-student-services/types-mtss-agency-longitudinal.spec.ts:427`
- `m63-food-service/dietary-eligibility.spec.ts:266`

Priority recommendations:

1. Remove or unskip the 7 facilities controller skips. These look like stale duplicates of active split specs and have no reason in code.
2. Track and fix the MTSS `svc_mtss_tiers.tier_level` SELECT bug, then unskip all 7 `recordDiscussion` tests.
3. Unskip or delete the food-service `upsertFromAlertEvent` test after comparing coverage with `allergy-alert-consumer.spec.ts`.
4. Add explicit tracking references to the 2 justified payments discount skips.

## Step 5 - Runtime-Conditional Skips

The requested conditional-skip grep found no runtime-conditional skips under `apps/api/test/integration/`.

It found environment-gated tests under `apps/api/src/shared/__tests__/`. These are **not counted** by `test:integration`, because `apps/api/vitest.integration.config.ts` includes only `test/integration/**/*.spec.ts`.

| File:Line                                                                | Condition                                                                            |                                                              Tests Affected | Counted In Integration Suite?                                                                                 | Assessment                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------------------------------------------- |
| `apps/api/src/shared/__tests__/p2h5-school-scope-integration.spec.ts:34` | `describe.skipIf(!ENABLED)`, where `ENABLED = process.env.P2H5_RUN_DB_TESTS === '1'` |                                       6 live cross-school DB contract tests | No                                                                                                            | Justified environment gate; requires dual-tenant DB infrastructure and `P2H5_OWNER_DATABASE_URL`. |
| `apps/api/src/shared/__tests__/p2h5-school-scope-integration.spec.ts:85` | `describe.skipIf(ENABLED)`                                                           | 1 placeholder documentation test, skipped only when live DB mode is enabled | No                                                                                                            | Justified placeholder inversion.                                                                  |
| `apps/api/src/shared/__tests__/p2h5-immutable-role-contract.spec.ts:45`  | `describe.skipIf(!ENABLED                                                            |                                                                             | !APP_DATABASE_URL)`, where `ENABLED = P2H5_RUN_DB_TESTS === '1'`and`APP_DATABASE_URL = P2H5_APP_DATABASE_URL` | 48 live app-role immutable-table contract tests                                                   | No  | Justified environment gate; requires special non-owner DB role and app-role connection string. |
| `apps/api/src/shared/__tests__/p2h5-immutable-role-contract.spec.ts:92`  | `describe.skipIf(ENABLED)`                                                           | 1 placeholder documentation test, skipped only when live DB mode is enabled | No                                                                                                            | Justified placeholder inversion.                                                                  |

Other grep hits were not runtime skips:

- `m25-curriculum/gaps.spec.ts` uses `SKIPPED` to describe domain behavior where draft/archived maps do not produce gap rows.
- `m81-enrolment/offers.spec.ts` uses `DEFERRED` as an enrollment offer family response status.
- `m00-platform/configuration-trees.spec.ts` has a "DEFERRED FOLLOW-UP" comment but no skipped test.
