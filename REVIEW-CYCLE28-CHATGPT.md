# REVIEW-CYCLE28-CHATGPT

**Cycle:** 28 — School Store (M67, Wave 6 closeout cycle).
**Status:** Awaiting Round 1 verdict.
**Round 1 commit:** `cycle28-complete` at TBD (see git log on `main`).
**Live verification:** `tenant_demo` 2026-05-06.

---

## What this cycle ships

Cycle 28 ships the M67 School Store module — 9 new tenant `str_*` base tables across 3 migrations (092 + 093 + 094), 13 intra-tenant FKs, 0 cross-schema FKs. **Wave 6 closes here** (Cycle 26 Finance + Cycle 27 Procurement + Cycle 28 School Store form the connected commerce stack).

Five structural keystones:

1. **PARENT APPROVAL GATE (ADR-062)** — every STUDENT-type order auto-creates a `str_order_approvals` row with `status='PENDING'` inside the same tenant tx as the order INSERT; inventory is reserved but not decremented; payment is NOT charged until approval. On approve: order PROCESSING + payment CHARGED + `str.order.completed` emit. On decline: order CANCELLED + reservation released atomically. Multi-column `responded_chk` lockstep + UNIQUE(order_id) enforce the contract at the schema layer.
2. **DUAL-MODE STORE** — `str_stores.store_type` 2-value CHECK (STUDENT, PUBLIC) with UNIQUE(school_id, store_type). Three multi-column shape CHECKs on `str_orders` enforce the dual contract (`customer_shape_chk`, `student_shape_chk`, `shipping_shape_chk`).
3. **CROSS-MODULE TO Cycle 6 PAYMENTS** — `str.order.completed` envelope fires AFTER tx commit with full payload for the future M84 Family Billing consumer (Phase 2). The store never writes to `pay_*` tables directly per ADR-001/020.
4. **CROSS-MODULE TO Cycle 27 PROCUREMENT** — `str.inventory.reorder_needed` envelope fires when `quantity_on_hand` crosses to `<= reorder_point`. Delta-based dedup. Future Cycle 27 procurement consumer (Phase 2) auto-creates a `prc_requisitions` row.
5. **REVENUE MATERIALISATION (ADR-018)** — `str_store_revenue` is a periodic materialised read model. `RevenueService.materialise()` is idempotent (UPSERT on `(store_id, period_start, period_end)`).

CAT script: `docs/cycle28-cat-script.md`. Plan: `docs/campusos-cycle28-implementation-plan.html`. Handoff: `HANDOFF-CYCLE28.md`.

---

## Reviewer attention items already documented + on the punch list

These are not blockers; they are recorded so reviewers don't re-flag closed items:

1. **Public storefront order placement** — `/shop/[storeId]` registers external customers but order placement requires Stripe Checkout integration (deferred to Phase 2). The PUBLIC store demo lands the customer record + manual admin order creation today.
2. **Cycle 6 family-billing consumer for `str.order.completed`** — emit fires cleanly with the full payload contract M84 needs; the consumer in the payments module is Phase 2 work.
3. **Cycle 27 procurement consumer for `str.inventory.reorder_needed`** — emit fires cleanly; the procurement consumer that converts the emit into a `prc_requisition` is Phase 2 work.
4. **Store Manager role split** — Staff currently holds STR-001..003 read+write as the store-manager stand-in. Joins the broader role-split chain (items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 in `CLAUDE.md`).
5. **Reorder emit on the order-completion path** — order completion decrements `quantity_on_hand` directly (not via `InventoryService.adjust`), so the reorder-threshold-crossing emit fires only on the explicit admin adjust path. Pre-pilot work moves the emit to a shared helper called from both paths.
6. **Persistent shopping cart** + **product variants** + **discount codes** + **bundles** + **backorder lifecycle UX** — deferred.

---

## Reviewer prompt (paste this into ChatGPT alongside the listed files)

> You are reviewing Cycle 28 of CampusOS — the School Store module that closes Wave 6 (Finance & Commerce). The spec, plan, and verification record are all in this repo. Your job is to verify the implementation against the plan and call out any **BLOCKING** correctness/security/data-integrity issues, then any **MAJOR** robustness/architecture issues that should land before pilot.
>
> **Scope:** review the closeout commit on `main` (`HANDOFF-CYCLE28.md` calls out the SHA). Treat `CLAUDE.md` Project Status section as the authoritative summary of what shipped. Treat `docs/cycle28-cat-script.md` as the live verification record on `tenant_demo` 2026-05-06.
>
> **Files to read in order:**
>
> 1. `docs/campusos-cycle28-implementation-plan.html` — the spec.
> 2. `HANDOFF-CYCLE28.md` — final cycle summary with iteration log.
> 3. `docs/cycle28-cat-script.md` — the CAT (10 plan scenarios verified live).
> 4. `packages/database/prisma/tenant/migrations/092_str_stores_products.sql`, `093_str_orders.sql`, `094_str_external_shipping.sql` — the schema.
> 5. `packages/database/src/seed-store.ts` — the seed.
> 6. `apps/api/src/store/products.service.ts`, `apps/api/src/store/orders.service.ts`, `apps/api/src/store/revenue.service.ts`, `apps/api/src/store/store.controller.ts`, `apps/api/src/store/store.module.ts` — the backend.
> 7. `apps/web/src/hooks/use-store.ts` + `apps/web/src/lib/store-format.ts` + the routes under `apps/web/src/app/(app)/store/*` and `apps/web/src/app/shop/[storeId]/page.tsx` — the UI.
>
> **Specifically verify:**
>
> - PARENT APPROVAL GATE keystone enforces approval atomicity (locked-row + multi-column lockstep + reservation release on decline).
> - DUAL-MODE STORE — three shape CHECKs on `str_orders` actually catch every malformed combination (try mentally placing a STUDENT order with `external_customer_id` set; verify it would 23514 at the schema layer).
> - `str.order.completed` envelope is `published_at`-after-tx-commit (not inside the tx) so a Kafka outage cannot roll back the user's action.
> - `str.inventory.reorder_needed` is delta-based and does not spam at-or-below threshold.
> - Revenue materialisation is idempotent on the unique key.
> - Cross-tenant isolation: every backend service path uses `executeInTenantContext` or `executeInTenantTransaction` (no raw `prisma.$queryRaw` outside a tenant context).
> - Permission gates match the IAM seed grants. Public route `POST /shop/external-customers` uses `@Public()` correctly.
>
> **Disposition format:** for every finding, classify as BLOCKING / MAJOR / MINOR / DEVIATION-FOLLOW-UP and supply the file path + line number + before/after suggestion. Group findings by class. End with a Round 1 verdict (Approved | Reject pending fixes).

---

## Triage table (to fill in when Round 1 returns)

| #   | Class | Title | Disposition |
| --- | ----- | ----- | ----------- |

(empty until verdict lands)

---

## Verification trail (to fill in when fixes land)

(empty until Round 1 fix commit lands)
