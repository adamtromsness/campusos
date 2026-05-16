# HANDOFF — Phase 2 Cycle 29 (Commerce .1 Bundle)

**Plan:** [`docs/campusos-p2c29-commerce-bundle.html`](docs/campusos-p2c29-commerce-bundle.html)
**Review scaffold:** [`P2C29-REVIEW-NOTES.md`](P2C29-REVIEW-NOTES.md)
**Review fix log:** [`REVIEW-P2C29-CHATGPT.md`](REVIEW-P2C29-CHATGPT.md)
**Status:** **COMPLETE + APPROVED.** Round 1 against `c244206` returned FAIL with 5 BLOCKING + 3 MAJOR; Round 2 against `e05d746` returned **PASS** across all 6 dimensions. Tagged `p2c29-complete` at `e05d746` and `p2c29-approved` at the closeout commit.

## **Phase 2 closes with this approval.** P2-29 is the final cycle of Phase 2.

## REVIEW-P2C29 Round 2 verdict — PASS

Reviewer's verification table marks every Round 1 finding FIXED. Per-dimension score:

| Dimension                     |   Rating |
| ----------------------------- | -------: |
| Loyalty                       | **PASS** |
| Wishlists                     | **PASS** |
| Promotions                    | **PASS** |
| Price Schedules               | **PASS** |
| Journal Batches / GL Boundary | **PASS** |
| Test Coverage                 | **PASS** |

Reviewer cache-busted each affected file in code on Round 2 and confirmed every fix matches in code:

- `assertCustomerAffiliatedWithSchool` validates the person through current-school student / guardian / employee projections (`sis_students.school_id`, guardian-linked student school, `hr_employees.school_id`) and is required for loyalty balance reads + ledger writes.
- `WishlistService.update` updates through `str_wishlists → str_products → str_stores` with `s.school_id = tenant.schoolId`; `remove` uses the same school-scoped `DELETE ... USING` pattern.
- `PromotionService.patch` joins through `str_stores` with `s.school_id = tenant.schoolId`.
- `PriceScheduleWorker` apply + revert paths both join through `str_products + str_stores` with school predicates.
- `JournalBatchService.post` no longer writes `fin_gl_entries`; new Finance-owned `JournalBatchPostedConsumer` materialises GL via `PostingService.createAndPost()` with `sourceEventId` UNIQUE idempotency.

The full Round 1 attack matrix re-runs clean against `e05d746`: the 5 previously-vulnerable attacks (loyalty cross-school grants, wishlist cross-school mutation, promotion patch cross-school, price schedule worker cross-school, GL module boundary) are now defended; the 6 previously-defended attacks (budget transfer concurrency, contract expiry durability, promotion max-use atomicity, gift card overspend, procurement analytics redelivery, contract event durability) stay defended.

**Tagging:** `p2c29-complete` at `e05d746` (the Round 1 fix commit that earned Round 2 PASS) and `p2c29-approved` at the closeout commit.

**Non-blocking carry-over to Phase 3:** Gift-card code lookup model. `card_code` is globally unique within the tenant by design while redemption remains school-scoped through the store join. Schools that want store-scoped codes can use prefixed codes operationally — no schema change required for the current contract.

## Closeout commit — CodeQL hardening + tagging

The closeout commit lands 3 CodeQL `js/loop-bound-injection` hardening fixes flagged on `e05d746`:

1. **`PromotionService.create` productIds loop** — added explicit runtime length cap (max 500) before the insert loop, matching the meeting-template.service.ts pattern from REVIEW-P2C28 MAJOR 2. The DTO carries `@ArrayMaxSize(500)` but CodeQL requires the runtime check at the call site.

2. **`JournalBatchPostedConsumer.process` payload.lines** — added explicit `MAX_BATCH_LINES = 1000` cap before iterating the Kafka payload. The producer is admin-bounded but a redelivered or corrupted envelope could carry an unbounded array.

