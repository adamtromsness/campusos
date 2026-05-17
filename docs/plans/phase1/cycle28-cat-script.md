# Cycle 28 — Customer Acceptance Test (Step 10)

**Module:** M67 School Store (Wave 6 closeout — closes Wave 6 Finance & Commerce).
**Verified live on:** `tenant_demo` 2026-05-06.
**Reproducibility:** every command is shell-pasteable. Cleanup at the end restores `tenant_demo` to the post-Step-4 seed shape.

---

## Schema preamble

8 checks confirming the tenant schema landed correctly.

```sh
# Check 1 — 9 str_* tables present
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='tenant_demo' AND table_name LIKE 'str_%'"
# Expect: 9

# Check 2 — list every table by name
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT table_name FROM information_schema.tables WHERE table_schema='tenant_demo' AND table_name LIKE 'str_%' ORDER BY table_name"
# Expect: str_external_customers, str_order_approvals, str_order_lines, str_orders,
#         str_product_inventory, str_products, str_shipping_options, str_store_revenue, str_stores

# Check 3 — UNIQUE(school_id, store_type) caps each school at one of each store type
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT indexdef FROM pg_indexes WHERE schemaname='tenant_demo' AND indexname='str_stores_school_type_uq'"
# Expect: CREATE UNIQUE INDEX … ON tenant_demo.str_stores USING btree (school_id, store_type)

# Check 4 — Multi-column shape CHECKs on str_orders
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT conname FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='tenant_demo' AND cl.relname='str_orders' AND contype='c' ORDER BY conname"
# Expect: str_orders_customer_shape_chk, str_orders_shipping_shape_chk,
#         str_orders_status_check, str_orders_student_shape_chk + several individual non-negative CHECKs

# Check 5 — PARENT APPROVAL multi-column responded_chk lockstep on str_order_approvals
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT conname FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='tenant_demo' AND cl.relname='str_order_approvals' AND contype='c' ORDER BY conname"
# Expect: str_order_approvals_responded_chk, str_order_approvals_status_check + UNIQUE(order_id)

# Check 6 — IAM grants for Staff: STR-001..003 read+write
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT p.code FROM platform.role_permission rp JOIN platform.roles r ON r.id=rp.role_id JOIN platform.permissions p ON p.id=rp.permission_id WHERE r.name='Staff' AND p.code LIKE 'str-00%' ORDER BY p.code"
# Expect: str-001:read, str-001:write, str-002:read, str-002:write, str-003:read, str-003:write

# Check 7 — Parent gets STR-001:read + STR-002:read+write (place + approve own children's orders)
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT p.code FROM platform.role_permission rp JOIN platform.roles r ON r.id=rp.role_id JOIN platform.permissions p ON p.id=rp.permission_id WHERE r.name='Parent' AND p.code LIKE 'str-00%' ORDER BY p.code"
# Expect: str-001:read, str-002:read, str-002:write

# Check 8 — Step 4 seed shape
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT 'stores' AS k, count(*) FROM tenant_demo.str_stores UNION ALL SELECT 'products', count(*) FROM tenant_demo.str_products UNION ALL SELECT 'inventory', count(*) FROM tenant_demo.str_product_inventory UNION ALL SELECT 'orders', count(*) FROM tenant_demo.str_orders UNION ALL SELECT 'order_lines', count(*) FROM tenant_demo.str_order_lines UNION ALL SELECT 'approvals', count(*) FROM tenant_demo.str_order_approvals UNION ALL SELECT 'external_customers', count(*) FROM tenant_demo.str_external_customers UNION ALL SELECT 'shipping_options', count(*) FROM tenant_demo.str_shipping_options UNION ALL SELECT 'revenue', count(*) FROM tenant_demo.str_store_revenue ORDER BY 1"
# Expect: approvals=1, external_customers=1, inventory=6, order_lines=3, orders=2,
#         products=6, revenue=1, shipping_options=2, stores=2
```

---

## Plan scenarios

