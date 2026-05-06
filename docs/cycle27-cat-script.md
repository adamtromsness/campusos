# Cycle 27 — Customer Acceptance Test (Step 10)

**Module:** M86 Procurement (Wave 6 continuation cycle, opens alongside M83 Finance).
**Verified live on:** `tenant_demo` 2026-05-06.
**Reproducibility:** every command is shell-pasteable. The cleanup section restores `tenant_demo` to the post-Step-4 seed shape so the next CAT run starts clean.

---

## Schema preamble

8 checks confirming the tenant schema landed correctly:

```sh
# Check 1 — 12 prc_* tables present
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='tenant_demo' AND table_name LIKE 'prc_%'"
# Expect: 12

# Check 2 — list every table by name
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT table_name FROM information_schema.tables WHERE table_schema='tenant_demo' AND table_name LIKE 'prc_%' ORDER BY table_name"
# Expect: prc_budget_commitments, prc_distribution_lines, prc_distributions, prc_goods_receipt_lines,
#         prc_goods_receipts, prc_procurement_settings, prc_purchase_order_lines, prc_purchase_orders,
#         prc_requisition_lines, prc_requisitions, prc_returns, prc_vendor_performance

# Check 3 — Foreign-key delete actions: CASCADE on subordinate audit
#           (lines, distribution lines), NO ACTION on financial-audit edges
#           (commitments → budget_lines, returns → receipt_lines, etc.).
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT cl.relname AS tbl, conname, confdeltype FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='tenant_demo' AND cl.relname LIKE 'prc_%' AND contype='f' ORDER BY cl.relname, conname"
# Expect 14 rows; CASCADE on prc_requisition_lines→prc_requisitions, prc_purchase_order_lines→prc_purchase_orders,
# prc_goods_receipt_lines→prc_goods_receipts, prc_distribution_lines→prc_distributions.

# Check 4 — Multi-column lockstep CHECKs landed
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT conname FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='tenant_demo' AND cl.relname='prc_returns' AND contype='c' ORDER BY conname"
# Expect: prc_ret_resolved_chk, prc_ret_resolution_pair_chk, prc_ret_status_chk

# Check 5 — Quantity balance CHECK on receipt lines (accepted + rejected = received)
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT conname FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='tenant_demo' AND cl.relname='prc_goods_receipt_lines' AND contype='c' ORDER BY conname"
# Expect: prc_grl_quantity_balance_chk among others

# Check 6 — IAM grants for Staff: PRC-001..003 read+write
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT p.code FROM platform.role_permission rp JOIN platform.roles r ON r.id=rp.role_id JOIN platform.permissions p ON p.id=rp.permission_id WHERE r.name='Staff' AND p.code LIKE 'prc-00%' ORDER BY p.code"
# Expect: prc-001:read, prc-001:write, prc-002:read, prc-002:write, prc-003:read, prc-003:write

# Check 7 — Teacher gets requisitioning-only PRC-001 read+write
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT p.code FROM platform.role_permission rp JOIN platform.roles r ON r.id=rp.role_id JOIN platform.permissions p ON p.id=rp.permission_id WHERE r.name='Teacher' AND p.code LIKE 'prc-00%' ORDER BY p.code"
# Expect: prc-001:read, prc-001:write

# Check 8 — Step 4 seed shape: 1 settings, 2 reqs (1 ADMIN_APPROVED + 1 SUBMITTED),
#           1 PO RECEIVED, 1 receipt with 2 lines (9 GOOD + 1 DAMAGED),
#           1 commitment $3,250 COMMITTED, 1 distribution → tech, 1 return INITIATED,
#           1 vendor performance row.
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT 'settings' AS k, count(*) FROM tenant_demo.prc_procurement_settings UNION ALL SELECT 'requisitions', count(*) FROM tenant_demo.prc_requisitions UNION ALL SELECT 'requisition_lines', count(*) FROM tenant_demo.prc_requisition_lines UNION ALL SELECT 'purchase_orders', count(*) FROM tenant_demo.prc_purchase_orders UNION ALL SELECT 'po_lines', count(*) FROM tenant_demo.prc_purchase_order_lines UNION ALL SELECT 'receipts', count(*) FROM tenant_demo.prc_goods_receipts UNION ALL SELECT 'receipt_lines', count(*) FROM tenant_demo.prc_goods_receipt_lines UNION ALL SELECT 'commitments', count(*) FROM tenant_demo.prc_budget_commitments UNION ALL SELECT 'distributions', count(*) FROM tenant_demo.prc_distributions UNION ALL SELECT 'distribution_lines', count(*) FROM tenant_demo.prc_distribution_lines UNION ALL SELECT 'returns', count(*) FROM tenant_demo.prc_returns UNION ALL SELECT 'vendor_perf', count(*) FROM tenant_demo.prc_vendor_performance ORDER BY 1"
# Expect: settings=1, requisitions=2, requisition_lines=5, purchase_orders=1, po_lines=2,
#         receipts=1, receipt_lines=2, commitments=1, distributions=1, distribution_lines=2,
#         returns=1, vendor_perf=1.
```

