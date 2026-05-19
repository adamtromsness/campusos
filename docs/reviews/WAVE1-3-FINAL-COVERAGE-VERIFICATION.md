# Wave 1-3 Final Coverage Verification

Date: 2026-05-18

## Scope

Final verification after the all-files push for Wave 1-3 coverage.

Coverage was measured with:

- `--coverage.include="src/modules/<module>/**"` for each module or platform submodule
- `--coverage.exclude='**/*.dto.ts'`
- `--coverage.exclude='**/*.module.ts'`
- `--coverage.exclude='**/index.ts'`
- `--coverage.reporter=text-summary`

The measured value below uses the V8 text-summary `Statements` percentage. In every run, `Lines` matched `Statements`.

## Step 1: Full Integration Suite

Command:

```bash
pnpm --filter @campusos/api test:integration
```

Result: PASS

Summary:

```text
Test Files  90 passed (90)
Tests       2426 passed | 9 skipped (2435)
Failures    0
Duration    350.48s
```

## Step 2: Per-Module Coverage

All coverage runs completed with 0 test failures.

| Module | Target | Measured | Meets Target? |
| --- | ---: | ---: | :---: |
| m83-finance | >=95% | 95.52% | Yes |
| m84-payments | >=95% | 96.94% | Yes |
| m86-procurement | >=80% | 84.17% | Yes |
| m00-platform/auth | >=95% | 100.00% | Yes |
| m00-platform/iam | >=95% | 99.09% | Yes |
| m00-platform/configuration | >=95% | 97.28% | Yes |
| m00-platform/governance | >=95% | 96.76% | Yes |
| m23-health | >=90% | 90.69% | Yes |
| m27-student-services | >=90% | 94.35% | Yes |
| m87-safety | >=90% | 95.93% | Yes |

## Verdict

PASS

The full integration suite had 0 failures, and all 10 measured modules met their coverage targets.