```sh
# Login as each persona (the rest of the script reads tokens from /tmp)
TEACHER_TOKEN=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' -d '{"email":"teacher@demo.campusos.dev"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
ADMIN_TOKEN=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' -d '{"email":"principal@demo.campusos.dev"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
PARENT_TOKEN=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' -d '{"email":"parent@demo.campusos.dev"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
STUDENT_TOKEN=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' -d '{"email":"student@demo.campusos.dev"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
```

### S1 — Stores list correctly (UNIQUE(school, store_type) holds)

```sh
curl -sX GET http://localhost:4000/api/v1/store/stores -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; [print(s['storeType'], s['name']) for s in json.load(sys.stdin)]"
# Expect: PUBLIC Eagle Merchandise / STUDENT Lincoln Academy Shop (count=2)
```

### S2 — Student catalogue browse (4 STUDENT-store products)

```sh
STUDENT_STORE=$(curl -sX GET http://localhost:4000/api/v1/store/stores -H "Authorization: Bearer $STUDENT_TOKEN" -H 'X-Tenant-Subdomain: demo' | python3 -c "import sys,json; print([s for s in json.load(sys.stdin) if s['storeType']=='STUDENT'][0]['id'])")
curl -sX GET "http://localhost:4000/api/v1/store/stores/$STUDENT_STORE/products" -H "Authorization: Bearer $STUDENT_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; [print(p['name'], '$'+str(p['price']), 'qty:', p['totalAvailable']) for p in json.load(sys.stdin)]"
# Expect: Yearbook 2026 / PE Kit / Scientific Calculator / School Polo with seeded qtys
```

### S3 — PARENT APPROVAL GATE keystone

```sh
MAYA_STUDENT=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc "SELECT s.id::text FROM tenant_demo.sis_students s JOIN platform.platform_students ps ON ps.id=s.platform_student_id JOIN platform.iam_person ip ON ip.id=ps.person_id WHERE ip.first_name='Maya' AND ip.last_name='Chen' LIMIT 1")
CALC_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc "SELECT id::text FROM tenant_demo.str_products WHERE sku='CALC-SCI' LIMIT 1")

# Pre-create the str.* topics on a fresh broker (one-time dev workaround)
docker exec campusos-kafka /opt/kafka/bin/kafka-topics.sh --create --if-not-exists --bootstrap-server localhost:9092 --topic dev.str.order.completed --partitions 1 --replication-factor 1 > /dev/null
docker exec campusos-kafka /opt/kafka/bin/kafka-topics.sh --create --if-not-exists --bootstrap-server localhost:9092 --topic dev.str.inventory.reorder_needed --partitions 1 --replication-factor 1 > /dev/null

# Maya places order (1 Calculator, $15)
ORDER_ID=$(curl -sX POST http://localhost:4000/api/v1/store/orders \
  -H "Authorization: Bearer $STUDENT_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d "{\"storeId\":\"$STUDENT_STORE\",\"orderType\":\"STUDENT\",\"studentId\":\"$MAYA_STUDENT\",\"shippingMethod\":\"PICKUP\",\"lines\":[{\"productId\":\"$CALC_ID\",\"quantity\":1}]}" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
# Expect: order created with status=PENDING_APPROVAL + paymentStatus=PENDING + approval row PENDING tied to David Chen

# Verify inventory reservation (calculator reserved=1)
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "SELECT quantity_on_hand, quantity_reserved FROM tenant_demo.str_product_inventory WHERE product_id='$CALC_ID'"
# Expect: 25 / 1

# Parent approves
APPROVAL_ID=$(curl -sX GET http://localhost:4000/api/v1/store/approvals -H "Authorization: Bearer $PARENT_TOKEN" -H 'X-Tenant-Subdomain: demo' | python3 -c "import sys,json; print(next(a['id'] for a in json.load(sys.stdin) if a['status']=='PENDING'))")
curl -sX PATCH "http://localhost:4000/api/v1/store/approvals/$APPROVAL_ID/approve" -H "Authorization: Bearer $PARENT_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('  approval:', d['status'], '  responded_at:', d['respondedAt'])"
# Expect: APPROVED with responded_at populated

# Order is now PROCESSING + payment CHARGED
curl -sX GET "http://localhost:4000/api/v1/store/orders/$ORDER_ID" -H "Authorization: Bearer $STUDENT_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('  status:', d['status'], '  payment:', d['paymentStatus'])"
# Expect: PROCESSING / CHARGED
```

