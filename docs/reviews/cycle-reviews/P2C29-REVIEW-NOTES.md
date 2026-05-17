# P2C29 — Reviewer Scaffold (Commerce .1 Bundle)

**Plan:** [`docs/campusos-p2c29-commerce-bundle.html`](docs/campusos-p2c29-commerce-bundle.html)
**Handoff:** [`HANDOFF-P2C29.md`](HANDOFF-P2C29.md)
**Status:** Awaiting Round 1. This is the **final cycle of Phase 2**.

P2-29 is the largest table-count cycle of Wave D — 19 new tenant base tables across two functional sub-bundles. Reviewer attention should split between the procurement + finance side (P2-29a, 9 tables) and the store side (P2-29b, 10 tables). The 6 keystones below are listed roughly in order of structural risk.

## 1. Catalogue-based auto-pricing (P2-29a)

`prc_vendor_catalogues` + `prc_catalogue_items` are a pre-negotiated price list. The intended Cycle 27 RequisitionService follow-up is to detect when a requisition line carries `catalogue_id` + `item_code` and auto-populate `unit_price` from the matching catalogue item rather than letting the requester free-text it. Today the schema is ready (`prc_catalogue_items.negotiated_price` + UNIQUE on catalogue + item_code), the service surfaces `VendorCatalogueService.list / getById` with inlined items, but the RequisitionService side of the wiring is a downstream task.

**Reviewer questions:**

- Are the schema invariants strong enough? `prc_catalogue_items` is CASCADE on catalogue + has UNIQUE(catalogue_id, item_code). When a catalogue is deactivated (is_active=false on parent) do we want a service-side gate on requisition-from-catalogue, or just rely on the read filter? (Currently the read returns inactive items; the future requisition wiring is the gate.)
- `negotiated_price NUMERIC(10,2) >= 0` — does the bid-zero-then-supplier-bills-overage pattern exist in real procurement? If yes a comment column on the catalogue item to surface the bid-vs-actual relationship would help.

## 2. Contract lifecycle + amendment pattern (P2-29a)

`prc_contracts` carries 5-value status (DRAFT, ACTIVE, EXPIRING, RENEWED, TERMINATED) plus `prc_contract_amendments` for numbered changes. The lifecycle transitions allow DRAFT→ACTIVE/TERMINATED, ACTIVE→EXPIRING/RENEWED/TERMINATED, EXPIRING→RENEWED/TERMINATED/ACTIVE (re-extend), RENEWED→ACTIVE/EXPIRING/TERMINATED. TERMINATED is terminal.

`ContractService.amend` applies `value_change` to parent `total_value` atomically; `newEndDate` replaces `end_date` when set. The amendment row is the audit trail.

`ContractExpiryWorker` sweeps every 6h, flips ACTIVE→EXPIRING when `end_date - renewal_reminder_days::interval <= now()`, emits `prc.contract.expiring` with deterministic event_id keyed on contractId. The deterministic id is what makes the alert fire exactly once per contract per renewal cycle — subsequent ticks see status=EXPIRING and the WHERE clause's `AND status='ACTIVE'` predicate skips.

**Reviewer questions:**

- The amendment `value_change` updates `total_value` but does NOT recompute `prc_budget_commitments` against the new value. If the original PO budget commitment was for the contract's old total, an amendment that lowers value leaves the commitment over-stated until the next PO-close. Worth a `prc.contract.amended` consumer that rebalances commitments before pilot.
- `RENEWED` and `ACTIVE` are conceptually distinct (RENEWED = "this contract continues after renewal" vs ACTIVE = "currently running") but transition rules let RENEWED→ACTIVE. Is the RENEWED state ever stable on disk, or is it just a transitional marker that gets flipped to ACTIVE on the next renewal cycle? Schools may want a derived "is_in_renewal_period" computed flag instead.

## 3. Journal batch balance validation (P2-29a)

`JournalBatchService.post` is the keystone. The post path:

1. Locks the batch row with FOR UPDATE inside `executeInTenantTransaction`.
2. Re-aggregates `fin_journal_entry_lines` fresh into `total_debits` + `total_credits` (does not trust the denormalised columns on the batch row).
3. Validates `total_debits = total_credits AND entry_count > 0` BEFORE any GL write.
4. Copies each line into Cycle 26 `fin_gl_entries` inside the same tx.
5. Flips the batch status to POSTED + stamps `posted_by` + `posted_at`.
6. Emits `fin.journal_batch.posted` via outbox.

The schema-side `fin_jel_one_side_chk` (debit = 0 OR credit = 0) enforces single-sided lines so a row is either a debit or credit, never both. `fin_jel_entry_chk` (debit > 0 OR credit > 0) rejects all-zero rows. The denormalised totals on the batch row are recomputed by service code on every line add/remove.

**Reviewer questions:**

