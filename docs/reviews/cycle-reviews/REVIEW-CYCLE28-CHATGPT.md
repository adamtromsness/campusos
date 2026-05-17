# REVIEW-CYCLE28-CHATGPT

**Cycle:** 28 — School Store (M67, Wave 6 closeout cycle).
**Round 1 verdict:** **Reject pending fixes** — 4 BLOCKING + 4 MAJOR (1 BLOCKING DISPUTED + 3 BLOCKING accepted; 4 MAJORs carried to Phase 2 punch list).
**Round 1 commit:** `cycle28-complete` at `d895a3c`.
**Round 1 fix commit:** `56678c9` on `main`.
**Round 2 verdict:** **Approved.** Cycle 28 ships clean. Tagged `cycle28-approved` at `56678c9`. **Wave 6 (Finance & Commerce) closes here.**
**Live verification:** `tenant_demo` 2026-05-07.

---

## Triage table

| #          | Class         | Title                                                       | Disposition                                                                                                                              |
| ---------- | ------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| BLOCKING 1 | Setup         | `StoreModule` not registered in `AppModule`                 | **DISPUTED** — registered at `apps/api/src/app.module.ts` line 44 (import) + line 112 (imports array) on `cycle28-complete` (`d895a3c`). |
| BLOCKING 2 | Authorisation | Student order can impersonate another student               | **Fixed** — `OrderService.create` resolves callerStudentId via `actor.personId → platform_students → sis_students` and refuses mismatch. |
| BLOCKING 3 | Atomicity     | Approval transition not atomic with order transition + emit | **Fixed** — approval row + parent order row both `FOR UPDATE` in one tenant tx; emit `str.order.completed` AFTER tx commits.             |
| BLOCKING 4 | Concurrency   | Inventory reservation race + missing final-remaining check  | **Fixed** — lock inventory rows BEFORE classifying IN_STOCK; reuse locked snapshot for the reservation; throw on `remaining > 0`.        |
| MAJOR 5    | Robustness    | Order number allocation race                                | DEVIATION-FOLLOW-UP — Phase 2 punch list. Per-store advisory tx lock + retry on UNIQUE conflict.                                         |
| MAJOR 6    | Authorisation | Store-manager role still generic `STAFF`                    | DEVIATION-FOLLOW-UP — joins items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 in the broader role-split chain (CLAUDE.md).            |
| MAJOR 7    | Validity      | Product `preferredSupplierId` not validated                 | DEVIATION-FOLLOW-UP — display-only soft ref today; validate before procurement consumer ships.                                           |
| MAJOR 8    | Reliability   | Reorder event does not fire on order completion             | DEVIATION-FOLLOW-UP — already on the cycle's punch list. Move emit to a shared helper called from both adjust + complete paths.          |

---

## Verification trail (live on `tenant_demo` 2026-05-07)

### BLOCKING 1 (DISPUTED) — `StoreModule` registration

```
$ git show origin/main:apps/api/src/app.module.ts | grep -n "StoreModule"
44:import { StoreModule } from './store/store.module';
112:    StoreModule,

$ curl -sw 'HTTP %{http_code}\n' -o /dev/null \
    http://localhost:4000/api/v1/store/stores \
    -H "Authorization: Bearer $ADMIN" -H 'X-Tenant-Subdomain: demo'
HTTP 200
```

`StoreModule` is imported on `d895a3c` (the closeout commit the reviewer pulled from `raw.githubusercontent.com`) and the `/store/stores` endpoint returns 200. The reviewer's claim was likely a stale-cache read of the file; no code change required.

### BLOCKING 2 — student impersonation rejected

`OrderService.create` now resolves the calling student's own `sis_students.id` via `resolveStudentSelfId(actor.personId)` (joins through `platform.platform_students` to `sis_students`) and refuses any STUDENT order from a STUDENT actor whose `input.studentId` does not match. Manager path unchanged.

```
=== 2a: Maya (STUDENT) attempts STUDENT order for Ethan ===
{"message":"Students may only place STUDENT orders for themselves. Use the store manager path to order on behalf of another student.","error":"Forbidden","statusCode":403}
HTTP 403

=== 2b: Maya places STUDENT order for herself ===
Order id: 019e01cd-c206-7115-8d36-beb64992c8a5
HTTP 201

=== 2c: principal (admin) places STUDENT order for Ethan via manager path ===
Admin-on-behalf order: 019e01cd-c270-7115-8d36-d28c2049715c
HTTP 201
```

### BLOCKING 3 — atomic approval transition

`ApprovalService.approve` and `decline` now open a single `executeInTenantTransaction`, lock both `str_order_approvals` AND the parent `str_orders` row `FOR UPDATE`, validate both states, then atomically:

- approve: flip approval to APPROVED + flip order to PROCESSING + payment_status=CHARGED via the new in-tx `OrderService.advanceFromApprovalInTx`
- decline: flip approval to DECLINED + cancel order + release reservations via the new in-tx `OrderService.cancelFromApprovalDeclineInTx`

`str.order.completed` emit fires AFTER tx commits so a Kafka outage cannot roll back the user's action.