3. **`LoyaltyService.redeem` ledger aggregation** — replaced the in-memory loop over an unbounded `FOR UPDATE` row set with a Postgres SUM aggregation under a CTE that still holds the FOR UPDATE lock. The DB returns one row regardless of how many historical transactions the customer has, eliminating the loop-bound concern AND closing the reviewer's MAJOR 6 scaling note (which flagged the same code path for performance at customer-history scale).

Tagged `p2c29-complete` at `e05d746` (the Round 1 fix that earned Round 2 PASS) and `p2c29-approved` at the closeout commit.

---

## REVIEW-P2C29 Round 1 fix log

Round 1 against `c244206` returned FAIL with 5 BLOCKING + 3 MAJOR. The fix commit lands all 5 BLOCKING + the 2 actionable MAJORs (catalogue item no-op reload + inventory adjust UPDATE) + 11 pinned regression tests in `apps/api/src/commerce/__tests__/commerce-review-p2c29.spec.ts` across 5 describe blocks. MAJOR 3 (gift card lookup UX scoping) is a product decision tracked as a Phase 3 follow-up — the schema's UNIQUE `card_code` is global by tenant design; redemption gates through store ownership + school_id via the `FROM str_stores s WHERE s.school_id = $tenant` join.

**BLOCKING fixes:**

1. **Loyalty customer affiliation** — new shared helper `assertCustomerAffiliatedWithSchool(tenantPrisma, customerPersonId)` in `apps/api/src/commerce/access.ts` runs an EXISTS query against `sis_students` (via `platform_students.person_id` chain) / `sis_guardians.person_id` / `hr_employees.person_id` for the current school. `LoyaltyService.getBalance`, `listTransactions`, `earn`, `redeem`, and `adjust` call the helper before any read or insert. Bogus / cross-school `customerPersonId` throws `BadRequestException` with the offending UUID inlined; no admin bypass.

2. **Wishlist update/remove school-scope** — `WishlistService.update` rewritten to `UPDATE str_wishlists w SET ... FROM str_products p JOIN str_stores s ON s.id = p.store_id WHERE w.product_id = p.id AND s.school_id = $tenant AND w.customer_person_id = $1 AND w.product_id = $2 RETURNING ...`. `remove` similarly uses `DELETE FROM str_wishlists w USING str_products p JOIN str_stores s ON s.id = p.store_id WHERE ...`. A support user with permission to act for a customer can no longer toggle or delete a wishlist entry for a foreign-school product.

3. **Promotion patch UPDATE through store join** — `PromotionService.patch` UPDATE rewritten to `UPDATE str_promotions p SET ... FROM str_stores s WHERE s.id = p.store_id AND p.id = $N::uuid AND s.school_id = $M::uuid RETURNING ...`. The pre-lock SELECT already validated ownership; this is the consistent mutation-statement-school-scope pattern the Phase 2 style guide enforces.

4. **PriceScheduleWorker apply/revert school predicate** — both UPDATE statements in `tickForSchool` rewritten. Apply runs `UPDATE str_products p ... FROM str_stores s WHERE s.id = p.store_id AND s.school_id = $tenant AND p.id = $id` and `UPDATE str_price_schedules ps ... FROM str_products p JOIN str_stores s ON s.id = p.store_id WHERE p.id = ps.product_id AND s.school_id = $tenant AND ps.id = $id`. Revert UPDATE follows the same pattern.

5. **Journal batch GL ownership** — `JournalBatchService.post` no longer writes `fin_gl_entries` directly. It now (a) validates balance + locks the batch, (b) reads lines fresh under the lock, (c) flips status to POSTED, (d) emits `fin.journal_batch.posted` via durable outbox with the line payload. New `JournalBatchPostedConsumer` in `apps/api/src/finance/journal-batch-posted.consumer.ts` (Finance module — the GL owner) subscribes to the event under group `journal-batch-posted-consumer`, resolves a synthetic CFO actor + per-account funds (with active-fund fallback), and calls `PostingService.createAndPost()` which materialises `fin_journal_batches` + `fin_gl_entries` with `source_event_id` UNIQUE for redelivery idempotency. Configuration misses throw + propagate to DLQ via the existing retry chain.

