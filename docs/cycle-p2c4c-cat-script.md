# P2-4c — Customer Acceptance Test (Training + Appraisals)

**Cycle:** Phase 2 Cycle 4 sub-cycle c (Training + Appraisals + GLConsumer wire to `hr.payroll.processed`).

**Scope:** 7 vertical-slice scenarios covering training programmes / events / completions, certification auto-issue, appraisal SIGNED_OFF immutability, lesson observation gate keystone, expense claim approval workflow, and the GLConsumer wire to `hr.payroll.processed` closing the Wave A payroll-to-finance integration loop.

## Schema preamble (run before each CAT)

```sql
-- 7 new tables from migrations 116 + 117 (and 118 extends fin_journal_batches)
SELECT relname FROM pg_class
WHERE relnamespace = 'tenant_demo'::regnamespace
  AND relname LIKE 'hr_training_%' OR relname LIKE 'hr_appraisal%'
   OR relname = 'hr_lesson_observations' OR relname = 'hr_expense_claims'
   OR relname = 'hr_certification_types' OR relname = 'hr_employee_certifications'
ORDER BY relname;
-- expect 12 rows: hr_appraisal_comments, hr_appraisal_cycles, hr_appraisal_frameworks,
--   hr_appraisal_goals, hr_appraisals, hr_certification_types, hr_employee_certifications,
--   hr_expense_claims, hr_lesson_observations, hr_training_completions,
--   hr_training_events, hr_training_programmes

-- AUTO_PAYROLL is in the fin_journal_batches batch_type CHECK
SELECT pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conname = 'fin_batches_type_chk';
-- expect AUTO_PAYROLL in the value list

-- Catalogue 510+ perms (HR-012 + lesson_observation added)
SELECT COUNT(*) FROM platform.permissions;
-- expect 510

-- IAM grant distribution post-rebuild
SELECT pu.email,
       array_length(eac.permission_codes, 1) AS perm_count
  FROM platform.iam_effective_access_cache eac
  JOIN platform.platform_users pu ON pu.id = eac.account_id
  ORDER BY pu.email;
-- expect admin/principal 516, teacher 94, vp/counsellor 226, student 52, parent 47

-- lesson_observation:write granted ONLY to admin tier
SELECT pu.email
  FROM platform.iam_effective_access_cache eac
  JOIN platform.platform_users pu ON pu.id = eac.account_id
 WHERE 'lesson_observation:write' = ANY(eac.permission_codes)
 ORDER BY pu.email;
-- expect admin@ + principal@ ONLY (NOT vp@ / counsellor@)
```

## Scenarios

### S1 — Training programme catalogue + event scheduling

```bash
# Admin lists active programmes
curl -X GET http://localhost:4000/api/v1/hr/training/programmes \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Tenant-Subdomain: demo"
# expect 200, 2 rows (Safeguarding L1, First Aid)

# Teacher CANNOT create a programme
curl -X POST http://localhost:4000/api/v1/hr/training/programmes \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke","description":"x","employmentType":"FULL_TIME"}'
# expect 403

# VP / Counsellor CAN create (Staff role holds HR-004:write)
curl -X POST http://localhost:4000/api/v1/hr/training/programmes \
  -H "Authorization: Bearer $VP_TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"name":"FERPA Training","description":"Annual FERPA refresher","isMandatory":true,"renewalMonths":12}'
# expect 201
```

### S2 — Training completion AUTO-ISSUE keystone

```bash
# Admin records Mitchell completing the SCHEDULED First Aid event
EVENT_ID=$(curl -s "http://localhost:4000/api/v1/hr/training/events?status=SCHEDULED" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Tenant-Subdomain: demo" \
  | jq -r '.[0].id')

MITCHELL_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT e.id FROM tenant_demo.hr_employees e JOIN platform.iam_person ip ON ip.id=e.person_id JOIN platform.platform_users pu ON pu.person_id=ip.id WHERE pu.email='principal@demo.campusos.dev'")

curl -X POST "http://localhost:4000/api/v1/hr/training/events/$EVENT_ID/completions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"'$MITCHELL_ID'","score":98,"passed":true}'
# expect 201

# Verify auto-issue keystone — Mitchell should now have a First Aid cert
curl -X GET "http://localhost:4000/api/v1/hr/training/employees/$MITCHELL_ID/certifications" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Tenant-Subdomain: demo"
# expect 2 First Aid rows — the seeded one (Red Cross 2025) AND the
#  auto-issued one with issued_at=today + expires_at=today+36mo

# `hr.training.completed` event in platform_outbox
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT topic, source_module FROM platform.platform_outbox \
    WHERE topic='hr.training.completed' ORDER BY created_at DESC LIMIT 1;"
# expect topic=hr.training.completed source_module=hr-training
```

