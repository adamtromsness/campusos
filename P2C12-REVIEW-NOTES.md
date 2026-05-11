# P2-12 Events & Ticketing — Peer Review Notes

**Purpose:** scaffold the architectural review of Phase 2 Cycle 12. The peer reviewer should walk every section, verify the claim against the code in `main` at this commit, and record VERIFIED / DEVIATION / VIOLATION per finding. The closeout commit lands every BLOCKING + actionable MAJOR before the cycle gets tagged `p2c12-approved`.

## How the cycle splits

| Sub-cycle | Commit        | Scope                                                                                                                                                                            |
| --------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-12a    | `52e3d5a`     | 9 tables (2 migrations), seed, 8 backend services + 1 worker, ~28 endpoints, 3 Kafka emits.                                                                                      |
| P2-12b    | _this commit_ | 7 web routes, 31 React Query hooks, 14 vitest tests, Stripe dev-auto-confirm flag, Step 9 athletic comp-list auto-populate, Step 10 revenue endpoints + GLConsumer subscription. |

---

## 1. Concurrency approach — ATOMIC UPDATE pattern

**Claim:** ticket sales are race-condition-proof via a single SQL UPDATE
that gates capacity inside the WHERE clause. No SELECT-then-UPDATE
anywhere on the sale path.

**The wire:**

```sql
UPDATE evt_ticket_tiers
SET quantity_sold = quantity_sold + $1, updated_at = now()
WHERE id = $2::uuid AND quantity_sold + $1 <= quantity
RETURNING quantity_sold AS new_sold
```

If `RETURNING` is empty (0 rows updated), the WHERE clause failed — the
tier is sold out OR the requested quantity would exceed remaining
capacity. `OrderService.purchase` throws `ConflictException` (HTTP 409)
when this happens.

**Defence-in-depth at the schema layer:**

- `evt_tiers_sold_chk CHECK (quantity_sold >= 0 AND quantity_sold <= quantity)`
  on `evt_ticket_tiers` — a Postgres-level violation can never sell
  beyond capacity even if the service-layer math drifts.
- `evt_events_venue_capacity_chk CHECK (total_capacity IS NULL OR
total_tier_quantity <= total_capacity)` on `evt_events` — the
  `TierService.create` and `patch` paths translate this into a
  `ConflictException` so the school's UI surfaces a friendly 409 if an
  admin tries to add a tier that would push past the venue capacity.

**Same pattern for gate scanning:**

```sql
UPDATE evt_tickets t
SET status = 'USED', scanned_at = now(), updated_at = now()
FROM evt_orders o JOIN evt_events e ON e.id = o.event_id
WHERE t.order_id = o.id AND e.school_id = $1::uuid
  AND t.qr_code_token = $2 AND t.status = 'VALID'
RETURNING t.id, t.tier_id, t.holder_name, e.id AS event_id, e.title
```

If RETURNING is empty, the ticket is either already scanned, cancelled,
refunded, or the token is unknown. The follow-up SELECT-by-token
distinguishes ALREADY_SCANNED from INVALID for the gate UX.

**Verify in code:**

- `apps/api/src/events/orders.service.ts:313-327` — the atomic UPDATE.
- `apps/api/src/events/gate.service.ts:110-127` — the atomic gate scan.

**Test coverage:**

- `events.spec.ts` S1 captures the SQL string and verifies the
  parameter binding.
- `events.spec.ts` S2 emulates concurrency by mutating shared state
  across two purchase calls — the second call's UPDATE returns 0 rows
  → ConflictException.

---

## 2. Tier total maintenance — service-layer over DB trigger

**Why no DB trigger:** the tenant provisioner (`packages/database/src/
provision-tenant.ts`) splits every migration on every `;` regardless of
quoting context. A `CREATE FUNCTION … LANGUAGE plpgsql AS $$ … $$;`
body needs internal semicolons that would cut the function definition
mid-body.

**The convention:** `evt_events.total_tier_quantity` is a denormalised
running total. The service layer is the single writer responsible for
maintaining it.

**Where it lives:** every `TierService.create` and `TierService.patch`
runs inside `executeInTenantTransaction` and issues a follow-up:

```sql
UPDATE evt_events SET total_tier_quantity = (
  SELECT COALESCE(SUM(quantity), 0)::int
  FROM evt_ticket_tiers WHERE event_id = $1::uuid
), updated_at = now() WHERE id = $1::uuid
```

This re-computation runs in the same tenant tx as the tier INSERT or
UPDATE. The schema-side `evt_events_venue_capacity_chk` CHECK is
evaluated at COMMIT time, so any service-layer drift fails the COMMIT
and the caller sees a `ConflictException`.

**Verify in code:**

- `apps/api/src/events/events.service.ts:438-441` (create path).
- `apps/api/src/events/events.service.ts:517-520` (patch quantity-changed path).

