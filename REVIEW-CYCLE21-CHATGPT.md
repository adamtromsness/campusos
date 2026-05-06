# REVIEW-CYCLE21-CHATGPT

**Round 1 verdict:** _pending peer review_ (against `cycle21-complete`).

This scaffold mirrors the Cycle 20 review template. Cycle 21 ships the M65 Facilities Management module — 16 new `fac_*` tenant base tables across 3 migrations (072 + 073 + 074), ~38 endpoints across 11 services + 1 controller, 5 Kafka emit topics, FAC-001..005 wired into `seed-iam.ts` (catalogue stays at 454 — FAC codes already in `permissions.json`), 9 web routes + 1 launchpad tile.

The vertical slice covers a full physical-plant lifecycle: FM registers Main Building → adds 12 spaces with `sch_room_id` cross-links for the 6 classrooms + gym → teacher books gym for assembly (EXCLUDE gist prevents double-booking) → FM creates REPAIR work order for leaking pipe in Room 101 → custodian Martinez logs status changes (immutable activity timeline) → FM creates "Monthly HVAC Inspection" PM plan with 6 checklist items → technician submits 5 PASS + 1 FAIL on belts → FAIL auto-creates follow-up REPAIR work order in same tenant tx → County Fire Marshal conducts annual fire inspection → outcome PASSED_WITH_CONDITIONS → 1 MAJOR violation logged (emergency exit signage, due in 30 days) → FM resolves with corrective work order link → FM assigns Martinez to Zone A MORNING + Hayes to Zone B AFTERNOON → supply inventory shows floor cleaner at 3 below threshold 5 → adjusting glass cleaner from 8 → 4 emits `fac.supply.reorder_needed` on the Kafka wire.

Three structural keystones drive the cycle:

1. **EXCLUDE gist booking conflict detection (KEYSTONE)** — `fac_space_bookings` carries `EXCLUDE USING gist (space_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status = 'CONFIRMED')`. Two CONFIRMED bookings on the same space with overlapping tstzrange windows can NEVER coexist in the database. Partial WHERE clause means CANCELLED and COMPLETED bookings drop out so a follow-up CONFIRMED on the same window is accepted. `BookingService.create` translates SQLSTATE 23P01 into a friendly 409 Conflict response. Live verified: first 201, overlapping 409, non-overlapping back-to-back via `[)` half-open tstzrange 201, cancel-and-rebook 201.
2. **Immutable work order activity timeline** — `fac_work_order_activity` is append-only at the service layer. `WorkOrderService.recordActivityInTx` is the sole writer; no UPDATE / no DELETE methods exposed. Every status transition, reassignment, and comment writes a row inside the same tenant tx with `activity_type` (4-value CHECK) + `metadata` JSONB. Mirrors Cycle 8 `tkt_ticket_activity`. Live verified: REPAIR work order has 3 activity rows in chronological order (OPEN→IN_PROGRESS / COMMENT / IN_PROGRESS→COMPLETED).
3. **PM checklist FAIL auto-creates follow-up work order** — `fac_maintenance_checklist_results` is IMMUTABLE per item once submitted (UNIQUE on `(task_id, checklist_item_id)`). When `MaintenanceTaskService.submitResults` writes a row with `passed=false`, it inserts a follow-up `fac_work_orders` row in the same tenant tx (status=OPEN, priority=MEDIUM, work_order_type=REPAIR, linked back via `follow_up_work_order_id`). Keeps the PM checklist authoritative as an immutable record while the corrective work flows through the standard work order lifecycle. Live verified: HVAC PM task with 5 PASS + 1 FAIL on belts auto-creates "HVAC belt replacement" follow-up REPAIR work order.

Cross-module touchpoints worth flagging for the reviewer:

- `fac_spaces.sch_room_id` — DISPLAY-ONLY soft ref to `sch_rooms.id` per ADR-001/020. 7 of 12 seeded spaces carry the cross-link (6 classrooms + Gymnasium).
- `fac_work_orders.tkt_ticket_id` — DISPLAY-ONLY soft polymorphic ref per ADR-033. The seed does not link any work order to a Cycle 8 ticket but the column is queryable.
- `fac_work_orders.vendor_id` — real DB-enforced FK (SET NULL) to `tkt_vendors`. Re-uses the Cycle 8 vendor catalogue.
- `fac_zone_assignments` per ADR-034 — Facilities owns where custodians work (zone assignments); HR (Cycle 4) owns when (shifts). The shift CHECK on `fac_zone_assignments` is the work-window label, not an HR shift schedule.

---

## Triage table

| #   | Severity | File | Reviewer claim | Triage | Resolution |
| --- | -------- | ---- | -------------- | ------ | ---------- |
|     |          |      |                |        |            |

_(populated when Round 1 lands)_

---

## Round 1 fixes summary

_(populated when fixes land)_

---

## Round 2 verdict

_(populated when fixes are reviewed)_

---

## Phase 2 carry-overs

_(populated as accepted DEVIATIONs are identified)_