### S3 — Duplicate completion catch (UNIQUE keystone)

```bash
# Re-record same employee on same event → 400 "already been recorded"
curl -X POST "http://localhost:4000/api/v1/hr/training/events/$EVENT_ID/completions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"'$MITCHELL_ID'","score":99,"passed":true}'
# expect 400 "This employee has already been recorded as completing this event."
```

### S4 — Appraisal SIGNED_OFF immutability keystone

```bash
APPRAISAL_ID=$(curl -s "http://localhost:4000/api/v1/hr/appraisals" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Tenant-Subdomain: demo" \
  | jq -r '.[0].id')

# Admin advances DRAFT → IN_REVIEW
curl -X PATCH "http://localhost:4000/api/v1/hr/appraisals/$APPRAISAL_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"status":"IN_REVIEW","appraiserReview":"Strong delivery this year.","overallRating":"GOOD"}'
# expect 200 status=IN_REVIEW

# Admin signs off
curl -X PATCH "http://localhost:4000/api/v1/hr/appraisals/$APPRAISAL_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"status":"SIGNED_OFF"}'
# expect 200 status=SIGNED_OFF + signedOffAt populated + signedOffByName="Sarah Mitchell"

# Subsequent edit refused (KEYSTONE)
curl -X PATCH "http://localhost:4000/api/v1/hr/appraisals/$APPRAISAL_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"appraiserReview":"updated text"}'
# expect 400 "Appraisal is SIGNED_OFF and cannot be modified."

# Verify multi-column signed_off_chk lockstep at the schema layer
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT status, signed_off_at IS NOT NULL AS at_set, signed_off_by IS NOT NULL AS by_set FROM tenant_demo.hr_appraisals WHERE id='$APPRAISAL_ID';"
# expect SIGNED_OFF | t | t
```

### S5 — Lesson observation KEYSTONE gate

```bash
# Setup: get Rivera + a class id
RIVERA_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT e.id FROM tenant_demo.hr_employees e JOIN platform.iam_person ip ON ip.id=e.person_id JOIN platform.platform_users pu ON pu.person_id=ip.id WHERE pu.email='teacher@demo.campusos.dev'")

# VP holds hr-005:write but NOT lesson_observation:write — refused
curl -X POST "http://localhost:4000/api/v1/hr/appraisals/lesson-observations" \
  -H "Authorization: Bearer $VP_TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"observedEmployeeId":"'$RIVERA_ID'","observationDate":"2026-05-09","observedClassLabel":"Algebra 1 — P3","durationMinutes":45,"overallGrade":"GOOD","strengths":"Clear pacing.","areasForDevelopment":"Differentiation."}'
# expect 403 "lesson_observation:write" (KEYSTONE — even with hr-005 + isSchoolAdmin=false)

# Admin authors → 201
curl -X POST "http://localhost:4000/api/v1/hr/appraisals/lesson-observations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"appraisalId":"'$APPRAISAL_ID'","observedEmployeeId":"'$RIVERA_ID'","observationDate":"2026-05-09","observedClassLabel":"Algebra 1 — P3","durationMinutes":45,"overallGrade":"GOOD","strengths":"Clear pacing.","areasForDevelopment":"Differentiation."}'
# expect 201 with id

OBS_ID=$(... id from above)

# Admin locks
curl -X PATCH "http://localhost:4000/api/v1/hr/appraisals/lesson-observations/$OBS_ID/lock" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Tenant-Subdomain: demo"
# expect 200 isLocked=true + lockedAt + lockedBy populated

# Re-lock refused
curl -X PATCH "http://localhost:4000/api/v1/hr/appraisals/lesson-observations/$OBS_ID/lock" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Tenant-Subdomain: demo"
# expect 400 "already locked"
```

### S6 — Expense claim approval workflow

