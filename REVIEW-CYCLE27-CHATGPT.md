# REVIEW-CYCLE27-CHATGPT

**Cycle:** 27 — Procurement (M86, Wave 6 continuation cycle).
**Status:** Awaiting Round 1 verdict.
**Build commit:** `cycle27-complete` (TBD — assigned at the closeout commit).
**Live verification:** `tenant_demo` 2026-05-06.

## Reviewer brief

Cycle 27 ships the M86 Procurement module — 12 new tenant `prc_*` base tables across migrations 089/090/091, 28 endpoints across 7 services + 1 controller, 2 Kafka emit topics, 13 web routes, 1 launchpad tile.

**Three structural keystones to verify:**

1. **BUDGET COMMITMENT KEYSTONE (Cycle 26 ↔ Cycle 27 integration)** — `PurchaseOrderService.transition({action:'ISSUE'})` must atomically: (a) lock the PO row + parent `fin_budget_lines` row `FOR UPDATE`, (b) validate remaining budget = `budgeted_amount - actual_amount - encumbered_amount` >= PO total, (c) INSERT `prc_budget_commitments` row with status=COMMITTED, (d) UPDATE `fin_budget_lines.encumbered_amount += PO total`, (e) flip PO to ISSUED + parent requisition to ORDERED — all inside one tenant tx. CLOSE / CANCEL paths should release the commitment + decrement encumbered_amount in the same atomic shape. Verify via `apps/api/src/procurement/purchase-orders.service.ts::transition`.

2. **CROSS-MODULE DISTRIBUTION KEYSTONE** — `DistributionService.create()` must emit `prc.distribution.completed` AFTER tx commits with `destination_module` payload that the 8 destination modules (tech / trn / fds / lib / ath / ext / fac / str) can consume. Procurement must NEVER write directly to another module's tables per ADR-061. Verify the emit shape includes `{distributionId, receiptId, purchaseOrderId, schoolId, destinationModule, destinationDepartment, distributedAt, sourceRefId, lines: [...]}`.

3. **VENDOR PERFORMANCE AUTO-SCORING** — `GoodsReceiptService.create()` must atomically UPSERT `prc_vendor_performance` inside the same tenant tx as the receipt write — `total_orders += 1`, on-time/late counters update based on `expected_delivery_date`, accepted/rejected counters from receipt-line aggregates, `average_quality_score = accepted / (accepted + rejected)`, `average_delivery_score = on_time / total_orders`. Same tx must auto-flip PO status to PARTIALLY_RECEIVED or RECEIVED based on cumulative line quantities. Verify in `purchase-orders.service.ts::GoodsReceiptService.create`.

**Cross-cycle integration to verify:**

- Cycle 26 `fin_budget_lines.encumbered_amount` is bumped/released atomically with PO ISSUE/CLOSE/CANCEL.
- Cycle 26 `fin_suppliers(id)` is the DB-enforced FK target for `prc_purchase_orders.vendor_id` and `prc_vendor_performance.vendor_id`.
- Cycle 26 `fin_chart_of_accounts(id)` is the soft FK target for `prc_purchase_order_lines.gl_account_id` (no DB-enforced FK — kept soft per ADR-001/020).
- Cycle 7 `wsk_approval_requests(id)` ref is wired in the schema via `prc_requisitions.approval_request_id` but engine integration is deferred to Phase 2 (current implementation uses direct admin transitions per the canonical reviewer attention item below).

**Row-scope to verify:**

- `RequisitionService.list(actor, status?)` — non-procurement-officer actors (Teacher with `PRC-001:read+write` only) see only their own requisitions; Staff / admin sees all.
- `RequisitionService.getById(id, actor)` — 404 don't-leak-existence for non-owner non-officer.
- All other endpoints gated on `PRC-002:read/write` or `PRC-003:read/write` which Teacher does NOT hold.

**Permission gating to verify:**

- Parent (no PRC) — 403 on every procurement endpoint.
- Student (no PRC) — same.
- Teacher (PRC-001:read+write only) — sees own requisitions, can submit; 403 on POs, receiving, distribution, returns, vendor performance.
- Staff (PRC-001..003:read+write) — full procurement officer surface.
- School Admin / Platform Admin (admin tier via `everyFunction`) — full access plus settings update.

## Triage table

(Populated by reviewer.)

| #   | Class | Title | Disposition |
| --- | ----- | ----- | ----------- |
| 1   | TBD   |       |             |

## Verification trail

(Populated by reviewer + author after fixes if any.)

## Known carry-overs to Phase 2 punch list

Per the reviewer attention items in `HANDOFF-CYCLE27.md`:

1. Workflow engine integration (current uses direct admin transitions on requisitions; schema is wired with `approval_request_id` column for future Cycle 7 wsk_approval_requests engine integration).
2. `auto_po_threshold` enforcement — schema accepts the column but PO creation does not consult it for auto-PO generation.
3. `require_three_quotes_above` enforcement — schema accepts the column but PO creation does not require quote attachments above the threshold.
4. Budget remaining check race window — current submit-time check uses snapshot; the locked-in commitment lands at PO ISSUE not requisition SUBMIT.
5. Cross-module distribution consumers — `prc.distribution.completed` emits cleanly but no downstream module currently subscribes. Each destination module needs its own `DistributionConsumer`.
6. Vendor performance score decay — current scoring treats every order with equal weight.
7. Procurement Officer / Purchasing Clerk role split — Staff role currently gets all PRC-001..003. Joins items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / 33 / 34 / 35 / 36 / 37 / 38 / 39 / 40 / 41 in the broader pre-pilot role-split chain.
