# REVIEW-P2C29-CHATGPT — fix log

**Final verdict (Round 2 against `e05d746`):** **PASS** — full P2-29 cycle APPROVED.
**Closeout commit:** this commit — appends Round 2 PASS verdict to handoff + CLAUDE.md and tags `p2c29-complete` at `e05d746` (the Round 1 fix commit that earned PASS) + `p2c29-approved` at the closeout commit.
**Tags:** `p2c29-complete` at `e05d746` + `p2c29-approved` at the closeout commit.

**Phase 2 closes with this approval.** P2-29 is the final cycle of Phase 2. The platform ships the complete operational + module-completion + .1 deferred-table surface across Waves A → D.

## Round 2 verdict — PASS

Reviewer cache-busted each affected file in code on Round 2 and confirmed every Round 1 fix matches:

| Dimension                     |   Rating | Findings                                                                                                     |
| ----------------------------- | -------: | ------------------------------------------------------------------------------------------------------------ |
| Loyalty                       | **PASS** | Customer person IDs must now be affiliated with the current school before balance/history/ledger operations. |
| Wishlists                     | **PASS** | Update and delete paths now scope through product → store → school ownership.                                |
| Promotions                    | **PASS** | Patch mutations now carry store/school predicates.                                                           |
| Price Schedules               | **PASS** | Worker apply/revert mutations are school-defensive.                                                          |
| Journal Batches / GL Boundary | **PASS** | Commerce emits the durable batch event; Finance owns GL materialisation through its consumer.                |
| Test Coverage                 | **PASS** | Round 1 blockers have pinned regression coverage and the full suite is green.                                |

The full Round 1 attack matrix re-runs clean against `e05d746`: the 5 previously-vulnerable attacks are now defended by the SQL-shape changes pinned in the regression spec, and the 6 already-defended attacks (budget transfer concurrency, contract expiry durability, promotion max-use, gift card overspend, procurement analytics replay, contract event durability) stay defended.

**Non-blocking carry-over to Phase 3:** Gift-card code lookup model. `card_code` is globally unique within the tenant by design while redemption remains school-scoped through the store join. Schools that want store-scoped codes can use prefixed codes operationally — no schema change required for the current contract.

## Closeout commit — CodeQL hardening

After the Round 2 PASS verdict, GitHub flagged 3 CodeQL `js/loop-bound-injection` findings on `e05d746` that hadn't surfaced in the manual review. The closeout commit lands all 3 fixes:

1. **`PromotionService.create` productIds loop** — added explicit runtime length cap (max 500) before the insert loop, matching the `meeting-template.service.ts` pattern from REVIEW-P2C28 MAJOR 2. The DTO already carries `@ArrayMaxSize(500)` but CodeQL requires the runtime check at the call site for the loop-bound rule.

2. **`JournalBatchPostedConsumer.process` payload.lines** — added explicit `MAX_BATCH_LINES = 1000` cap before iterating the Kafka payload's `payload.lines.map(...)`. The producer is admin-bounded today but a redelivered or corrupted envelope could carry an unbounded array; the consumer now throws `Error` for cap violation which propagates through `processWithIdempotency` to DLQ.

3. **`LoyaltyService.redeem` ledger aggregation** — replaced the in-memory `for (const r of ledger) { earned += ... }` loop over an unbounded `FOR UPDATE` row set with a Postgres SUM aggregation under a CTE that still holds the FOR UPDATE lock on every contributing row:

   ```sql
   WITH locked AS (
     SELECT transaction_type, points
       FROM str_loyalty_transactions
      WHERE store_id = $1::uuid AND customer_person_id = $2::uuid
      FOR UPDATE
   )
   SELECT
     COALESCE(SUM(CASE WHEN transaction_type = 'EARNED' THEN points ELSE 0 END), 0)::int AS earned,
     COALESCE(SUM(CASE WHEN transaction_type = 'REDEEMED' THEN points ELSE 0 END), 0)::int AS redeemed,
     COALESCE(SUM(CASE WHEN transaction_type = 'ADJUSTMENT' THEN points ELSE 0 END), 0)::int AS adjusted
   FROM locked
   ```

   The DB returns one row regardless of how many historical transactions the customer has, eliminating the loop-bound concern AND closing the reviewer's MAJOR 6 scaling note (which flagged the same code path for performance at customer-history scale). The FOR UPDATE in the CTE preserves concurrent-redemption serialisation.

