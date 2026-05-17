# Phase 2 Cycle 12 — Events & Ticketing (M101)

**Status:** COMPLETE + APPROVED at the closeout commit (Round 2 PASS, 2026-05-11).
**Wave:** C (Operational Depth).
**Plan:** `docs/campusos-p2c12-events-ticketing.html`.
**Sub-cycles:**

- P2-12a (schema + seed + backend services) at `52e3d5a`
- P2-12b (UI + tests + Stripe stub + athletic linking + revenue + GL) at `6c12e25`
- Round 1 fix (5 BLOCKING + 2 actionable MAJORs, 15 new regression tests) at `fe2660b` — tagged `p2c12-complete`
- Closeout (this commit) — tagged `p2c12-approved`

**Round 2 verdict:** PASS. Every prior blocker FIXED in code; every dimension at PASS
(Event Durability / Stripe Dev Auto-Confirm / Athletic Game Linking / Season Pass Gate /
Comp List Validation / Major Hardening Items / Test Coverage). One non-blocking carry-over
to Phase 2 / pre-pilot: partial-refund operational state model — recommendation-class polish
requiring product alignment on `PARTIALLY_REFUNDED` / per-ticket refund selection / fee-only refunds.

---

## Final totals

| Dimension                       | Count                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New tenant base tables          | **9** (`evt_*` prefix)                                                                                                                                          |
| Tenant logical base table count | 645 → **654**                                                                                                                                                   |
| Tenant migrations               | 2 (`140_evt_events_orders.sql`, `141_evt_scans_passes.sql`)                                                                                                     |
| Intra-tenant FKs                | 8 (5 CASCADE on order/event children + 1 RESTRICT on tickets → tiers + 2 CASCADE on comp/volunteer)                                                             |
| Cross-schema FKs                | 0 (every cross-module ref is soft per ADR-001/020)                                                                                                              |
| Partition leaves                | 25 monthly partitions of `evt_ticket_scans` (2025-08 → 2027-08)                                                                                                 |
| Backend services                | **8** (Event / Tier / Order / Refund / GateScan / SeasonPass / CompList / Volunteer) + **1 worker** (OrderExpiryWorker) + **1 read-only** (EventRevenueService) |
| Endpoints                       | **30** under `/api/v1/events/*` (28 from P2-12a + 2 new revenue endpoints)                                                                                      |
| Kafka emit topics               | **4** (`evt.order.confirmed`, `evt.refund.issued`, `evt.event.completed`, `evt.athletic_event.created`)                                                         |
| GLConsumer subscriptions added  | 2 (`evt.event.completed`, `evt.refund.issued`)                                                                                                                  |
| Web routes                      | **7** under `/events/*` (calendar, buy, my-tickets, gate, admin, admin/[id], admin/revenue)                                                                     |
| React Query hooks               | **31** in `apps/web/src/hooks/use-events.ts`                                                                                                                    |
| App tile                        | 1 (`Events`, `TicketIcon`, gated on `evt-001:read`)                                                                                                             |
| Vitest spec count               | 618 → **632** (+14 new in `events/events.spec.ts`)                                                                                                              |
| Permission codes                | `EVT-001` + `ATH-010` already in catalogue from P2-12a Step 3                                                                                                   |

---

## What ships

### Schema (P2-12a — already in repo at `52e3d5a`)

Migration `140_evt_events_orders.sql` (5 tables):

- **`evt_events`** — School event header. 8-value `event_type` CHECK
  (ATHLETIC_GAME / PERFORMANCE / DANCE / FUNDRAISER / GRADUATION /
  ASSEMBLY / COMMUNITY / OTHER). 5-value `status` lifecycle (DRAFT →
  ON_SALE → SOLD_OUT → COMPLETED → CANCELLED). `total_tier_quantity` is
  denormalised — the service layer maintains it inside every tier write
  tx because the tenant provisioner SQL splitter cuts on every `;` and
  cannot host a DB trigger body. The CHECK constraint
  `evt_events_venue_capacity_chk` (`total_capacity IS NULL OR
total_tier_quantity <= total_capacity`) is the schema-side
  belt-and-braces. `linked_game_id` is a soft ref to `ath_games`.
  `venue_id` is a soft ref to `fac_spaces`.