### S4 — `str.order.completed` envelope on the wire (Cycle 6 keystone)

```sh
sleep 2
docker exec campusos-kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic dev.str.order.completed --from-beginning --max-messages 1 --timeout-ms 5000 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('event_type:', d['event_type']); print('source_module:', d['source_module']); print('payload.orderType:', d['payload']['orderType']); print('payload.total:', d['payload']['total']); print('payload.paymentMode:', d['payload']['paymentMode']); print('payload.lineItems:', d['payload']['lineItems'])"
# Expect: event_type=str.order.completed / source_module=store / orderType=STUDENT
#         total=15 / paymentMode=FAMILY_ACCOUNT / lineItems=[{productId, quantity:1, unitPrice:15, lineTotal:15}]
```

### S5 — Decline path releases inventory

```sh
# Maya places another order (1 Polo)
POLO_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc "SELECT id::text FROM tenant_demo.str_products WHERE sku='POLO-BLU-M' LIMIT 1")
DECLINE_ORDER=$(curl -sX POST http://localhost:4000/api/v1/store/orders \
  -H "Authorization: Bearer $STUDENT_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d "{\"storeId\":\"$STUDENT_STORE\",\"orderType\":\"STUDENT\",\"studentId\":\"$MAYA_STUDENT\",\"shippingMethod\":\"PICKUP\",\"lines\":[{\"productId\":\"$POLO_ID\",\"quantity\":1}]}" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
DECLINE_APPROVAL=$(curl -sX GET http://localhost:4000/api/v1/store/approvals -H "Authorization: Bearer $PARENT_TOKEN" -H 'X-Tenant-Subdomain: demo' | python3 -c "import sys,json; print(next(a['id'] for a in json.load(sys.stdin) if a['status']=='PENDING'))")
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "SELECT quantity_on_hand, quantity_reserved FROM tenant_demo.str_product_inventory WHERE product_id='$POLO_ID'"
# Expect: 49 / 1 (1 reserved while pending)

curl -sX PATCH "http://localhost:4000/api/v1/store/approvals/$DECLINE_APPROVAL/decline" \
  -H "Authorization: Bearer $PARENT_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d '{"reason":"Not approved by parent"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('  status:', d['status'], '  reason:', d['declineReason'])"
# Expect: DECLINED / "Not approved by parent"

docker exec campusos-postgres psql -U campusos -d campusos_dev -c "SELECT status FROM tenant_demo.str_orders WHERE id='$DECLINE_ORDER'"
# Expect: CANCELLED
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "SELECT quantity_on_hand, quantity_reserved FROM tenant_demo.str_product_inventory WHERE product_id='$POLO_ID'"
# Expect: 49 / 0 (reservation released)
```

### S6 — Fulfilment path: PROCESSING → READY_FOR_PICKUP → COMPLETED + decrement

```sh
# Use the S3 order which is now PROCESSING
curl -sX PATCH "http://localhost:4000/api/v1/store/orders/$ORDER_ID/fulfil" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d '{"toStatus":"READY_FOR_PICKUP"}' \
  | python3 -c "import sys,json; print('  status:', json.load(sys.stdin)['status'])"
# Expect: READY_FOR_PICKUP

curl -sX PATCH "http://localhost:4000/api/v1/store/orders/$ORDER_ID/complete" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | python3 -c "import sys,json; print('  status:', json.load(sys.stdin)['status'])"
# Expect: COMPLETED

# Inventory: calculator on_hand decremented from 25 to 24, reserved back to 0
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "SELECT quantity_on_hand, quantity_reserved FROM tenant_demo.str_product_inventory WHERE product_id='$CALC_ID'"
# Expect: 24 / 0
```