- Re-aggregation under FOR UPDATE re-reads the lines table — a concurrent add-line that completes after the post path's re-read but before COMMIT would NOT be picked up. The lock on the batch row prevents concurrent line edits because every line edit goes through `addLine / removeLine` which lock the parent batch first. Confirm this contract by tracing the addLine path.
- Mirror the Cycle 26 ADR-058/ADR-059 contract — both `PostingService.post` (auto) and `JournalBatchService.post` (manual) end with rows in `fin_gl_entries`. The downstream GLConsumer idempotency is keyed on `source_event_id` which differs between AUTO and MANUAL, so a redelivered manual-batch event doesn't collide with an auto-posted event for the same gross+net split.

## 4. Budget transfer atomicity (P2-29a)

`BudgetTransferService.approve` is the keystone. The approve path:

1. Locks the `fin_budget_transfers` row with FOR UPDATE.
2. Validates status=PENDING; refuses non-PENDING transitions.
3. Locks BOTH `fin_departmental_budgets` rows (`from_budget_id`, `to_budget_id`) in deterministic id-ascending order so concurrent transfers that touch the same pair of budgets don't deadlock.
4. Validates `from_budget.allocated_amount >= transfer.amount`.
5. Issues atomic UPDATEs: from-decrement + to-increment + transfer-flip-to-APPROVED, all inside the same tx.
6. Emits `fin.budget_transfer.approved` via outbox.

The schema-side CHECK `from_budget_id <> to_budget_id` rejects same-budget self-transfers. The amount > 0 CHECK rejects zero/negative transfers.

**Reviewer questions:**

- Deadlock avoidance via id-ascending lock order is correct but worth tracing — the code uses `transfer.from_budget_id < transfer.to_budget_id ? [from, to] : [to, from]` and locks via `ANY($2::uuid[]) ORDER BY id FOR UPDATE`. Confirm that Postgres respects the ORDER BY when acquiring row locks in a single SELECT (it does in practice but worth confirming on the documentation).
- `allocated_amount` can be moved freely between budgets but `committed_amount` and `spent_amount` are not touched by transfer. If a budget's `available_amount = allocated - committed - spent` goes negative after a transfer that drops allocated below committed, the schema accepts it. The dashboard surfaces this as overspend — is that the intended UX, or should the approve path refuse transfers that would create overspend?

## 5. Gift card atomic balance (P2-29b)

`GiftCardService.redeem` is the keystone of P2-29b. The redeem path runs a single UPDATE with every gate in the WHERE clause:

```sql
UPDATE str_gift_cards g
   SET current_balance_cents = g.current_balance_cents - $amount,
       status = CASE WHEN g.current_balance_cents - $amount = 0
                     THEN 'DEPLETED' ELSE g.status END,
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

Zero rows returned means one of the gates fired (insufficient balance, expired, cancelled, unknown card) — the redemption is rejected with a friendly 409 and **NO** audit row is written. On success, status flips to DEPLETED atomically in the same UPDATE via the CASE expression, and a `str.gift_card.depleted` outbox event is enqueued inside the same tx so the customer notification consumer can fire.

The schema-side `str_gc_balance_chk` (`current_balance_cents >= 0`) is the belt-and-braces against a negative balance even if the service layer somehow bypasses the WHERE gate. `str_gc_depleted_chk` enforces `status='DEPLETED' iff current_balance_cents=0`.

**Reviewer questions:**

- The card code is generated with rejection-sampling against a 32-character alphabet (excluding ambiguous I/O/0/1). At 16 characters that's 32^16 ≈ 1.2e24 space so collisions are astronomically rare; the UNIQUE constraint on `card_code` is the safety net + the issue path retries up to 5 times. Is 16 characters long enough vs typical retail gift card UX (often 14)? Pre-pilot test the UI.
- `expires_at DATE` (not timestamptz) — gift cards expire at end-of-day in school's local timezone. The CHECK `expires_at >= CURRENT_DATE` uses Postgres's server time. If the platform deploys across timezones, the server-side `CURRENT_DATE` is UTC by default which might surface a one-day-off issue. Pre-pilot confirm tenancy timezone is set on the connection or shift the CHECK to compare against a tenant-supplied "today".

## 6. Loyalty point economics (P2-29b)

`str_loyalty_config` carries the programme parameters:

- `points_per_dollar` (default 1) — how many points earn per dollar spent
- `redemption_rate_cents` (default 1) — how many cents discount per point redeemed
- `min_redemption_points` (default 100) — minimum redemption threshold

The customer balance is computed in service code on every read as:

```
balance = SUM(points WHERE type IN (EARNED, ADJUSTMENT))
        - SUM(points WHERE type = REDEEMED)