```bash
# Teacher submits own claim
curl -X POST http://localhost:4000/api/v1/hr/expense-claims \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"claimTitle":"Conference registration","incurredOn":"2026-05-01","totalAmount":150}'
# expect 201 status=SUBMITTED

# Teacher CANNOT see another teacher's claims (row scope)
curl -X GET "http://localhost:4000/api/v1/hr/expense-claims" \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H "X-Tenant-Subdomain: demo"
# expect only teacher's own claims

# Admin approves
CLAIM_ID=$(... id from above)
curl -X PATCH "http://localhost:4000/api/v1/hr/expense-claims/$CLAIM_ID/decide" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"decision":"APPROVED"}'
# expect 200 status=APPROVED + approvedBy + approvedAt populated

# Admin marks paid
curl -X PATCH "http://localhost:4000/api/v1/hr/expense-claims/$CLAIM_ID/mark-paid" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Tenant-Subdomain: demo" \
  -d '{}'
# expect 200 status=PAID + paidAt populated

# Reject path requires non-empty reason
curl -X PATCH "http://localhost:4000/api/v1/hr/expense-claims/$NEW_CLAIM/decide" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"decision":"REJECTED","rejectionReason":""}'
# expect 400 "rejectionReason is required when REJECTED"
```

### S7 — GLConsumer payroll posting (Wave A integration loop closes)

```bash
# Trigger the markPaid path on a payroll period — the existing
# Cycle 26 GLConsumer subscription now picks up hr.payroll.processed.
PP_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT id FROM tenant_demo.hr_pay_periods WHERE status='PAID' LIMIT 1")

# Inspect the auto-posted journal batch — should appear when the
# OutboxPublisherWorker drains the platform_outbox + GLConsumer
# processes the event. The batch carries source_module='payroll'
# + batchType='AUTO_PAYROLL'.
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT batch_number, batch_type, source_module, total_debits, total_credits, status \
   FROM tenant_demo.fin_journal_batches \
   WHERE source_module='payroll' ORDER BY created_at DESC LIMIT 1;"
# expect batch_type=AUTO_PAYROLL + source_module=payroll + total_debits = total_credits + status=POSTED

# Inspect the per-line entries — DR Salaries (5100) for grossPay,
# CR Cash (1000) for netPay, CR Accrued Liabilities (2100) for
# totalDeductions
BATCH_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT id FROM tenant_demo.fin_journal_batches WHERE source_module='payroll' ORDER BY created_at DESC LIMIT 1")

docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT a.account_code, e.debit, e.credit, e.description \
   FROM tenant_demo.fin_journal_entries e \
   JOIN tenant_demo.fin_chart_of_accounts a ON a.id=e.account_id \
   WHERE e.batch_id='$BATCH_ID' ORDER BY a.account_code;"
# expect:
#   1000 (Cash)         | 0    | $netPay
#   2100 (Accrued)      | 0    | $totalDeductions
#   5100 (Salaries)     | $grossPay | 0
# total_debits = grossPay; total_credits = netPay + totalDeductions; balanced.
```

## Schema invariants verified

- **Multi-column `signed_off_chk` lockstep on `hr_appraisals`** — SIGNED_OFF requires both `signed_off_at` + `signed_off_by` populated; service stamps both atomically (S4).
- **Multi-column `decided_chk` lockstep on `hr_expense_claims`** — every terminal status requires `approved_by` + `approved_at` populated; REJECTED additionally requires non-empty `rejection_reason` (S6).
- **Multi-column `locked_chk` lockstep on `hr_lesson_observations`** — `is_locked=true` requires both `locked_at` + `locked_by` populated (S5).
- **UNIQUE(event_id, employee_id) on `hr_training_completions`** — duplicate submission catches via 23505 → friendly 400 (S3).
- **3-value role CHECK on `hr_interview_panel_members.role_in_panel`** — verified via P2-4b migration 115 (carry-over not exercised here).
- **5-value batch_type CHECK + `AUTO_PAYROLL`** — fin_journal_batches accepts payroll batches via migration 118 (S7).

## Known limitations / Phase 2 follow-ups

1. **No web UI yet** — admin drives training + appraisals + expense claims via API. Web tile (`/hr/training`, `/hr/appraisals`, `/hr/expense-claims`) is a polish-pass follow-up; backend + tests are the load-bearing P2-4c deliverable.
2. **`hr.certification.expiring` emit deferred** — schema-ready (`/hr/training/certifications-expiring` admin endpoint surfaces the data); a cron-driven worker emits the topic in a future polish cycle.
3. **Salary scale auto-assignment on offer-accept (P2-4b carry-over)** — admins still populate `hr_employee_positions.salary_scale_id` manually before payroll runs against new hires. The `hr.offer.accepted` outbox row carries the position metadata for a future onboarding consumer.
4. **GLConsumer payroll account mapping is hard-coded** — Salaries 5100 + Cash 1000 + Accrued 2100. Future `fin_posting_rules` table abstracts these per-tenant.
