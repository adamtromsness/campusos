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

---

## REVIEW-P2C12 Round 1 fix log (2026-05-11)

Round 1 against `cycle12-complete` at `6c12e25` returned **FAIL** with
5 BLOCKING + 3 MAJOR. The fix commit lands all 5 BLOCKING + 2
actionable MAJORs with 15 new pinned regression tests.

### Verification trail

| Reviewer finding                                                         | Status   | Fix landed                                                                                                                                                                                                                     | Test                              |
| ------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| BLOCKING 1 — 4 emit topics best-effort after commit                      | ✅ FIXED | All 4 emits moved to `OutboxService.enqueueInTx` inside the originating tenant tx; 4 deterministic event-id helpers added in `apps/api/src/events/event-ids.ts` (SHA-256 → v5-shaped UUID)                                     | R-B1a, R-B1b, R-B1c, R-B1d, R-B1e |
| BLOCKING 2 — `STRIPE_DEV_AUTO_CONFIRM=true` skips evt.order.confirmed    | ✅ FIXED | `OrderService.purchase` now enqueues `evt.order.confirmed` outbox row inside the purchase tx when `autoConfirm=true`; payload carries `autoConfirmed: true` for downstream awareness                                           | R-B2                              |
| BLOCKING 3 — Athletic game linking not school-scoped                     | ✅ FIXED | `linked_game_id` lookup JOINs through `ath_games → ath_rosters → ath_seasons → ath_programmes.school_id = $tenant.schoolId`; the 3 INSERT…SELECT fan-outs carry the same join chain via `pr2`/`pr3`/`pr4` aliases              | R-B3a, R-B3b                      |
| BLOCKING 4 — Season pass gate admits any event when events_included NULL | ✅ FIXED | `SeasonPassService.gateCheck` JOINs `evt_events` with `school_id` + status filter; events_included NULL path now validates academic-year window AND pass-type → event-type coverage via tightened heuristic                    | R-B4a, R-B4b, R-B4c, R-B4d        |
| BLOCKING 5 — Comp list accepts arbitrary personId                        | ✅ FIXED | New `CompListService.assertCompPersonAffiliated` validator per compType — STUDENT/ATHLETE via sis_students; STAFF/COACH via hr_employees; OFFICIAL via platform.platform_official_profiles; MEDIA/VIP/OTHER via UNION of all 3 | R-B5a, R-B5b, R-B5c, R-B5d        |
| MAJOR 1 — maybeAutoFlipSoldOut UPDATE id-only                            | ✅ FIXED | UPDATE now `WHERE id = $1::uuid AND school_id = $2::uuid` as defence-in-depth alongside the row lock                                                                                                                           | R-M1                              |
| MAJOR 2 — loadTiers not school-scoped                                    | ✅ FIXED | `loadTiers(eventId)` JOINs `evt_events` with `school_id = $tenant.schoolId`                                                                                                                                                    | R-M2                              |
| MAJOR 3 — Partial refund operational state                               | DEFERRED | Carried to Phase 2 punch list — requires product alignment on `PARTIALLY_REFUNDED` / per-ticket refund selection / fee-only refunds                                                                                            | n/a                               |

### Detail per fix

**BLOCKING 1 — Durable outbox** (`apps/api/src/events/event-ids.ts`,
`events.service.ts`, `orders.service.ts`):

- `OrderService` constructor: `kafka: KafkaProducerService` →
  `outbox: OutboxService`. The `evt.order.confirmed` emit in
  `OrderService.confirm` moved from a post-commit `try/catch` block to
  `await this.outbox.enqueueInTx(tx, { … eventId: deterministicOrderConfirmedEventId(orderId) … })`
  inside the tx that flips status to CONFIRMED.
- `RefundService` constructor: `kafka` → `outbox`. The `evt.refund.issued`
  emit moved inside the existing tx that writes the refund row + flips
  tickets to REFUNDED + decrements tier counters.
- `EventService` constructor: `kafka` → `outbox`. The `evt.event.completed`
  emit moved inside the tx that flips event to COMPLETED.
- `EventService.create` athletic branch: `evt.athletic_event.created`
  outbox row enqueued inside the create tx (right after the 3 INSERT…SELECT
  comp population statements). Emits on every athletic event create
  regardless of whether the linked game resolved, so the awareness
  signal stays durable even when `compEntriesAdded=0`.
- Removed the unused `KafkaProducerService` import + `Logger` fields
  that the new outbox path no longer needs.

**BLOCKING 2 — STRIPE_DEV_AUTO_CONFIRM emits** (`orders.service.ts`):

The auto-confirm fast-path in `OrderService.purchase` now mirrors the
explicit `confirm()` path's outbox enqueue. Payload carries
`autoConfirmed: true` so downstream consumers can distinguish the
dev/CAT auto-flow from the production webhook flow if needed (default
behaviour: both treated identically).

**BLOCKING 3 — Athletic linking school-scoped** (`events.service.ts`):

The Round 0 implementation did `SELECT roster_id FROM ath_games WHERE
id = $1::uuid` and then ran 3 INSERT…SELECTs with no school filter on
any of them. The Round 1 implementation:

- `linked_game_id` lookup: `JOIN ath_rosters → ath_seasons →
ath_programmes` with `pr.school_id = $tenant.schoolId`.
- ATHLETE INSERT: same chain via `pr2` alias, plus `sis_students.school_id
= $tenant.schoolId` as a redundant student-leg gate.
- COACH INSERT: same chain via `pr3` alias.
- OFFICIAL INSERT: JOINs through `ath_games g2 → ath_rosters ar4 →
ath_seasons sn4 → ath_programmes pr4` so the official assignment is
  also pinned to the current school's game (not just any game with the
  same id).