**MAJOR fixes:**

- **M1 catalogue item reload** — `VendorCatalogueService.patchItem` no-op reload + UPDATE path both join through `prc_vendor_catalogues` with the school predicate.
- **M2 inventory adjust UPDATE** — `InventoryAdjustmentService.adjust` UPDATE rewritten with FROM `str_products` + JOIN `str_stores` + school predicate.

**Test coverage:** 11 new pinned regression tests across 5 describe blocks:

- R-B1 × 3 — affiliation helper fires before mutation on `earn`, `redeem`, `getBalance`
- R-B2 × 2 — wishlist update + delete SQL shape pinned (JOIN through products + stores with school predicate + arg-binding assertions)
- R-B3 × 1 — promotion patch UPDATE SQL shape pinned (FROM `str_stores` + school predicate + arg-binding)
- R-B4 × 2 — price schedule apply + revert UPDATE SQL shapes pinned (both UPDATEs join through products + stores)
- R-B5 × 2 — journal batch post emits-only + lines payload + does NOT insert `fin_gl_entries` + unbalanced batch rejection before any UPDATE fires
- 1 sanity test — affiliation helper is exported from `commerce/access`

CI parity: API build clean + Prettier format clean + log-schema lint 1016+ files clean + new vitest spec passes 11/11. No schema migrations — every fix is service-layer + 1 new consumer.

---

P2-29 closes the M86 Procurement, M83/84 Finance, and M67 Store .1 deferred-table surface in two sub-cycles:

- **P2-29a** (Procurement Advanced + Finance Extensions) — 9 tables, ~22 endpoints, 2 workers, 4 durable Kafka emits — shipped at `59aaa20`.
- **P2-29b** (Store Advanced) — 10 tables + 1 ALTER on Cycle 28 `str_products`, ~32 endpoints, 1 worker, 3 durable Kafka emits — ships in this commit.

**Cumulative P2-29 totals:**

- 19 new tenant base tables across 2 migrations (`175_prc_catalogues_fin_budgets.sql` + `176_str_promotions_loyalty.sql`)
- 1 ALTER on Cycle 28 `str_products` adding `category_id UUID` with FK to `str_category_hierarchy` ON DELETE SET NULL
- 20 intra-tenant DB-enforced FKs (8 from P2-29a + 12 from P2-29b)
- 0 cross-schema FKs (all `school_id` / `created_by` / `customer_person_id` / `vendor_id` etc. are soft per ADR-001/020 except where targeting tenant-scoped `fin_suppliers` from Cycle 26)
- ~46 endpoints across 13 services + 3 background workers + 1 NestJS controller
- 7 durable Kafka emit topics (all via `OutboxService.enqueueInTx`)
- Tenant logical base table count after P2-29: **826** (807 + 19)

## Sub-cycle structure

### P2-29a — Procurement Advanced + Finance Extensions (9 tables)

Shipped at `59aaa20`. Migration `175_prc_catalogues_fin_budgets.sql`.