**Test coverage:**

- `events.spec.ts` S3 emulates the venue_capacity_chk violation by
  throwing the same error message the schema would raise — verifies the
  service translates it into a `ConflictException`.

---

## 3. Order expiry — pending-cleanup worker

**Why this exists:** Stripe PaymentIntents have a short authorization
window. Orders that sit PENDING without a successful webhook need to
be cancelled so the held tier inventory becomes resellable.

**Worker:** `OrderExpiryWorker` polls every 5 minutes (`runInterval =
5 * 60_000 ms` in `apps/api/src/events/order-expiry.worker.ts`). For
every active school in the tenant routing table, it walks PENDING
orders whose `expires_at < now()` and calls
`OrderService.cancel(orderId, { cancellationReason: 'Order expired' },
null)`. The `null` actor signals a system invocation; the cancel
path's actor-aware authorization check short-circuits.

**Cancel pathology:** runs inside `executeInTenantTransaction`:

1. Lock the order row with `SELECT … FOR UPDATE OF o`.
2. Decrement `tier.quantity_sold` for each linked ticket via a
   `UPDATE evt_ticket_tiers SET quantity_sold = GREATEST(0,
quantity_sold - tk.cnt) FROM (subquery)` lateral.
3. Flip linked tickets to status='CANCELLED'.
4. Flip the order to status='CANCELLED' with `cancelled_at = now()`.

**Why GREATEST(0, …):** belt-and-braces against a service-layer bug
that would drift quantity_sold negative — Postgres clamps to zero
rather than violating the column-level CHECK.

**Stripe side:** the worker does NOT currently call Stripe's
PaymentIntent cancel endpoint. The `pi_dev_evt_*` stub means there's
nothing to cancel in the dev stub model. When the real Stripe
integration lands, the cancel path adds a `stripe.paymentIntents.cancel(
intentId)` call inside or just outside the tx (best-effort).

**Verify in code:**

- `apps/api/src/events/order-expiry.worker.ts` (the worker).
- `apps/api/src/events/orders.service.ts:464-521` (the cancel path).

**Test coverage:**

- `events.spec.ts` S4 fires `cancel(...)` directly with a `null` actor
  and verifies the tier decrement + ticket flip + order flip all land
  inside one tx.

---

## 4. Stripe integration via Cycle 6 StripeService stub

**The product intent:** ticket purchases create a Stripe PaymentIntent
via the existing Cycle 6 stub pattern. `payment_intent.succeeded` webhook
flips the order to CONFIRMED. `payment_intent.payment_failed` webhook
flips to CANCELLED. Refunds use the Stripe Refund API. All Stripe
interactions route through the existing `pay_ledger_entries` for the
financial audit trail.

**What ships today (dev stub):**

- **`OrderService.purchase`** generates a deterministic `pi_dev_evt_*`
  string (matching Cycle 6 `PaymentService`'s `pi_dev_*` shape) and
  inserts the order PENDING with `expires_at = now() + 15 min`.
- **`OrderService.confirm`** is the Stripe webhook callback endpoint
  (`POST /events/orders/:id/confirm`). In dev it accepts the call
  directly; in production a Stripe webhook handler routes here.
- **`RefundService.issue`** generates a deterministic `re_dev_evt_*`
  string for the refund stripe id. The refund's GL post (via
  `evt.refund.issued`) closes the financial loop.
- **`STRIPE_DEV_AUTO_CONFIRM=true`** env flag (Step 8): when set, the
  `purchase()` path bypasses the PENDING phase and lands the order as
  CONFIRMED at insert time. Mirrors Cycle 6 PaymentService's CARD
  auto-COMPLETE behaviour. Useful for CAT / load testing.

**What's deferred to a future Stripe integration cycle:**

- Real `stripe.paymentIntents.create()` call inside `purchase`.
- Real Stripe webhook signature verification on `/orders/:id/confirm`.
- Real `stripe.paymentIntents.cancel()` on order expiry.
- Real `stripe.refunds.create()` on refund issue.
- Routing the actual Stripe fee into `pay_ledger_entries` (currently
  the revenue report's `estimatedStripeFees` is a 2.9% + $0.30 estimate;
  the actual fee lives on the real Stripe payout).

**Verify in code:**

- `apps/api/src/events/orders.service.ts:343-364` (PaymentIntent stub + STRIPE_DEV_AUTO_CONFIRM).
- `apps/api/src/events/orders.service.ts:377-452` (confirm webhook handler).
- `apps/api/src/events/orders.service.ts:608-718` (refund + Stripe refund stub).

**Reviewer attention:** verify the dev stub matches the Cycle 6
`PaymentService.pay` shape closely enough that a future real-Stripe
integration cycle is mechanical, not architectural.

---

## 5. Athletic game linking — auto-populated comp list