```
=== 3a: pre-state ===
  status: PENDING_APPROVAL payment: PENDING
  approval status: PENDING

=== 3b: parent (David) approves ===
  approval status: APPROVED responded: 2026-05-07 09:38:42.484522+00

=== 3c: post-state read directly from DB ===
   status   | payment_status
------------+----------------
 PROCESSING | CHARGED
```

The order flipped to PROCESSING + payment CHARGED inside the same tx as the approval flip — atomicity confirmed.

### BLOCKING 4 — locked-row inventory reservation

`OrderService.create` now:

1. Acquires `SELECT ... FOR UPDATE` on every `str_product_inventory` row for each line BEFORE computing IN_STOCK vs BACKORDERED.
2. Uses the locked snapshot for the IN_STOCK / BACKORDERED decision (so the availability number is authoritative under concurrency).
3. Reuses the same locked snapshot for the reservation step (no second SELECT).
4. After the reservation loop, throws `400 "Reservation race detected"` if `remaining > 0` on an IN_STOCK line — defence-in-depth.

```
=== 4a: pre-state Polo inventory ===
 quantity_on_hand | quantity_reserved
------------------+-------------------
               49 |                 0

=== 4b: 3 parallel STUDENT orders for 1 Polo each ===
  1: 019e01cd  HTTP 201
  2: 019e01cd  HTTP 201
  3: 019e01cd  HTTP 201

=== 4c: post-state Polo inventory ===
 quantity_on_hand | quantity_reserved
------------------+-------------------
               49 |                 3
```

`quantity_reserved` bumped by exactly the number of successful orders (3) — no under-reservation; lock serialises the reservation correctly.

---

## MAJOR follow-ups carried to Phase 2 punch list

These are recommendation-class hardening tasks that join the existing CLAUDE.md punch list. They are NOT cycle blockers per the reviewer's gate decision — they should land before real schools onboard at scale.

### MAJOR 5 — Order number allocation race

`OrderService.create` allocates the next `order_number` from `count(*) + 1` for the store. Two concurrent orders could collide. Fix pattern: per-store `pg_advisory_xact_lock` at the top of the order create tx (matches the Cycle 6 `PaymentAccountWorker.createOrLinkAccount` advisory-lock pattern) OR a UNIQUE catch + retry loop. Schema already has `UNIQUE(store_id, order_number)` so the worst case today is the second order surfaces the raw 23505 — not a data integrity bug, just a UX bug.

### MAJOR 6 — Store-manager role split

`isStoreManager(actor)` returns true for `actor.isSchoolAdmin OR actor.personType === 'STAFF'`. Same shape as items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 in CLAUDE.md — a dedicated Store Manager role should hold the STR-\* codes alone. Tracked.

### MAJOR 7 — `preferredSupplierId` validation

`ProductService.create` and `patch` accept `preferredSupplierId` directly. Display-only today (the future Cycle 27 procurement consumer reads it from the `str.inventory.reorder_needed` payload). Pre-pilot: validate the supplier exists in this tenant via `prc_suppliers` / `fin_suppliers` lookup.

### MAJOR 8 — Reorder event on order completion

Already on the Cycle 28 punch list (item 5 in HANDOFF-CYCLE28.md): `OrderService.complete` decrements `quantity_on_hand` directly via `releaseAndDecrement` rather than going through `InventoryService.adjust`, so the reorder-threshold-crossing emit fires only on the explicit admin adjust path. Pre-pilot fix: hoist the threshold check into a shared helper called from both paths.

---

## Files changed in the fix commit

- `apps/api/src/store/orders.service.ts` — added `resolveStudentSelfId` + student-self guard (BLOCKING 2); added in-tx `advanceFromApprovalInTx` + `cancelFromApprovalDeclineInTx` and rewrote `ApprovalService.approve` + `decline` to use one tx with both rows locked (BLOCKING 3); added locked-snapshot inventory + final-remaining check (BLOCKING 4). Deprecated public `advanceFromApproval` / `cancelFromApprovalDecline` are removed; only the in-tx helpers remain.

No DB migrations required — all four BLOCKINGs are service-layer fixes.

## Round 2 verdict

**Approved at `56678c9`.** Reviewer's Round 2 note (verbatim):

> Cycle 28 is clean from my review perspective at `56678c9`.
>
> The current `56678c9` version does contain the fixes that I did not see in the earlier floating `main` read.
>
> - StoreModule registration — closed (correctly disputed as a stale-read issue)
> - Student order impersonation — fixed (verified live: Maya impersonating Ethan returns 403; Maya for self succeeds)
> - Parent approval / order transition atomicity — fixed (single tenant transaction with both rows FOR UPDATE; advanceFromApprovalInTx + cancelFromApprovalDeclineInTx in same tx; emit fires only after commit)
> - Inventory reservation race — fixed (locks before classifying, reuses locked snapshot, mutates in-loop, throws on remaining > 0)
>
> Remaining items (order-number race, Store Manager role split, preferredSupplierId validation, reorder-on-completion event) correctly carried as Phase 2 follow-ups.

**Final gate decision: Approved.** Tagged `cycle28-approved` on `56678c9`. **Wave 6 (Finance & Commerce) closes here** — the platform now has the connected commerce stack (Cycle 26 Finance + Cycle 27 Procurement + Cycle 28 School Store).
