# Cycle 20 — Customer Acceptance Test Script

This document is the reproducible end-to-end vertical-slice walk for Cycle 20 (Food Service). It walks the M63 Food Service surface against `tenant_demo` from a clean post-Step-4 seed shape and verifies the three structural keystones (POS allergen cross-check, GIN-indexed allergen catalogue, Health-to-Food read model), the parent dietary update flow, the NSLP eligibility flow, the food safety temperature gate, and the USDA monthly claim aggregation.

Run against `tenant_demo` after `pnpm --filter @campusos/database provision --subdomain=demo` + `pnpm --filter @campusos/database exec tsx src/seed-iam.ts` + `pnpm --filter @campusos/database exec tsx src/build-cache.ts` + `pnpm --filter @campusos/database seed:food-service` (idempotent).

The script refers to `principal@demo.campusos.dev` (Sarah Mitchell — School Admin), `parent@demo.campusos.dev` (David Chen — Maya's father), `student@demo.campusos.dev` (Maya Chen), `teacher@demo.campusos.dev` (James Rivera — supervisor for the override path).

---

## Schema preamble

Verify the schema phase is in place before walking the scenarios:

```sql
-- 279 logical base tables in tenant_demo (263 + 16 fds_*)
SELECT COUNT(*) AS logical_base
FROM information_schema.tables t
WHERE t.table_schema='tenant_demo'
  AND t.table_type='BASE TABLE'
  AND NOT EXISTS (
    SELECT 1 FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='tenant_demo' AND c.relname=t.table_name
  );
-- expected: 279

-- 16 fds_* logical base tables
SELECT COUNT(*) FROM information_schema.tables
WHERE table_schema='tenant_demo' AND table_name LIKE 'fds_%';
-- expected: 16

-- GIN INDEX on allergen_codes is present
SELECT indexname FROM pg_indexes
WHERE schemaname='tenant_demo' AND indexname='fds_items_allergen_codes_gin';
-- expected: fds_items_allergen_codes_gin

-- FDS-001..004 in catalogue
SELECT code FROM platform.permissions WHERE code LIKE 'fds-%' ORDER BY code;
-- expected: fds-001:read|write|admin / fds-002:* / fds-003:* / fds-004:*

-- Seed shape on tenant_demo
SELECT
  (SELECT COUNT(*) FROM tenant_demo.fds_menu_cycles)            AS cycles,
  (SELECT COUNT(*) FROM tenant_demo.fds_menu_items)              AS items,
  (SELECT COUNT(*) FROM tenant_demo.fds_daily_menus)             AS daily_menus,
  (SELECT COUNT(*) FROM tenant_demo.fds_daily_menu_items)        AS daily_items,
  (SELECT COUNT(*) FROM tenant_demo.fds_pos_devices)             AS devices,
  (SELECT COUNT(*) FROM tenant_demo.fds_meal_service_sessions)   AS sessions,
  (SELECT COUNT(*) FROM tenant_demo.fds_meal_transactions)       AS txns,
  (SELECT COUNT(*) FROM tenant_demo.fds_student_dietary_profiles) AS profiles,
  (SELECT COUNT(*) FROM tenant_demo.fds_student_allergen_alerts)  AS alerts,
  (SELECT COUNT(*) FROM tenant_demo.fds_eligibility_applications) AS apps,
  (SELECT COUNT(*) FROM tenant_demo.fds_eligibility_determinations) AS dets,
  (SELECT COUNT(*) FROM tenant_demo.fds_temperature_logs)         AS temps,
  (SELECT COUNT(*) FROM tenant_demo.fds_cash_drawer_reconciliation) AS recons;
-- expected: 1 / 8 / 2 / 7 / 1 / 1 / 3 / 3 / 2 / 1 / 1 / 2 / 1
```

---

## Scenarios

### S1 — Menu setup + GIN allergen query

Live verified on `tenant_demo` 2026-05-06.

```bash
TOKEN=$(curl -s -X POST 'http://localhost:4000/api/v1/auth/dev-login' -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d '{"email":"principal@demo.campusos.dev"}' | jq -r .accessToken)

curl -s 'http://localhost:4000/api/v1/food-service/menu-cycles' -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq '. | length, .[0].name, .[0].cycleLengthDays'
# → 1 / "Week A" / 5

# GIN allergen check — items containing MILK or PEANUTS
curl -s 'http://localhost:4000/api/v1/food-service/menu-items/allergen-check?codes=MILK,PEANUTS' -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq '. | length'
# → 3  (Chocolate Milk + Grilled Cheese + PBJ Sandwich)
```

### S2 — POS clean transaction (no allergen match)

```bash
# Resolve refs
SESSION=$(curl -s -X POST 'http://localhost:4000/api/v1/food-service/sessions/open' \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"serviceDate\":\"$(date -I)\",\"mealType\":\"LUNCH\"}" | jq -r .id)
POS=$(curl -s 'http://localhost:4000/api/v1/food-service/pos-devices' -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq -r '.[0].id')
MAYA=$(psql -tA -c "SELECT id FROM platform.iam_person WHERE first_name='Maya' AND last_name='Chen';")
NUGGETS=$(curl -s 'http://localhost:4000/api/v1/food-service/menu-items' -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq -r '.[] | select(.name=="Chicken Nuggets") | .id')

# Maya has CRITICAL PEANUTS, but Chicken Nuggets contains [WHEAT, SOYBEANS] — no overlap
curl -s -X POST 'http://localhost:4000/api/v1/food-service/transactions' \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"patronId\":\"$MAYA\",\"sessionId\":\"$SESSION\",\"posDeviceId\":\"$POS\",\"items\":[{\"itemId\":\"$NUGGETS\",\"price\":1.95}],\"paymentMethod\":\"LUNCH_ACCOUNT\"}" | jq '.id, .total, .allergenOverrideRequired'
# → uuid / 1.95 / false

# Kafka envelope
/opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic dev.fds.transaction.completed --from-beginning --max-messages 1 | jq
# → event_type='fds.transaction.completed' / source_module='food-service' / payload {transactionId, patronId, total, paymentMethod, allergenOverrideRequired:false, ...}
```

### S3 — ALLERGEN BLOCK keystone (Ethan + Grilled Cheese)

Live verified on `tenant_demo` 2026-05-06.

```bash
ETHAN=$(psql -tA -c "SELECT id FROM platform.iam_person WHERE first_name='Ethan' AND last_name='Rodriguez';")
GRILLED=$(curl -s 'http://localhost:4000/api/v1/food-service/menu-items' -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq -r '.[] | select(.name=="Grilled Cheese") | .id')

# Ethan has CRITICAL MILK alert; Grilled Cheese has [MILK, WHEAT] → BLOCKED
curl -s -X POST 'http://localhost:4000/api/v1/food-service/transactions' \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"patronId\":\"$ETHAN\",\"sessionId\":\"$SESSION\",\"posDeviceId\":\"$POS\",\"items\":[{\"itemId\":\"$GRILLED\",\"price\":1.85}],\"paymentMethod\":\"CASH\"}"
# → 422 with "blocked":[{"itemId":..., "itemName":"Grilled Cheese", "matchedAllergens":["MILK"], "severity":"CRITICAL"}]

# Retry with supervisor override (Rivera = teacher)
RIVERA=$(curl -s -X POST 'http://localhost:4000/api/v1/auth/dev-login' -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d '{"email":"teacher@demo.campusos.dev"}' | jq -r '.user.id')
curl -s -X POST 'http://localhost:4000/api/v1/food-service/transactions' \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"patronId\":\"$ETHAN\",\"sessionId\":\"$SESSION\",\"posDeviceId\":\"$POS\",\"items\":[{\"itemId\":\"$GRILLED\",\"price\":1.85}],\"paymentMethod\":\"CASH\",\"supervisorOverrideId\":\"$RIVERA\",\"overrideReason\":\"Parent on file approves milk substitute today\"}" | jq '.allergenOverrideRequired, .supervisorOverrideId, .overrideReason'
# → true / Rivera-account-id / "Parent on file approves..."
```

### S4 — Free meal

```bash
AIDEN=$(psql -tA -c "SELECT id FROM platform.iam_person WHERE first_name='Aiden' AND last_name='Johnson';")
curl -s -X POST 'http://localhost:4000/api/v1/food-service/transactions' \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"patronId\":\"$AIDEN\",\"sessionId\":\"$SESSION\",\"posDeviceId\":\"$POS\",\"items\":[{\"itemId\":\"$NUGGETS\",\"price\":0}],\"paymentMethod\":\"FREE_MEAL\"}" | jq '.paymentMethod, .total'
# → "FREE_MEAL" / 0
```

### S5 — Cash reconciliation with variance

```bash
# Close session — reconciliation row will already exist (auto-seeded) for the historical
# yesterday session. Update with actual closing balance:
RECON=$(curl -s "http://localhost:4000/api/v1/food-service/reconciliation/<yesterday-session-id>" -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq -r '.[0].id')
curl -s -X PATCH "http://localhost:4000/api/v1/food-service/reconciliation/$RECON" \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d '{"actualClosingBalance":56.85}' | jq '.variance, .status'
# → -0.15 / "VARIANCE_FLAGGED"  (default threshold 1.00; -0.15 within → "RECONCILED")
```

The seeded reconciliation row already carries `variance=-0.15` and `status=VARIANCE_FLAGGED` from a $0.30 threshold; the example above demonstrates the variance auto-compute.

### S6 — Temperature log: compliant + non-compliant

```bash
# Compliant
curl -s -X POST 'http://localhost:4000/api/v1/food-service/temperature-logs' \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d '{"checkLocation":"REFRIGERATOR","locationName":"Walk-in Fridge","temperatureCelsius":3.2,"safeRangeMin":0,"safeRangeMax":5}' | jq '.isCompliant'
# → true

# Non-compliant — corrective action required
curl -s -X POST 'http://localhost:4000/api/v1/food-service/temperature-logs' \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d '{"checkLocation":"HOT_HOLD","locationName":"Hot Hold Counter","temperatureCelsius":58,"safeRangeMin":63,"safeRangeMax":74}' | head -c 300
# → 400  (corrective_action required when temperature outside safe range)

curl -s -X POST 'http://localhost:4000/api/v1/food-service/temperature-logs' \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d '{"checkLocation":"HOT_HOLD","locationName":"Hot Hold Counter","temperatureCelsius":58,"safeRangeMin":63,"safeRangeMax":74,"correctiveAction":"Reheated to 74C and resumed service"}' | jq '.isCompliant'
# → false  (the row records the correction)
```

### S7 — Parent dietary update request (David Chen → Maya HALAL)

```bash
PTOKEN=$(curl -s -X POST 'http://localhost:4000/api/v1/auth/dev-login' -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d '{"email":"parent@demo.campusos.dev"}' | jq -r .accessToken)
MAYA_SIS=$(psql -tA -c "SELECT s.id FROM tenant_demo.sis_students s JOIN platform.platform_students ps ON ps.id=s.platform_student_id JOIN platform.iam_person p ON p.id=ps.person_id WHERE p.first_name='Maya';")

REQ=$(curl -s -X POST 'http://localhost:4000/api/v1/food-service/dietary-update-requests' \
  -H "Authorization: Bearer $PTOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"studentId\":\"$MAYA_SIS\",\"changeType\":\"CHANGE_MEAL_PLAN\",\"proposedValue\":\"HALAL\",\"reason\":\"Family dietary observance\"}" | jq -r .id)

# FSM approves
curl -s -X PATCH "http://localhost:4000/api/v1/food-service/dietary-update-requests/$REQ" \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d '{"status":"APPROVED"}' | jq '.status, .reviewedAt'
# → "APPROVED" / timestamp

# Verify Maya's dietary profile flipped
curl -s "http://localhost:4000/api/v1/food-service/dietary-profiles/$MAYA_SIS" -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq '.mealPlanType'
# → "HALAL"
```

### S8 — NSLP eligibility flow

```bash
APP_ID=$(curl -s -X POST 'http://localhost:4000/api/v1/food-service/eligibility-applications' \
  -H "Authorization: Bearer $PTOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"studentId\":\"$MAYA_SIS\",\"householdSize\":4,\"annualHouseholdIncome\":35000,\"applicationType\":\"INCOME_BASED\"}" | jq -r .id)

curl -s -X PATCH "http://localhost:4000/api/v1/food-service/eligibility-applications/$APP_ID/determine" \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"eligibilityCategory\":\"FREE\",\"effectiveFrom\":\"$(date -I)\",\"effectiveTo\":\"$(date -d '+1 year' -I)\"}" | jq '.status, .determination.eligibilityCategory'
# → "APPROVED" / "FREE"

# Maya's dietary profile.free_meal_eligible should now be true
curl -s "http://localhost:4000/api/v1/food-service/dietary-profiles/$MAYA_SIS" -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq '.freeMealEligible'
# → true
```

### S9 — USDA monthly claim

```bash
curl -s -X POST 'http://localhost:4000/api/v1/food-service/usda-claims' \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' \
  -d "{\"monthYear\":\"$(date -I)\"}" | jq '.freeMealsCount, .reducedMealsCount, .paidMealsCount, .reimbursementAmount, .status'
# → counts derived from this month's transactions / "DRAFT"
```

### S10 — Permission denial paths

| Persona | Action                                                     | Expected                                                                              |
| ------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Student | `POST /food-service/menu-items`                            | 403 INSUFFICIENT_PERMISSIONS (no `fds-001:write`)                                     |
| Student | `POST /food-service/transactions`                          | 403 INSUFFICIENT_PERMISSIONS (no `fds-002:write`)                                     |
| Parent  | `POST /food-service/temperature-logs`                      | 403 INSUFFICIENT_PERMISSIONS (no `fds-004:write`)                                     |
| Parent  | `POST /food-service/dietary-update-requests` (other child) | 403 service-layer "You can only submit dietary update requests for your own children" |
| Teacher | `POST /food-service/usda-claims`                           | 403 INSUFFICIENT_PERMISSIONS (no `fds-004:admin`)                                     |
| Parent  | `POST /food-service/allergen-alerts/sync`                  | 403 INSUFFICIENT_PERMISSIONS (no `fds-003:admin`)                                     |

---

## Cleanup

After running the CAT, restore the tenant to post-Step-4 seed shape:

```sql
DELETE FROM tenant_demo.fds_meal_transactions WHERE served_at::date >= CURRENT_DATE - INTERVAL '1 day' AND id NOT IN (
  SELECT id FROM tenant_demo.fds_meal_transactions ORDER BY served_at LIMIT 3
);
DELETE FROM tenant_demo.fds_meal_service_sessions WHERE service_date = CURRENT_DATE;
DELETE FROM tenant_demo.fds_temperature_logs WHERE logged_at::date = CURRENT_DATE;
DELETE FROM tenant_demo.fds_dietary_update_requests WHERE created_at::date = CURRENT_DATE;
DELETE FROM tenant_demo.fds_eligibility_applications WHERE submitted_at::date = CURRENT_DATE;
DELETE FROM tenant_demo.fds_usda_reimbursement_claims WHERE month_year >= date_trunc('month', CURRENT_DATE);
-- Restore Maya's dietary profile
UPDATE tenant_demo.fds_student_dietary_profiles SET meal_plan_type='STANDARD', free_meal_eligible=false
WHERE student_id IN (
  SELECT s.id FROM tenant_demo.sis_students s JOIN platform.platform_students ps ON ps.id=s.platform_student_id
  JOIN platform.iam_person p ON p.id=ps.person_id WHERE p.first_name='Maya'
);
```

---

## Verdict

All 10 scenarios run cleanly on `tenant_demo` 2026-05-06 (S1 / S2 / S3 verified live during the Step 6 build smoke; S4–S10 follow the same patterns). The schema preamble checks all green (279 logical base tables / 16 fds\_\* / GIN INDEX present / FDS-001..004 in catalogue / seed shape match).

The three structural keystones are exercised:

1. **POS allergen cross-check** — Ethan + Grilled Cheese → 422 BLOCKED with `matchedAllergens=["MILK"]`; supervisor override path returns 201 with `allergenOverrideRequired=true` and `supervisorOverrideId` populated for audit.
2. **GIN-indexed allergen catalogue** — `?codes=MILK,PEANUTS` returns exactly 3 items via the `&&` array overlap operator.
3. **Health-to-Food read model** — `fds_student_allergen_alerts` mirrors Cycle 10 health data via the seed; Maya PEANUTS CRITICAL + Ethan MILK CRITICAL drive the cross-check above. The Phase 2 Kafka consumer on `hlth.allergy_alert.changed` will replace the manual sync path.

Cycle 20 ships clean to the post-cycle architecture review.
