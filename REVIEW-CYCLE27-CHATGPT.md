# REVIEW-CYCLE27-CHATGPT

**Cycle:** 27 — Procurement (M86, Wave 6 continuation cycle).
**Round 1 verdict:** Reject pending fixes — 5 BLOCKING + 4 MAJOR.
**Round 1 commit:** `cycle27-complete` (`3826df0`).
**Round 1 fix commit:** this commit.
**Live verification:** `tenant_demo` 2026-05-06.

## Triage table

| #          | Class        | Title                                                          | Disposition                                                                                                                  |
| ---------- | ------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| BLOCKING 1 | Validity     | Requisition soft refs (`budgetLineId`, `preferredVendorId`)    | Fixed — `FinanceValidationService.assertBudgetLineInCurrentTenant` + `.assertActiveSupplier` applied to create + addLine     |
| BLOCKING 2 | Validity     | PO source-line + GL validation                                 | Fixed — requisition state must be ADMIN/DISTRICT_APPROVED, requisition_line_id must belong, gl_account_id must be EXP/AS/LIA |
| BLOCKING 3 | Bug          | Vendor performance counts receipts as orders                   | Fixed — total_orders bumps once per PO (first receipt only); on_time/late only on final receipt                              |
| BLOCKING 4 | Concurrency  | Return creation concurrent over-returns                        | Fixed — `SELECT … FROM prc_goods_receipt_lines rl … FOR UPDATE OF rl` + re-read inside the locked tx                         |
| BLOCKING 5 | Validity     | Procurement settings validation                                | Fixed — prefix shape regex, length cap, non-blank trim, cross-field `requireThreeQuotesAbove >= autoPoThreshold`             |
| MAJOR 6    | Architecture | Workflow engine integration deferred                           | DEVIATION-FOLLOW-UP — Cycle 7 wsk_approval_requests engine connection deferred; documented; Phase 2 backlog                  |
| MAJOR 7    | Reliability  | `prc.distribution.completed` best-effort after commit          | DEVIATION-FOLLOW-UP — matches existing CampusOS pattern; outbox once destination workers ship; Phase 2 backlog               |
| MAJOR 8    | Bug          | ORDERED cascade too permissive (DRAFT/SUBMITTED also promoted) | Fixed — cascade tightened to ADMIN_APPROVED/DISTRICT_APPROVED only                                                           |
| MAJOR 9    | Robustness   | `GREATEST(..., 0)` clamp on encumbered_amount release          | DEVIATION-FOLLOW-UP — schema CHECK is the safety net; pre-pilot raise a finance exception instead; Phase 2 backlog           |

## Verification trail (live on `tenant_demo` 2026-05-06)

### BLOCKING 1 — soft-ref validation

Bogus `budgetLineId` returns the friendly 400; bogus `lines[].preferredVendorId` returns the field-named 400.

```
=== BLOCKING 1a: bogus budgetLineId ===
{"message":"budgetLineId does not match a budget line in this school. Confirm the id is from an active budget.","error":"Bad Request","statusCode":400}
HTTP 400

=== BLOCKING 1b: bogus preferredVendorId on a line ===
{"message":"lines[].preferredVendorId does not match a supplier in this school.","error":"Bad Request","statusCode":400}
HTTP 400
```

### BLOCKING 2 — PO source-line + GL validation

5 paths verified: DRAFT requisition rejected, bogus glAccountId rejected, REVENUE-typed glAccountId rejected, orphan requisitionLineId rejected, standalone-PO with requisitionLineId rejected.

```
=== BLOCKING 2a: PO from DRAFT requisition ===
{"message":"Cannot create a PO from a requisition in status=DRAFT. Requisition must be ADMIN_APPROVED or DISTRICT_APPROVED before order creation.","error":"Bad Request","statusCode":400}
HTTP 400

=== BLOCKING 2b: bogus glAccountId on line ===
{"message":"lines[].glAccountId does not match a chart-of-accounts row in this school.","error":"Bad Request","statusCode":400}
HTTP 400

=== BLOCKING 2c: REVENUE-typed glAccountId rejected ===
{"message":"lines[].glAccountId (4000 Tuition Revenue) has account_type=REVENUE; expected one of EXPENSE, ASSET, LIABILITY.","error":"Bad Request","statusCode":400}
HTTP 400

=== BLOCKING 2d: requisitionLineId from a different requisition ===
{"message":"These requisitionLineId values do not belong to requisition 019dffbd-…: 019dff81-b501-…","error":"Bad Request","statusCode":400}
HTTP 400

=== BLOCKING 2e: standalone PO with requisitionLineId set ===
{"message":"Cannot supply requisitionLineId on PO lines when requisitionId is not set on the PO","error":"Bad Request","statusCode":400}
HTTP 400
```