### S7 — Reorder threshold + `str.inventory.reorder_needed` envelope

```sh
PE_KIT_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc "SELECT id::text FROM tenant_demo.str_products WHERE sku='PE-KIT-S' LIMIT 1")
PE_INV=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tAc "SELECT id::text FROM tenant_demo.str_product_inventory WHERE product_id='$PE_KIT_ID' LIMIT 1")

# Adjust PE Kit from 30 → 5 (the seeded reorder_point) → crossing fires emit
curl -sX PATCH "http://localhost:4000/api/v1/store/inventory/$PE_INV" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d '{"quantityOnHand":5}' > /dev/null
echo "Adjusted PE Kit to 5 (at reorder_point)"
sleep 2

docker exec campusos-kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic dev.str.inventory.reorder_needed --from-beginning --max-messages 1 --timeout-ms 5000 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('event_type:', d['event_type']); print('payload.productName:', d['payload']['productName']); print('payload.currentStock:', d['payload']['currentStock']); print('payload.reorderPoint:', d['payload']['reorderPoint'])"
# Expect: event_type=str.inventory.reorder_needed / productName=PE Kit / currentStock=5 / reorderPoint=5
```

### S8 — Revenue materialisation

```sh
curl -sX POST http://localhost:4000/api/v1/store/revenue/materialise \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d "{\"storeId\":\"$STUDENT_STORE\",\"periodStart\":\"2026-04-01\",\"periodEnd\":\"2026-05-31\"}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('  total_orders:', d['totalOrders']); print('  total_revenue:', d['totalRevenue']); print('  total_cost:', d['totalCost']); print('  gross_margin:', d['grossMargin'])"
# Expect: at least 2 completed orders aggregated (Maya seed + S6 calculator order); revenue >= 60; margin = revenue - cost
```

### S9 — Permission denial paths

```sh
# Teacher does not hold STR-002:read — orders 403
curl -sw 'HTTP %{http_code}\n' -o /dev/null http://localhost:4000/api/v1/store/orders -H "Authorization: Bearer $TEACHER_TOKEN" -H 'X-Tenant-Subdomain: demo'
# Expect: 403

# Teacher cannot hit revenue (STR-003:read required)
curl -sw 'HTTP %{http_code}\n' -o /dev/null http://localhost:4000/api/v1/store/revenue -H "Authorization: Bearer $TEACHER_TOKEN" -H 'X-Tenant-Subdomain: demo'
# Expect: 403

# Student cannot fulfil orders (STR-002:write held but isStoreManager check refuses)
curl -sw 'HTTP %{http_code}\n' -X PATCH "http://localhost:4000/api/v1/store/orders/$ORDER_ID/fulfil" \
  -H "Authorization: Bearer $STUDENT_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' -d '{"toStatus":"READY_FOR_PICKUP"}'
# Expect: 403

# Parent cannot create products (STR-001:write held by Staff/admin only)
curl -sw 'HTTP %{http_code}\n' -X POST http://localhost:4000/api/v1/store/products \
  -H "Authorization: Bearer $PARENT_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d "{\"storeId\":\"$STUDENT_STORE\",\"name\":\"Should fail\",\"price\":1}"
# Expect: 403
```

### S10 — Public endpoint registers external customer (no auth)

```sh
curl -sX POST http://localhost:4000/api/v1/shop/external-customers \
  -H 'X-Tenant-Subdomain: demo' \
  -H 'Content-Type: application/json' \
  -d '{"name":"CAT Smoke","email":"cat-smoke@example.com","shippingAddress":"123 Smoke Lane"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('  id:', d['id'][:8], '  email:', d['email'])"
# Expect: 201 with id + email back; no auth required
```

---

## Cleanup

