# CampusOS Cycle 6 — Customer Acceptance Test Script

**Cycle:** 6 (Enrollment & Payments)
**Step:** 12 of 12 — Vertical Slice Integration Test
**Last verified:** 2026-04-29 (against `tenant_demo` on `main`)
**Plan reference:** `docs/campusos-cycle6-implementation-plan.html` § Step 12

This is the manual walkthrough that exercises every layer of Cycle 6 — the 22 base enrollment + payments tables across Steps 1–4 (with `pay_ledger_entries` RANGE-partitioned annually 2025–2030 and the partition-replicated FK to `pay_family_accounts`), the seeded admissions + billing data from Step 5, the 17 enrollment + 24 payments endpoints from Steps 6–7, the **`PaymentAccountWorker`** Kafka consumer that closes the enrollment→payments event loop on `enr.student.enrolled`, the admin web surfaces from Steps 8 + 10 (admissions pipeline, capacity dashboard, billing accounts, invoices, payments, fees), the parent web surfaces from Steps 9 + 11 (apply, offer respond, billing dashboard, pay form, ledger), and the ADR-057 envelope shape on every Cycle 6 emit. The format mirrors `docs/cycle1-cat-script.md` through `docs/cycle5-cat-script.md`.

The verification below was captured live with the API, all Cycle 1–5 Kafka consumers (gradebook-snapshot-worker, audience-fan-out-worker, the 5 notification consumers, leave-notification-consumer, coverage-consumer), the `PaymentAccountWorker`, and the notification-delivery worker all running against the freshly-seeded demo tenant. Outputs are recorded inline so a reviewer can re-run the script and diff the results against this transcript.

The plan's 12 scenarios are bracketed by a 4-check schema preamble that proves the 22 enrollment + payments tables landed cleanly (with the partitioned ledger and zero cross-schema FKs) before the business flow runs.

---

## Prerequisites

- Docker services up: `docker compose up -d` (Postgres, Redis, Kafka, Keycloak).
- Cycle 0–5 schema + seed in place. Full reset for a fresh CAT run:

  ```bash
  docker exec campusos-postgres psql -U campusos -d campusos_dev \
    -c "DROP SCHEMA IF EXISTS tenant_demo CASCADE; DROP SCHEMA IF EXISTS tenant_test CASCADE;"
  pnpm --filter @campusos/database provision --subdomain=demo
  pnpm --filter @campusos/database provision --subdomain=test
  pnpm --filter @campusos/database seed                       # platform + 7 test users
  pnpm --filter @campusos/database exec tsx src/seed-iam.ts   # 444 perms, 6 roles
  pnpm --filter @campusos/database seed:sis                   # SIS
  pnpm --filter @campusos/database seed:classroom             # Cycle 2
  pnpm --filter @campusos/database seed:messaging             # Cycle 3
  pnpm --filter @campusos/database seed:hr                    # Cycle 4
  pnpm --filter @campusos/database seed:scheduling            # Cycle 5
  pnpm --filter @campusos/database seed:enrollment            # Cycle 6
  pnpm --filter @campusos/database seed:payments              # Cycle 6
  pnpm --filter @campusos/database exec tsx src/build-cache.ts
  ```

- API running (must be the freshly built `dist/`): `pnpm --filter @campusos/api build && pnpm --filter @campusos/api start`. The PaymentAccountWorker subscribes to `dev.enr.student.enrolled` on boot — Scenario 6 below depends on it.

- Pre-create the dev Kafka topics on a fresh broker (the Cycle 6 emits add 8 topics on top of Cycles 1–5):

  ```bash
  for t in \
      dev.enr.application.submitted dev.enr.application.status_changed \
      dev.enr.offer.issued dev.enr.offer.responded dev.enr.student.enrolled \
      dev.pay.invoice.created dev.pay.payment.received dev.pay.refund.issued; do
    docker exec campusos-kafka /opt/kafka/bin/kafka-topics.sh \
      --bootstrap-server localhost:9092 --create --if-not-exists \
      --topic "$t" --partitions 3 --replication-factor 1
  done
  ```

- Web running (for the UI walkthrough lines): `pnpm --filter @campusos/web dev` at `http://localhost:3000`.

