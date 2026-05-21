# Wave 1-3 Coverage Verification

Date: 2026-05-18

## Method

I ran the full integration suite first:

```bash
pnpm --filter @campusos/api test:integration
```

For coverage, I ran each requested module slice with the requested include/test paths and added:

- `--coverage.reporter=json-summary` so service-file statement counts could be aggregated exactly.
- `--coverage.reportOnFailure` so failing slices still emitted coverage.
- `--no-file-parallelism` to reduce cross-spec database interference.
- `--reporter=dot --silent` to keep output manageable.

Coverage aggregation below includes only files ending in `*.service.ts`. It excludes DTOs, module files, indexes, controllers, workers, and consumers.

## Full Suite Result

The full integration suite did **not** pass.

| Metric            | Count |
| ----------------- | ----: |
| Total tests       |  2231 |
| Passed            |  2118 |
| Failed            |    65 |
| Skipped           |    48 |
| Spec files        |    78 |
| Failed spec files |    17 |
| Passed spec files |    61 |

Failing spec files observed in the full-suite run:

| Spec file                                                          | Error summary                                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/integration/m00-platform/governance-sar.spec.ts`             | Setup failed with `23505` unique violation on `sis_guardians (school_id, person_id)`.                                                       |
| `test/integration/m00-platform/tenant-isolation.spec.ts`           | `23505` unique violation on `pay_family_accounts (school_id, account_holder_id)`; rollback test received that DB error instead of `/boom/`. |
| `test/integration/m23-health/immunisation-and-dietary.spec.ts`     | `23503` FK violation on `hlth_immunisation_compliance.student_fk`.                                                                          |
| `test/integration/m27-student-services/deployment.spec.ts`         | `ForbiddenException: Only counsellors or admins can create wellbeing deployments`.                                                          |
| `test/integration/m27-student-services/referral-lifecycle.spec.ts` | `ForbiddenException: Only counsellors or admins can start a referral`.                                                                      |
| `test/integration/m83-finance/ap-recon-board.spec.ts`              | AP voucher/report lookup failed, including `AP voucher not found`.                                                                          |
| `test/integration/m83-finance/chart-of-accounts.spec.ts`           | Create/get path failed with `Account not found`.                                                                                            |
| `test/integration/m83-finance/gl-consumer.spec.ts`                 | Missing configured accounts and batch lookup failures, e.g. payroll accounts `5100`/`2100`, Fee Revenue `4100`, `Batch not found`.          |
| `test/integration/m83-finance/gl-posting.spec.ts`                  | Draft happy path expected two entries but found zero.                                                                                       |
| `test/integration/m83-finance/gl-reconciliation.spec.ts`           | Reconciliation rows/check statuses did not match expected discrepancy scenarios.                                                            |
| `test/integration/m83-finance/journal-batches.spec.ts`             | `Journal batch not found` and deadlock symptoms.                                                                                            |
| `test/integration/m83-finance/validation.spec.ts`                  | Deadlock `40P01`.                                                                                                                           |
| `test/integration/m84-payments/billing-config.spec.ts`             | Repeated `23505` unique violations on `pay_family_accounts`.                                                                                |
| `test/integration/m84-payments/financial-aid-applications.spec.ts` | Programme/application lookup mismatch, including `programId does not match...`.                                                             |
| `test/integration/m84-payments/invoice-lifecycle.spec.ts`          | Deadlock `40P01` and `pay_family_accounts` unique violations.                                                                               |
| `test/integration/m84-payments/late-fees.spec.ts`                  | Repeated `23505` unique violations on `pay_family_accounts`.                                                                                |
| `test/integration/m84-payments/remaining-branches.spec.ts`         | Financial aid application lookup failed with `... not found`.                                                                               |

## Measured Service Coverage

| Module                       | Slice status                               | Total statements | Covered statements | Codex measured | Target | Meets target? |
| ---------------------------- | ------------------------------------------ | ---------------: | -----------------: | -------------: | -----: | ------------- |
| `m83-finance`                | Failed: 12 failed / 517 passed             |             2504 |               2294 |         91.61% |    95% | No            |
| `m84-payments`               | Failed: 41 failed / 316 passed / 2 skipped |             3788 |               3595 |         94.90% |    95% | No            |
| `m86-procurement`            | Passed: 264 passed                         |             2170 |               2087 |         96.18% |    80% | Yes           |
| `m00-platform/auth`          | Passed: 422 passed                         |               89 |                 89 |        100.00% |    95% | Yes           |
| `m00-platform/iam`           | Passed: 422 passed                         |              628 |                610 |         97.13% |    95% | Yes           |
| `m00-platform/configuration` | Passed: 422 passed                         |              925 |                870 |         94.05% |    95% | No            |
| `m00-platform/governance`    | Passed: 422 passed                         |             2203 |               2153 |         97.73% |    95% | Yes           |
| `m23-health`                 | Passed: 224 passed                         |             3658 |               3398 |         92.89% |    90% | Yes           |
| `m27-student-services`       | Passed: 384 passed / 7 skipped             |             4485 |               4085 |         91.08% |    90% | Yes           |
| `m87-safety`                 | Passed: 163 passed / 3 skipped             |             1540 |               1292 |         83.90% |    90% | No            |

Notes:

- `m83-finance` and `m84-payments` coverage is measured from failed runs; the numbers are useful for statement accounting but should not be treated as validated green coverage.
- `m00-platform/auth`, `iam`, `configuration`, and `governance` each run the full `test/integration/m00-platform` slice, so the same 422 tests execute while only the coverage include path changes.

## Claude Comparison

Claude-reported figures were taken from `docs/reviews/handoffs/WAVE1-3-REVIEW.md`. Those figures appear to mix unit and integration/function-level accounting, while this verification uses integration coverage on `*.service.ts` statement counts only.

| Module                       | Claude reported | Codex measured | Match? | Meets target? |
| ---------------------------- | --------------: | -------------: | ------ | ------------- |
| `m83-finance`                |           86.5% |         91.61% | No     | No            |
| `m84-payments`               |           96.5% |         94.90% | No     | No            |
| `m86-procurement`            |           59.2% |         96.18% | No     | Yes           |
| `m00-platform/auth`          |            100% |        100.00% | Yes    | Yes           |
| `m00-platform/iam`           |           97.3% |         97.13% | Close  | Yes           |
| `m00-platform/configuration` |           56.5% |         94.05% | No     | No            |
| `m00-platform/governance`    |           21.4% |         97.73% | No     | Yes           |
| `m23-health`                 |           46.4% |         92.89% | No     | Yes           |
| `m27-student-services`       |           66.7% |         91.08% | No     | Yes           |
| `m87-safety`                 |           57.8% |         83.90% | No     | No            |

## Verdict

The full integration suite currently **fails**, so the coverage enhancement cannot be accepted as green.

Coverage targets are met for `m86-procurement`, `auth`, `iam`, `governance`, `m23-health`, and `m27-student-services`. Targets are missed for `m83-finance`, `m84-payments`, `configuration`, and `m87-safety`.

Priority fixes:

1. Stabilize the full integration suite, especially duplicate seeded `pay_family_accounts`, deadlocks, and missing finance chart/account fixtures.
2. Raise service coverage for `m83-finance`, `m84-payments`, `m00-platform/configuration`, and `m87-safety`.
3. Re-run coverage only after the full suite is green; failed-run coverage can hide broken paths behind partially executed files.
