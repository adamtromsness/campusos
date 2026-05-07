# Cycle 29 — Customer Acceptance Test (Step 10)

**Module:** M110 Analytics & Reporting (Wave 7 opener — opens Wave 7 Analytics & Governance).
**Verified live on:** `tenant_demo` 2026-05-07.
**Reproducibility:** every command is shell-pasteable. The cycle ships nightly batch materialisation only — Kafka consumer wiring lands per-read-model in Phase 2 per ADR-049.

---

## Schema preamble

10 checks confirming the tenant schema landed correctly.

```sh
# 1 — 16 rpt_* tables present
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='tenant_demo' AND table_name LIKE 'rpt_%'"
# Expect: 16

# 2 — list every table
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT table_name FROM information_schema.tables WHERE table_schema='tenant_demo' AND table_name LIKE 'rpt_%' ORDER BY table_name"
# Expect: rpt_analytics_worker_checkpoints, rpt_at_risk_configurations, rpt_class_performance_summary,
#         rpt_daily_attendance_summary, rpt_district_school_comparison, rpt_district_summary,
#         rpt_fin_aged_debtors, rpt_rebuild_snapshots, rpt_report_definitions, rpt_report_runs,
#         rpt_scheduled_reports, rpt_school_summary, rpt_staff_summary,
#         rpt_state_report_templates, rpt_student_academic_summary, rpt_wellbeing_trends

# 3 — UNIQUE(consumer_group, topic, partition) on checkpoints
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT indexdef FROM pg_indexes WHERE schemaname='tenant_demo' AND indexname='rpt_checkpoints_uq'"

# 4 — partial index on at_risk_flags <> '{}' (the at-risk hot path)
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT indexdef FROM pg_indexes WHERE schemaname='tenant_demo' AND indexname='rpt_student_academic_at_risk_idx'"

# 5 — multi-column status + format CHECKs on rpt_report_runs
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT conname FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='tenant_demo' AND cl.relname='rpt_report_runs' AND contype='c' ORDER BY conname"

# 6 — RPT-001..004 in the catalogue
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT code FROM platform.permissions WHERE code LIKE 'rpt-%' ORDER BY code"
# Expect: 12 rows (RPT-001..004 × read/write/admin)

# 7 — Teacher gets RPT-001:read only
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT p.code FROM platform.role_permission rp JOIN platform.roles r ON r.id=rp.role_id JOIN platform.permissions p ON p.id=rp.permission_id WHERE r.name='Teacher' AND p.code LIKE 'rpt-%' ORDER BY p.code"
# Expect: rpt-001:read

# 8 — Staff gets RPT-001 + RPT-002 + RPT-004 (NOT RPT-003 — admin only)
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT p.code FROM platform.role_permission rp JOIN platform.roles r ON r.id=rp.role_id JOIN platform.permissions p ON p.id=rp.permission_id WHERE r.name='Staff' AND p.code LIKE 'rpt-%' ORDER BY p.code"
# Expect: rpt-001:read, rpt-001:write, rpt-002:read, rpt-002:write, rpt-004:read, rpt-004:write

# 9 — Step 4 seed shape
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "SET search_path TO tenant_demo, platform, public; SELECT 'attendance' AS k, count(*) FROM rpt_daily_attendance_summary UNION ALL SELECT 'academic', count(*) FROM rpt_student_academic_summary UNION ALL SELECT 'at_risk_students', count(*) FROM rpt_student_academic_summary WHERE at_risk_flags <> '{}'::jsonb UNION ALL SELECT 'class_perf', count(*) FROM rpt_class_performance_summary UNION ALL SELECT 'staff', count(*) FROM rpt_staff_summary UNION ALL SELECT 'school', count(*) FROM rpt_school_summary UNION ALL SELECT 'district', count(*) FROM rpt_district_summary UNION ALL SELECT 'comparisons', count(*) FROM rpt_district_school_comparison UNION ALL SELECT 'wellbeing', count(*) FROM rpt_wellbeing_trends UNION ALL SELECT 'aged_debtors', count(*) FROM rpt_fin_aged_debtors UNION ALL SELECT 'at_risk_configs', count(*) FROM rpt_at_risk_configurations UNION ALL SELECT 'report_defs', count(*) FROM rpt_report_definitions UNION ALL SELECT 'report_runs', count(*) FROM rpt_report_runs UNION ALL SELECT 'scheduled', count(*) FROM rpt_scheduled_reports UNION ALL SELECT 'state_templates', count(*) FROM rpt_state_report_templates ORDER BY 1"
# Expect: academic=10, aged_debtors=1, at_risk_configs=2, at_risk_students=2, attendance=30,
#         class_perf=3, comparisons=2, district=1, report_defs=2, report_runs=2,
#         scheduled=1, school=1, staff=2, state_templates=2, wellbeing=1

# 10 — analytics module wired into AppModule (live route check)
curl -sw 'HTTP %{http_code}\n' -o /dev/null http://localhost:4000/api/v1/analytics/attendance \
  -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo'
# Expect: 200
```

