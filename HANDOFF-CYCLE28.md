# Cycle 28 Handoff — School Store

**Status:** Cycle 28 **COMPLETE + APPROVED at `56678c9` (REVIEW-CYCLE28-CHATGPT Round 2 — final verdict).** Wave 6 (Finance & Commerce) closes here. Round 1 against `cycle28-complete` (`d895a3c`) returned `Reject pending fixes` with 4 BLOCKING + 4 MAJOR; Round 2 against `56678c9` returned `Approved` after the 3 valid BLOCKINGs landed (BLOCKING 1 was DISPUTED + confirmed spurious by reviewer in Round 2: "correctly disputed as a stale-read issue"). All 4 MAJORs (order-number race, Store Manager role split, preferredSupplierId validation, reorder-on-completion event) appropriately remain Phase 2 / pre-pilot hardening tasks. Tagged `cycle28-complete` at `d895a3c` and `cycle28-approved` at `56678c9`. **Wave 6 ships the connected commerce stack — Cycle 26 Finance + Cycle 27 Procurement + Cycle 28 School Store.**

Cycle 28 builds the M67 School Store module — 9 tenant tables, dual-mode (STUDENT + PUBLIC) storefront with parent approval gate, 2 cross-module Kafka emits (`str.order.completed` for Cycle 6 family billing pickup, `str.inventory.reorder_needed` for Cycle 27 procurement pickup), and periodic revenue materialisation. **The fifth parent-active feature** (parent approval gate on student orders before payment is charged) after parent messaging (Cycle 3), conference booking (Cycle 15), application submission (Cycle 16), and route-change requests (Cycle 19). **Wave 6 closes with this cycle.**

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle28-implementation-plan.html`
**CAT script:** `docs/cycle28-cat-script.md`
**Vertical-slice deliverable verified live:** Admin creates a STUDENT store + a PUBLIC store → 6 products (Polo / PE Kit / Yearbook / Calculator / Hoodie / Mug) with inventory rows + reorder_points → Maya orders 1 Calculator → order=PENDING_APPROVAL + inventory reserved → David Chen approves → order=PROCESSING + payment=CHARGED + `str.order.completed` envelope captured live on `dev.str.order.completed` with full ADR-057 shape (paymentMode=FAMILY_ACCOUNT, total=15, lineItems with productId+quantity+unitPrice+lineTotal) → admin marks ready + completes → inventory decrements 25→24 → admin adjusts PE Kit to 5 (reorder_point) → `str.inventory.reorder_needed` envelope captured live on `dev.str.inventory.reorder_needed` with payload (productId, productName, currentStock=5, reorderPoint=5) → admin materialises April–May revenue → `str_store_revenue` row written with totalOrders + totalRevenue + grossMargin computed.

---

## Step status

| Step | Title                                                   | Status   |
| ---- | ------------------------------------------------------- | -------- |
| 1    | Stores + Products + Inventory Schema                    | Complete |
| 2    | Orders + Lines + Approvals Schema                       | Complete |
| 3    | External Customers + Shipping + Revenue Schema          | Complete |
| 4    | Seed Data + STR-001..003 IAM grants                     | Complete |
| 5    | Products + Inventory NestJS Module                      | Complete |
| 6    | Orders + Approvals NestJS Module (PARENT APPROVAL GATE) | Complete |
| 7    | External Customers + Shipping + Revenue NestJS Module   | Complete |
| 8    | Store UI — Catalogue + Checkout + Admin                 | Complete |
| 9    | Store UI — Public Store + Parent Approval + Fulfilment  | Complete |
| 10   | Vertical Slice CAT + Wave 6 close                       | Complete |

---

## Final cycle totals

- **Tenant base tables:** 362 → **371** (+9 `str_*` tables across migrations 092 + 093 + 094).
- **Intra-tenant FKs:** 13 (CASCADE × 7 + NO ACTION × 4 + SET NULL × 2). 0 cross-schema FKs (all cross-module refs are soft per ADR-001/020).
- **Backend:** StoreModule with **6 services + 1 controller + ~26 endpoints + 1 public endpoint** under `str-001:read/write/admin` + `str-002:read/write/admin` + `str-003:read/write/admin`.
- **Kafka emits:** 2 new topics (`str.order.completed`, `str.inventory.reorder_needed`).
- **Permission catalogue:** 465 → **468** (+1 function `STR-003` × 3 tiers — added in Step 4 to scope External Customers + Shipping + Revenue separately from Stores/Products and Orders/Approvals).
- **Web side:** new `Store` launchpad tile gated on `str-001:read` + `ShoppingBagIcon` + 7 `/store/*` routes + 1 unauthenticated `/shop/[storeId]` public storefront route at the app root.
- **CAT:** 8-check schema preamble + 10 plan scenarios all green on `tenant_demo` 2026-05-06.

---

## What this cycle adds on top of Cycle 27

**Greenfield — clean `str_*` namespace.** Cycle 28 ships the M67 School Store module from scratch. **Wave 6 (Finance & Commerce) closeout cycle** (Cycle 26 opened with Finance; Cycle 27 added Procurement; Cycle 28 closes with the School Store).

- **9 new tenant base tables** across 3 migrations (092 + 093 + 094). The plan's migration filenames (086/087/088) are out of date — those slots were taken by Cycle 26 Finance; Cycle 28 uses 092/093/094 mirroring the Cycle 27 renumber.
- **Five structural keystones (verified live in the CAT):**
  1. **PARENT APPROVAL GATE (ADR-062 KEYSTONE).** Every STUDENT-type order auto-creates a `str_order_approvals` row with `status='PENDING'` inside the same tenant tx as the order INSERT. Inventory is reserved (`quantity_reserved += quantities`) but `quantity_on_hand` is untouched until fulfilment. Payment is NOT charged. On parent approve: order flips PENDING_APPROVAL → PROCESSING + payment=CHARGED + `str.order.completed` emits AFTER tx commit. On parent decline: order flips PENDING_APPROVAL → CANCELLED + reservation released atomically. Multi-column `responded_chk` lockstep + UNIQUE(order_id) keep the contract enforceable at the schema layer.
  2. **DUAL-MODE STORE.** `str_stores.store_type` is a 2-value CHECK with UNIQUE(school_id, store_type) — exactly one store of each type per school. STUDENT mode: orders flow through the parent approval gate (when customer is a student) or charge family account directly (when customer is a parent). PUBLIC mode: orders use `external_customer_id` instead of `customer_person_id`, require `shipping_method=SHIPPED` with `shipping_option_id`, and skip the approval gate entirely. Three multi-column shape CHECKs (`customer_shape_chk`, `student_shape_chk`, `shipping_shape_chk`) on `str_orders` enforce the contract at the schema layer.
  3. **CROSS-MODULE TO Cycle 6 PAYMENTS (Wave 1 ↔ Wave 6 KEYSTONE).** `str.order.completed` envelope fires AFTER tx commit with full `lineItems` array + `paymentMode` so M84 Family Billing can charge the matching `pay_family_account` (STUDENT/PARENT) or stub the external charge (EXTERNAL). The store never writes to `pay_*` tables directly per ADR-001/020. The Cycle 6 consumer is Phase 2 work; this cycle ships the emit + verified envelope.
  4. **CROSS-MODULE TO Cycle 27 PROCUREMENT.** `str.inventory.reorder_needed` envelope fires when `quantity_on_hand` crosses to `<= reorder_point`, with payload that the future Cycle 27 procurement consumer can use to auto-create a `prc_requisitions` row.
  5. **REVENUE MATERIALISATION (ADR-018).** `str_store_revenue` is a periodic materialised read model. `RevenueService.materialise(storeId, periodStart, periodEnd)` aggregates COMPLETED orders into `total_orders + total_revenue + total_cost + gross_margin` and UPSERTs on `(store_id, period_start, period_end)` so re-runs are idempotent.
- **1 new web app tile** (Store under STR-001:read with new `ShoppingBagIcon`) + **7 new routes** under `/store/*` + 1 unauthenticated public storefront route at the app root (`/shop/[storeId]`).

**Iteration issues caught + fixed during the build (recorded for review continuity):**

1. **Splitter `;`-in-string trap (twice).** Migration 093 had 2 stray `;` instances inside `COMMENT ON COLUMN ... IS '...'` strings — rewrote with em-dashes. Migration 094 had 2 stray `;` instances inside `--` line comments (`; this FK` and `; SET NULL`) — rewrote with em-dashes/commas. The audit-then-provision discipline caught both before any provision attempt. Cycles 4–28 unbroken streak.
2. **Smoke SQL: `\set ON_ERROR_STOP off` doesn't recover from aborted tx.** Restructured the negative-path tests to ROLLBACK TO savepoint BEFORE the next verification SELECT.
3. **Stale API instance on port 4000.** First smoke run hit a stale `node dist/main.js` from before the rebuild and returned `string indices must be integers` from the dict-shape 404. Killed the PID + booted fresh.
4. **Prisma error "column g.is_primary does not exist".** OrderService SQL referenced `sis_guardians.is_primary` which doesn't exist. Fixed with the `sis_student_guardians` ranking pattern: `ORDER BY sg.has_custody DESC, sg.portal_access DESC, sg.receives_reports DESC LIMIT 1`.
5. **TS closure variable narrowing.** `let context: T | null = null` narrowed to `never` outside the closure when checked. Fixed with `as ReorderContext` cast inside `if (val !== null)`.
6. **PrismaClient param typing.** `loadForOrderInTx` declared the `tx` parameter as `{ $queryRawUnsafe: ... }` — TypeScript rejected the call site passing a full PrismaClient. Fixed by importing `type { PrismaClient } from '@prisma/client'` and using that type.
7. **Kafka topic auto-creation race.** First emit failed with "This server does not host this topic-partition". Pre-created `dev.str.order.completed` and `dev.str.inventory.reorder_needed` topics with `kafka-topics.sh --create` once for the dev verification run. Documented in the CAT.

---

## Existing-system touchpoints

- `iam_person(id)` — soft refs from `str_orders.customer_person_id` + `str_order_approvals.parent_person_id`.
- `sis_students(id)` — soft ref from `str_orders.student_id` (the recipient on a STUDENT order).
- `sis_student_guardians + sis_guardians + platform_users` — used by `OrderService.create` to resolve the parent account when auto-creating the approval row.
- `hr_employees(id)` — soft ref on `str_products.preferred_supplier_id` (DISPLAY-ONLY per ADR-001/020 today; future Cycle 27 procurement consumer reads this from the `str.inventory.reorder_needed` payload).
- `pay_family_accounts(id)` — DOES NOT appear in any `str_*` table; the future Cycle 6 consumer resolves the family account from `customer_person_id` at billing time.
- `prc_requisitions(id)` — DOES NOT appear in any `str_*` table; the future Cycle 27 consumer creates the requisition from the emit payload.
- `fin_chart_of_accounts(id)` — out of scope for this cycle; product cost lives on `str_products.cost` directly. Future polish: optional `revenue_account_id` + `cost_account_id` columns to drive M83 GL entries on order completion.

What does not change: every existing module continues to function. Cycle 28 is purely additive on a clean `str_*` namespace.

---

## Phase 2 / Pre-pilot punch list (carry-overs from this cycle)

Recorded for the post-cycle review and joins the Wave 2/Wave 6 backlog already in `CLAUDE.md`:

1. **Public storefront order placement** — `/shop/[storeId]` registers external customers but does not create orders publicly. Stripe Checkout wiring is deferred; the PUBLIC store demo lands the customer record + manual admin order creation today.
2. **Cycle 6 family-billing consumer for `str.order.completed`** — emit fires cleanly with the full payload contract M84 needs; the consumer in the payments module is Phase 2 work.
3. **Cycle 27 procurement consumer for `str.inventory.reorder_needed`** — emit fires cleanly with `productId` + `preferredSupplierId` + `reorderQuantity`; the procurement consumer that converts the emit into a `prc_requisition` is Phase 2 work.
4. **Store manager role split** — Staff currently holds STR-001..003 read+write as the store-manager stand-in. Joins the broader role-split chain (items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 in CLAUDE.md) — a dedicated Store Manager role should hold the STR-\* codes alone before pilot.
5. **Reorder emit on the order-completion path** — order completion decrements `quantity_on_hand` directly (not via `InventoryService.adjust`), so the reorder-threshold-crossing emit fires only on the explicit admin adjust path. Pre-pilot work moves the emit to a shared helper called from both paths.
6. **Persistent shopping cart** — current implementation uses in-memory session cart; `str_carts` deferred.
7. **Product variants** — size/colour matrices with per-variant inventory deferred.
8. **Discount codes / coupons** — deferred.
9. **Bundle products** — deferred.
10. **Backorder lifecycle on the order side** — `line_status='BACKORDERED'` flows are scaffolded but not exercised end-to-end. Pre-pilot work to verify the flip from BACKORDERED → IN_STOCK + payment_status update when stock arrives.

---

## Closing record

- Plan: `docs/campusos-cycle28-implementation-plan.html`
- CAT: `docs/cycle28-cat-script.md`
- Review prompt scaffold: `REVIEW-CYCLE28-CHATGPT.md`
- Tag: `cycle28-complete` after CI green on the closeout commit.

**Wave 6 (Finance & Commerce) closes here. The platform now has Finance + Procurement + School Store as a connected commerce stack.** The next wave is the broader Phase 2 hardening cycle that consolidates the punch list items across Waves 1–6 (role-model split, outbox for finance + commerce events, consumer tenant-routing validation, platform-scope auth path, DLQ dashboard).