| Table                       | Purpose                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prc_vendor_catalogues`     | Per-(vendor, school) pre-negotiated pricing catalogue header. UNIQUE(vendor_id, school_id, catalogue_name).                                            |
| `prc_catalogue_items`       | Catalogue line items with negotiated_price. UNIQUE(catalogue_id, item_code). Requisitions from a catalogue auto-populate pricing.                      |
| `prc_contracts`             | Vendor contract lifecycle. 5-value status CHECK (DRAFT, ACTIVE, EXPIRING, RENEWED, TERMINATED). ContractExpiryWorker flips ACTIVE→EXPIRING nightly.    |
| `prc_contract_amendments`   | Per-contract numbered amendment audit trail. UNIQUE(contract_id, amendment_number). Value changes apply atomically to parent total_value.              |
| `prc_spending_analytics`    | Materialised monthly rollup by (vendor, category, department). Maintained by ProcurementAnalyticsWorker.                                               |
| `fin_departmental_budgets`  | Per-(school, year, dept, category) allocation with committed + spent + available NUMERIC(12,2) tracking. 6-value budget_category CHECK.                |
| `fin_budget_transfers`      | Inter-department transfer request + approval. 3-value status. CHECK(from != to). Atomic from-decrement + to-increment on APPROVED.                     |
| `fin_journal_entry_batches` | Admin manual GL adjustment batch. 3-value status. total_debits + total_credits + is_balanced materialised; post path validates is_balanced=true.       |
| `fin_journal_entry_lines`   | Per-batch debit OR credit line (never both). CHECK(debit >= 0 AND credit >= 0). CHECK(debit = 0 OR credit = 0) — single-sided. CHECK(debit OR credit). |

**P2-29a services + Kafka emits:**

| Service                      | Endpoints | Responsibilities                                                                                                                                                                                                            |
| ---------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VendorCatalogueService`     | 5         | Catalogue + line item CRUD, catalogue-based requisition auto-pricing helper.                                                                                                                                                |
| `ContractService`            | 5         | Full contract lifecycle + amendment. Emits `prc.contract.amended` on amendment insert.                                                                                                                                      |
| `ContractExpiryWorker`       | 0         | Nightly sweep, ACTIVE→EXPIRING transition, emits `prc.contract.expiring` with deterministic event_id keyed on contractId.                                                                                                   |
| `SpendingAnalyticsService`   | 1         | Read endpoint for materialised analytics.                                                                                                                                                                                   |
| `ProcurementAnalyticsWorker` | 0         | Monthly materialisation from prc_purchase_orders + prc_goods_receipts.                                                                                                                                                      |
| `DepartmentalBudgetService`  | 4         | Budget CRUD with computed available_amount.                                                                                                                                                                                 |
| `BudgetTransferService`      | 5         | Request + approve + reject. **KEYSTONE: atomic from-decrement + to-increment** inside one tx with FOR UPDATE locks on both budgets. Emits `fin.budget_transfer.approved`.                                                   |
| `JournalBatchService`        | 7         | DRAFT batch + add/remove lines + post + void. **KEYSTONE: balanced post** validates total_debits = total_credits AND entry_count > 0 before copying lines into Cycle 26 `fin_gl_entries`. Emits `fin.journal_batch.posted`. |

### P2-29b — Store Advanced (10 tables)

Ships in this commit. Migration `176_str_promotions_loyalty.sql`.