---

## Plan scenarios

```sh
ADMIN=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' -d '{"email":"principal@demo.campusos.dev"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
TEACHER=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' -d '{"email":"teacher@demo.campusos.dev"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
PARENT=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' -d '{"email":"parent@demo.campusos.dev"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
STUDENT=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' -d '{"email":"student@demo.campusos.dev"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
```

### S1 — Worker materialisation (chained nightly pipeline)

```sh
curl -sX POST http://localhost:4000/api/v1/analytics/workers/run \
  -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'  {s[\"worker\"]}: {s[\"status\"]} rows={s[\"rowsWritten\"]} {s[\"durationMs\"]}ms') for s in d]"
# Expect 7 workers all OK:
#   sis: OK rows=21 ~150ms
#   classroom: OK rows=10 ~50ms
#   at-risk: OK rows=15 ~40ms (2 newly flagged emit rpt.at_risk.flagged)
#   school-summary: OK rows=1
#   district: OK rows=2
#   wellbeing: OK rows=0 (Cycle 11.1 has no completed checkin in last month)
#   finance-ar: OK rows=1
```

### S2 — Attendance dashboard (school-wide, then teacher row scope)

```sh
echo "== admin sees all 30 =="
curl -s http://localhost:4000/api/v1/analytics/attendance -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  rows={len(d)}')"
# Expect 30

echo "== teacher (Rivera) sees own 6 classes × 5 days = 30 =="
curl -s http://localhost:4000/api/v1/analytics/attendance -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  rows={len(d)}')"
# Expect 30 (Rivera teaches all 6 seeded classes; row scope filters via sis_class_teachers)
```

### S3 — At-risk detection + new flag emit

The workers in S1 re-materialised `rpt_student_academic_summary` from real
operational data (`cls_grades` + `sis_attendance_records`), which clears any
hand-flagged seed students because the computed values mostly don't trip
the seeded "Academic Risk" thresholds. To make this scenario deterministic,
we manually plant a low-GPA student then re-evaluate.

```sh
# Pre-create the at-risk Kafka topic for the envelope check in S4
docker exec campusos-kafka /opt/kafka/bin/kafka-topics.sh --create --if-not-exists \
  --bootstrap-server localhost:9092 --topic dev.rpt.at_risk.flagged \
  --partitions 1 --replication-factor 1 > /dev/null 2>&1

# Plant a student with bad metrics that trip both default thresholds
# (attendance<0.85 AND gpa<2.0). Worker overwrites at_risk_flags so we
# clear them first to ensure a clean DELTA when the worker fires.
docker exec campusos-postgres psql -U campusos -d campusos_dev <<'EOF'
SET search_path TO tenant_demo, platform, public;
UPDATE rpt_student_academic_summary
   SET current_gpa = 1.5, attendance_rate = 0.78, at_risk_flags = '{}'::jsonb
 WHERE student_id = (SELECT id FROM sis_students LIMIT 1);
EOF

echo "== re-evaluate with seeded Academic Risk config =="
curl -sX POST http://localhost:4000/api/v1/analytics/workers/run \
  -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' -d '{"worker":"at-risk"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  status={d[0][\"status\"]} reviewed={d[0][\"rowsWritten\"]}')"

echo "== flagged count =="
curl -s http://localhost:4000/api/v1/analytics/at-risk -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  flagged={len(d)}')"
# Expect: 1 (the planted student now trips Academic Risk: gpa<2.0 AND attendance<0.85)
```

### S4 — `rpt.at_risk.flagged` envelope on the wire