- **`evt_ticket_tiers`** — Per-event ticket pricing tier. **ATOMIC SALE
  KEYSTONE** — `UPDATE evt_ticket_tiers SET quantity_sold = quantity_sold

* $qty WHERE id = $tier_id AND quantity_sold + $qty <= quantity`.
Zero rows matched equals 409 Sold Out. Column-level `sold_chk`
(`quantity_sold >= 0 AND quantity_sold <= quantity`) is the schema-side
invariant. Partial INDEX on `(event_id, sale_starts_at, sale_ends_at)
  WHERE is_active = true` for the on-sale-now filter.

- **`evt_orders`** — Per-purchase order. 4-value status lifecycle
  (PENDING → CONFIRMED → CANCELLED → REFUNDED). PENDING orders carry
  `expires_at` and are swept every 5 minutes by `OrderExpiryWorker`.
  Multi-column `confirmed_chk` plus `cancelled_chk` lockstep enforces
  timestamp consistency with status.

- **`evt_tickets`** — Per-ticket QR code holder. `qr_code_token TEXT
NOT NULL UNIQUE` is the scannable identifier (48 hex chars via
  `crypto.randomBytes(24).toString('hex')`). **ATOMIC GATE SCAN
  KEYSTONE** — `UPDATE evt_tickets SET status='USED', scanned_at=now()
WHERE qr_code_token=$1 AND status='VALID'`. Zero rows matched means
  already used or invalid token. Multi-column `scanned_chk` keeps
  `scanned_at` populated only when status='USED'.

- **`evt_refunds`** — Per-refund audit. `refund_amount > 0`,
  `reason TEXT NOT NULL` (admin must justify every refund). On INSERT
  the `RefundService` flips parent order to REFUNDED + linked tickets
  to REFUNDED + decrements `tier.quantity_sold` for each ticket — all
  inside one tenant tx. Emits `evt.refund.issued` for the Cycle 26
  GLConsumer.

Migration `141_evt_scans_passes.sql` (4 tables):

- **`evt_ticket_scans`** — Gate audit log. Every scan attempt logged
  regardless of result. 4-value `scan_result` CHECK (VALID,
  ALREADY_SCANNED, INVALID, EXPIRED). RANGE-partitioned by `scanned_at`
  monthly across 25 partitions (2025-08 → 2027-08). Composite PK
  `(id, scanned_at)` because the partition column must appear in the
  unique constraint.

- **`evt_season_passes`** — Multi-event admission pass. 3-value status
  CHECK (ACTIVE, EXPIRED, REVOKED). `events_included UUID[]` — NULL =
  all events of the matching type. INDEX(school_id, person_id,
  academic_year) backs the per-person gate look-up.

- **`evt_comp_lists`** — Complimentary entry list. 8-value `comp_type`
  CHECK (ATHLETE, COACH, OFFICIAL, MEDIA, STAFF, STUDENT, VIP, OTHER).
  UNIQUE(event_id, comp_type, person_id) so a person cannot appear twice
  under the same comp type for the same event, but the same person can
  appear under different types (e.g. ATHLETE + STUDENT).

- **`evt_volunteers`** — Volunteer sign-up. 3-value status
  (SIGNED_UP / CONFIRMED / CANCELLED). UNIQUE(event_id, person_id)
  prevents duplicates.

### Seed (P2-12a)

`seed-events.ts` (idempotent, gated on `evt_events` row count for the
demo school) — 2 events (Spring Musical, Varsity Basketball), 5 tiers,
4 orders covering all 4 status states, 8 tickets, 1 refund, 10 scans,
1 season pass, 5 comp entries, 3 volunteers. Wired as `seed:events` and
into `seed-all.ts`.