| Table                        | Purpose                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `str_inventory_adjustments`  | Audit trail for stock movements outside normal sales. 5-value adjustment_type CHECK (RECOUNT, DAMAGE, THEFT, RETURN_TO_STOCK, WRITE_OFF). Service drives `str_product_inventory.quantity_on_hand` mutation inside same tenant tx as the audit insert.                                       |
| `str_promotions`             | Per-store promo with date range + 4-value discount_type CHECK (PERCENTAGE, FLAT_AMOUNT, BOGO, FREE_SHIPPING). Partial UNIQUE(store_id, promo_code) WHERE promo_code IS NOT NULL. `PromotionService.applyPromoCode` is the authoritative max_uses gate via atomic UPDATE … WHERE clause.     |
| `str_promotion_products`     | Junction. UNIQUE(promotion_id, product_id). Empty for a promotion means it applies to every product on the parent store.                                                                                                                                                                    |
| `str_loyalty_config`         | Per-store programme parameters. UNIQUE on store_id. points_per_dollar + redemption_rate_cents + min_redemption_points + is_enabled.                                                                                                                                                         |
| `str_loyalty_transactions`   | Append-only ledger of EARNED / REDEEMED / ADJUSTMENT rows. Customer balance computed in service code; no denormalisation.                                                                                                                                                                   |
| `str_gift_cards`             | Gift card head row with UNIQUE(card_code). 3-value status (ACTIVE, DEPLETED, CANCELLED). `str_gc_depleted_chk` lockstep keeps status=DEPLETED iff current_balance_cents=0.                                                                                                                  |
| `str_gift_card_transactions` | Append-only ledger of PURCHASE / REDEMPTION / TOP_UP rows. Service writes inside same tenant tx as the atomic balance update.                                                                                                                                                               |
| `str_wishlists`              | Per-(customer, product) wishlist row. UNIQUE(customer_person_id, product_id). Partial INDEX (product_id) WHERE notify_on_restock=true backs the future RestockNotificationWorker.                                                                                                           |
| `str_price_schedules`        | Per-product scheduled price change. effective_from required, effective_to nullable. `PriceScheduleWorker` applies ripe rows + reverts expired.                                                                                                                                              |
| `str_category_hierarchy`     | Self-referential category tree per store. UNIQUE(store_id, name, COALESCE(parent_category_id, sentinel)) catches sibling-name collisions. CHECK str_ch_no_self_parent_chk prevents self-parent. ALTER on `str_products` adds nullable `category_id UUID` FK with SET NULL on parent delete. |

**P2-29b services + Kafka emits:**