```sh
docker exec campusos-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic dev.rpt.at_risk.flagged \
  --from-beginning --max-messages 1 --timeout-ms 8000 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  event_type={d[\"event_type\"]} source={d[\"source_module\"]} cfg={d[\"payload\"][\"configName\"]} matched={d[\"payload\"][\"conditionsMatched\"]}')"
# Expect: event_type=rpt.at_risk.flagged source=analytics
#         payload.configName=Academic Risk
#         payload.conditionsMatched=['attendance<0.85', 'gpa<2']
```

### S5 — School summary aggregation

```sh
curl -s http://localhost:4000/api/v1/analytics/school-summary \
  -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  enrolled={d[\"totalEnrolled\"]} staff={d[\"totalStaff\"]} attendance={d[\"avgAttendanceRate\"]} gpa={d[\"avgGpa\"]} at_risk={d[\"atRiskCount\"]}')"
# Expect non-zero numbers — totalEnrolled = COUNT(sis_enrollments WHERE status='ACTIVE'),
# avg_attendance_rate = AVG over rpt_daily_attendance_summary last 30 days
```

### S6 — District summary + comparison rankings

```sh
echo "== district summary =="
curl -s http://localhost:4000/api/v1/analytics/district-summary -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  schools={d[\"schoolCount\"]} enrolled={d[\"totalEnrolled\"]} avg_att={d[\"avgAttendanceRate\"]}')"

echo "== district comparison =="
curl -s http://localhost:4000/api/v1/analytics/district-comparison -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'  rank_att={r[\"rankByAttendance\"]} rank_perf={r[\"rankByPerformance\"]} school={r[\"schoolName\"]}') for r in d]"
# Expect Lincoln Academy ranked #1 in the demo (single-school district),
# plus the synthetic Elmwood comparison row from the seed
```

### S7 — Wellbeing trends + privacy invariant

```sh
curl -s http://localhost:4000/api/v1/analytics/wellbeing-trends -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'  grade={r[\"gradeLevel\"]} period={r[\"periodStart\"]}->{r[\"periodEnd\"]} avg={r[\"avgWellbeingScore\"]} responses={r[\"responseCount\"]}') for r in d]"

# Schema-level privacy proof: rpt_wellbeing_trends has NO student_id column
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT column_name FROM information_schema.columns WHERE table_schema='tenant_demo' AND table_name='rpt_wellbeing_trends' AND column_name LIKE '%student%'"
# Expect: 0 rows — the schema enforces no individual attribution
```

### S8 — Aged debtors (Cycle 6 cross-cycle read)

```sh
curl -s http://localhost:4000/api/v1/analytics/aged-debtors -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'  family={r[\"accountHolderName\"]} total=\${r[\"totalOutstanding\"]} cur=\${r[\"currentBucket\"]} d30=\${r[\"days30\"]} d60=\${r[\"days60\"]} d90+=\${r[\"days90Plus\"]}') for r in d]"
# Expect Chen family with $150 outstanding (seed shape) — workers re-materialise from
# Cycle 6 pay_invoices + pay_payments + pay_refunds
```

### S9 — Report engine (on-demand + scheduled run-now)

```sh
DEF_ID=$(curl -s http://localhost:4000/api/v1/analytics/reports -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(next(r['id'] for r in d if r['name']=='Weekly Attendance Report'))")
echo "  DEF_ID=${DEF_ID:0:8}..."

echo "== run on-demand =="
curl -sX POST "http://localhost:4000/api/v1/analytics/reports/$DEF_ID/run" \
  -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' -d '{"outputFormat":"CSV"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  status={d[\"status\"]} rows={d[\"rowCount\"]} s3={d[\"outputS3Key\"][:50]}...')"

echo "== run history =="
curl -s "http://localhost:4000/api/v1/analytics/reports/$DEF_ID/runs" -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  count={len(d)} statuses={[r[\"status\"] for r in d]}')"

echo "== scheduled report run-now (Mon 8am cron computes next_run_at) =="
SCHED=$(curl -s http://localhost:4000/api/v1/analytics/scheduled-reports -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
curl -sX POST "http://localhost:4000/api/v1/analytics/scheduled-reports/$SCHED/run-now" \
  -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  reportName={d[\"reportName\"]} lastRunStatus={d[\"lastRunStatus\"]} nextRunAt={d[\"nextRunAt\"][:16]}')"
# Expect lastRunStatus=SUCCESS + nextRunAt=next-Monday-08:00
```

### S10 — Permission denial paths