### Backend services (P2-12a)

8 services in `apps/api/src/events/`:

1. **`EventService`** — event CRUD, status transitions, auto-flip
   ON_SALE → SOLD_OUT when all tiers are full, `complete()` emits
   `evt.event.completed` for GLConsumer. **Step 9 addition**: ATHLETIC_GAME
   events with `linked_game_id` auto-populate the comp list from
   `ath_roster_members` (ATHLETE), `ath_coaching_assignments` (COACH),
   and `ath_official_assignments` (OFFICIAL) inside the same tenant tx.
2. **`TierService`** — tier create/patch; ConflictException on the
   schema's `evt_events_venue_capacity_chk` violation.
3. **`OrderService`** — `purchase()` is **THE ATOMIC SALE KEYSTONE**.
   `confirm()` flips PENDING → CONFIRMED + emits `evt.order.confirmed`.
   `cancel()` decrements tier.quantity_sold + flips tickets CANCELLED
   inside one tenant tx. **Step 8 addition**: `STRIPE_DEV_AUTO_CONFIRM`
   env flag mirrors Cycle 6 PaymentService's CARD auto-COMPLETE
   behaviour for dev / CAT.
4. **`RefundService`** — `issue()` writes the audit row + decrements
   tier counts + flips tickets to REFUNDED + emits `evt.refund.issued`
   for the GLConsumer revenue-reversal post.
5. **`GateScanService`** — **THE ATOMIC GATE SCAN KEYSTONE**. Single
   UPDATE for the flip; follow-up read to distinguish ALREADY_SCANNED
   from INVALID; every attempt logged to `evt_ticket_scans` regardless
   of result.
6. **`SeasonPassService`** — purchase + revoke + gate check (`admitted`,
   `reason`).
7. **`CompListService`** — list, add, remove, gate check.
8. **`VolunteerService`** — sign-up, list, patch (status, check-in).

Worker: **`OrderExpiryWorker`** — polls every 5 minutes for PENDING
orders past `expires_at`, calls `OrderService.cancel(...)` for each,
decrements tier.quantity_sold via the cancel path.

### Backend additions (P2-12b)

- **`EventRevenueService`** (new, `apps/api/src/events/revenue.service.ts`):
  - `GET /events/:id/revenue` — per-event report with gross, refunds,
    net, estimated Stripe fees, orders confirmed/refunded, tickets
    sold/scanned, season pass admits, comp admits, and per-tier
    breakdown.
  - `GET /events/revenue/summary?from=&to=` — school-wide rollup by
    `event_type` for the supplied date window (default last 90 days).
- **Step 9 auto comp-list**: `EventService.create` now runs comp-list
  fan-out inside the same tenant tx as the event INSERT when
  `event_type='ATHLETIC_GAME'` and `linked_game_id` is set. Uses
  `ON CONFLICT ON CONSTRAINT evt_comp_uq DO NOTHING` so re-running
  against the same `(event, game)` pair is a no-op. Emits
  `evt.athletic_event.created` AFTER tx commits with the
  `compEntriesAdded` count.
- **Step 10 GL integration**: `apps/api/src/finance/gl.consumer.ts`
  subscribes to `evt.event.completed` and `evt.refund.issued` under the
  existing `gl-consumer` group:
  - **`evt.event.completed`** → looks up net revenue (gross − prior
    refunds) for the event, builds a balanced batch DR Cash (1000) /
    CR Fee Revenue (4100), `batchType='AUTO_PAYMENT'`,
    `sourceModule='events'`. The `fin_journal_batches.source_event_id`
    UNIQUE constraint provides Kafka redelivery idempotency.
  - **`evt.refund.issued`** → reverses the cash leg: DR Fee Revenue /
    CR Cash for the refund amount, `batchType='AUTO_REFUND'`.