| Service                      | Endpoints | Responsibilities                                                                                                                                                                                                                          |
| ---------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InventoryAdjustmentService` | 2         | List per-product + adjust. Locks `str_product_inventory` row FOR UPDATE inside tenant tx, updates `quantity_on_hand` atomically with the audit insert. Refuses adjustments that would drive on_hand below 0.                              |
| `PromotionService`           | 5         | CRUD + the **KEYSTONE atomic max_uses enforcement**. Single UPDATE bundles all gates (active, in window, < max_uses) in WHERE + RETURNING. Zero rows means rejection. Emits `str.promotion.code_redeemed` per successful redemption.      |
| `LoyaltyService`             | 7         | Config upsert + balance + history + earn + **atomic redeem** + adjust. Redeem locks the customer's full ledger row set with FOR UPDATE, recomputes balance under the lock, refuses if balance < requested OR < min_redemption_points.     |
| `GiftCardService`            | 6         | Issue + look up by code + **atomic redeem** + top-up + cancel. Redeem runs a single UPDATE with balance gate + expiry + status in WHERE. status flips to DEPLETED atomically when balance hits zero; emits `str.gift_card.depleted`.      |
| `WishlistService`            | 4         | Per-customer list + add (idempotent on UNIQUE collision) + notify_on_restock toggle + remove.                                                                                                                                             |
| `PriceScheduleService`       | 3         | List + create + remove. **PriceScheduleWorker** ticks every minute, applies ripe schedules (UPDATE product.price + stamp applied_at), reverts expired schedules (stamp reverted_at). Emits `str.price.scheduled_applied` per applied row. |
| `CategoryHierarchyService`   | 5         | Tree read + create + patch + remove (refuses if children still reference). Self-parent CHECK and self-referential FK NO ACTION on delete.                                                                                                 |

**3 durable Kafka emits new in P2-29b**, all via `OutboxService.enqueueInTx` with deterministic v5-shape event ids:

- `str.promotion.code_redeemed` — keyed on (promotionId, current_uses_after) so each successful redemption is a fresh envelope despite the same promotionId.
- `str.price.scheduled_applied` — keyed on scheduleId.
- `str.gift_card.depleted` — keyed on giftCardId. Fires only on the redemption that drives balance to zero.

## Six structural keystones across P2-29

1. **Atomic budget transfer** (P2-29a) — `BudgetTransferService.approve` locks BOTH the transfer row AND the two budgets with FOR UPDATE in deterministic id order (smaller-id-first) to avoid deadlock between concurrent transfers, then decrements from-budget + increments to-budget atomically inside a single `executeInTenantTransaction`. Emits `fin.budget_transfer.approved` via outbox inside the same tx.

2. **Balanced journal batch post** (P2-29a) — `JournalBatchService.post` locks the batch row, re-aggregates lines fresh from `fin_journal_entry_lines`, validates `total_debits = total_credits AND entry_count > 0` BEFORE copying lines into Cycle 26 `fin_gl_entries`. Unbalanced batches are rejected with the entire tx rolling back — the schema-side multi-side CHECK on `fin_journal_entry_lines` is the belt-and-braces. Mirrors the ADR-058/ADR-059 Cycle 26 PostingService contract for the manual edit path.

3. **Contract expiry alerting** (P2-29a) — `ContractExpiryWorker` sweeps every 6 hours per active school, flips ACTIVE→EXPIRING when `end_date - renewal_reminder_days::interval <= now()`, emits `prc.contract.expiring` with deterministic event_id keyed on contractId so subsequent ticks see status=EXPIRING and the WHERE clause skips — the emit fires exactly once per contract per renewal cycle.

4. **Atomic promotion max_uses** (P2-29b) — `PromotionService.applyPromoCode` runs a single UPDATE that bundles every validation gate into the WHERE clause:

   ```sql
   UPDATE str_promotions
      SET current_uses = current_uses + 1, updated_at = now()
    WHERE store_id = $1::uuid
      AND promo_code = $2
      AND is_active = true
      AND starts_at <= now()
      AND ends_at > now()
      AND (max_uses IS NULL OR current_uses < max_uses)
    RETURNING …;
   ```

   Zero rows returned means one of the gates fired — the promotion is inactive, outside its date range, or its max_uses cap is exhausted. The redemption is rejected with a friendly 409 and NO use is consumed. The schema-side `str_promo_cap_chk` (current_uses <= max_uses) is the belt-and-braces.

5. **Atomic gift card redemption** (P2-29b) — `GiftCardService.redeem` runs a single UPDATE with the balance gate + expiry + status all in the WHERE clause:

   ```sql
   UPDATE str_gift_cards g
      SET current_balance_cents = g.current_balance_cents - $amount,
          status = CASE WHEN g.current_balance_cents - $amount = 0 THEN 'DEPLETED' ELSE g.status END,
          updated_at = now()
     FROM str_stores s
    WHERE g.store_id = s.id
      AND s.school_id = $tenant
      AND g.card_code = $code
      AND g.status = 'ACTIVE'
      AND (g.expires_at IS NULL OR g.expires_at >= CURRENT_DATE)
      AND g.current_balance_cents >= $amount
    RETURNING …;
   ```

   Zero rows returned means the gate fired (insufficient balance, expired, cancelled, or unknown card); the redemption is rejected with a friendly 409 and NO audit row is written. The schema-side `str_gc_balance_chk` (current_balance_cents >= 0) is the belt-and-braces. On the redemption that drives balance to zero, status flips to DEPLETED in the same UPDATE (CASE expression) and `str.gift_card.depleted` is emitted via outbox inside the same tx.

6. **Atomic loyalty redemption** (P2-29b) — `LoyaltyService.redeem` locks the customer's full ledger row set with `SELECT … FROM str_loyalty_transactions WHERE store_id = $1 AND customer_person_id = $2 FOR UPDATE`, recomputes balance under the lock as `earned + adjusted - redeemed`, then validates `balance >= requested AND requested >= min_redemption_points`. The REDEEMED row inserts inside the same tenant tx. Concurrent redemptions serialise on the lock so a customer cannot drain their balance twice.

## Migration details

**Migration `175_prc_catalogues_fin_budgets.sql` (P2-29a, 9 tables, 8 FKs)** — splitter-safe on first audit. Both `tenant_demo` and `tenant_test` provisioned cleanly.

**Migration `176_str_promotions_loyalty.sql` (P2-29b, 10 tables + 1 ALTER, 12 FKs)** — splitter audit caught 2 stray `;` inside a block-comment description (rewritten with em-dash + comma + "and") before any provision attempt. Splitter audit clean after correction; `tenant_demo` and `tenant_test` both at migration 176 with the new tables + the str_products.category_id column + the FK chain verified via `pg_constraint.confdeltype`:

- 12 CASCADE 'c' (children of products/stores/promotions/inventory/cards)
- 1 NO ACTION 'a' (`str_ch_parent_fk` self-FK on category hierarchy)
- 1 SET NULL 'n' (`str_products_category_fk` so a product survives a category removal)

## IAM grants

Cycle 28 already shipped:

- `STR-001` (Store Management) — admin tier on the existing Staff/Store Manager roles
- `STR-002` (Store Orders) — held by Parent, Student, Staff
- `STR-003` (External Customers, Shipping & Revenue) — held by Staff

P2-29 reuses these codes. No catalogue additions. Permission distribution:

- **`str-001:admin`** — store administrators (admin or holder of `str-001:admin` / `str-003:admin`). Drives promotion / loyalty config / category / gift card issue + cancel / inventory adjust.
- **`str-001:write`** — store staff. Drives gift card top-up + loyalty earn / inventory adjust read.
- **`str-002:read`** — customer-facing surfaces. Drives promo code apply, gift card redeem, loyalty redeem, wishlist.
- **`str-002:write`** — customer-facing surfaces with write authority.
- **`prc-001..004` + `fin-005..006`** — P2-29a permission distribution (unchanged from existing Cycle 26 + Cycle 27 grants).

The service layer `assertStoreAdmin` / `assertStoreReader` / `assertStoreCustomer` in `apps/api/src/commerce/access.ts` is the actual access boundary on every endpoint — controller permissions only filter at the gate.

## Endpoint summary (cumulative)

**Total: ~46 endpoints** under `/api/v1/commerce/*` on the `CommerceController`:

| Surface                         | Count | Permission        |
| ------------------------------- | ----: | ----------------- |
| Vendor catalogues (P2-29a)      |     5 | prc-004           |
| Contracts + amendments (P2-29a) |     5 | prc-004           |
| Spending analytics (P2-29a)     |     1 | prc-002           |
| Departmental budgets (P2-29a)   |     4 | fin-006           |
| Budget transfers (P2-29a)       |     5 | fin-006           |
| Journal entry batches (P2-29a)  |     7 | fin-005           |
| Inventory adjustments (P2-29b)  |     2 | str-001           |
| Promotions (P2-29b)             |     5 | str-001 / str-002 |
| Loyalty (P2-29b)                |     7 | str-001 / str-002 |
| Gift cards (P2-29b)             |     6 | str-001 / str-002 |
| Wishlists (P2-29b)              |     4 | str-002           |
| Price schedules (P2-29b)        |     3 | str-001           |
| Category hierarchy (P2-29b)     |     5 | str-001           |

## CI parity at this commit

- API build clean (`pnpm --filter @campusos/api build`)
- Prettier format clean (`pnpm format:check`)
- log-schema lint 1016 files clean (`pnpm lint:logs`)
- Both `tenant_demo` and `tenant_test` provisioned cleanly through migration 176
- 14 P2-29b FK constraints verified via `pg_constraint.confdeltype` readout
- 60 commerce controller routes mapped under `/api/v1/commerce/*`

## Phase 2 / pre-pilot carry-overs from P2-29

1. **RestockNotificationWorker** — schema is wired (str_wishlists.notify_on_restock + partial INDEX) but the worker that watches `str_product_inventory.quantity_on_hand` cross from 0 to >0 and fans out to wishlist entries is deferred to the M40 Communications cycle when the Cycle 14 notification pipeline can absorb store-domain events.

2. **PromotionService order-completion fan-out** — `applyPromoCode` validates and consumes a use, but the actual discount application to the order total lives in the Cycle 28 OrderService (next major store-side cycle would add an order-completion consumer that emits `str.promotion.applied` per order to keep analytics fresh).

3. **LoyaltyService order-completion auto-earn** — Cycle 28 OrderService should call `LoyaltyService.earn` automatically on order completion. Until then, schools call the `/store/loyalty/earn` endpoint manually or via a future Cycle 28 consumer chain.

4. **Gift card purchase flow** — `GiftCardService.issue` is admin-only today (for promotional cards + customer-purchased cards an admin issues against a paid order). A customer-facing purchase endpoint that integrates with Cycle 6 family billing + Cycle 28 order flow is the natural Phase 3 next step.

5. **Price schedule conflict detection** — schedules with overlapping `[effective_from, effective_to]` windows on the same product are not refused at create time. The worker applies them in effective_from order, so the latest wins; future hardening adds an EXCLUSION constraint or service-layer conflict check.

6. **Category tree depth** — no schema limit on nesting depth. Pre-pilot consider a service-layer cap (e.g. 5 levels) to prevent UI rendering issues with deeply nested trees.

7. **Catalogue-based requisition auto-pricing** — P2-29a `VendorCatalogueService` exposes the catalogue + items; the wiring into `RequisitionService` (Cycle 27) that auto-populates pricing when a catalogue id is supplied is a Cycle 27 follow-up.

8. **Contract amendment value cascading** — `amend()` updates `prc_contracts.total_value` atomically but does not currently re-balance any in-flight `prc_budget_commitments` against the new value. Pre-pilot hardening adds a recompute path or refuses amendments that would overshoot the committed amount.

## What ships in P2-29 closeout (this commit)

- New migration `176_str_promotions_loyalty.sql` (10 tables + ALTER, 12 FKs)
- 7 new services in `apps/api/src/commerce/`:
  - `inventory-adjustment.service.ts`
  - `promotion.service.ts`
  - `loyalty.service.ts`
  - `gift-card.service.ts`
  - `wishlist.service.ts`
  - `price-schedule.service.ts` (includes the PriceScheduleWorker)
  - `category-hierarchy.service.ts`
- New DTO module `apps/api/src/commerce/dto/commerce-store.dto.ts`
- Extended `apps/api/src/commerce/access.ts` with `assertStoreAdmin` / `assertStoreReader` / `assertStoreCustomer`
- Extended `apps/api/src/commerce/event-ids.ts` with 3 new deterministic helpers
- Extended `apps/api/src/commerce/commerce.controller.ts` with 32 P2-29b routes
- Updated `apps/api/src/commerce/commerce.module.ts` with the 7 new services
- HANDOFF-P2C29.md + P2C29-REVIEW-NOTES.md + CLAUDE.md updates

## **Phase 2 closes here.**

P2-29 is the final cycle of Phase 2. The platform now ships the complete operational + module-completion + .1 deferred-table surface across:

- **Wave A** (Pilot Critical): Cycles 0–8
- **Wave B** (Pilot Enhancement): Cycles 9–17, P2-1..P2-11
- **Wave C** (Operational Depth): Cycles 11–17, P2-13..P2-17
- **Wave D** (Module Completion): P2-18..P2-29

All 19 P2-29 tables are in repo. Tenant logical base table count: **826**. ~46 new endpoints. 7 new durable Kafka emits via the platform outbox. 3 background workers (ContractExpiryWorker, ProcurementAnalyticsWorker, PriceScheduleWorker). All schema invariants verified via live `pg_constraint` readout on `tenant_demo`.

Phase 3 themes (chart of accounts management, AP three-way matching, grant accounting, financial statements, AI-driven analytics, full Stripe wiring) remain on the roadmap.