```sh
echo "-- parent /attendance (Parent doesn't hold RPT-001:read):"
curl -sw 'HTTP %{http_code}\n' -o /dev/null http://localhost:4000/api/v1/analytics/attendance -H "Authorization: Bearer $PARENT" -H 'X-Tenant-Subdomain: demo'
# Expect: 403

echo "-- student /district-summary (RPT-003:read required):"
curl -sw 'HTTP %{http_code}\n' -o /dev/null http://localhost:4000/api/v1/analytics/district-summary -H "Authorization: Bearer $STUDENT" -H 'X-Tenant-Subdomain: demo'
# Expect: 403

echo "-- teacher /at-risk (RPT-002:read required, Teacher only has RPT-001):"
curl -sw 'HTTP %{http_code}\n' -o /dev/null http://localhost:4000/api/v1/analytics/at-risk -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo'
# Expect: 403

echo "-- teacher /reports (RPT-004:read required, Teacher doesn't hold it):"
curl -sw 'HTTP %{http_code}\n' -o /dev/null http://localhost:4000/api/v1/analytics/reports -H "Authorization: Bearer $TEACHER" -H 'X-Tenant-Subdomain: demo'
# Expect: 403
```

---

## Cleanup

```sh
docker exec campusos-postgres psql -U campusos -d campusos_dev <<'EOF'
SET search_path TO tenant_demo, platform, public;
-- Drop CAT-created configs and runs (the seeded ones survive)
DELETE FROM rpt_at_risk_configurations WHERE name = 'CAT-S3 Strict';
-- Workers are idempotent; their last writes are harmless. Optionally trim:
-- DELETE FROM rpt_report_runs WHERE started_at > now() - interval '1 hour' AND output_s3_key LIKE '%-019%';
EOF
```

---

## Reviewer attention items

Recorded for the post-cycle architecture review and Phase 2 punch list:

1. **Real Kafka consumer wiring per read model** — Cycle 29 ships nightly batch materialisation only. Per-event consumers (subscribe to `att.attendance.confirmed`, `cls.grade.posted`, etc.) land per read model in Phase 2 per ADR-049. The schema is set up for Kafka-offset checkpoints; the workers currently use synthetic offsets (the row count of the run).
2. **PDF / XLSX rendering** — `ReportRunService` records a `output_s3_key` and `output_format` but the actual S3 upload is stubbed. Pre-pilot work wires headless Chrome (PDF) + ExcelJS (XLSX) renderers and the S3 upload step.
3. **Cron polling loop** — `ScheduledReportWorker.runNow()` works for both admin-triggered + future cron-tick paths, and `computeNextRun()` correctly walks weekday cron expressions. The actual polling loop (every 5 min, `WHERE next_run_at <= NOW() AND is_active=true`) is a setInterval registration that ships with the production deploy container.
4. **18 deferred ERD tables (Cycle 29.1)** — domain-specific read models for procurement / store / officials / facilities / transportation / food service / IT / library / enrollment / athletics / groups / publications / clubs / messaging surface as their owning modules ship per-domain workers post-pilot.
5. **Multi-school district** — the demo tenant has one school. The DistrictAnalyticsWorker correctly aggregates across `rpt_school_summary` rows joined on `organisation_id`, but the rankings only really exercise when 2+ schools are seeded (the seed plants a synthetic Elmwood comparison row to make the dashboard render).
6. **Custom dashboard builder** — pre-built dashboards this cycle. Drag-and-drop dashboard widget configuration is a future polish item.
7. **Multi-year trend analysis** — current year + prior year comparison only; multi-year deferred.
8. **Read replica routing (ADR-050)** — analytics queries currently route through the same Postgres connection as the operational module. Production deployment routes `rpt_*` SELECTs to the read replica via a connection string switch.
9. **Snapshot rebuild SLA** — `rpt_rebuild_snapshots` is schema-ready but the FROM_SNAPSHOT rebuild path is not yet exercised end-to-end. Pre-pilot work materialises a snapshot, truncates one read model, and verifies <10 min restore.
10. **`rpt_state_report_templates` should be platform-scope** — the schema places it in tenant scope today (every tenant carries identical Kansas templates). A platform.rpt_state_report_templates_master + per-tenant copy-on-create pattern would deduplicate the data.

**Cycle 29 ships clean to the post-cycle architecture review. Wave 7 (Analytics & Governance) opens.**