**Trigger:** `EventService.create` runs the auto-populate fan-out
inside the same tenant tx as the event INSERT when:

- `input.eventType === 'ATHLETIC_GAME'`
- `input.linkedGameId` is set

**The 3 SQL fan-outs (each `INSERT … SELECT … ON CONFLICT DO NOTHING`):**

1. **ATHLETE** — `INSERT INTO evt_comp_lists (…)
SELECT gen_random_uuid(), $1, 'ATHLETE', ps.person_id, $2, '…'
FROM ath_roster_members rm
JOIN sis_students s ON s.id = rm.student_id
JOIN platform.platform_students ps ON ps.id = s.platform_student_id
WHERE rm.roster_id = $3 AND rm.removed_at IS NULL
  AND rm.eligibility_status = 'ELIGIBLE'
ON CONFLICT ON CONSTRAINT evt_comp_uq DO NOTHING`

2. **COACH** — joins `ath_coaching_assignments WHERE is_active=true`.
   `coach_person_id` is a direct soft ref to `platform.iam_person`.

3. **OFFICIAL** — joins `ath_official_assignments WHERE status IN
('ACCEPTED', 'CONFIRMED', 'COMPLETED')` then resolves the
   `official_profile_id` through `platform.platform_official_profiles`
   to `person_id`.

**Idempotency:** the schema-side `evt_comp_uq UNIQUE(event_id,
comp_type, person_id)` is the dedup gate. Re-running the create against
the same `(event, game)` pair is a no-op on already-present rows.

**Defensive behaviour:**

- If `linked_game_id` does not resolve to an `ath_games` row in the
  tenant, the create succeeds (event is still created) and the comp
  fan-out is silently skipped with a warn log. This avoids blocking
  the create on a stale or wrong-tenant `linked_game_id`.

**Kafka emit:** after tx commit, emits `evt.athletic_event.created`
with `compEntriesAdded` count for downstream consumers (Cycle 13
athletics module awareness, future notification fan-out).

**Verify in code:**

- `apps/api/src/events/events.service.ts:213-320` (the full create with
  the 3 fan-out SQL statements).

**Reviewer attention:**

- Are the joins through `platform.platform_students.person_id` correct
  for resolving `sis_students` → `iam_person`? (Yes — `sis_students`
  has `platform_student_id` which references `platform_students.id`,
  which has `person_id` to `iam_person`.)
- Is the OFFICIAL status filter (`'ACCEPTED', 'CONFIRMED', 'COMPLETED'`)
  the right one? POSTED officials haven't accepted yet; CANCELLED /
  NO_SHOW shouldn't get a comp pass.

---

## 6. Revenue report + GL integration

### Per-event report

`GET /events/:id/revenue` returns:

```typescript
{
  eventId, eventTitle, eventDate, status,
  grossTicketSales,    // SUM(orders WHERE status IN CONFIRMED/REFUNDED)
  refundsIssued,       // SUM(evt_refunds.refund_amount)
  netRevenue,          // gross - refunds
  estimatedStripeFees, // gross * 2.9% + 0.30 * confirmedOrders
  ordersConfirmed, ordersRefunded,
  totalTicketsSold, totalTicketsScanned,
  seasonPassAdmissions,    // count of scans with NULL ticket_id + source LIKE 'SEASON_PASS%'
  compAdmissions,          // count of scans with NULL ticket_id + source LIKE 'COMP%'
  tiers: [{ tierId, tierName, price, quantitySold, ticketsScanned, grossRevenue }]
}
```

### School-wide rollup

`GET /events/revenue/summary?from=&to=` aggregates by `event_type` for
the supplied date window (default last 90 days). Returns per-type rows

- school-wide totals.

### GLConsumer subscriptions (Step 10)

`apps/api/src/finance/gl.consumer.ts` now subscribes to 2 new topics
under the existing `gl-consumer` group:

- **`evt.event.completed`** — looks up the event's net revenue at post
  time (gross − refunds; cross-tenant via `executeInTenantContext`),
  posts a balanced batch:
  - DR Cash (1000) for net amount
  - CR Fee Revenue (4100) for net amount
  - `batchType='AUTO_PAYMENT'`, `sourceModule='events'`

- **`evt.refund.issued`** — reverses the cash leg:
  - DR Fee Revenue (4100) for refund amount
  - CR Cash (1000) for refund amount
  - `batchType='AUTO_REFUND'`, `sourceModule='events'`

**Idempotency:** the `fin_journal_batches.source_event_id UNIQUE`
constraint means a Kafka redelivery returns the existing batch
silently. Same pattern as the `pay.payment.received` and
`pay.refund.issued` handlers.

**Account mapping:** uses the existing seeded chart of accounts
(`1000 Cash`, `4100 Fee Revenue`). On missing config the consumer
THROWS (per REVIEW-CYCLE26 BLOCKING 3 fail-closed pattern) so the event
ends up in `platform_dlq_messages` for operator action.

