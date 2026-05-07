# Cycle 31 Step 4 — k6 Load Test Scripts

12 critical hot paths from the Cycle 31 plan. Run with k6 against a
production-like environment (NOT against `tenant_demo` which has 15
seeded students — k6 results are meaningless on a 15-row dataset).

## Quick start

```bash
# Install k6 (Linux)
sudo gpg -k && sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Run against staging
TARGET=https://api.staging.campusos.dev TOKEN="$TOKEN" k6 run pos-allergen.js
```

## Hot paths

| #   | Script                    | Path                                   | Target p95 |
| --- | ------------------------- | -------------------------------------- | ---------- |
| 1   | pos-allergen.js           | POST /food-service/transactions        | <50ms      |
| 2   | library-search.js         | GET /library/catalogue?q=…             | <100ms     |
| 3   | inbox-list.js             | GET /threads                           | <200ms     |
| 4   | iam-permission-check.js   | iam_effective_access_cache lookup      | <10ms      |
| 5   | attendance-submit.js      | POST /attendance                       | <100ms     |
| 6   | gl-batch-post.js          | POST /finance/journal-batches/:id/post | <200ms     |
| 7   | bus-pass-scan.js          | POST /transport/ridership/scan         | <50ms      |
| 8   | student-profile-load.js   | GET /students/:id (with joins)         | <300ms     |
| 9   | timetable-render.js       | GET /scheduling/timetable/:classId     | <150ms     |
| 10  | at-risk-evaluation.js     | rpt_student_academic_summary scan      | <5s/500    |
| 11  | emergency-alert-fanout.js | POST /alerts/emergency                 | <2s        |
| 12  | space-booking-conflict.js | EXCLUDE gist conflict check            | <20ms      |

## Baseline contract

Each script exits non-zero if its p95 target is exceeded. Wired into
the pre-deploy CI gate. Production-like target: 100 VUs, 60s
duration. The numbers hold against a school with ~5,000 students;
larger districts re-baseline.

## Deployment-time wiring

- Run pg_stat_statements ON the read replica during a 1-hour load
  test window: `EXTRACT(EPOCH FROM ts) AS run_ts`.
- Capture top 10 by `total_exec_time` and `mean_exec_time`.
- Apply targeted index additions / query rewrites in a fix migration.
- Re-run k6 → confirm the before/after p95 improvement.