CI parity at the closeout: API build clean, Prettier clean, log-schema lint 1018 files clean, vitest 1463/1463 passing across 70 spec files (existing regression tests unaffected by the changes).

---

## Round 1 fix log (preserved below for review trail)

**Round 1 verdict (`59aaa20` + `c244206`):** FAIL — 5 BLOCKING + 3 MAJOR.
**Round 1 fix commit:** `e05d746`.
**Round 2 verdict:** PASS at top of this file.

The Round 1 reviewer's gate decision required 5 BLOCKING fixes + tests:

1. Loyalty `customerPersonId` not validated against current-school affiliation.
2. Wishlist `update()` + `remove()` not school-scoped through product → store.
3. Promotion `patch()` UPDATE by id only after scoped lock.
4. PriceScheduleWorker apply/revert UPDATEs by id only after scoped selection.
5. Journal batch posting writes `fin_gl_entries` directly across the GL module boundary.

This commit lands all 5 BLOCKINGs + the 2 actionable MAJORs (catalogue item no-op reload + inventory adjust UPDATE) + 11 new pinned regression tests in `apps/api/src/commerce/__tests__/commerce-review-p2c29.spec.ts`. MAJOR 3 (gift card lookup UX scoping) is a UX/design question — the schema's UNIQUE `card_code` is global by design; redemption is school-scoped through store ownership; the question of whether codes should be store-scoped is a product decision tracked as a Phase 3 follow-up.

## Round 1 triage table

| #              | Finding                                                                     | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **BLOCKING 1** | Loyalty `customerPersonId` not validated against current-school affiliation | New shared helper `assertCustomerAffiliatedWithSchool(tenantPrisma, customerPersonId)` in `apps/api/src/commerce/access.ts` runs an EXISTS query joining `sis_students` (via `platform.platform_students.person_id` chain), `sis_guardians.person_id`, and `hr_employees.person_id` against the current school. `LoyaltyService.getBalance`, `listTransactions`, `earn`, `redeem`, and `adjust` all call the helper before any read or insert. Bogus / cross-school `customerPersonId` throws `BadRequestException` with the offending UUID inlined; no admin bypass.                                                                                                                                                                                                                                                                                                                            |
| **BLOCKING 2** | Wishlist update/remove not school-scoped                                    | `WishlistService.update` rewritten to `UPDATE str_wishlists w SET ... FROM str_products p JOIN str_stores s ON s.id = p.store_id WHERE w.product_id = p.id AND s.school_id = $tenant AND w.customer_person_id = $1 AND w.product_id = $2 RETURNING ...`. `remove` similarly uses `DELETE FROM str_wishlists w USING str_products p JOIN str_stores s ON s.id = p.store_id WHERE ...`. A support user with permission to act for a customer can no longer toggle or delete a wishlist entry for a foreign-school product.                                                                                                                                                                                                                                                                                                                                                                         |
| **BLOCKING 3** | Promotion patch UPDATE by id only                                           | `PromotionService.patch` UPDATE rewritten to `UPDATE str_promotions p SET ... FROM str_stores s WHERE s.id = p.store_id AND p.id = $N::uuid AND s.school_id = $M::uuid RETURNING ...`. The pre-lock SELECT already validated ownership; this is the consistent mutation-statement-school-scope pattern the Phase 2 style guide enforces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **BLOCKING 4** | PriceScheduleWorker apply/revert UPDATEs by id only                         | Both UPDATE statements in `tickForSchool` rewritten — apply UPDATEs `UPDATE str_products p ... FROM str_stores s WHERE s.id = p.store_id AND s.school_id = $tenant AND p.id = $id` and `UPDATE str_price_schedules ps ... FROM str_products p JOIN str_stores s ON s.id = p.store_id WHERE p.id = ps.product_id AND s.school_id = $tenant AND ps.id = $id`. Revert UPDATE follows the same pattern. The pre-select already joined through stores; the worker's mutation path is now defensive at the row-update level too.                                                                                                                                                                                                                                                                                                                                                                       |
| **BLOCKING 5** | Journal batch posting writes `fin_gl_entries` directly                      | `JournalBatchService.post` no longer writes `fin_gl_entries`. It now (1) validates balance + locks the batch, (2) reads the lines fresh under the lock, (3) flips status to POSTED, (4) emits `fin.journal_batch.posted` via durable outbox with the line payload. New `JournalBatchPostedConsumer` in `apps/api/src/finance/journal-batch-posted.consumer.ts` (Finance module — the GL owner) subscribes to the event under group `journal-batch-posted-consumer`, resolves a synthetic CFO actor, resolves per-account funds (with active-fund fallback), and calls `PostingService.createAndPost()` which materialises `fin_journal_batches` + `fin_gl_entries` with `source_event_id` UNIQUE for redelivery idempotency. The consumer follows the standard `processWithIdempotency` claim-after-success pattern; configuration misses throw + propagate to DLQ via the existing retry chain. |
| **MAJOR 1**    | Catalogue item no-op patch reload is ID-only                                | `VendorCatalogueService.patchItem` no-op reload rewritten to join through `prc_vendor_catalogues` with the school predicate; the UPDATE path also joins through `prc_vendor_catalogues` so the school predicate threads through the mutation statement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **MAJOR 2**    | Inventory adjustment final UPDATE is ID-only after scoped lock              | `InventoryAdjustmentService.adjust` UPDATE rewritten to `UPDATE str_product_inventory i ... FROM str_products p JOIN str_stores s ON s.id = p.store_id WHERE p.id = i.product_id AND s.school_id = $tenant AND i.id = $inv`. The pre-lock SELECT already proved ownership; the mutation now carries the predicate through.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **MAJOR 3**    | Gift card lookup model UX scoping                                           | Tracked as Phase 3 product follow-up. Current contract: `card_code` is UNIQUE across the tenant (single namespace per tenant); redemption gates through store ownership + school_id via the `FROM str_stores s WHERE s.school_id = $tenant` join, so a foreign-tenant card cannot be redeemed. Schools that want store-scoped codes can use prefixed codes operationally. No code change in Round 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Files in this commit