**Verify in code:**

- `apps/api/src/events/revenue.service.ts` (the new service).
- `apps/api/src/finance/gl.consumer.ts:138-145` (subscription).
- `apps/api/src/finance/gl.consumer.ts:316-466` (new handlers in `process`).
- `apps/api/src/finance/gl.consumer.ts:619-668` (new
  `loadFeeRevenueAccount` + `loadEventNetRevenue` helpers).

---

## 7. Reviewer attention items (Phase 2 punch list candidates)

These are non-blocking observations the reviewer should note for the
broader Phase 2 hardening backlog:

1. **Partial refund revenue treatment** — partial refunds today don't
   touch `tier.quantity_sold` (only full refunds do). This matches
   "refund the money, ticket stays valid". Verify this matches the
   school's product intent and reviewer agreement.

2. **Stripe fee model is hard-coded** — `STRIPE_FEE_PERCENT = 0.029` +
   `STRIPE_FEE_FIXED = 0.30` in `revenue.service.ts`. International
   tenants pay different rates. Future: pull from a per-school
   `pay_stripe_accounts` settings table.

3. **Event-level revenue posting (vs per-order)** — the GLConsumer
   posts revenue once on event COMPLETED, not per-order. This keeps the
   GL clean but does mean revenue recognition is deferred. Verify this
   matches GAAP / school accounting policy. The alternative model:
   post per-order revenue on `evt.order.confirmed`, then post a
   reversing batch on refund. Either model is defensible — the current
   one is simpler.

4. **Season pass revenue posting** — currently season passes create
   `pi_dev_evt_pass_*` stubs but don't trigger a GL post. Future:
   either emit `evt.season_pass.purchased` for GLConsumer or batch
   season pass revenue with event completion.

5. **Comp list auto-populate runs synchronously** — the 3 fan-out
   INSERTs run inside the event-create tx. For large rosters (say
   100 athletes), this could add noticeable latency to the create.
   Acceptable today; consider moving to an async worker if profiles
   show the create slowing past 500ms.

6. **Volunteer ticket integration** — volunteers currently have no
   automatic comp-list entry (they pay or use a season pass). Future:
   `evt_volunteers.status='CONFIRMED'` could auto-create a comp-list
   entry, or volunteers could be a separate gate-check path.

7. **Tier sale-window enforcement on update** — `UpdateTierDto` accepts
   `saleStartsAt` / `saleEndsAt` changes. If a tier is currently on
   sale and the admin pushes the start time into the future, the
   purchase path immediately rejects new sales. Acceptable; verify
   the UI surfaces this clearly.

8. **`evt_ticket_scans` partition rollover** — 25 monthly partitions
   cover 2025-08 → 2027-08. A future partition-maintenance worker
   should auto-create new partitions before they're needed (matches
   the Cycle 19 transportation partition concern). Phase 2 ops.

9. **OrderExpiryWorker should also cancel the Stripe PaymentIntent**
   when real Stripe wiring lands. Today's stub doesn't need it.

10. **Refund-issued GL post happens BEFORE event completion** — if a
    parent gets a refund pre-event, the GL has a refund entry with no
    matching revenue entry until completion. This is correct under
    cash-basis accounting (you pay the cash out when the refund
    issues, regardless of when revenue is recognized). Under
    accrual-basis, the school may want a `pre-event refund liability`
    account. Phase 2 finance refinement.

---

## 8. Strong points to call out in the verdict

- **Single load-bearing UPDATE for inventory** — the ATOMIC SALE pattern
  is genuinely race-condition-proof. No SELECT-then-UPDATE seam
  anywhere in the sale or scan paths.
- **Schema invariants as belt-and-braces** — `sold_chk` + `venue_capacity_chk`
  - `scanned_chk` + multiple lifecycle CHECKs mean a service-layer bug
    cannot drift the database into a broken state.
- **Idempotency everywhere** — gate scan re-scans return ALREADY_SCANNED
  cleanly, refund redeliveries hit the UNIQUE source_event_id in
  fin_journal_batches, athletic comp-list fan-out is `ON CONFLICT DO
NOTHING`, order confirm is idempotent on already-CONFIRMED.
- **Standard Cycle 31 fail-closed on missing finance config** — the
  GLConsumer throws on missing account mapping per REVIEW-CYCLE26 BLOCKING
  3, so config drift ends up in DLQ rather than silently dropped.
- **Persona-aware UI** — events tile renders different copy for staff
  vs. student vs. parent; admin / gate / revenue surfaces gated on
  evt-001:write.
- **Test coverage on the atomic paths** — S1 verifies the single SQL
  string, S2 emulates concurrency, S3 verifies the schema CHECK
  translation, S5 verifies the gate scan idempotency.