### Web UI (P2-12b)

`apps/web/src/app/(app)/events/`:

| Route                   | Audience               | Purpose                                                                 |
| ----------------------- | ---------------------- | ----------------------------------------------------------------------- |
| `/events`               | Public (every persona) | Event calendar with type+status filters, tier availability, buy button  |
| `/events/[id]/buy`      | evt-001:write          | Ticket purchase flow with quantity picker per tier + total summary      |
| `/events/my-tickets`    | evt-001:read           | Parent / staff order history with QR tokens displayable for gate scan   |
| `/events/gate`          | evt-001:write          | Full-screen gate scanner with VALID/ALREADY_SCANNED/INVALID feedback    |
| `/events/admin`         | evt-001:write          | Event admin queue + New-event modal                                     |
| `/events/admin/[id]`    | evt-001:write          | Per-event detail with Tiers / Orders / Comp / Volunteers / Revenue tabs |
| `/events/admin/revenue` | evt-001:write          | School-wide revenue summary with date range + by-event-type breakdown   |

Supporting files:

- `apps/web/src/lib/events-format.ts` — label maps, pill class maps, and
  formatting helpers (`formatCurrency`, `formatEventDate`,
  `formatEventTime`, `formatDateTime`, `tierAvailabilityLabel`,
  `tierAvailabilityTone`).
- `apps/web/src/hooks/use-events.ts` — 31 React Query hooks covering
  every endpoint (events / tiers / orders / refunds / gate scan / season
  passes / comp list / volunteers / revenue).
- `apps/web/src/lib/types.ts` — ~25 new TypeScript interfaces for the
  Cycle 12 DTOs + payloads.
- `apps/web/src/components/shell/icons.tsx` — new `TicketIcon`
  (Heroicons ticket).
- `apps/web/src/components/shell/apps.tsx` — `Events` tile gated on
  `evt-001:read`.

### Tests (P2-12b — Step 7)

`apps/api/src/events/events.spec.ts` — 14 vitest cases:

| #     | Scenario                                                                    | Assertion                                                                           |
| ----- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| S1    | Atomic ticket sale issues `UPDATE … WHERE quantity_sold + $qty <= quantity` | SQL capture confirms the single-statement update fires with correct positional args |
| S2    | Tier qty=1, two simultaneous purchases — exactly one 409                    | First call succeeds, second rejects with `ConflictException` (atomic UPDATE 0 rows) |
| S3    | Tier insert that would push past `total_capacity`                           | `evt_events_venue_capacity_chk` violation surfaces as `ConflictException`           |
| S4    | OrderExpiryWorker cancel path                                               | Tier decrement + tickets CANCELLED + order CANCELLED all fire inside one tx         |
| S5    | Gate scan atomic                                                            | First scan returns VALID, second returns ALREADY_SCANNED, scan log INSERT verified  |
| S6    | Season pass `events_included` gate                                          | Listed event admits, non-listed denies, REVOKED denies                              |
| S7    | Comp list gate check                                                        | Listed person admitted with comp_type populated, non-listed denied                  |
| S8    | Full-amount refund                                                          | Tier decrement + tickets REFUNDED + order REFUNDED + `evt.refund.issued` emit fired |
| S9    | Auto SOLD_OUT flip                                                          | `UPDATE evt_events SET status='SOLD_OUT'` fires when remaining-tier count = 0       |
| S10   | Controller permission metadata                                              | `@RequirePermission` decorators pinned to `evt-001:read` / `evt-001:write`          |
| Bonus | Revenue summary aggregation                                                 | `byEventType` rows + totals correctly net gross − refunds                           |
| Bonus | Sale outside `sale_starts_at` window                                        | Purchase rejected with `BadRequestException`                                        |
| Bonus | Purchase on DRAFT event                                                     | Purchase rejected with `BadRequestException`                                        |
| Bonus | getEvent on missing event                                                   | `NotFoundException`                                                                 |