```sh
docker exec campusos-postgres psql -U campusos -d campusos_dev <<'EOF'
SET search_path TO tenant_demo, platform, public;
-- Drop CAT-created orders (Maya's calculator order + Polo decline order + any PEs we touched)
DELETE FROM str_order_approvals
  WHERE order_id IN (SELECT id FROM str_orders WHERE order_number IN ('STR-2026-0002','STR-2026-0003','STR-2026-0004'));
DELETE FROM str_order_lines
  WHERE order_id IN (SELECT id FROM str_orders WHERE order_number IN ('STR-2026-0002','STR-2026-0003','STR-2026-0004'));
DELETE FROM str_orders
  WHERE order_number IN ('STR-2026-0002','STR-2026-0003','STR-2026-0004');

-- Restore inventory to seed (Polo 49, PE Kit 30, Yearbook 99, Calculator 25, Hoodie 23, Mug 40)
UPDATE str_product_inventory SET quantity_on_hand=49, quantity_reserved=0
  WHERE product_id = (SELECT id FROM str_products WHERE sku='POLO-BLU-M');
UPDATE str_product_inventory SET quantity_on_hand=30, quantity_reserved=0, reorder_point=5
  WHERE product_id = (SELECT id FROM str_products WHERE sku='PE-KIT-S');
UPDATE str_product_inventory SET quantity_on_hand=99, quantity_reserved=0
  WHERE product_id = (SELECT id FROM str_products WHERE sku='YRB-2026');
UPDATE str_product_inventory SET quantity_on_hand=25, quantity_reserved=0
  WHERE product_id = (SELECT id FROM str_products WHERE sku='CALC-SCI');
UPDATE str_product_inventory SET quantity_on_hand=23, quantity_reserved=0
  WHERE product_id = (SELECT id FROM str_products WHERE sku='HDY-GRY-L');
UPDATE str_product_inventory SET quantity_on_hand=40, quantity_reserved=0
  WHERE product_id = (SELECT id FROM str_products WHERE sku='MUG-ALM');

-- Drop CAT external customer
DELETE FROM str_external_customers WHERE email='cat-smoke@example.com';

-- Drop CAT-created revenue snapshots that aren't the seed
DELETE FROM str_store_revenue
  WHERE NOT (period_start = '2026-04-01' AND period_end = '2026-04-30' AND total_orders = 1);
EOF
```

---

## Reviewer attention items

Recorded for the post-cycle architecture review and Phase 2 punch list:

1. **Public storefront order placement** — current `/shop/[storeId]` registers external customers but does not create orders publicly. Stripe Checkout integration is deferred to Phase 2; the PUBLIC store demo lands the customer record + manual admin order creation today.
2. **Cycle 6 family-billing consumer for `str.order.completed`** — the emit fires cleanly with `paymentMode='FAMILY_ACCOUNT'` and the full payload contract M84 needs; the corresponding consumer in the payments module is Phase 2 work.
3. **Cycle 27 procurement consumer for `str.inventory.reorder_needed`** — the emit fires cleanly with `productId` + `preferredSupplierId` + `reorderQuantity`; the procurement consumer that converts the emit into a `prc_requisition` is Phase 2 work.
4. **Store manager role split** — Staff currently holds STR-001..003 read+write as the store-manager stand-in. Joins the broader role-split chain (items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 in CLAUDE.md) — a dedicated Store Manager role should hold the STR-\* codes alone before pilot.
5. **Reorder emit on the order-completion path** — order completion decrements `quantity_on_hand` directly (not via `InventoryService.adjust`), so the reorder-threshold-crossing emit fires only on the explicit admin adjust path. Pre-pilot work moves the emit to a shared helper called from both paths.
6. **Persistent shopping cart** — current implementation uses in-memory session cart. `str_carts` (persistent cart) is on the deferred list.
7. **Product variants** — size/colour matrices with per-variant inventory deferred to Phase 2.
8. **Discount codes / coupons** — deferred to Phase 2.
9. **Bundle products** — deferred to Phase 2.
10. **Backorder lifecycle on the order side** — `line_status='BACKORDERED'` flows are scaffolded but not exercised end-to-end in this CAT. Pre-pilot work to verify the flip from BACKORDERED → IN_STOCK + payment_status update when stock arrives.

**Cycle 28 ships clean to the post-cycle architecture review. Wave 6 (Finance & Commerce) closes here.**