---

## Plan scenarios

### S1 — Teacher submits a requisition (PRC-001 self-service)

```sh
# Login as Rivera (teacher)
TOKEN=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' -d '{"email":"teacher@demo.campusos.dev"}' | jq -r '.accessToken')

# Submit a requisition for 10 Chromebooks
REQ_ID=$(curl -sX POST http://localhost:4000/api/v1/procurement/requisitions \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d '{"justification":"S1 CAT — classroom Chromebook refresh","urgency":"ROUTINE","lines":[{"itemDescription":"Chromebook 14\"","quantity":10,"estimatedUnitCost":325,"destinationModule":"tech"}]}' | jq -r '.id')
echo "Created req $REQ_ID"
# Expect: status=DRAFT, totalEstimatedCost=$3,250

# Submit for approval
curl -sX PATCH http://localhost:4000/api/v1/procurement/requisitions/$REQ_ID/submit \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq '.status'
# Expect: "SUBMITTED" + Kafka envelope on dev.prc.requisition.submitted
```

### S2 — Multi-level approval (DEPT → ADMIN → DISTRICT)

```sh
# Switch to Sarah (school admin)
ADMIN_TOKEN=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' -d '{"email":"principal@demo.campusos.dev"}' | jq -r '.accessToken')

# Advance through the chain
curl -sX PATCH http://localhost:4000/api/v1/procurement/requisitions/$REQ_ID/approve \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' -d '{"toStatus":"DEPT_APPROVED"}' | jq '.status'
# Expect: "DEPT_APPROVED"

curl -sX PATCH http://localhost:4000/api/v1/procurement/requisitions/$REQ_ID/approve \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' -d '{"toStatus":"ADMIN_APPROVED"}' | jq '.status'
# Expect: "ADMIN_APPROVED"

# Try an illegal transition (jump from ADMIN to ORDERED before DISTRICT approval is allowed since
# ALLOWED_APPROVAL_TRANSITIONS.ADMIN_APPROVED includes both DISTRICT_APPROVED and ORDERED — both work)
```

### S3 — Issue PO (BUDGET COMMITMENT KEYSTONE)

```sh
# Read budget remaining BEFORE the issue
BUDGET_LINE_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc \
  "SELECT bl.id FROM tenant_demo.fin_budget_lines bl JOIN tenant_demo.fin_chart_of_accounts a ON a.id=bl.account_id WHERE a.account_code='5000' LIMIT 1")
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT budgeted_amount, actual_amount, encumbered_amount, budgeted_amount - actual_amount - encumbered_amount AS remaining FROM tenant_demo.fin_budget_lines WHERE id='$BUDGET_LINE_ID'"
# Capture initial encumbered_amount.

# Create PO from-scratch (skip create-from-requisition for this run since the seed already has the CB-12345 PO)
DELL_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc \
  "SELECT id FROM tenant_demo.fin_suppliers WHERE supplier_name='Dell Education' LIMIT 1")
PO_ID=$(curl -sX POST http://localhost:4000/api/v1/procurement/purchase-orders \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d "{\"vendorId\":\"$DELL_ID\",\"requisitionId\":\"$REQ_ID\",\"deliveryAddress\":\"Lincoln Elementary, 1234 Oak St\",\"expectedDeliveryDate\":\"2026-05-20\",\"paymentTerms\":\"NET_30\",\"budgetLineId\":\"$BUDGET_LINE_ID\",\"lines\":[{\"itemDescription\":\"Chromebook 14\\\"\",\"quantityOrdered\":10,\"unitCost\":325,\"destinationModule\":\"tech\"}]}" | jq -r '.id')
echo "Created PO $PO_ID"
# Expect: status=DRAFT, totalAmount=3250

# Issue keystone — opens tx, INSERTs commitment, bumps fin_budget_lines.encumbered_amount,
# flips PO → ISSUED + parent requisition → ORDERED.
curl -sX PATCH http://localhost:4000/api/v1/procurement/purchase-orders/$PO_ID/transition \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d "{\"action\":\"ISSUE\",\"budgetLineId\":\"$BUDGET_LINE_ID\"}" | jq '.status,.commitments[0].committedAmount,.commitments[0].status'
# Expect: "ISSUED", 3250, "COMMITTED"

# Re-read encumbered_amount
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT encumbered_amount FROM tenant_demo.fin_budget_lines WHERE id='$BUDGET_LINE_ID'"
# Expect: bumped by exactly 3250 (the PO total)
```