All 14 tests pass; total vitest suite: **632 / 632 passing**.

### CI parity (P2-12b)

- `pnpm format:check` ✓ clean
- `pnpm lint:logs` ✓ 742 files clean
- `pnpm --filter @campusos/api build` ✓ clean (nest build)
- `pnpm --filter @campusos/web build` ✓ clean (7 event routes ship 3.41–5.83 kB each)
- `pnpm --filter @campusos/api test` ✓ 632/632

---

## Endpoint surface (30 endpoints)

All under `/api/v1` prefix.

### Events

- `GET /events?status=&eventType=&fromDate=` — `evt-001:read`. Non-writers see ON_SALE / SOLD_OUT / COMPLETED only.
- `GET /events/:id` — `evt-001:read`.
- `POST /events` — `evt-001:write`. Body: `CreateEventDto`. Creates as DRAFT. Step 9: ATHLETIC_GAME with `linkedGameId` auto-populates comp list + emits `evt.athletic_event.created`.
- `PATCH /events/:id` — `evt-001:write`. Status transitions validated against `ALLOWED_STATUS_TRANSITIONS`.
- `POST /events/:id/complete` — `evt-001:write`. Flips status COMPLETED + emits `evt.event.completed`.

### Tiers

- `GET /events/:id/tiers` — `evt-001:read`.
- `POST /events/:id/tiers` — `evt-001:write`. Body: `CreateTierDto`. Schema-side venue_capacity_chk → 409.
- `PATCH /events/tiers/:tierId` — `evt-001:write`. Refuses quantity drop below quantity_sold.

### Orders

- `GET /events/orders?eventId=&status=&mine=` — `evt-001:read`. Non-writers row-scoped to own purchases.
- `GET /events/orders/my` — `evt-001:read`.
- `GET /events/orders/:id` — `evt-001:read`.
- `POST /events/:eventId/purchase` — `evt-001:write`. Body: `PurchaseDto`. **ATOMIC.**
- `POST /events/orders/:id/confirm` — `evt-001:write`. Stripe webhook callback. Idempotent.
- `POST /events/orders/:id/cancel` — `evt-001:write`. Decrements tier + flips tickets.

### Refunds

- `GET /events/orders/:id/refunds` — `evt-001:read`.
- `POST /events/orders/:id/refund` — `evt-001:write`. Body: `RefundOrderDto`. Emits `evt.refund.issued`.

### Gate scanning

- `POST /events/gate/scan` — `evt-001:write`. Body: `GateScanDto`. **ATOMIC.**

### Season passes

- `GET /events/season-passes` — `evt-001:read`. Writers see all; readers see own.
- `GET /events/season-passes/my` — `evt-001:read`.
- `POST /events/season-passes` — `evt-001:write`.
- `POST /events/season-passes/:id/revoke` — `evt-001:write`.
- `POST /events/gate/season-pass-check` — `evt-001:write`.

### Comp lists

- `GET /events/:id/comp-list` — `evt-001:write`.
- `POST /events/:id/comp-list` — `evt-001:write`.
- `DELETE /events/:id/comp-list/:entryId` — `evt-001:write`.
- `POST /events/gate/comp-check` — `evt-001:write`.

### Volunteers

- `GET /events/:id/volunteers` — `evt-001:read`.
- `POST /events/:id/volunteers` — `evt-001:read`. Non-writers can only sign self up.
- `PATCH /events/volunteers/:volunteerId` — `evt-001:read`. Non-writers can only cancel own.

### Revenue (P2-12b — new)

- `GET /events/:id/revenue` — `evt-001:read` (`assertReader` requires evt-001:write/admin). Per-event report.
- `GET /events/revenue/summary?from=&to=` — `evt-001:read`. School-wide rollup.

---

## Cross-module integrations