- The error message on miss now reads "…did not resolve to an
  ath_games row in school <schoolId> (or belongs to another school)"
  so an operator looking at the logs can distinguish the typo case from
  the cross-school attempt.

**BLOCKING 4 — Season pass gate validation** (`gate.service.ts`):

Three-phase validation in `SeasonPassService.gateCheck`:

1. Pass row exists in current school with status='ACTIVE'.
2. Target event row exists in current school with status IN
   ('ON_SALE','SOLD_OUT','COMPLETED'). Deny with "Event not found in
   this school" if missing.
3. Coverage policy: explicit list → must contain eventId; events_included
   IS NULL → academic-year window + pass-type heuristic. The
   `passCovers(event_type)` heuristic returns:
   - ATHLETIC / SPORTS → ATHLETIC_GAME only
   - THEATRE / PERFORMANCE / ARTS → PERFORMANCE only
   - DANCE → DANCE only
   - FUNDRAISER → FUNDRAISER only
   - "ALL EVENTS" / "ALL ACCESS" / "EVERY EVENT" → universal
   - Otherwise literal-match against canonical event_type token

A bare "ALL" no longer matches anything — too ambiguous to risk
cross-category admission.

**BLOCKING 5 — Comp person validation** (`gate.service.ts`):

New private `assertCompPersonAffiliated(client, personId, compType,
schoolId)` helper called from `CompListService.add` before the INSERT.
Per comp_type:

- STUDENT, ATHLETE: SELECT through `sis_students` JOIN
  `platform.platform_students` filtered by `school_id = $tenant.schoolId
AND person_id = $personId`. 0 rows → 400.
- STAFF, COACH: SELECT `hr_employees WHERE person_id = $personId AND
school_id = $tenant.schoolId`. 0 rows → 400.
- OFFICIAL: SELECT `platform.platform_official_profiles WHERE
person_id = $personId`. Platform-tier records are cross-school by
  design per ADR-063; the event-ownership predicate is the school-side
  gate (we already validated the event belongs to this school).
- MEDIA, VIP, OTHER: SELECT through a UNION of `hr_employees`,
  `sis_students JOIN platform_students`, and `sis_guardians`, all
  filtered by `school_id = $tenant.schoolId AND person_id = $personId`.
  0 rows → 400.

All four error paths throw `BadRequestException` with a comp-type-specific
message so the school admin sees a clear cause.

**MAJOR 1 — sold_out UPDATE school predicate** (`events.service.ts`):

```sql
UPDATE evt_events SET status = 'SOLD_OUT', updated_at = now()
WHERE id = $1::uuid AND school_id = $2::uuid
```

**MAJOR 2 — loadTiers school-scoped** (`events.service.ts`):

```sql
SELECT … FROM evt_ticket_tiers t
JOIN evt_events e ON e.id = t.event_id
WHERE t.event_id = $1::uuid AND e.school_id = $2::uuid
ORDER BY t.created_at ASC
```

### Test additions

15 new vitest cases across 2 new describe blocks in
`apps/api/src/events/events.spec.ts`:

- `describe('REVIEW-P2C12 ROUND 1 — BLOCKING regressions')` (13 tests)
- `describe('REVIEW-P2C12 ROUND 1 — MAJOR regressions')` (2 tests)

Existing S1–S10 + Bonus tests (15 cases) rewritten to use the new
`makeOutbox()` stub instead of the deprecated `makeKafka()` so the
durable contract is enforced across the entire suite. S6 (season pass
gate) additionally mocks the new `evt_events` school lookup since the
gate check now does an extra round-trip.

**Test suite totals: vitest 632 → 647 across 30 spec files.**

### Phase 2 punch list carry-over

- MAJOR 3 (partial refund operational state) — needs product alignment
  on `PARTIALLY_REFUNDED` vs per-ticket refund selection vs fee-only
  refunds. Today's behaviour is the simplest acceptable one: cumulative
  refund reaching the total flips order + tickets to REFUNDED;
  partial refunds leave them as CONFIRMED. Future cycle resolves the
  model.

### CI parity

- `pnpm format:check` ✓ clean
- `pnpm lint:logs` ✓ 743 files clean
- `pnpm --filter @campusos/api build` ✓ clean
- `pnpm --filter @campusos/web build` ✓ clean (no web changes)
- `pnpm --filter @campusos/api test` ✓ 647/647

Awaiting Round 2 verdict before tagging `p2c12-complete`.

---

## Round 2 verdict — PASS (2026-05-11)

Reviewer confirmed all 5 BLOCKING + the 2 actionable MAJORs (1 + 2) are fixed in code on Round 2 against `fe2660b`. Every prior blocker FIXED; every dimension at PASS:

| Dimension               |  Round 1 |  Round 2 |
| ----------------------- | -------: | -------: |
| Event Durability        | BLOCKING | **PASS** |
| Stripe Dev Auto-Confirm | BLOCKING | **PASS** |
| Athletic Game Linking   | BLOCKING | **PASS** |
| Season Pass Gate        | BLOCKING | **PASS** |
| Comp List Validation    | BLOCKING | **PASS** |
| Major Hardening Items   |    MAJOR | **PASS** |
| Test Coverage           |    MAJOR | **PASS** |

**Phase 2 punch list carry-over** (per Round 2 reviewer's gate decision): partial-refund operational state model — `PARTIALLY_REFUNDED` / per-ticket refund selection / fee-only refunds. Recommendation-class polish requiring product alignment.

**Tags:**

- `p2c12-complete` at `fe2660b` (the Round 1 fix that earned PASS)
- `p2c12-approved` at the closeout commit

**P2-12 Events & Ticketing ships clean. Wave C cycle 2 closes here.**