### S4 — Receive goods with 1 damaged (vendor performance auto-scoring)

```sh
PO_LINE_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc \
  "SELECT id FROM tenant_demo.prc_purchase_order_lines WHERE purchase_order_id='$PO_ID' LIMIT 1")

curl -sX POST http://localhost:4000/api/v1/procurement/purchase-orders/$PO_ID/receipts \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d "{\"inspectionOutcome\":\"ACCEPTED_WITH_DISCREPANCY\",\"notes\":\"S4 CAT — 1 damaged unit\",\"lines\":[{\"poLineId\":\"$PO_LINE_ID\",\"quantityReceived\":10,\"quantityAccepted\":9,\"quantityRejected\":1,\"condition\":\"GOOD\",\"discrepancyNotes\":\"1 unit arrived with cracked screen\"}]}" | jq '.inspectionOutcome,.lines[0].quantityAccepted,.lines[0].quantityRejected'
# Expect: "ACCEPTED_WITH_DISCREPANCY", 9, 1

# Verify PO auto-flipped to RECEIVED (cumulative received = ordered)
curl -sX GET http://localhost:4000/api/v1/procurement/purchase-orders/$PO_ID \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' | jq '.status'
# Expect: "RECEIVED"

# Verify vendor performance updated atomically
curl -sX GET http://localhost:4000/api/v1/procurement/vendor-performance/$DELL_ID \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' | jq '.totalOrders,.acceptedCount,.rejectedCount,.averageQualityScore'
# Expect: total bumped by 1; accepted bumped by 9; rejected bumped by 1; quality_score updated.
```

### S5 — CROSS-MODULE DISTRIBUTION KEYSTONE (→ tech)

```sh
RECEIPT_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc \
  "SELECT id FROM tenant_demo.prc_goods_receipts WHERE purchase_order_id='$PO_ID' ORDER BY received_at DESC LIMIT 1")
RECEIPT_LINE_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc \
  "SELECT id FROM tenant_demo.prc_goods_receipt_lines WHERE receipt_id='$RECEIPT_ID' LIMIT 1")

# Distribute the 9 accepted units to IT/tech
curl -sX POST http://localhost:4000/api/v1/procurement/receipts/$RECEIPT_ID/distributions \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d "{\"destinationModule\":\"tech\",\"destinationDepartment\":\"IT Asset Pool\",\"notes\":\"Add to Chromebook fleet\",\"lines\":[{\"receiptLineId\":\"$RECEIPT_LINE_ID\",\"quantityDistributed\":9,\"itemDescription\":\"Chromebook 14\\\"\"}]}" | jq '.destinationModule,.lines[0].quantityDistributed'
# Expect: "tech", 9
# Expect: prc.distribution.completed envelope on the wire with destination_module="tech"
```

### S6 — Initiate return for the damaged unit + resolve

```sh
RET_ID=$(curl -sX POST http://localhost:4000/api/v1/procurement/receipt-lines/$RECEIPT_LINE_ID/returns \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d '{"returnType":"DAMAGED","quantityReturned":1,"vendorRmaNumber":"RMA-S6-CAT"}' | jq -r '.id')
echo "Return $RET_ID"
# Expect: status=INITIATED

# Ship to vendor
curl -sX PATCH http://localhost:4000/api/v1/procurement/returns/$RET_ID \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' -d '{"action":"SHIP"}' | jq '.status'
# Expect: "SHIPPED_TO_VENDOR"

# Resolve as REPLACED
curl -sX PATCH http://localhost:4000/api/v1/procurement/returns/$RET_ID \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d '{"action":"RESOLVE","resolution":"REPLACED","resolutionNotes":"Replacement unit arrived 2026-05-20"}' | jq '.status,.resolution,.resolvedAt'
# Expect: "RESOLVED", "REPLACED", non-null timestamp
```

### S7 — Close PO releases budget commitment