| Direction                          | Mechanism                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Events → Cycle 26 Finance (GL)** | `evt.event.completed` and `evt.refund.issued` subscribed by GLConsumer for revenue posting (Step 10). |
| **Cycle 13 Athletics → Events**    | `linked_game_id` soft FK; Step 9 auto-populates comp list from rosters / coaching / officials.        |
| **Cycle 21 Facilities → Events**   | `venue_id` soft FK to `fac_spaces` (P2-12a — display only).                                           |
| **Cycle 6 Payments (Stripe stub)** | Order purchase generates `pi_dev_evt_*` matching Cycle 6 PaymentService's `pi_dev_*` shape (Step 8).  |
| **Cycle 14 Communications**        | `evt.event.completed` event available for future notification fan-out (no consumer wired this cycle). |

---

## Out of scope / deferred

- Reserved seating (seat picker UI) — schema agnostic; tier quantity is the single concurrency primitive today.
- Multi-date recurring events (series) — schools work around with multiple `evt_events` rows linked by a future `series_id` soft ref.
- Ticket transfer between holders — refund + repurchase is the workaround.
- Waitlist for sold-out tiers — would slot into a new `evt_waitlist` table.
- Third-party ticketing platform integration (Eventbrite, etc).
- Digital wallet ticket (Apple/Google Wallet pass).
- Real Stripe API integration — `pi_dev_evt_*` and `re_dev_evt_*` are dev stubs. Production wiring lands when the Cycle 6 StripeService cycle ships.
- Per-event capacity oversell across multiple sub-events (e.g. a venue hosting two simultaneous events).
- Configurable Stripe fee model (currently hard-coded 2.9% + $0.30).

---

## Reviewer attention items

1. **Atomic ticket sale** — verify the single `UPDATE evt_ticket_tiers
SET quantity_sold = quantity_sold + $qty WHERE … AND quantity_sold +
$qty <= quantity` clause cannot be split into a SELECT-then-UPDATE
   under any code path. `orders.service.ts:313`.
2. **Schema-side belt-and-braces** — column-level
   `evt_tiers_sold_chk` plus event-level
   `evt_events_venue_capacity_chk` plus the application-layer
   `total_tier_quantity` maintenance combine to guarantee no oversell
   even under a service-layer bug.
3. **Tier total maintenance** — denormalised `total_tier_quantity` is
   maintained at the service layer (no DB trigger) because the SQL
   splitter cuts on every `;` regardless of quoting context. Verify
   every tier write path goes through `TierService.create` / `patch`
   and recomputes the parent event total inside the same tenant tx.
4. **Order expiry race** — `OrderExpiryWorker` calls
   `OrderService.cancel(orderId, …, null)` (system actor). The cancel
   path is idempotent — already-CANCELLED / REFUNDED orders short-
   circuit cleanly.
5. **Refund tier decrement only on full refund** — partial refunds
   don't touch tier.quantity_sold (the schools may want the ticket
   to remain valid). Verify this matches the product intent.
6. **Athletic comp-list fan-out** — runs inside the create tx. If
   `linked_game_id` resolves to no row, the create succeeds (the
   warn-log is the operator signal). Verify no orphan `evt_comp_lists`
   rows can land.
7. **Revenue posting on completion** — GLConsumer posts the NET
   revenue (gross − refunds), so refunds that landed pre-completion
   are netted out automatically. Refunds that land after completion
   post a separate reversing batch. Verify this matches the school's
   accounting convention.
8. **GLConsumer Fee Revenue account 4100** — assumes the canonical
   chart of accounts. Tenants that customise the chart may need a
   `fin_posting_rules` lookup (already on the Cycle 26 Phase 2 punch
   list).

---

## Git tags

- `p2c12a-complete` — P2-12a at `52e3d5a` (schema + seed + backend services).
- _(this commit)_ — P2-12 complete, awaiting peer review verdict before tagging `p2c12-complete`.