- Tokens stashed for the four personas under test:

  ```bash
  login() {
    curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
      -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" \
      -d "{\"email\":\"$1\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])"
  }
  PRINCIPAL=$(login principal@demo.campusos.dev)   # School Admin (Sarah Mitchell)
  TEACHER=$(login teacher@demo.campusos.dev)       # Teacher (James Rivera)
  PARENT=$(login parent@demo.campusos.dev)         # Parent (David Chen, Maya's father)
  STUDENT=$(login student@demo.campusos.dev)       # Student (Maya Chen)
  ```

  Every request below sends `X-Tenant-Subdomain: demo` and the appropriate `Authorization: Bearer …` token.

---

## Schema preamble — 4 checks

The 22 base enrollment + payments tables landed across Steps 1–4 with `pay_ledger_entries` RANGE-partitioned annually 2025–2030, composite PK `(id, created_at)`, the partition-replicated `family_account_id` FK, and zero cross-schema FKs. Verified before any business flow runs:

```sql
SET search_path TO tenant_demo, platform, public;
SELECT 'tenant base tables' AS check, count(*)::text AS value
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='tenant_demo' AND c.relkind IN ('r','p') AND c.relispartition=false
UNION ALL
SELECT 'enr_ tables', count(*)::text
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='tenant_demo' AND c.relkind IN ('r','p') AND c.relispartition=false
   AND c.relname LIKE 'enr\_%' ESCAPE '\'
UNION ALL
SELECT 'pay_ tables', count(*)::text
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='tenant_demo' AND c.relkind IN ('r','p') AND c.relispartition=false
   AND c.relname LIKE 'pay\_%' ESCAPE '\'
UNION ALL
SELECT 'cross-schema FKs', count(*)::text
  FROM pg_constraint c
  JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace nt ON nt.oid=t.relnamespace
  JOIN pg_class r ON r.oid=c.confrelid JOIN pg_namespace nr ON nr.oid=r.relnamespace
 WHERE c.contype='f' AND nt.nspname='tenant_demo' AND nr.nspname<>'tenant_demo';
```

```
       check        | value
--------------------+-------
 tenant base tables | 106
 enr_ tables        | 10
 pay_ tables        | 12
 cross-schema FKs   | 0
```

Cycle 5 left 84 tenant base tables; Cycle 6 added 22 logical base tables (8 enrollment from Step 1 + 2 from Step 2 + 5 payments from Step 3 + 7 from Step 4 — the 6 partition leaves of `pay_ledger_entries` are NOT counted as logical base tables, matching the `sis_attendance_records` + `msg_notification_log` precedents). ADR-001/020 holds: zero DB-enforced FKs from a tenant table to anything outside `tenant_demo`.

Seed row counts (from `seed:enrollment` + `seed:payments`):

```sql
SELECT 'enr_enrollment_periods' AS t, count(*)::text FROM enr_enrollment_periods
UNION ALL SELECT 'enr_admission_streams', count(*)::text FROM enr_admission_streams
UNION ALL SELECT 'enr_intake_capacities', count(*)::text FROM enr_intake_capacities
UNION ALL SELECT 'enr_capacity_summary', count(*)::text FROM enr_capacity_summary
UNION ALL SELECT 'enr_applications', count(*)::text FROM enr_applications
UNION ALL SELECT 'enr_application_screening_responses', count(*)::text FROM enr_application_screening_responses
UNION ALL SELECT 'enr_application_notes', count(*)::text FROM enr_application_notes
UNION ALL SELECT 'enr_offers', count(*)::text FROM enr_offers
UNION ALL SELECT 'enr_waitlist_entries', count(*)::text FROM enr_waitlist_entries
UNION ALL SELECT 'pay_fee_categories', count(*)::text FROM pay_fee_categories
UNION ALL SELECT 'pay_fee_schedules', count(*)::text FROM pay_fee_schedules
UNION ALL SELECT 'pay_stripe_accounts', count(*)::text FROM pay_stripe_accounts
UNION ALL SELECT 'pay_family_accounts', count(*)::text FROM pay_family_accounts
UNION ALL SELECT 'pay_family_account_students', count(*)::text FROM pay_family_account_students
UNION ALL SELECT 'pay_invoices', count(*)::text FROM pay_invoices
UNION ALL SELECT 'pay_invoice_line_items', count(*)::text FROM pay_invoice_line_items
UNION ALL SELECT 'pay_payments', count(*)::text FROM pay_payments
UNION ALL SELECT 'pay_ledger_entries', count(*)::text FROM pay_ledger_entries
UNION ALL SELECT 'pay_refunds', count(*)::text FROM pay_refunds;
```