```

No denormalisation — the ledger is the canonical source of truth. The keystone is `LoyaltyService.redeem` which locks the customer's full ledger row set with `FOR UPDATE` inside the redemption tx, recomputes balance under the lock, validates (>= min_redemption_points AND >= requested points), then writes the REDEEMED row. Concurrent redemptions serialise on the lock so a customer cannot drain their balance twice.

**Reviewer questions:**

- The `FOR UPDATE` lock on the entire ledger row set scales poorly for a customer with thousands of historical transactions. Pre-pilot, the lock should switch to a synthetic per-(store, customer) advisory lock (`pg_advisory_xact_lock(hashtext('loyalty:' || store_id || ':' || customer_person_id))`) so the lock surface is constant regardless of history depth.
- `points_per_dollar` is an integer — fractional point earning (e.g. 0.5 points per dollar) is not supported. If schools want "earn 1 point per $2 spent" they'd configure `points_per_dollar=1` and `redemption_rate_cents=2` — verify this models cleanly.
- Adjustment rows can be unbounded positive (no max_points cap). Audit log on adjust includes the `description` field which is required (5-char min) but no admin-override workflow exists for credibility-style adjustments. Should adjustment rows route through `WorkflowEngineService`?

## 7. Promotion discount application order (P2-29b)

`PromotionService.applyPromoCode` validates and consumes a use via the keystone atomic UPDATE. But the actual discount application to an order is a future Cycle 28 OrderService wiring — today `applyPromoCode` just bumps `current_uses` and emits `str.promotion.code_redeemed`. The order-completion consumer would:

1. Look up the promotion (now with `current_uses` already incremented from the apply call).
2. Compute the discount per the `discount_type`:
   - PERCENTAGE: discount = order_total \* (discount_value / 100)
   - FLAT_AMOUNT: discount = MIN(discount_value, order_total)
   - BOGO: depends on cart line composition (product allowlist via str_promotion_products)
   - FREE_SHIPPING: discount = order's shipping_amount
3. Apply discount before tax calculation.
4. Persist the discount as a line item on `str_order_lines` with `line_type='DISCOUNT'` (or similar).

If multiple promotions stack, the application order matters. Pre-pilot conventions:

- PERCENTAGE applies first, then FLAT_AMOUNT, then BOGO, then FREE_SHIPPING.
- No two PERCENTAGE promotions stack; if the customer has two valid percentage promos, the higher value wins.
- `min_order_amount` is checked against the pre-discount subtotal.

**Reviewer questions:**

- The schema does not prevent two PERCENTAGE promos from being applied to the same order — the "no stacking" rule lives in the order-completion consumer. Pre-pilot decide whether stacking is allowed via a `str_promotions.allows_stacking BOOLEAN` column or a global per-store config.
- BOGO doesn't carry product-pair metadata. The current model is "BOGO across any product in the allowlist" — schools that want "buy product X get product Y free" need a separate model. Worth a pre-pilot UX review.

## 8. Price schedule worker (P2-29b)

`PriceScheduleWorker` (lives on `PriceScheduleService`) ticks every minute, applies ripe schedules + reverts expired schedules. The apply path:

```sql
SELECT … FROM str_price_schedules WHERE applied_at IS NULL AND effective_from <= now()
```

The partial INDEX `str_ps_ripe_idx (effective_from) WHERE applied_at IS NULL` is the hot path.

For each ripe row: UPDATE `str_products.price = scheduled_price` + UPDATE `str_price_schedules.applied_at = now()` + emit `str.price.scheduled_applied`.

The revert path stamps `reverted_at` on schedules where `effective_to <= now()` but does NOT restore the prior price — the plan documents this as best-effort and recommends schools chain schedules (one to apply, one to restore) for true rollback semantics. Schools that don't chain see the price stay at whatever the most recent ripe schedule applied.

**Reviewer questions:**

- The "no rollback on revert" semantic is intentional but surprising for an admin who reads "schedule a 20% discount from Oct 1 to Oct 7" and expects the price to bounce back. Pre-pilot UX should make this explicit on the create form ("note: when this discount expires, you'll need a follow-up schedule to restore the original price").
- Apply ordering when multiple schedules share `effective_from`: the worker LIMIT 200 + ORDER BY `effective_from` doesn't tie-break. For two schedules at the same instant on the same product the last one wins (per the UPDATE-overwrite path). Pre-pilot consider rejecting create of a schedule that exactly matches another's effective_from on the same product.
- Cross-tenant work: the worker iterates every active school via `platform.school.findMany`. A slow tenant DB doesn't block the others (each tenant's tickForSchool runs in isolation, with errors caught + logged). Worth tracing the cross-tenant fan-out cost as the school count grows.

## CI parity at this commit

- API build clean (`pnpm --filter @campusos/api build`)
- Prettier format clean (`pnpm format:check`)
- log-schema lint 1016 files clean (`pnpm lint:logs`)
- Both `tenant_demo` and `tenant_test` provisioned cleanly through migration 176
- All 14 P2-29b FK constraints verified via `pg_constraint.confdeltype` readout

## Non-blocking Phase 3 carry-overs (see HANDOFF for full list)

1. RestockNotificationWorker (wishlist → notification fan-out)
2. PromotionService order-completion fan-out consumer
3. LoyaltyService auto-earn on order completion
4. Customer-facing gift card purchase flow
5. Price schedule conflict detection
6. Category tree depth cap
7. Catalogue-based requisition auto-pricing wiring on Cycle 27 RequisitionService
8. Contract amendment value cascading to committed amounts
