# Cycle 21 Handoff — Facilities Management

**Status:** Cycle 21 **IN PROGRESS** — Wave 4 (Campus Operations) cycle 3. Cycle 21 ships the M65 Facilities Management module — 16 of the 37 ERD tables in scope (21 deferred to Cycle 21.1: detailed cleaning route tracking, supply transactions + stocktakes, work order attachments + parts, fire drills, facilities asset lifecycle, energy / utility tracking, space utilisation analytics). The Facilities Manager (FM) is the **eighth specialist operator persona** after the nurse, counsellor, librarian, athletic director, enrolment officer, transportation coordinator, and food service manager.

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle21-implementation-plan.html`
**Vertical-slice deliverable:** FM registers Main Building (3 floors, built 2005) → adds 12 spaces (classrooms, gym, cafeteria, corridors) with `sch_room_id` cross-links for the 6 classrooms → teacher books the gym for a Grade 5 assembly (conflict detection via EXCLUDE gist prevents double-booking) → FM creates a REPAIR work order for a leaking pipe in Room 101, assigns Custodian Martinez, priority=HIGH → Martinez logs STATUS_CHANGE to IN_PROGRESS (immutable activity row) → completes the work order → FM creates a "Monthly HVAC Inspection" preventive maintenance plan with a 6-item checklist → generates a task for May → technician completes 5 PASS + 1 FAIL → FAIL auto-creates a follow-up work order → County Fire Marshal conducts annual fire inspection → outcome PASSED_WITH_CONDITIONS → 1 MAJOR violation logged (emergency exit signage, due in 30 days) → FM creates corrective work order linked to the violation → FM assigns Custodian Martinez to Zone A (Main Building ground floor) for the MORNING shift → supply inventory shows floor cleaner at 3 units (below reorder threshold 5) → `fac.supply.reorder_needed` emits.

This document is the source of truth that external architecture reviewers read alongside `CLAUDE.md`.

---

## Step status

| Step | Title                                        | Status   |
| ---- | -------------------------------------------- | -------- |
| 1    | Buildings + Spaces + Bookings Schema         | Complete |
| 2    | Work Orders + Preventive Maintenance Schema  | Complete |
| 3    | Inspections + Zones + Supply Schema          | Complete |
| 4    | Seed Data + FAC-001..005 IAM grants          | Complete |
| 5    | Buildings + Spaces NestJS Module             | Complete |
| 6    | Work Orders + PM NestJS Module               | Complete |
| 7    | Inspections + Zones + Supply NestJS Module   | Complete |
| 8    | Facilities UI — Buildings + Work Orders + PM | Complete |
| 9    | Facilities UI — Inspections + Zones + Supply | Complete |
| 10   | Vertical Slice Integration Test              | Complete |

---

## What this cycle adds on top of Cycle 20

**Greenfield — clean `fac_*` namespace.** Cycle 21 ships the entire M65 Facilities Management core from scratch.

- **16 new tenant base tables** across 3 migrations (072 + 073 + 074). Tenant base table count after Cycle 20 was 279 → **295** after Cycle 21.
- **1 new backend module** (FacilitiesModule) with ~11 services + 1 controller + ~38 endpoints under `fac-001:read/write/admin` through `fac-005:read/write/admin`.
- **5 new Kafka emit topics**: `fac.work_order.created`, `fac.maintenance_task.overdue`, `fac.inspection.failed`, `fac.inspection_violation.overdue`, `fac.supply.reorder_needed`.
- **9+ new web routes**: `/facilities` dashboard, `/facilities/buildings/[id]` browser, `/facilities/bookings` calendar, `/facilities/work-orders` Kanban board, `/facilities/pm` PM dashboard, `/facilities/inspections` log, `/facilities/violations` tracker, `/facilities/zones` manager, `/facilities/supply` inventory.
- **5 new permission codes**: `FAC-001` (Building + Space Management), `FAC-002` (Preventive Maintenance), `FAC-003` (Custodial Zones), `FAC-004` (Compliance Inspections), `FAC-005` (Energy / Sustainability — schema-ready, deferred). Will be added to `permissions.json`. Catalogue: 454 → **459** (153 functions × 3 tiers).

**Three structural keystones for the cycle:**

1. **EXCLUDE gist booking conflict detection (KEYSTONE).** `fac_space_bookings` carries the schema-level `EXCLUDE USING gist (space_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status = 'CONFIRMED')` constraint. Two CONFIRMED bookings for the same space with overlapping time windows can NEVER coexist in the database — enforced by PostgreSQL's btree_gist extension. The Step 5 BookingService translates the `23P01` SQLSTATE into a friendly 409 Conflict response. This is the **first schema-level temporal overlap prevention in CampusOS** outside the Cycle 5 timetable EXCLUSIONs.
2. **Immutable work order activity timeline.** `fac_work_order_activity` is append-only at the service layer (only `WorkOrderService.recordActivity` writes; no UPDATE / no DELETE methods exposed). Every status transition, reassignment, and comment writes a row inside the same tenant tx with `activity_type` (4-value CHECK) + `metadata` JSONB. This mirrors the Cycle 8 `tkt_ticket_activity` immutability pattern.
3. **PM checklist FAIL auto-creates follow-up work order.** `fac_maintenance_checklist_results` is IMMUTABLE per item once submitted (UNIQUE on `(task_id, checklist_item_id)`). When the Step 6 `MaintenanceTaskService.submitResults` writes a row with `passed=false`, it inserts a follow-up `fac_work_orders` row in the same tenant tx — Status=OPEN, Priority=MEDIUM, work_order_type=REPAIR, linked back to the parent task via metadata. The follow-up flow keeps the PM checklist authoritative (immutable record of what was inspected) while the corrective work flows through the standard work order lifecycle.

**Existing-system touchpoints:**

- `sch_rooms(id)` — DISPLAY-ONLY soft ref on `fac_spaces.sch_room_id`. Links the facilities-side space record to the scheduling-side classroom record so the timetable + booking calendar can resolve names + amenities consistently. Nullable (only the 6 classroom spaces carry it).
- `tkt_tickets(id)` — DISPLAY-ONLY soft ref on `fac_work_orders.tkt_ticket_id` per ADR-033. When a Cycle 8 reactive ticket escalates into a proactive facilities work order, the cross-link surfaces the ticket on the work order detail. Nullable (most work orders are FM-initiated, not ticket-originated).
- `tkt_vendors(id)` — DB-enforced FK on `fac_work_orders.vendor_id` (nullable). Re-uses the Cycle 8 vendor catalogue rather than duplicating it.
- `hr_employees(id)` — soft refs on `fac_work_orders.assigned_to_id`, `fac_preventive_maintenance_tasks.assigned_to`, `fac_zone_assignments.employee_id`, `fac_inspection_violations.resolved_by`. Per ADR-034: HR owns when staff work; Facilities owns where they're assigned.
- `iam_person(id)` — soft refs on `fac_space_bookings.booked_by`, `fac_space_closures.created_by`, `fac_work_order_activity.actor_id` (the audit identity for every timeline entry).

What does not change: every existing module continues to function. Cycle 21 is purely additive on a clean `fac_*` namespace with the documented cross-links to `sch_rooms` (Cycle 5), `tkt_tickets`+`tkt_vendors` (Cycle 8), and `hr_employees` (Cycle 4).

---

## Step 1 — Buildings + Spaces + Bookings Schema (complete)

**Migration:** `packages/database/prisma/tenant/migrations/072_fac_buildings_spaces.sql`. 4 logical base tables. **Slot 072 because 067-071 are taken** (Cycle 19 used 064-067, Cycle 20 used 068-071).

- `fac_buildings` — `school_id UUID NOT NULL`, `name TEXT NOT NULL`, `code TEXT`, `year_built INT`, `total_floors INT`, `address TEXT`, `is_active BOOLEAN DEFAULT true`. UNIQUE(school_id, name). INDEX(school_id, is_active).
- `fac_spaces` — `building_id UUID FK NOT NULL` (CASCADE on building delete), `name TEXT NOT NULL`, `floor TEXT`, 11-value `space_type` CHECK (CLASSROOM, BATHROOM, CORRIDOR, STAIRWELL, MECHANICAL, STORAGE, OFFICE, GROUNDS, COMMON_AREA, GYM, CAFETERIA, OTHER), `area_sqft NUMERIC(8,1)`, `is_active BOOLEAN DEFAULT true`, `sch_room_id UUID` nullable (DISPLAY-ONLY soft ref to `sch_rooms.id`). UNIQUE(building_id, name). INDEX(building_id, space_type, is_active).
- `fac_space_bookings` — `space_id UUID FK NOT NULL` (NO ACTION refusing space delete with bookings; admin must cancel bookings first), soft `booked_by UUID NOT NULL` to `iam_person`, `title TEXT NOT NULL`, `starts_at TIMESTAMPTZ NOT NULL`, `ends_at TIMESTAMPTZ NOT NULL`, 3-value `status` CHECK (CONFIRMED, CANCELLED, COMPLETED), `notes TEXT`, multi-column `time_chk` requires `ends_at > starts_at`. **`EXCLUDE USING gist (space_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status = 'CONFIRMED')`** — the schema-level keystone. INDEX(space_id, starts_at).
- `fac_space_closures` — `school_id UUID NOT NULL`, `space_id UUID FK NOT NULL` (CASCADE), `closure_reason TEXT NOT NULL`, `starts_at TIMESTAMPTZ NOT NULL`, `ends_at TIMESTAMPTZ` nullable (null = indefinite), `affects_scheduling BOOLEAN DEFAULT true`, `linked_work_order_id UUID` nullable (soft to `fac_work_orders` since that table doesn't exist yet at Step 1), soft `created_by UUID NOT NULL` to `iam_person`. INDEX(space_id, starts_at). Partial INDEX `(school_id, ends_at) WHERE ends_at IS NULL OR ends_at > now()` for the active-closure dashboard hot path.

**4 new intra-tenant DB-enforced FKs**: 1 CASCADE (`fac_spaces.building_id → fac_buildings`), 1 NO ACTION (`fac_space_bookings.space_id → fac_spaces`), 1 CASCADE (`fac_space_closures.space_id → fac_spaces`), 1 implicit on the bookings space FK matching the EXCLUDE constraint. **0 cross-schema FKs.**

**`btree_gist` extension** required for the bookings EXCLUDE constraint. The Cycle 5 timetable migration (`016_sch_timetable_and_bookings.sql`) already enables it via `CREATE EXTENSION IF NOT EXISTS btree_gist` so the dependency is already present in every tenant; Cycle 21 doesn't need to re-create it but the migration includes the IF NOT EXISTS guard for first-time provisions.

**Tenant logical base table count after Step 1: 279 → 283**.

---

## Step 2 — Work Orders + Preventive Maintenance Schema (pending)

**Migration:** `packages/database/prisma/tenant/migrations/073_fac_work_orders_pm.sql`. 6 logical base tables.

- `fac_work_orders` — 5-value `work_order_type` CHECK (REPAIR, INSTALLATION, INSPECTION_PREP, DEEP_CLEAN, RENOVATION), 4-value `priority` CHECK (LOW, MEDIUM, HIGH, CRITICAL), 6-value `status` CHECK (OPEN, IN_PROGRESS, VENDOR_ASSIGNED, ON_HOLD, COMPLETED, CANCELLED), DISPLAY-ONLY soft ref to `tkt_tickets` per ADR-033, DB-enforced FK to `tkt_vendors` re-using the Cycle 8 catalogue.
- `fac_work_order_activity` — IMMUTABLE per ADR-010. 4-value `activity_type` CHECK + JSONB metadata. Service-side discipline (no UPDATE / no DELETE methods); CASCADE on parent work order matches Cycle 8 `tkt_ticket_activity`.
- `fac_preventive_maintenance_plans` — `frequency_months INT > 0` CHECK, 3-value `target_type` CHECK (BUILDING, SPACE, SYSTEM) + soft polymorphic `target_id`.
- `fac_preventive_maintenance_checklist_items` — `sort_order INT >= 0` CHECK, CASCADE on parent plan.
- `fac_preventive_maintenance_tasks` — 4-value `status` CHECK (SCHEDULED, IN_PROGRESS, COMPLETED, OVERDUE).
- `fac_maintenance_checklist_results` — IMMUTABLE per ADR-010. UNIQUE(task_id, checklist_item_id). On FAIL → auto-creates follow-up `fac_work_orders` row.

---

## Step 3 — Inspections + Zones + Supply Schema (pending)

**Migration:** `packages/database/prisma/tenant/migrations/074_fac_inspections_zones.sql`. 6 logical base tables.

- `fac_inspection_types` — UNIQUE(school_id, name); `frequency_months INT > 0` CHECK; `failure_escalation_days INT >= 0` CHECK.
- `fac_inspections` — 4-value `outcome` CHECK (PASSED, PASSED_WITH_CONDITIONS, FAILED, PENDING). IMMUTABLE once outcome is set — service-side discipline. Emits `fac.inspection.failed` on FAILED or PASSED_WITH_CONDITIONS.
- `fac_inspection_violations` — 3-value `severity` CHECK (MINOR, MAJOR, CRITICAL); soft FK to `fac_work_orders` for the corrective-work cross-link. Emits `fac.inspection_violation.overdue` when `due_date < now()` AND `resolved_at IS NULL`.
- `fac_zones` — UNIQUE(school_id, name); `color TEXT` for the UI badge.
- `fac_zone_assignments` — UNIQUE(zone_id, employee_id, effective_from); 4-value `shift` CHECK (MORNING, AFTERNOON, EVENING, OVERNIGHT). Per ADR-034: HR owns when, Facilities owns where.
- `fac_supply_inventory` — UNIQUE(building_id, item_name); `current_quantity NUMERIC(8,2) >= 0` CHECK; `reorder_threshold NUMERIC(8,2) >= 0` CHECK. Emits `fac.supply.reorder_needed` when `current_quantity < reorder_threshold`.

**Cycle 21 schema phase total:** 16 fac\_\* tables, ~20 intra-tenant FKs, 0 cross-schema FKs. Tenant base table count: 279 → **295**.

---

## Step 4 — Seed Data + FAC-001..005 IAM grants (pending)

**`packages/database/src/seed-facilities.ts`** (idempotent, gated on `fac_buildings` row count) wired as `seed:facilities`. Sections:

- **A) 1 building + 12 spaces**: "Main Building" (3 floors, 2005) + 6 classrooms with `sch_room_id` cross-links (joined back to the seeded sch_rooms from Cycle 5) + 1 gym + 1 cafeteria + 2 corridors + 1 office + 1 storage room.
- **B) 2 space bookings**: Gym booked Thursday 14:00-15:00 (CONFIRMED). Cafeteria booked PTC event (CONFIRMED). Verify EXCLUDE gist prevents overlap during smoke.
- **C) 1 space closure**: Room 101 closed for pipe repair (linked to seeded work order). Indefinite (`ends_at = null`).
- **D) 2 work orders + 3 activity rows**: REPAIR pipe leak in Room 101 (HIGH, COMPLETED, 3 activity rows: STATUS_CHANGE OPEN→IN_PROGRESS, COMMENT "fixed", STATUS_CHANGE IN_PROGRESS→COMPLETED). INSTALLATION whiteboard in Room 102 (MEDIUM, OPEN).
- **E) 1 PM plan + 6 checklist items + 1 task + 6 results**: "Monthly HVAC Inspection" (frequency=1 month). Items: filters, belts, thermostat, ductwork, refrigerant, drainage. Last month task COMPLETED with 5 PASS + 1 FAIL (belt worn) → 1 follow-up work order auto-created.
- **F) 2 inspection types + 1 inspection + 1 violation**: "Annual Fire Inspection" (Fire Marshal, 12 months, mandatory) + "Elevator Certification" (State Board, 12 months). Fire inspection PASSED_WITH_CONDITIONS with 1 MAJOR violation (emergency exit signage, due in 30 days).
- **G) 2 zones + 2 assignments**: "Zone A: Ground Floor" (color=blue) + "Zone B: Upper Floors" (color=green). Martinez assigned to Zone A MORNING. Second custodian to Zone B AFTERNOON.
- **H) 5 supply inventory items**: Floor cleaner (3 units, threshold 5 = below reorder), paper towels (12, threshold 10), trash bags (20, threshold 15), glass cleaner (8, threshold 5), mop heads (4, threshold 3 = above).
- **Permissions:** `permissions.json` extended with FAC-001..005 (catalogue 454 → 459). FAC-001:read to Teacher (book a space, view buildings), FAC-001:write+admin to Staff (covers FM). FAC-002..004:read+write to Staff. FAC-005 schema-ready, deferred. Admin gets all via `everyFunction`.

---

## Step 5 — Buildings + Spaces NestJS Module (pending)

**`apps/api/src/facilities/`** with FacilitiesModule, BuildingService + SpaceService + BookingService + ClosureService + matching controllers + DTO module + ~14 endpoints under `fac-001:read/write/admin`.

- BuildingService: list + getById (with spaces inlined) + create + patch.
- SpaceService: list per building + getById (with bookings, closures, sch_room cross-link inlined) + create + patch.
- BookingService: list per space (date range filter) + create (EXCLUDE gist 23P01 → 409 translation) + patch (cancel/complete) + my-bookings.
- ClosureService: list active closures + create + patch (reopen via setting `ends_at`).

---

## Step 6 — Work Orders + PM NestJS Module (pending)

**`apps/api/src/facilities/`** extended with WorkOrderService + ActivityService + MaintenancePlanService + MaintenanceTaskService + matching controllers + ~12 endpoints + 2 Kafka emits (`fac.work_order.created`, `fac.maintenance_task.overdue`).

- WorkOrderService: list (filters status/priority/building/assigned), getById (with activity timeline inlined), create (emits `fac.work_order.created`), patch (locked-row state-machine; every mutation writes an immutable activity row in the same tenant tx via private `recordActivity` helper). POST /comment adds COMMENT activity.
- MaintenancePlanService: list + create (with checklist items in same tx) + patch + generate-tasks (date-range generator based on frequency).
- MaintenanceTaskService: list + patch (status transitions) + submit-results (IMMUTABLE per item, FAIL auto-creates follow-up work order in same tenant tx). Emits `fac.maintenance_task.overdue` on OVERDUE flip.

---

## Step 7 — Inspections + Zones + Supply NestJS Module (pending)

**`apps/api/src/facilities/`** extended with InspectionService + ViolationService + ZoneService + SupplyService + matching controllers + ~12 endpoints + 3 Kafka emits (`fac.inspection.failed`, `fac.inspection_violation.overdue`, `fac.supply.reorder_needed`).

- InspectionService: list (with upcoming due dates), record outcome (IMMUTABLE once set, emits `fac.inspection.failed` on FAILED/PASSED_WITH_CONDITIONS), inspection-types CRUD.
- ViolationService: list (active filtered by severity), create (with due_date), resolve (resolution notes + linked work order). Background sweep emits `fac.inspection_violation.overdue` for past-due unresolved rows.
- ZoneService: list (with assignments inlined), create + assignment CRUD. UNIQUE(zone, employee, effective_from) catch into 409.
- SupplyService: list per building (highlight below-threshold), create + adjust quantity (emits `fac.supply.reorder_needed` when crossing below threshold).

**Total Cycle 21 endpoints:** ~38 across 11 services.

---

## Step 8 — Facilities UI: Buildings + Work Orders + PM (pending)

**`apps/web/src/app/(app)/facilities/`** + new "Facilities" launchpad tile gated on `fac-001:read` using new `WrenchIcon`.

- `/facilities` dashboard with FM 5-stat header (open work orders by priority, upcoming PM tasks, active violations, supply reorder alerts, active closures) + teacher view (book a space, submit maintenance request → links to Cycle 8 ticket flow).
- `/facilities/buildings/[id]` browser with metadata header + space list (type pills + booking calendar + closure status) + sch_room cross-link chip on classroom spaces.
- `/facilities/bookings` weekly calendar per space + click-to-book Modal with conflict detection (409 → friendly toast).
- `/facilities/work-orders` Kanban board by status + per-card priority pill + assigned custodian/vendor + detail modal with activity timeline.
- `/facilities/pm` PM dashboard with plan list + next-due indicators + task calendar + checklist completion form (PASS/FAIL per item + photo upload).

---

## Step 9 — Facilities UI: Inspections + Zones + Supply (pending)

**`apps/web/src/app/(app)/facilities/`** extended with 4 more routes.

- `/facilities/inspections` log by building + type with upcoming due-date countdowns + record-outcome form + certificate upload.
- `/facilities/violations` active list sorted by due-date (overdue rose-tinted) + per-violation severity pill + linked work order + resolve form.
- `/facilities/zones` zone list with colour coding + assignment table per zone.
- `/facilities/supply` per-building inventory + below-threshold amber highlight + adjust-quantity form.

---

## Step 10 — Vertical Slice Integration Test (pending)

**`docs/cycle21-cat-script.md`** with 10 scenarios:

1. Building + spaces with `sch_room_id` cross-link verification.
2. Space booking + EXCLUDE gist conflict (409) + non-overlapping accept.
3. Space closure (indefinite + reopen).
4. Work order lifecycle + immutable activity timeline + `fac.work_order.created` envelope.
5. PM plan + checklist + FAIL auto-creates follow-up work order + checklist immutability.
6. Compliance inspection PASSED_WITH_CONDITIONS + violation logging + `fac.inspection.failed` envelope + corrective work order link.
7. Custodial zones + UNIQUE constraint + assignment lifecycle.
8. Supply reorder + `fac.supply.reorder_needed` envelope.
9. Persona visibility (teacher / FM / custodian / admin).
10. Cross-module cross-link verification (work order ↔ tkt_ticket ADR-033, space closure → scheduling advisory).