```
                  t                  | count
-------------------------------------+-------
 enr_enrollment_periods              | 1
 enr_admission_streams               | 2
 enr_intake_capacities               | 2
 enr_capacity_summary                | 2
 enr_applications                    | 4
 enr_application_screening_responses | 10
 enr_application_notes               | 3
 enr_offers                          | 2
 enr_waitlist_entries                | 1
 pay_fee_categories                  | 4
 pay_fee_schedules                   | 4
 pay_stripe_accounts                 | 1
 pay_family_accounts                 | 1
 pay_family_account_students         | 1
 pay_invoices                        | 2
 pay_invoice_line_items              | 2
 pay_payments                        | 1
 pay_ledger_entries                  | 3
 pay_refunds                         | 0
```

The 4 seeded applications cover every shape relied on downstream: Aiden Park SUBMITTED (drives the admin pipeline), Sophia Nakamura ACCEPTED w/ ISSUED offer + 1 confidential REFERENCE_CHECK note, Maya Chen ENROLLED (historical, with `guardian_person_id` linked to David Chen's `iam_person.id`), Olivia Bennett WAITLISTED (1 ACTIVE waitlist entry). The seeded `pay_family_accounts.FA-1001` belongs to David Chen and is linked to Maya's `sis_students` row; ledger sums to $400.00 (matches the SENT Tech Fee 2026 invoice's outstanding balance).

---

## Scenario 1 — Admin views the admissions pipeline

Anchored read: principal hits `GET /applications` and gets the 4 seeded applications across the SUBMITTED → ENROLLED lifecycle.

```bash
curl -s -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/applications
```

```
count=4
  Aiden Park           grade=9  status=SUBMITTED   guardianEmail=helen.park@example.com
  Olivia Bennett       grade=9  status=WAITLISTED  guardianEmail=sara.bennett@example.com
  Sophia Nakamura      grade=10 status=ACCEPTED    guardianEmail=kenji.nakamura@example.com
  Maya Chen            grade=9  status=ENROLLED    guardianEmail=parent@demo.campusos.dev
```

UI walkthrough: log in as `principal@demo.campusos.dev`, click the **Admissions** tile on the launchpad. `/admissions/applications` renders the pipeline view with 6 status columns (SUBMITTED / UNDER_REVIEW / ACCEPTED / WAITLISTED / REJECTED / ENROLLED). Aiden lands in column 1, Olivia in column 4, Sophia in column 3, Maya in column 6.

---

## Scenario 2 — Parent sees only their own application via row-scope

Parents hold `stu-003:read` (granted in Step 5), but the `ApplicationService.list` row-scope filters on `enr_applications.guardian_person_id = actor.personId`, so David Chen sees only Maya's row. Sophia / Aiden / Olivia have different (or NULL) guardian_person_id and are excluded.

```bash
curl -s -H "Authorization: Bearer $PARENT" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/applications
```

```
count=1
  Maya Chen status=ENROLLED guardianPersonId=019dc92d-088c-7442-abf6-0134867d2d92
```

UI walkthrough: log in as `parent@demo.campusos.dev`, click the **Apply** tile (Step 9 added it for guardians with `stu-003:write`). `/apply` renders 1 row for Maya with the ENROLLED status pill, no Respond callout (offer was accepted historically), and a "Start new application" button in the header (the open period exists). Confidential admin notes are stripped from the parent payload by the same service-layer filter.

---

## Scenario 3 — Parent submits new application

David Chen submits an application for a fictional new child "CatStep12 Chen" in Grade 9. The service stamps `guardian_person_id` from `actor.personId`, runs the application against the OPEN period validity check, and recomputes the `enr_capacity_summary` row for Grade 9 in the same transaction.

```bash
curl -s -X POST http://localhost:4000/api/v1/applications \
  -H "Authorization: Bearer $PARENT" -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" \
  -d '{
    "enrollmentPeriodId": "<period.id>",
    "studentFirstName": "CatStep12",
    "studentLastName": "Chen",
    "studentDateOfBirth": "2011-04-15",
    "applyingForGrade": "9",
    "admissionType": "NEW_STUDENT",
    "guardianEmail": "parent@demo.campusos.dev",
    "screening": [{"questionKey":"prior_school","responseValue":"Test School"}]
  }'
```

```
app.id=019dd790-9866-7ddd-97e6-042608f60847
status=SUBMITTED
guardianPersonId=019dc92d-088c-7442-abf6-0134867d2d92   ← David Chen iam_person.id
submittedAt=2026-04-29T04:47:50Z
```

Capacity summary post-submit (Grade 9 `applications_received` bumped 3 → 4):

```
 grade_level | applications_received | offers_issued | offers_accepted | waitlisted | available
-------------+-----------------------+---------------+-----------------+------------+-----------
 9           |                     4 |             1 |               1 |          1 |       109
 10          |                     1 |             1 |               0 |          0 |       109
```

The screening response with `responseValue: "Test School"` passes the global `forbidNonWhitelisted` ValidationPipe because Step 6 added `@Allow()` to `ScreeningResponseInputDto.responseValue` (the bug caught and fixed during the Step 6 smoke).

---

## Scenario 4 — Admin transitions SUBMITTED → UNDER_REVIEW → ACCEPTED

The admin pipeline transition uses `assertTransitionAllowed` to reject illegal moves at the service layer and locks the row `FOR UPDATE` inside the `executeInTenantTransaction` (Cycle 5 review carry-over).

```bash
curl -s -X PATCH http://localhost:4000/api/v1/applications/$APP_ID/status \
  -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" \
  -d '{"status":"UNDER_REVIEW","reviewNote":"CAT script — review"}'
# → status=UNDER_REVIEW reviewedAt=2026-04-29T04:48:11Z

curl -s -X PATCH http://localhost:4000/api/v1/applications/$APP_ID/status \
  -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" \
  -d '{"status":"ACCEPTED","reviewNote":"CAT script — accepted"}'
# → status=ACCEPTED notes=2 confidentialNotes=0
```

UI walkthrough: navigate to `/admissions/applications/{id}`. The header card shows the status pill flipping SUBMITTED → UNDER_REVIEW after the first click on "Move to review", then ACCEPTED after the second. Each transition appends an admin note via `NoteComposer`. With no offer issued yet and status=ACCEPTED, the **Issue offer** button surfaces below the header.

---

## Scenario 5 — Admin issues UNCONDITIONAL offer

`POST /applications/:id/offer` with response_deadline 14 days out. The schema's UNIQUE on `application_id` is the safety net (a second-offer attempt would 400 — verified live in Step 6 smoke).

```bash
DEADLINE=$(date -u -d "+14 days" +"%Y-%m-%d")
curl -s -X POST "http://localhost:4000/api/v1/applications/$APP_ID/offer" \
  -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" \
  -d "{\"offerType\":\"UNCONDITIONAL\",\"responseDeadline\":\"$DEADLINE\"}"
```

```
offer.id=019dd790-e7fa-7ddd-97e6-62de3e750efa
status=ISSUED
type=UNCONDITIONAL
issuedAt=2026-04-29T04:48:11Z
responseDeadline=2026-05-13
```

UI walkthrough: the OfferPanel renders inline below the application header, showing offer-type / issued-at / deadline + admin Mark-met/Mark-failed buttons (only when CONDITIONAL — UNCONDITIONAL hides the conditions panel) + parent-proxy Accept/Decline buttons. Parent will hit `/offers/:id` directly in the next scenario, but admin proxy is also wired.

---

## Scenario 6 — Parent ACCEPTS offer (`enr.student.enrolled` keystone)

The keystone end-to-end transition. `OfferService.respond` locks BOTH `enr_offers` AND `enr_applications` FOR UPDATE in the same `executeInTenantTransaction` (Cycle 5 review carry-over satisfied), flips the offer to ACCEPTED, the application to ENROLLED, recomputes `enr_capacity_summary`, and emits **`enr.student.enrolled`** with the full ADR-057 envelope shape.

```bash
curl -s -X PATCH "http://localhost:4000/api/v1/offers/$OFFER_ID/respond" \
  -H "Authorization: Bearer $PARENT" -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" \
  -d '{"familyResponse":"ACCEPTED"}'
# → offer.status=ACCEPTED familyResponse=ACCEPTED familyRespondedAt=2026-04-29T04:49:53Z
# → application.status=ENROLLED
```

Capacity summary post-accept (Grade 9 `offers_accepted` 1 → 2, `available` 109 → 108):

```
 grade_level | applications_received | offers_issued | offers_accepted | waitlisted | available
-------------+-----------------------+---------------+-----------------+------------+-----------
 9           |                     4 |             2 |               2 |          1 |       108
 10          |                     1 |             1 |               0 |          0 |       109
```

**`enr.student.enrolled` envelope captured live** on `dev.enr.student.enrolled`:

```json
{
  "event_id": "019dd792-77a4-7ddd-97e6-caf49f2d77d1",
  "event_type": "enr.student.enrolled",
  "event_version": 1,
  "occurred_at": "2026-04-29T04:49:53.572Z",
  "published_at": "2026-04-29T04:49:53.572Z",
  "tenant_id": "019dc92b-ea59-7bb7-aa7f-929729562010",
  "source_module": "enrollment",
  "correlation_id": "019dd792-77a4-7ddd-97e6-...",
  "payload": {
    "applicationId": "019dd790-9866-7ddd-97e6-042608f60847",
    "offerId": "019dd790-e7fa-7ddd-97e6-62de3e750efa",
    "schoolId": "019dc92b-ea59-7bb7-aa7f-929729562010",
    "enrollmentPeriodId": "019dd6e3-1e32-7228-b320-538448dded93",
    "studentFirstName": "CatStep12",
    "studentLastName": "Chen",
    "studentDateOfBirth": "2011-04-15T00:00:00.000Z",
    "gradeLevel": "9",
    "admissionType": "NEW_STUDENT",
    "guardianPersonId": "019dc92d-088c-7442-abf6-0134867d2d92",
    "guardianEmail": "parent@demo.campusos.dev",
    "enrolledAt": "2026-04-29T04:49:53.516Z"
  }
}
```

**`PaymentAccountWorker` reaction** (consumer group `payment-account-worker` subscribed to `dev.enr.student.enrolled`): the worker UPSERTs `pay_family_accounts` keyed on `(school_id, account_holder_id=019dc92d-088c-...)`. Because David Chen already has FA-1001 from the seed, the UPSERT is a no-op. The worker idempotency hit is the documented Step 7 behaviour:

```
[payment-account-worker] reusing existing pay_family_accounts.id=019dd6e4-09a3-7cca-8a56-b559840bba34 for guardianPersonId=019dc92d-088c-7442-abf6-0134867d2d92
[payment-account-worker] no sis_students row for CatStep12 Chen yet — skipping link, will be picked up on later re-emit
```

DB verification — FA count + link count unchanged from the seed:

```
 family_accounts_count |   account_number   |   status   |          account_holder_id           | link_rows
-----------------------+--------------------+------------+--------------------------------------+-----------
                     1 |   FA-1001          |   ACTIVE   | 019dc92d-088c-7442-abf6-0134867d2d92 |         1
```

This is the **graceful-skip behaviour** documented in HANDOFF-CYCLE6.md at line 742 — a future EnrollmentConfirmedWorker will materialise `sis_students` from `enr_applications` on enroll and re-emit, and the worker will then idempotently insert the missing `pay_family_account_students` link.

UI walkthrough: parent at `/offers/:id` clicks **Accept**. The page re-fetches the offer (now `status=ACCEPTED`), application flips to `ENROLLED`, and the inline emerald **Welcome confirmation banner** renders: "🎉 Welcome! CatStep12 Chen has been enrolled in Grade 9. A tuition invoice will be generated shortly — check the Billing section once it arrives." Quick links to `/apply` and `/children`.

---

## Scenario 7 — Admin views billing

Same row David Chen is the account holder for from the seed; `useFamilyAccounts()` returns 1 row for the admin view too (this school has one family).

```bash
curl -s -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/family-accounts
curl -s -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/invoices
```

```
family-accounts: count=1
  FA-1001 David Chen balance=$400 students=1

invoices: count=2
  Technology Fee 2026  status=SENT  total=$400   paid=$0      balance=$400  due=2026-05-28
  Fall 2026 Tuition    status=PAID  total=$12000 paid=$12000  balance=$0    due=2025-09-01
```

UI walkthrough: log in as `principal@demo.campusos.dev`, click **Billing** → routes to `/billing/accounts` (the admin landing). The 3-stat header shows Active accounts=1 / Outstanding balance=$400 / Total accounts=1. Click into FA-1001 — `/billing/accounts/{id}` renders the per-family detail with the Invoices / Payments / Ledger panels.

---

## Scenario 8 — Admin generates invoice from schedule (idempotency check)

`POST /invoices/generate-from-schedule` for the Technology Fee 2026 schedule. The seed already planted a SENT $400 invoice attributed to this fee_schedule_id for FA-1001 (the Maya tech fee), so the backend's `InvoiceService.generateFromSchedule` correctly returns `created=0, skipped=1` — proving the idempotency invariant under UNIQUE-by-(family, fee_schedule_id, non-CANCELLED status).

```bash
curl -s -X POST http://localhost:4000/api/v1/invoices/generate-from-schedule \
  -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" \
  -d '{"feeScheduleId":"<tech-fee-schedule-id>"}'
```

```json
{
  "feeScheduleId": "019dd6e4-099f-7cca-8a56-a14b0a7b98cf",
  "created": 0,
  "skipped": 1,
  "invoiceIds": []
}
```

UI walkthrough: at `/billing/invoices`, click **Generate from schedule**, pick "Technology Fee 2026", submit. The Toast surfaces "0 created, 1 skipped" — re-running the same generate against the already-seeded data is a no-op.

---

## Scenario 9 — Parent partial-pays $200 on Tech Fee 2026

The keystone billing leg. `PaymentService.pay` locks the invoice `FOR UPDATE` inside the tx, writes a PAYMENT ledger entry with negative amount, recomputes invoice status (PARTIAL because `amountPaid < totalAmount`), invalidates the Redis balance cache, and emits **`pay.payment.received`**.

```bash
curl -s -X POST http://localhost:4000/api/v1/invoices/$INVOICE/pay \
  -H "Authorization: Bearer $PARENT" -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" \
  -d '{"amount":200,"paymentMethod":"CARD","notes":"CAT step 12 partial"}'
```

```
payment.id=019dd794-4be3-7ddd-97e7-27222314a34b
amount=200 status=COMPLETED
stripePaymentIntentId=pi_dev_019dd7944be37ddd97e72722

invoice.status=PARTIAL amountPaid=200 balanceDue=200
balance: { balance: 200, cached: true }
```

**`pay.payment.received` envelope captured live** on `dev.pay.payment.received` (full ADR-057 shape):

```json
{
  "event_id": "019dd794-4bef-7ddd-97e7-34026cc491f3",
  "event_type": "pay.payment.received",
  "event_version": 1,
  "occurred_at": "2026-04-29T04:51:53.455Z",
  "published_at": "2026-04-29T04:51:53.455Z",
  "tenant_id": "019dc92b-ea59-7bb7-aa7f-929729562010",
  "source_module": "payments",
  "correlation_id": "019dd794-4bef-7ddd-97e7-38e5c0c2aa2c",
  "payload": {
    "paymentId": "019dd794-4be3-7ddd-97e7-27222314a34b",
    "invoiceId": "019dd6e4-09af-7cca-8a56-d29f6b7c3a11",
    "familyAccountId": "019dd6e4-09a3-7cca-8a56-b559840bba34",
    "amount": 200,
    "paymentMethod": "CARD",
    "invoiceStatus": "PARTIAL",
    "totalAmount": 400,
    "amountPaid": 200,
    "paidAt": "2026-04-29T04:51:53.442Z"
  }
}
```

UI walkthrough: parent at `/billing` sees the SENT Tech Fee 2026 row in the Outstanding-invoices section with a "Pay now →" link. Clicks through to `/billing/pay/019dd6e4-09af-...`. The amount field auto-fills with $400 (the full balance) — parent edits to `200`. Clicks "Pay $200.00". Toast: "Paid $200.00 by card." Routes back to `/billing/invoices/{id}` which now renders status=Partially paid, balance due $200.

---

## Scenario 10 — Parent pays remaining $200 (PAID + balance $0)

Second `pay.payment.received` emit; invoice flips PARTIAL → PAID; balance $200 → $0.

```bash
curl -s -X POST http://localhost:4000/api/v1/invoices/$INVOICE/pay \
  -H "Authorization: Bearer $PARENT" -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" \
  -d '{"amount":200,"paymentMethod":"CARD","notes":"CAT step 12 final"}'
```

```
payment.id=019dd794-4c29-7ddd-97e7-45cb88c9c21e
amount=200 status=COMPLETED
stripePaymentIntentId=pi_dev_019dd7944c297ddd97e745cb

invoice.status=PAID amountPaid=400 balanceDue=0
balance: { balance: 0, cached: true }
```

DB ledger SUM check confirms 5 entries summing to $0 (3 seeded + 2 PAYMENT entries from this run):

```
 ledger_sum | rows
------------+------
 0.00       | 5
```

Overpay attempt rejected — invoice is now PAID:

```
HTTP 400 "Invoice is already PAID"
```

UI walkthrough: parent pays the remaining $200 from `/billing/pay/{id}`. Toast: "Paid $200.00 by card." Invoice detail now shows status=Paid, balance due $0. The parent's `/billing` dashboard's Outstanding-invoices section now shows the "You're all paid up — no invoices need your attention" emerald banner.

---

## Scenario 11 — Admin issues partial refund of $50

`RefundService.issue` locks the payment `FOR UPDATE` inside the tx, writes a REFUND ledger entry with positive amount (restoring balance), and emits **`pay.refund.issued`**. Partial refund leaves the payment as COMPLETED (a full-amount refund would flip it to REFUNDED — verified live in Step 7 smoke).

```bash
curl -s -X POST http://localhost:4000/api/v1/payments/$PAYMENT_ID/refund \
  -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" \
  -d '{"amount":50,"refundCategory":"GOODWILL","reason":"CAT step 12 partial refund test"}'
```

```
refund.id=019dd795-cf7d-7ddd-97e7-801d78bcb1fb
amount=50 status=COMPLETED
stripeRefundId=re_dev_019dd795cf7d7ddd97e7801d

payment.status=COMPLETED amount=200   ← partial refund leaves payment COMPLETED
balance: { balance: 50, cached: true } ← REFUND ledger entry restores $50 to balance

ledger_sum=$50.00 rows=6   ← 3 seeded + 2 PAYMENT + 1 REFUND
```

**`pay.refund.issued` envelope captured live** on `dev.pay.refund.issued`:

```json
{
  "event_id": "019dd795-cf9d-7ddd-97e7-916e71cab65b",
  "event_type": "pay.refund.issued",
  "event_version": 1,
  "occurred_at": "2026-04-29T04:53:32.701Z",
  "published_at": "2026-04-29T04:53:32.701Z",
  "tenant_id": "019dc92b-ea59-7bb7-aa7f-929729562010",
  "source_module": "payments",
  "correlation_id": "019dd795-cf9d-7ddd-97e7-9d1a4b46c5d7",
  "payload": {
    "refundId": "019dd795-cf7d-7ddd-97e7-801d78bcb1fb",
    "paymentId": "019dd794-4c29-7ddd-97e7-45cb88c9c21e",
    "familyAccountId": "019dd6e4-09a3-7cca-8a56-b559840bba34",
    "amount": 50,
    "refundCategory": "GOODWILL",
    "reason": "CAT step 12 partial refund test",
    "status": "COMPLETED",
    "authorisedBy": "019dc92d-087d-7442-abf5-d16bc2fe960d",
    "completedAt": "2026-04-29T04:53:32.669Z"
  }
}
```

UI walkthrough: admin at `/billing/payments` sees the second $200 COMPLETED payment row, clicks **Refund**. Modal pre-fills $50 (refund category required: GOODWILL), enters reason "CAT step 12 partial refund test", submits. Toast: "Refunded $50.00." The family account's running balance updates from $0 to $50 on the next bell tick.

---

## Scenario 12 — Permission denials (6 paths)

| # | Scenario | Result |
|---|----------|--------|
| a | teacher `GET /family-accounts` | **403** (no `fin-001:read`) |
| b | student `POST /invoices/{id}/pay` | **403 INSUFFICIENT_PERMISSIONS** required=`['fin-001:write']` (gate-tier) |
| c | parent `POST /fee-categories` | **403 INSUFFICIENT_PERMISSIONS** required=`['fin-001:admin']` (gate-tier) |
| d | parent `GET /refunds` | **403 Forbidden** "Only admins can list refunds" (service-layer admin-only) |
| e | parent `PATCH /applications/{Aiden's}/status` | **403 INSUFFICIENT_PERMISSIONS** required=`['stu-003:admin']` (gate-tier — parent has stu-003:write but not admin) |
| f | parent `POST /pay` with `paymentMethod:"CASH"` | **403 Forbidden** "Self-service parent payments accept CARD or BANK_TRANSFER only" (`PaymentService.pay`'s `assertSelfServiceMethod`) |

Three permission tiers verified: gate-tier method-level (b, c, e), service-layer admin-only (d), and service-layer self-service rule (f). Plus the gate-tier no-permission case (a).

---

## Cleanup

The CAT modifies the demo tenant. Restore to seed state with:

```sql
SET search_path TO tenant_demo, platform, public;

-- Drop the new application + offer + screening + notes (CASCADE on application drops the rest)
DELETE FROM enr_applications WHERE student_first_name = 'CatStep12';

-- Drop the 1 refund + 2 payments + 3 ledger entries from this run
DELETE FROM pay_refunds WHERE reason = 'CAT step 12 partial refund test';
DELETE FROM pay_ledger_entries WHERE description LIKE '%invoice payment via CARD%' AND created_at >= '2026-04-29' AND amount = -200;
DELETE FROM pay_ledger_entries WHERE entry_type = 'REFUND' AND created_at >= '2026-04-29' AND amount = 50;
DELETE FROM pay_payments WHERE invoice_id = '019dd6e4-09af-7cca-8a56-d29f6b7c3a11' AND amount = 200;

-- Reset Tech Fee invoice back to SENT (was flipped to PAID in scenario 10)
UPDATE pay_invoices SET status = 'SENT' WHERE id = '019dd6e4-09af-7cca-8a56-d29f6b7c3a11';

-- Restore capacity_summary to seed values
UPDATE enr_capacity_summary SET applications_received=2, offers_issued=1, offers_accepted=1, waitlisted=1, available=108 WHERE grade_level='9';
```

Then `redis-cli DEL ledger:balance:019dd6e4-09a3-7cca-8a56-b559840bba34` (typically returns 0 because the `usePayInvoice` mutation already cleared the cache inside its write tx). Final balance read confirms `$400 cached:true`:

```bash
curl -s "http://localhost:4000/api/v1/family-accounts/019dd6e4-09a3-7cca-8a56-b559840bba34/balance" \
  -H "Authorization: Bearer $PARENT" -H "X-Tenant-Subdomain: demo"
# { "familyAccountId": "...", "balance": 400, "cached": true }
```

Final restored state:

```
              t              | count
-----------------------------+--------
 enr_applications            | 4
 enr_offers                  | 2
 pay_invoices_status         | SENT
 pay_payments                | 1
 pay_ledger_entries          | 3
 pay_refunds                 | 0
 ledger_balance_for_FA-1001  | 400.00
```

---

## Outcome

All 12 scenarios pass. The vertical slice exercises:

- **Schema** — 22 enrollment + payments base tables, partition-replicated FK on `pay_ledger_entries`, zero cross-schema FKs, multi-column CHECK constraints (sent_chk, paid_chk, conditions_chk, response_pair_chk, completed_chk).
- **Seed** — admissions pipeline shape (4 applications across statuses), offers + waitlist, fee categories + schedules, family account FA-1001 with 1 student linked, 2 invoices + 1 payment + 3 ledger entries summing to $400.
- **API** — 17 enrollment endpoints (`ApplicationService.create` + `transition`, `OfferService.issue` + `respond`, `EnrollmentPeriodService` reads) + 24 payments endpoints (`FamilyAccountService` reads, `InvoiceService.generateFromSchedule` idempotent, `PaymentService.pay` lock-and-emit, `RefundService.issue` lock-and-emit, balance reads through Redis).
- **Kafka** — 3 envelopes captured live with full ADR-057 shape: `enr.student.enrolled` (`source_module:enrollment`), `pay.payment.received` (`source_module:payments`), `pay.refund.issued` (`source_module:payments`).
- **Worker** — `PaymentAccountWorker` idempotently UPSERTs `pay_family_accounts` keyed on `(school, account_holder_id)` + gracefully skips the student link when `sis_students` doesn't exist yet (the documented edge case for the future EnrollmentConfirmedWorker).
- **Web** — admin admissions pipeline + capacity dashboard (Step 8), parent apply + offer respond (Step 9), admin billing accounts/invoices/payments/fees (Step 10), parent billing dashboard + pay form + ledger (Step 11). Sidebar tile branches on `personType=GUARDIAN` to route guardians to `/billing` instead of `/billing/accounts`.
- **Permissions** — 6 denial paths covering gate-tier method requirements (read / write / admin tiers) and service-layer rules (admin-only refund list, self-service payment-method restriction).

### Known gaps surfaced by the CAT (Phase 2 punch list, not Cycle 6 scope)

- **PaymentAccountWorker student link.** When parent submits a new application that becomes ENROLLED, the worker correctly creates / reuses the family account but skips the `pay_family_account_students` link because the `sis_students` row doesn't exist. The future EnrollmentConfirmedWorker will materialise `sis_students` from `enr_applications` on enroll and re-emit `enr.student.enrolled`, at which point the worker will idempotently insert the link. This is the documented Step 7 behaviour and intentional for Cycle 6.
- **Receipt PDF download.** The schema's `pay_payments.receipt_s3_key` is nullable and currently NULL for every dev payment (CARD payments mock with `pi_dev_*` and don't generate a receipt). Real S3 wiring is a Phase 3 ops task once Stripe lands properly per ADR-003.
- **Real Stripe API integration.** The PaymentService accepts a Stripe payment intent reference but doesn't make actual Stripe API calls in dev — CARD payments auto-COMPLETE with mock `pi_dev_*` ids, refunds with mock `re_dev_*` ids. Phase 3 ops work, deliberately punted to keep Cycle 6 focused on the schema + service contract.

**Cycle 6 ships clean to the post-cycle architecture review.**