```sh
# Close keystone — flip status to CLOSED, decrement encumbered_amount, mark commitment RELEASED
curl -sX PATCH http://localhost:4000/api/v1/procurement/purchase-orders/$PO_ID/transition \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' -d '{"action":"CLOSE"}' | jq '.status,.commitments[0].status,.commitments[0].releasedAt'
# Expect: "CLOSED", "RELEASED", non-null timestamp

# Re-read encumbered_amount — should drop by exactly 3250
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT encumbered_amount FROM tenant_demo.fin_budget_lines WHERE id='$BUDGET_LINE_ID'"
# Expect: same as initial value (release matches the commit)

# Verify parent requisition flipped to CLOSED
curl -sX GET http://localhost:4000/api/v1/procurement/requisitions/$REQ_ID \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' | jq '.status'
# Expect: "CLOSED" (was DISTRIBUTED → CLOSED on PO close)
```

### S8 — Permission denials

```sh
PARENT_TOKEN=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' -d '{"email":"parent@demo.campusos.dev"}' | jq -r '.accessToken')
STUDENT_TOKEN=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' -d '{"email":"student@demo.campusos.dev"}' | jq -r '.accessToken')

# Parent: every procurement endpoint 403 (no PRC-001+)
curl -sw '\n%{http_code}\n' -o /dev/null http://localhost:4000/api/v1/procurement/requisitions \
  -H "Authorization: Bearer $PARENT_TOKEN" -H 'X-Tenant-Subdomain: demo'
# Expect: 403

# Student: same
curl -sw '\n%{http_code}\n' -o /dev/null http://localhost:4000/api/v1/procurement/requisitions \
  -H "Authorization: Bearer $STUDENT_TOKEN" -H 'X-Tenant-Subdomain: demo'
# Expect: 403

# Teacher: can list requisitions but only sees own (row-scoped to actor.personId)
curl -sX GET http://localhost:4000/api/v1/procurement/requisitions \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' | jq 'length'
# Expect: count of Rivera's own requisitions (excludes Hayes' seeded Cafeteria req)

# Teacher: cannot list POs (no PRC-002:read)
curl -sw '\n%{http_code}\n' -o /dev/null http://localhost:4000/api/v1/procurement/purchase-orders \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo'
# Expect: 403

# Teacher: cannot approve own requisition (admin-only)
curl -sw '\n%{http_code}\n' -o /dev/null -X PATCH http://localhost:4000/api/v1/procurement/requisitions/$REQ_ID/approve \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' -d '{"toStatus":"DEPT_APPROVED"}'
# Expect: 403
```

### S9 — Settings auto-create + admin-only update

```sh
# Confirm settings already populated (from Step 4 seed)
curl -sX GET http://localhost:4000/api/v1/procurement/settings \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' | jq '.poNumberPrefix,.poNumberNextSeq'
# Expect: "PO", >= 2 (seed used PO-2026-001; subsequent PO consumed at least 1 more)

# Teacher cannot update settings (admin-only)
curl -sw '\n%{http_code}\n' -o /dev/null -X PATCH http://localhost:4000/api/v1/procurement/settings \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' -d '{"poNumberPrefix":"NEWPO"}'
# Expect: 403

# Admin can — update default payment terms
curl -sX PATCH http://localhost:4000/api/v1/procurement/settings \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' -d '{"defaultPaymentTerms":"NET_45"}' | jq '.defaultPaymentTerms'
# Expect: "NET_45"
```

### S10 — Reject path on a fresh requisition

```sh
# New draft from teacher
REJECT_REQ_ID=$(curl -sX POST http://localhost:4000/api/v1/procurement/requisitions \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d '{"justification":"S10 CAT — invalid request to test reject path","lines":[{"itemDescription":"Test item","quantity":1,"destinationModule":"general"}]}' | jq -r '.id')
curl -sX PATCH http://localhost:4000/api/v1/procurement/requisitions/$REJECT_REQ_ID/submit \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo' > /dev/null

# Admin rejects
curl -sX PATCH http://localhost:4000/api/v1/procurement/requisitions/$REJECT_REQ_ID/reject \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d '{"reason":"Out of scope for this fiscal year"}' | jq '.status,.rejectionReason'
# Expect: "REJECTED", "Out of scope for this fiscal year"
```

---

## Cleanup — restore tenant_demo to post-Step-4 seed shape

