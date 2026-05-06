# Cycle 27 Handoff — Procurement

**Status:** Cycle 27 **COMPLETE** — awaiting peer review. Wave 6 (Finance & Commerce) continuation cycle. Cycle 27 builds the M86 Procurement module — all 12 ERD tables in scope per the basic procurement scope (ADR-061). The Procurement Officer / Purchasing Clerk is the **eleventh specialist operator persona** after the nurse, counsellor, librarian, athletic director, enrolment officer, transportation coordinator, food service manager, facilities manager, IT administrator, and CFO/Business Manager. **The cross-module supply chain hub** — when goods are received and distributed, `prc.distribution.completed` fires with a `destination_module` payload that 8 destination modules (tech / trn / fds / lib / ath / ext / fac / str) can consume to create their own inventory rows. Procurement never writes directly to another module's tables.

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle27-implementation-plan.html`
**Vertical-slice deliverable:** Rivera submits a requisition for 10 Chromebooks ($325 each, $3,250 total, destination=tech, budget line=Supplies $X) → multi-level approval (DEPT → ADMIN → DISTRICT) → admin issues PO #PO-2026-002 → **budget commitment created**: `fin_budget_lines.encumbered_amount += $3,250` → vendor ships → receiving clerk inspects: 10 Chromebooks received, 9 GOOD + 1 DAMAGED → **vendor performance auto-scored** atomically inside the same tx → admin distributes 9 good units → `prc.distribution.completed` fires with `destination_module=tech` → admin initiates a DAMAGED return + ships to vendor + resolves with REPLACED → admin closes PO → **commitment released** atomically (encumbered_amount drops by $3,250) → requisition status walks DRAFT → SUBMITTED → DEPT_APPROVED → ADMIN_APPROVED → ORDERED → RECEIVED → DISTRIBUTED → CLOSED.

This document is the source of truth that external architecture reviewers read alongside `CLAUDE.md`.

---

## Step status

| Step | Title                                                                              | Status   |
| ---- | ---------------------------------------------------------------------------------- | -------- |
| 1    | Requisitions + Lines Schema                                                        | Complete |
| 2    | Purchase Orders + Goods Receipt Schema                                             | Complete |
| 3    | Budget Commitments + Distribution + Returns + Vendor Performance + Settings Schema | Complete |
| 4    | Seed Data + PRC-001..003 IAM grants                                                | Complete |
| 5    | Requisitions NestJS Module                                                         | Complete |
| 6    | Purchase Orders + Goods Receipt NestJS Module (BUDGET COMMITMENT KEYSTONE)         | Complete |
| 7    | Distribution + Returns + Vendor + Settings NestJS Module (CROSS-MODULE KEYSTONE)   | Complete |
| 8    | Procurement UI — Dashboard + Requisitions + POs + Receiving                        | Complete |
| 9    | Procurement UI — Distribution + Returns + Vendor + Commitments                     | Complete |
| 10   | Vertical Slice CAT                                                                 | Complete |

---

## What this cycle adds on top of Cycle 26

**Greenfield — clean `prc_*` namespace.** Cycle 27 ships the M86 Procurement module from scratch. **Wave 6 continuation cycle** (Cycle 26 opened Wave 6 with Finance; Cycle 28 closes with the School Store).

- **12 new tenant base tables** across 3 migrations (089 + 090 + 091). Tenant base table count after Cycle 26 was 350 → **362** after Cycle 27.
- **1 new backend module** (ProcurementModule) with **7 services + 1 controller + ~28 endpoints** under `prc-001:read/write/admin` (Requisitions) + `prc-002:read/write/admin` (Purchase Orders + Receiving) + `prc-003:read/write/admin` (Distribution + Returns + Vendor).
- **2 new Kafka emit topics**: `prc.requisition.submitted` (fires when a requisition advances DRAFT → SUBMITTED) + `prc.distribution.completed` (the cross-module supply-chain event with `destination_module` payload).
- **0 new Kafka consumers** — Procurement is a pure emitter into the cross-module event bus this cycle. Phase 2 wires the destination-module workers per ADR-061.
- **No new permission codes** — `PRC-001..003` already in the catalogue from Wave 1.
- **1 new web app tile** (Procurement under PRC-001:read with new `ShoppingCartIcon`) + **13 new routes** under `/procurement/*`.

**Three structural keystones for the cycle:**

1. **BUDGET COMMITMENT (Cycle 26 ↔ Cycle 27 KEYSTONE).** When a PO transitions to ISSUED, `PurchaseOrderService.transition({action:'ISSUE'})` opens `executeInTenantTransaction`, locks the PO row + the parent budget line `FOR UPDATE`, validates remaining budget, INSERTs `prc_budget_commitments` (status=COMMITTED, committed_amount=PO total), increments `fin_budget_lines.encumbered_amount` by the same total, and flips the PO to ISSUED + parent requisition to ORDERED — all inside one tenant tx. CLOSE / CANCEL release the commitment + decrement encumbered_amount in the same atomic shape. The Cycle 26 budget-vs-actual variance dashboard immediately reflects every commit/release.

2. **CROSS-MODULE DISTRIBUTION (Wave 1 ↔ Wave 2 ↔ Wave 4 ↔ Wave 6 KEYSTONE).** `DistributionService.create()` writes the `prc_distributions` + `prc_distribution_lines` rows then emits `prc.distribution.completed` AFTER the tx commits, with payload `{distributionId, receiptId, purchaseOrderId, schoolId, destinationModule, destinationDepartment, distributedAt, sourceRefId, lines: [{receiptLineId, itemDescription, quantity, unitCost}]}`. 8 destination modules each have a `destination_module` token: `tech` (Cycle 22 → tech_assets), `trn` (Cycle 19 → trn_parts_inventory), `fds` (Cycle 20 → fds_inventory), `lib` (Cycle 12 → lib_catalogue_items), `ath` (Cycle 13 → ath_equipment), `ext` (Cycle 17 → ext_equipment_items), `fac` (Cycle 21 → fac_supply_inventory), `str` (Cycle 28 → str_product_inventory). Each module's inventory worker (Phase 2) consumes the event. **Procurement never writes directly to another module's tables** per ADR-061.

3. **VENDOR PERFORMANCE AUTO-SCORING.** `GoodsReceiptService.create()` updates `prc_vendor_performance` atomically inside the same tenant tx as the receipt write — `total_orders` increments by 1, `accepted_count` += sum(quantity_accepted), `rejected_count` += sum(quantity_rejected), `on_time_deliveries` increments when `today <= expected_delivery_date`. `average_quality_score` recomputes as `accepted / (accepted + rejected)`; `average_delivery_score` as `on_time / total_orders`. Schools see vendor scorecards live without a nightly batch job. Same tx also auto-flips PO status to PARTIALLY_RECEIVED or RECEIVED based on cumulative line quantities.

**Existing-system touchpoints:**

- `wsk_approval_requests(id)` (Cycle 7) — soft `approval_request_id` on `prc_requisitions` for multi-level approval routing (engine integration deferred to Phase 2; current implementation uses direct admin transitions).
- `fin_budget_lines(id)` (Cycle 26) — soft `budget_line_id` on `prc_requisitions`; PO ISSUE atomically increments `encumbered_amount`.
- `fin_suppliers(id)` (Cycle 26) — DB-enforced FK on `prc_purchase_orders.vendor_id` and `prc_vendor_performance.vendor_id`; soft `preferred_vendor_id` on `prc_requisition_lines`.
- `fin_chart_of_accounts(id)` (Cycle 26) — soft `gl_account_id` on `prc_purchase_order_lines` for GL coding.
- `iam_person(id)` — DB-enforced FK on `prc_requisitions.requesting_person_id`; soft refs on issued_by / received_by / distributed_by / initiated_by.
- `hr_employees(id)` (Cycle 4) — soft refs from the issued_by / received_by / distributed_by / initiated_by audit fields when the actor's `employeeId` is resolved.

What does not change: every existing module continues to function. Cycle 27 is purely additive on a clean `prc_*` namespace.

---

## Step 1 — Requisitions + Lines Schema

`packages/database/prisma/tenant/migrations/089_prc_requisitions.sql` lands 2 logical base tables: `prc_requisitions` (school-scoped requisition header; `requesting_person_id` declared with `REFERENCES platform.iam_person(id)` so the requester is tenant-locked; 3-value `urgency` CHECK ROUTINE/URGENT/EMERGENCY; **10-value `status` CHECK** DRAFT/SUBMITTED/DEPT_APPROVED/ADMIN_APPROVED/DISTRICT_APPROVED/ORDERED/RECEIVED/DISTRIBUTED/CLOSED/REJECTED — covers the full lifecycle; soft `approval_request_id` to `wsk_approval_requests`; soft `budget_line_id` to `fin_budget_lines`); `prc_requisition_lines` (CASCADE on parent requisition; **9-value `destination_module` CHECK** `tech / trn / fds / lib / ath / ext / fac / str / general`; soft `preferred_vendor_id` to `fin_suppliers`; non-negative `quantity` + `estimated_unit_cost` CHECKs). 1 new intra-tenant FK (CASCADE on lines → requisition); 0 cross-schema DB-enforced FKs (per ADR-001/020 the iam_person ref stays soft at the app layer). Tenant logical base table count: 350 → **352**. **Splitter trap audit clean** — no stray `;` inside any block comment or string literal. Live verification: 11 schema assertions all green (status / urgency / destination_module CHECKs reject BOGUS values; quantity / estimated_unit_cost reject negatives; FK rejection on bogus parent; CASCADE on parent delete drops 5 lines → 0; idempotent re-provision verified).

---

## Step 2 — Purchase Orders + Goods Receipt Schema

`packages/database/prisma/tenant/migrations/090_prc_purchase_orders.sql` lands 4 logical base tables: `prc_purchase_orders` (UNIQUE(school_id, po_number) so each school owns its own PO numbering; **8-value `status` CHECK** DRAFT/ISSUED/ACKNOWLEDGED/SHIPPED/PARTIALLY_RECEIVED/RECEIVED/CLOSED/CANCELLED; DB-enforced FK to `fin_suppliers(id)` on vendor_id; soft refs to `prc_requisitions(id)`, `hr_employees(id)` (issued_by, cancelled_by); non-negative `total_amount`); `prc_purchase_order_lines` (CASCADE on parent PO; soft `requisition_line_id` to source line; soft `gl_account_id` to `fin_chart_of_accounts`; non-negative `quantity_ordered` + `unit_cost` + `line_total`; 9-value `destination_module` CHECK matching requisition lines); `prc_goods_receipts` (NO ACTION on `purchase_order_id` so receipts survive PO archival as audit; soft `received_by` to `hr_employees`; **3-value `inspection_outcome` CHECK** ACCEPTED/ACCEPTED_WITH_DISCREPANCY/REJECTED); `prc_goods_receipt_lines` (CASCADE on receipt; **3-value `condition` CHECK** GOOD/DAMAGED/DEFECTIVE; **multi-column `quantity_balance_chk`** enforcing `accepted + rejected = received` so the schema rejects any half-state; non-negative quantities). 7 new intra-tenant FKs (CASCADE × 4 + NO ACTION × 2 + SET NULL × 1). Tenant logical base table count: 352 → **356**. **Splitter trap caught + fixed pre-provision twice**: 1 stray `;` in the block-comment header (rewritten with comma) + 1 stray `;` inside a `COMMENT ON TABLE` string (rewritten as em-dash). Live verification: 10 schema assertions all green (status / inspection_outcome / condition CHECKs; UNIQUE(school, po_number) rejects duplicate; quantity_balance_chk rejects 9 received with 5 accepted + 5 rejected; CASCADE on receipt delete drops 2 lines → 0).

---

## Step 3 — Budget Commitments + Distribution + Returns + Vendor Performance + Settings Schema

`packages/database/prisma/tenant/migrations/091_prc_distribution_vendor.sql` lands 6 logical base tables completing the Cycle 27 schema phase: `prc_budget_commitments` (CASCADE on parent PO; soft `budget_line_id` to `fin_budget_lines`; **3-value `status` CHECK** COMMITTED/PARTIALLY*RELEASED/RELEASED; non-negative `committed_amount` + `released_amount`; soft `released_by` audit ref); `prc_distributions` (CASCADE on receipt; **8-value `destination_module` CHECK** — same as line catalogue but excludes `general` since distributions are always module-specific; soft `distributed_by` to `hr_employees`); `prc_distribution_lines` (CASCADE on distribution; CASCADE on receipt_line; non-negative `quantity_distributed`; soft `unit_cost`); `prc_returns` (CASCADE on receipt_line; **3-value `return_type` CHECK** DAMAGED/DEFECTIVE/WARRANTY_CLAIM; **4-value `status` CHECK** INITIATED/SHIPPED_TO_VENDOR/RESOLVED/CANCELLED; nullable 3-value `resolution` CHECK REPLACED/REFUNDED/CREDITED; **multi-column `prc_ret_resolution_pair_chk`** (resolution + resolution_notes can both be NULL or both non-NULL); **multi-column `prc_ret_resolved_chk`** keeping `resolution + resolved_at + resolved_by` populated only when status=RESOLVED; soft `initiated_by` to `hr_employees`); `prc_vendor_performance` (UNIQUE(vendor_id, school_id); DB-enforced FK to `fin_suppliers(id)` on vendor_id; non-negative counters; `average_quality_score` + `average_delivery_score` as NUMERIC(5,4) with 0..1 range CHECK + nullable so first-receipt path can compute fresh); `prc_procurement_settings` (UNIQUE(school_id); `po_number_prefix` default 'PO'; non-negative `po_number_next_seq` default 1; nullable `auto_po_threshold` + `require_three_quotes_above`). 6 new intra-tenant FKs (CASCADE × 3 + NO ACTION × 3); 0 cross-schema FKs. Tenant logical base table count: 356 → **362**. \*\*Cycle 27 schema phase complete: 12 prc*\* tables across 3 migrations, 14 intra-tenant FKs total.\*\* **Splitter trap caught + fixed pre-provision once**: 1 stray `;` in a COMMENT string (`quality_score = accepted / (accepted+rejected); delivery_score = on_time / total_orders. Stored as 0.00..1.00 fractions; the UI renders as %.` — rewritten with "and" and ", "). Live verification: 12 schema assertions all green covering every CHECK + every UNIQUE + every FK delete-action.

---

## Step 4 — Seed Data + IAM grants

`packages/database/src/seed-procurement.ts` (idempotent, gated on `prc_procurement_settings` row count for the demo school) wired as `seed:procurement` in `packages/database/package.json` after `seed:finance`. 12 sections seed all 12 `prc_*` tables on `tenant_demo`:

- **1 settings row** (`PO` prefix, next_seq=2 since seed consumes PO-2026-001, `NET_30` default terms, `auto_po_threshold=500`, `require_three_quotes_above=2000`).
- **2 requisitions + 5 lines**: Rivera ADMIN_APPROVED Chromebook req (3 lines, $3,250 total, destination=tech) + Hayes SUBMITTED Cafeteria supplies req (2 lines, $850 total, destination=fds).
- **1 PO PO-2026-001** issued to Dell Education for Rivera's Chromebooks ($3,250) + 2 PO lines + status=RECEIVED.
- **1 goods receipt + 2 receipt lines** (10 Chromebooks: 9 GOOD + 1 DAMAGED with discrepancy notes; ACCEPTED_WITH_DISCREPANCY inspection).
- **1 budget commitment** ($3,250 COMMITTED against `account_code='5000'` Supplies budget line — Cycle 26 seed populates Supplies, not Technology, so this is the active line).
- **1 distribution + 2 distribution lines** (9 good Chromebooks → tech destination, distributed to "IT Asset Pool").
- **1 return** (1 DAMAGED Chromebook, status=INITIATED, return_reference auto-stamped).
- **1 vendor performance row** for Dell Education (totalOrders=1, on_time=1, accepted=9, rejected=1, quality=0.9, delivery=1.0).

Companion bump: `fin_budget_lines.encumbered_amount += $3,250` against the seeded Supplies budget line so the Cycle 26 budget-vs-actual dashboard reflects the seeded commitment immediately.

`packages/database/src/seed-iam.ts` extended: **Teacher** gains `PRC-001:read+write` (85 perms total, +2 for self-service requisitioning); **Staff** (the Procurement Officer stand-in) gains `PRC-001..003:read+write` (146 perms total, +6); School Admin / Platform Admin retain admin-tier on all 3 PRC codes via `everyFunction`. Catalogue stays at 465 — `PRC-001..003` already present from Wave 1.

Idempotent re-run: gates on `prc_procurement_settings` row count and skips with `Procurement settings already populated for demo school — skipping` log line. `tenant_test` stays empty by convention. Wired into `packages/database/package.json` as `"seed:procurement": "tsx src/seed-procurement.ts"`.

---

## Step 5 — Requisitions NestJS Module

`apps/api/src/procurement/requisitions.service.ts` + DTO surface in `apps/api/src/procurement/dto/procurement.dto.ts`. RequisitionService implements:

- `list(actor, status?)` — row-scoped: non-procurement-officer actors (Teacher with `PRC-001:read+write` only) see only their own requisitions; Staff (procurement officer or admin) sees all in school.
- `getById(id, actor)` — 404 don't-leak-existence for non-owner non-officer.
- `create(actor, input)` — INSERTs `prc_requisitions` + bulk-INSERTs `prc_requisition_lines` inside one tenant tx; computes `total_estimated_cost` from line items.
- `addLine(actor, reqId, input)` / `removeLine(actor, lineId)` — only DRAFT requisitions allow line modification; locks parent for update; recomputes total.
- `submit(actor, reqId)` — locks row, validates DRAFT status + at-least-one-line + (optional) budget remaining via soft `budget_line_id` ref to `fin_budget_lines`; flips to SUBMITTED; emits `prc.requisition.submitted` Kafka envelope OUTSIDE the tx.
- `approve(actor, reqId, {toStatus})` — admin-only; ALLOWED_APPROVAL_TRANSITIONS map enforces SUBMITTED → DEPT_APPROVED → ADMIN_APPROVED → DISTRICT_APPROVED/ORDERED state machine; locks row inside tx.
- `reject(actor, reqId, {reason})` — admin-only with required reason; refuses CLOSED/REJECTED/DISTRIBUTED.
- `markOrdered(reqId)` — public helper for PurchaseOrderService.create-from-requisition.

Helpers: `isUniqueViolation()` exported for downstream services. `insertLine(tx, reqId, line, order)` typed with `PrismaClient` to match Cycle 26's pattern. Tenant-scoped reads use `executeInTenantContext`; mutations use `executeInTenantTransaction` per the locked-state-machine convention.

---

## Step 6 — Purchase Orders + Goods Receipt NestJS Module (BUDGET COMMITMENT KEYSTONE)

`apps/api/src/procurement/purchase-orders.service.ts` ships **PurchaseOrderService** + **GoodsReceiptService**.

**PurchaseOrderService**:

- `list({status?, vendorId?})` / `getById(id)` — joined to `fin_suppliers` for vendor name + `iam_person` for issued-by name; loads lines + commitments inline.
- `create(actor, input)` — opens tx, locks `prc_procurement_settings` row `FOR UPDATE` to allocate the next `po_number` sequence atomically (auto-creates settings row on first PO if missing), validates vendor exists + active, INSERTs PO + lines, returns DRAFT shape. The settings-lock pattern guarantees no two POs ever land with the same `po_number` even under parallel writes.
- **`transition(actor, poId, {action}, budgetLineId?)` — THE BUDGET COMMITMENT KEYSTONE**. Opens `executeInTenantTransaction` with `SELECT … FOR UPDATE OF po`, validates transition per `ALLOWED_PO_TRANSITIONS` map. On `ISSUE`: reads `budget_line_id` from override input or parent requisition snapshot; locks `fin_budget_lines` row `FOR UPDATE`; computes `remaining = budgeted - actual - encumbered` and rejects with friendly 400 when PO total exceeds; INSERTs `prc_budget_commitments` (status=COMMITTED, committed_amount=PO total); UPDATEs `fin_budget_lines.encumbered_amount += PO total`; flips PO status to ISSUED + stamps issued_at + issued_by; cascades parent requisition → ORDERED. On `CLOSE`: walks every COMMITTED commitment, decrements `fin_budget_lines.encumbered_amount` by `(committed - released)`, marks commitments RELEASED with released_at + released_by stamps, flips PO to CLOSED + cascades requisition to CLOSED. On `CANCEL`: same release pattern as CLOSE + stamps cancelled_at + cancelled_by + cancel_reason.

**GoodsReceiptService**:

- `listForPO(poId)` — joined receipts with line breakdown.
- **`create(actor, poId, input)`** — opens tx, locks PO row `FOR UPDATE`, validates PO is ISSUED/ACKNOWLEDGED/SHIPPED/PARTIALLY_RECEIVED, validates each receipt-line `po_line_id` belongs to this PO + has remaining quantity, INSERTs receipt + lines; **UPSERTs `prc_vendor_performance` atomically inside the same tx** with `ON CONFLICT (vendor_id, school_id) DO UPDATE SET total_orders += 1, on_time_deliveries += $on_time, late_deliveries += $late, accepted_count += $sum_accepted, rejected_count += $sum_rejected, average_quality_score = recomputed, average_delivery_score = recomputed`; on-time check uses `today <= expected_delivery_date`; recomputes PO status based on cumulative quantities (`received >= ordered → RECEIVED`, else `PARTIALLY_RECEIVED`); cascades parent requisition → RECEIVED when PO fully received.

**ProcurementController** ships 18 endpoints under PRC-001/PRC-002 from Steps 5+6 (requisitions + lines + transitions + POs + receipts).

---

## Step 7 — Distribution + Returns + Vendor + Settings NestJS Module (CROSS-MODULE KEYSTONE)

`apps/api/src/procurement/distribution.service.ts` ships **DistributionService** + **ReturnService** + **VendorPerformanceService** + **ProcurementSettingsService**.

**DistributionService** — **THE CROSS-MODULE KEYSTONE**:

- `listForReceipt(receiptId)` — distributions for a receipt with lines + actor-name joins.
- **`create(actor, receiptId, input)`** — opens `executeInTenantTransaction`, validates receipt belongs to tenant + each receipt-line `FOR UPDATE OF rl` validates the line is part of the receipt + has remaining `quantity_accepted` minus already-distributed (so partial distributions are supported), INSERTs `prc_distributions` + lines; cascades parent requisition → DISTRIBUTED if PO is RECEIVED. **Emits `prc.distribution.completed` AFTER tx commits** (best-effort emit per the Wave 1 convention) with full payload `{distributionId, receiptId, purchaseOrderId, schoolId, destinationModule, destinationDepartment, distributedAt, sourceRefId, lines: [{receiptLineId, itemDescription, quantity, unitCost}]}`. The 8 destination modules (`tech / trn / fds / lib / ath / ext / fac / str`) each can land their own consumer in Phase 2.

**ReturnService**:

- `listAll({status?})` / `listForReceiptLine(rlId)` / `getById(id)` — full DTO with type / status / resolution + initiator audit.
- `create(actor, receiptLineId, input)` — opens tx, validates receipt line belongs to school + has sufficient `quantity_received` minus already-returned (excludes CANCELLED returns from the cap); INSERTs INITIATED return.
- `update(actor, returnId, {action, resolution?, resolutionNotes?})` — opens tx + locks return row, state-machine: SHIP (INITIATED → SHIPPED_TO_VENDOR), RESOLVE (any non-CANCELLED → RESOLVED with required resolution + stamps resolved_at + resolved_by per the multi-column `prc_ret_resolved_chk` lockstep), CANCEL (refused on RESOLVED).

**VendorPerformanceService**: read-only `list()` + `getForVendor(vendorId)` — joined to `fin_suppliers` for vendor name; returns the live counters maintained by `GoodsReceiptService.create`.

**ProcurementSettingsService**: `get()` (auto-creates default settings row on first read for tenant) + `update(actor, input)` (admin-only).

**ProcurementController** extended with 10 more endpoints under PRC-003 + settings — total **28 endpoints** for the cycle.

**ProcurementModule** wired into `apps/api/src/app.module.ts` between `FinanceModule` and the global guards. Imports `TenantModule + IamModule + KafkaModule`. API build clean; all 28 routes mapped on boot.

---

## Step 8 — Procurement UI: Dashboard + Requisitions + POs + Receiving

Web side at `apps/web/src/app/(app)/procurement/`:

- **Procurement launchpad tile** added to `apps/web/src/components/shell/apps.tsx` under `prc-001:read` (every persona who can submit requisitions sees the tile; Staff/admin gets the broader copy). New `ShoppingCartIcon` in `apps/web/src/components/shell/icons.tsx` (Heroicons shopping-cart).
- **`procurement-format.ts`** — const arrays, label maps, pill class maps for every enum (urgency, req status, PO status, destination module, inspection outcome, receipt condition, commitment status, return type/status/resolution) + `formatCurrency` / `formatDate` / `formatDateTime` / `formatPercentage` / `isOpenPo` / `isOpenReq` helpers.
- **`use-procurement.ts`** — 18 React Query hooks covering every endpoint with consistent invalidation on mutation (mutations on POs invalidate `['finance','budgets']` so the budget dashboard refreshes on commit/release).

**5 routes shipped in Step 8:**

- `/procurement` — persona-aware dashboard with 4-stat header (open requisitions / open POs / active commitments / open returns), nav chips, recent requisitions + open POs list, open returns list.
- `/procurement/requisitions` — filterable list with status chips.
- `/procurement/requisitions/new` — create form with line-item editor, urgency picker, optional budget line ID, destination module dropdown per line.
- `/procurement/requisitions/[id]` — detail with status pill triplet, action bar (Submit / Approve / Reject), line items, justification, review record.
- `/procurement/purchase-orders` — filterable PO list.
- `/procurement/purchase-orders/[id]` — full detail with status transition bar, **BUDGET COMMITMENT KEYSTONE Issue Modal** (warns about commitment + accepts optional budget-line override), Cancel Modal with reason, lines table, commitments panel, receipts panel with deep links.
- `/procurement/purchase-orders/new` — create form, supports `?requisitionId=` query param to pre-populate from approved requisition.
- `/procurement/receiving` — PO picker + per-line receive form with quantity-balance validation (accepted + rejected = received) + condition picker + discrepancy notes + inspection outcome.

---

## Step 9 — Procurement UI: Distribution + Returns + Vendor + Commitments

**5 more routes shipped in Step 9:**

- `/procurement/distribution` — PO + Receipt picker + accepted-lines table + **CROSS-MODULE DISTRIBUTION KEYSTONE Modal** (warns about the `prc.distribution.completed` emit + destination module dropdown + per-line quantity input).
- `/procurement/receipts/[id]?poId=…` — receipt detail with lines (Initiate-return per line button auto-fills return type from condition), returns list per line, distribution history.
- `/procurement/returns` — global returns list with status chips + per-row inline Mark-shipped, Resolve Modal (with required resolution + optional notes), Cancel.
- `/procurement/vendors` — vendor performance scorecards table with green/amber/rose pill thresholds (≥95% emerald, ≥80% amber, else rose).
- `/procurement/commitments` — active budget commitments table + total active encumbrance stat card; per-row deep link to PO; net encumbered shown bold for live commitments.

**Total Cycle 27 web routes: 13** under `/procurement/*`. Web build clean (`pnpm --filter @campusos/web build`); all routes present in the production manifest; sizes 2.94–6.14 kB First Load JS each.

---

## Step 10 — Vertical Slice CAT

`docs/cycle27-cat-script.md` walks 10 plan scenarios end-to-end:

1. **S1** — Teacher submits requisition (PRC-001 self-service) + Kafka envelope on `dev.prc.requisition.submitted`.
2. **S2** — Multi-level approval chain (DEPT → ADMIN → optional DISTRICT).
3. **S3** — **BUDGET COMMITMENT KEYSTONE** Issue PO → `prc_budget_commitments` row + `fin_budget_lines.encumbered_amount` bumped atomically.
4. **S4** — Receive goods with 1 damaged → vendor performance auto-updated + PO auto-flips to RECEIVED.
5. **S5** — **CROSS-MODULE DISTRIBUTION KEYSTONE** → `prc.distribution.completed` envelope on the wire with `destination_module="tech"`.
6. **S6** — Initiate damaged return + ship + resolve as REPLACED.
7. **S7** — Close PO releases the budget commitment atomically.
8. **S8** — 5 permission denial paths (parent/student 403, teacher 403 on POs/approve, teacher row-scope filter excludes other actors' requisitions).
9. **S9** — Settings auto-create + admin-only update.
10. **S10** — Reject path on a fresh requisition.

Cleanup section restores `tenant_demo` to the post-Step-4 seed shape via direct SQL (drops CAT-created POs + commitments + receipts + distributions + requisitions + resets PO sequence + payment terms).

**Cycle 27 ships clean to the post-cycle architecture review.**

---

## Reviewer attention items (non-blocking)

Recorded for the post-cycle architecture review and the Wave 6 Phase 2 punch list:

1. **Workflow engine integration deferred** — current implementation uses direct admin transitions on requisitions; the `approval_request_id` column is wired in the schema but no engine connection yet. Phase 2 should connect Cycle 7 wsk_approval_requests for dynamic multi-step routing.
2. **`auto_po_threshold` enforcement** — schema accepts the column but PO creation does not consult it for auto-PO generation.
3. **`require_three_quotes_above` enforcement** — schema accepts the column but PO creation does not require quote attachments above the threshold.
4. **Budget remaining check race** — current submit-time check uses `fin_budget_lines.encumbered_amount` snapshot; the locked-in commitment lands at PO ISSUE not requisition SUBMIT, so a race window exists between approval and issue. Pre-pilot tighten by computing `remaining = budgeted - actual - encumbered - sum(pending requisitions)`.
5. **Cross-module distribution consumers** — `prc.distribution.completed` emits cleanly but no downstream module currently subscribes. Each destination module needs its own `DistributionConsumer` to materialise assets / catalogue items / etc.
6. **Vendor performance score decay** — current scoring treats every order with equal weight; real-world buying typically uses time-decayed averages. Phase 2 polish.
7. **Procurement Officer / Purchasing Clerk role split** — Staff role currently gets all `PRC-001..003:read+write`. Joins the broader pre-pilot role-split punch list (items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32) for a dedicated Procurement Officer role distinct from generic Staff.