### BLOCKING 3 — vendor performance scoring

3-receipt partial-delivery scenario on a 10-unit PO. Pre-state `(total_orders=1, on_time=1)`. Each step:

```
--- Receipt 1: 4 of 10 (partial) ---
 total_orders | on_time_deliveries | late_deliveries | accepted_count | rejected_count
            2 |                  1 |               0 |             23 |              1
(orderBump=1 for first receipt; on_time/late unchanged because PO not yet RECEIVED)

--- Receipt 2: 3 more (still partial) ---
 total_orders | on_time_deliveries | late_deliveries | accepted_count | rejected_count
            2 |                  1 |               0 |             26 |              1
(no order bump; accepted_count continues to accumulate per-line)

--- Receipt 3: final 3 (PO becomes RECEIVED) ---
 total_orders | on_time_deliveries | late_deliveries | accepted_count | rejected_count
            2 |                  2 |               0 |             29 |              1
(no order bump; on_time bumps because final receipt within expected_delivery_date)
```

`total_orders` ends at 2 (1 seed + 1 new PO). Pre-fix this would have been 4 (3 receipts × 1 = 3 added). Score formulas: `quality = 29/30 = 0.9667`; `delivery = 2/2 = 1.0`. Both formulas now compute against PO-level totals correctly.

### BLOCKING 4 — return concurrency

5 parallel POSTs (1 unit each) against a receipt line with `quantity_received=4`:

```
[1] 201 — return id 019dffbe-5578-…
[2] 400 — quantity_returned 1 exceeds remaining 0 on receipt line
[3] 201 — return id 019dffbe-557f-…
[4] 201 — return id 019dffbe-557c-…
[5] 201 — return id 019dffbe-557c-…
=== Total returned units (cap=4): 4
=== Overflow attempt: 400 — quantity_returned 1 exceeds remaining 0
```

The FOR UPDATE lock serialised the 5 calls, the 4 winners landed cleanly, the 1 loser saw the winners' rows in its post-lock recompute, and a follow-up sequential attempt also correctly hit 400.

### BLOCKING 5 — settings validation

5 paths verified:

```
=== 5a: blank prefix ===           400 "poNumberPrefix must not be blank"
=== 5b: semicolon prefix ===       400 "poNumberPrefix must contain only ASCII letters, digits, and dashes"
=== 5c: prefix length > 20 ===     400 (DTO @MaxLength)
=== 5d: cross-field threshold ===  400 "requireThreeQuotesAbove (500) must be greater than or equal to autoPoThreshold (1000)"
=== 5e: valid update ===           200, prefix becomes REQ-26
```

### MAJOR 8 — ORDERED cascade tightening

Direct SQL INSERT of DRAFT requisition + DRAFT PO + service-layer ISSUE:

```
PO status after ISSUE: ISSUED
Linked requisition status: DRAFT
```

Pre-fix the cascade would have promoted DRAFT → ORDERED. Now stays DRAFT.

## Cleanup

Tenant restored to post-Step-4 seed shape via `/tmp/cleanup-cycle27.sql`:

```
 requisitions    |     2
 purchase_orders |     1
 receipts        |     1
 distributions   |     1
 returns         |     1
 commitments     |     1
 vendor_perf row | total=1, on_time=1, accepted=9, rejected=1, qual=0.90, del=1.00
```

## Known carry-overs to Phase 2 punch list

Per the reviewer's gate decision, the 3 deferred MAJORs join the broader Wave 6 Phase 2 backlog:

1. **MAJOR 6** — Workflow engine integration on requisitions (current uses direct admin transitions; schema is wired with `approval_request_id` column for future Cycle 7 wsk_approval_requests engine connection).
2. **MAJOR 7** — `prc.distribution.completed` outbox-backed delivery (best-effort emit after commit today; once each destination module's inventory worker subscribes, this needs outbox semantics so a successful distribution can never fail to notify).
3. **MAJOR 9** — Replace `GREATEST(encumbered - amt, 0)` clamp with checked update / finance exception (schema CHECK on `encumbered_amount` non-negative is the safety net; the silent clamp can hide accounting drift).

Plus the 7 cycle-build attention items already documented in `HANDOFF-CYCLE27.md` (workflow engine integration, auto_po_threshold, require_three_quotes_above, budget remaining race, cross-module distribution consumers, vendor performance score decay, Procurement Officer role split).