```sh
# Drop CAT-created data (preserves the seeded shape from seed-procurement.ts)
docker exec campusos-postgres psql -U campusos -d campusos_dev <<'EOF'
SET search_path TO tenant_demo, platform, public;

-- Find all CAT POs
WITH cat_pos AS (
  SELECT id FROM prc_purchase_orders WHERE notes LIKE '%CAT%' OR po_number LIKE 'PO-2026-002%' OR po_number LIKE 'PO-2026-003%'
)
DELETE FROM prc_distribution_lines WHERE distribution_id IN (
  SELECT d.id FROM prc_distributions d JOIN prc_goods_receipts gr ON gr.id=d.receipt_id
  WHERE gr.purchase_order_id IN (SELECT id FROM cat_pos)
);
DELETE FROM prc_distributions WHERE receipt_id IN (
  SELECT id FROM prc_goods_receipts WHERE purchase_order_id IN (SELECT id FROM prc_purchase_orders WHERE po_number LIKE 'PO-2026-002%' OR po_number LIKE 'PO-2026-003%')
);
DELETE FROM prc_returns WHERE receipt_line_id IN (
  SELECT rl.id FROM prc_goods_receipt_lines rl JOIN prc_goods_receipts gr ON gr.id=rl.receipt_id
  WHERE gr.purchase_order_id IN (SELECT id FROM prc_purchase_orders WHERE po_number LIKE 'PO-2026-002%' OR po_number LIKE 'PO-2026-003%')
);
DELETE FROM prc_goods_receipt_lines WHERE receipt_id IN (
  SELECT id FROM prc_goods_receipts WHERE purchase_order_id IN (SELECT id FROM prc_purchase_orders WHERE po_number LIKE 'PO-2026-002%' OR po_number LIKE 'PO-2026-003%')
);
DELETE FROM prc_goods_receipts WHERE purchase_order_id IN (SELECT id FROM prc_purchase_orders WHERE po_number LIKE 'PO-2026-002%' OR po_number LIKE 'PO-2026-003%');
DELETE FROM prc_budget_commitments WHERE purchase_order_id IN (SELECT id FROM prc_purchase_orders WHERE po_number LIKE 'PO-2026-002%' OR po_number LIKE 'PO-2026-003%');
DELETE FROM prc_purchase_order_lines WHERE purchase_order_id IN (SELECT id FROM prc_purchase_orders WHERE po_number LIKE 'PO-2026-002%' OR po_number LIKE 'PO-2026-003%');
DELETE FROM prc_purchase_orders WHERE po_number LIKE 'PO-2026-002%' OR po_number LIKE 'PO-2026-003%';

-- Drop CAT requisitions
DELETE FROM prc_requisition_lines WHERE requisition_id IN (
  SELECT id FROM prc_requisitions WHERE justification LIKE '%CAT%'
);
DELETE FROM prc_requisitions WHERE justification LIKE '%CAT%';

-- Reset PO sequence + payment terms
UPDATE prc_procurement_settings SET po_number_next_seq = 2, default_payment_terms = 'NET_30';
EOF

# Verify state matches Step 4 seed
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT 'requisitions' AS k, count(*) FROM tenant_demo.prc_requisitions UNION ALL SELECT 'purchase_orders', count(*) FROM tenant_demo.prc_purchase_orders UNION ALL SELECT 'receipts', count(*) FROM tenant_demo.prc_goods_receipts UNION ALL SELECT 'distributions', count(*) FROM tenant_demo.prc_distributions UNION ALL SELECT 'returns', count(*) FROM tenant_demo.prc_returns ORDER BY 1"
# Expect: requisitions=2, purchase_orders=1, receipts=1, distributions=1, returns=1
```

---

## Reviewer attention items

Non-blocking items recorded for the post-cycle architecture review:

1. **Workflow engine integration** — current implementation uses direct admin-tier transitions on requisitions (Cycle 7 wsk_approval_requests scaffolding is in place via `approval_request_id` column but no engine connection yet). Phase 2 polish should connect the workflow engine to drive multi-step approval routing dynamically.
2. **`auto_po_threshold` enforcement** — schema accepts the column but PO create does not consult it for auto-PO generation. Phase 2 task to implement the `requisition.amount < threshold && admin.autoApprove == true` shortcut path.
3. **`require_three_quotes_above` enforcement** — schema accepts the column but PO create does not require quote attachments above the threshold. Schema-only this cycle.
4. **Budget remaining check on requisition submit** — currently uses `fin_budget_lines.encumbered_amount` snapshot at submit time, not the locked-in commitment amount that lands at PO ISSUE. Race window is small; pre-pilot tighten by computing `remaining = budgeted - actual - encumbered - sum(pending requisitions for this line)`.
5. **Cross-module distribution consumers** — `prc.distribution.completed` emits cleanly but no downstream module currently subscribes. Each destination module (tech / lib / etc.) needs its own `DistributionConsumer` to materialise assets / catalogue items / etc. when distribution lands.
6. **Vendor performance score decay** — current scoring treats every order with equal weight. Real-world buying typically uses time-decayed averages so a recent good streak rebalances older bad scores. Phase 2 polish.

**Cycle 27 ships clean to the post-cycle architecture review.**