| File                                                            | Change                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/commerce/access.ts`                               | New `assertCustomerAffiliatedWithSchool` helper + import of `TenantPrismaService` + `BadRequestException`.                            |
| `apps/api/src/commerce/loyalty.service.ts`                      | Affiliation helper called in `getBalance`, `listTransactions`, `earn`, `redeem`, `adjust`.                                            |
| `apps/api/src/commerce/wishlist.service.ts`                     | `update` + `remove` rewritten to join through `str_products` + `str_stores` with school predicate.                                    |
| `apps/api/src/commerce/promotion.service.ts`                    | `patch` UPDATE rewritten with FROM `str_stores` + school predicate.                                                                   |
| `apps/api/src/commerce/price-schedule.service.ts`               | Apply + revert UPDATEs in `tickForSchool` rewritten with FROM `str_products` + JOIN `str_stores` + school predicate.                  |
| `apps/api/src/commerce/journal-batch.service.ts`                | `post` removes direct `fin_gl_entries` + companion `fin_journal_batches` writes; emits-only with line payload.                        |
| `apps/api/src/finance/journal-batch-posted.consumer.ts`         | New — subscribes to `fin.journal_batch.posted`, calls `PostingService.createAndPost` with `sourceEventId` for redelivery idempotency. |
| `apps/api/src/finance/finance.module.ts`                        | Wires `JournalBatchPostedConsumer` into providers.                                                                                    |
| `apps/api/src/commerce/vendor-catalogue.service.ts`             | `patchItem` no-op reload + UPDATE both join through `prc_vendor_catalogues`.                                                          |
| `apps/api/src/commerce/inventory-adjustment.service.ts`         | `adjust` UPDATE rewritten with FROM `str_products` + JOIN `str_stores` + school predicate.                                            |
| `apps/api/src/commerce/__tests__/commerce-review-p2c29.spec.ts` | New — 11 pinned regression tests across 5 BLOCKING describe blocks plus an affiliation-helper-export sanity check.                    |
| `HANDOFF-P2C29.md`                                              | Round 1 fix log appended.                                                                                                             |
| `CLAUDE.md`                                                     | Project Status updated with Round 1 fix log.                                                                                          |
| `REVIEW-P2C29-CHATGPT.md`                                       | this file                                                                                                                             |

## CI parity at this commit

- API build clean (`pnpm --filter @campusos/api build`)
- Prettier format clean (`pnpm format:check`)
- log-schema lint 1016+ files clean (`pnpm lint:logs`)
- New vitest spec passes 11/11 (`apps/api/src/commerce/__tests__/commerce-review-p2c29.spec.ts`)
- No schema migrations required — every fix is service-layer + the new consumer

## What follows

Awaiting Round 2 verdict. If Round 2 returns PASS, the full P2-29 cycle ships clean and Phase 2 closes.
