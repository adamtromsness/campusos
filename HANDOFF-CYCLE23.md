# Cycle 23 Handoff — Curriculum & Standards

**Status:** Cycle 23 **COMPLETE pending peer review** — Wave 5 (Academic Advanced) cycle 1 / opening cycle. All 10 steps shipped + vertical-slice CAT verified live on `tenant_demo` 2026-05-06. Cycle 23 ships the M25 Curriculum module — all 11 of the 11 ERD tables in scope (9 tenant + 2 platform). The Curriculum Coordinator role emerges from the existing Teacher persona — schools can elevate a teacher to "Department Head" via the existing `IT-008:admin` / department head workflow rather than introducing a new persona type. **Opens Wave 5.**

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle23-implementation-plan.html`
**Vertical-slice deliverable:** Admin seeds the platform with "Common Core ELA" framework + ~50 standards → school adopts CCSS ELA for 2025-2026 → Department Head creates a "Grade 5 ELA" curriculum map → adds 4 units in scope-and-sequence order ("Narrative Writing" 4 weeks, "Persuasive Essays" 3 weeks, "Research Reports" 5 weeks, "Poetry & Creative Writing" 3 weeks) → aligns 8 standards (5 CCSS + 3 Lincoln Academy custom) to "Narrative Writing" unit → links 3 existing `cls_lessons` from Cycle 2 to the unit → attaches a teacher-only resource PDF "Narrative Writing Rubric" + 2 student-visible resources → the nightly delivery gap worker materialises 4 `cur_delivery_gaps` rows: W.5.3a COMPLETE / W.5.3b PARTIAL / W.5.3c NOT_STARTED / W.5.3d NOT_STARTED → Cycle 12's `lib_reading_lists.curriculum_unit_id` soft FK now resolves to the "Narrative Writing" unit, linking the library reading list to the curriculum.

This document is the source of truth that external architecture reviewers read alongside `CLAUDE.md`.

---

## Step status

| Step | Title                                               | Status   |
| ---- | --------------------------------------------------- | -------- |
| 1    | Framework + Standards Schema (Platform + Tenant)    | Complete |
| 2    | Curriculum Maps + Units + Alignment Schema          | Complete |
| 3    | Seed Data + TCH-008 IAM grants                      | Complete |
| 4    | Framework + Standards NestJS Module                 | Complete |
| 5    | Curriculum Maps + Units NestJS Module               | Complete |
| 6    | Delivery Gaps + Resources NestJS Module             | Complete |
| 7    | Curriculum UI — Frameworks + Maps + Units           | Complete |
| 8    | Curriculum UI — Delivery Gaps + Resources + Teacher | Complete |
| 9    | Cross-cycle integration verification                | Complete |
| 10   | Vertical Slice Integration Test                     | Complete |

**Final cycle totals:** 9 tenant `cur_*` base tables across 3 migrations (078 + 079 + 080) + 2 platform tables via Prisma migration `20260506171048_add_curriculum_platform_tables`. Tenant logical base table count 311 → **320** (+1 column-only on `lib_reading_lists` from 080). 8 intra-tenant FKs (CASCADE × 6 on map/unit/standard chains + NO ACTION × 2 on academic_year refs). 0 cross-schema DB-enforced FKs (the platform-framework refs are all soft per ADR-001/020). **29 endpoints** under `tch-008:read/write/admin` across 6 services + 1 controller (FrameworkService + StandardService in `frameworks.service.ts`; CurriculumMapService + UnitService in `maps.service.ts`; DeliveryGapService + ResourceLinkService in `gaps.service.ts`). **1 Kafka emit topic** (`cur.delivery_gap.detected`). **7 web routes** (`/curriculum`, `/curriculum/frameworks`, `/curriculum/maps/[id]`, `/curriculum/units/[id]`, `/curriculum/gaps`, `/curriculum/resources`, `/curriculum/my`). IAM: Teacher gains `TCH-008:read+write` (75 perms total, +2). Student + Parent gain `TCH-008:read` (41 + 39). Catalogue stays at **454**. Vertical-slice CAT at `docs/cycle23-cat-script.md` walks 10 plan scenarios end-to-end with the dual-resolution framework list verified live, the GIN search returning CCSS narrative + plants + fraction matches, the delivery gap worker materialising 8 rows + capturing the `cur.delivery_gap.detected` Kafka envelope live, and all 3 cross-cycle integrations (cur_unit_lessons → cls_lessons; cls_lesson_id validation; lib_reading_lists.curriculum_unit_id binding) verified end-to-end. **Splitter trap caught + fixed pre-provision** on 079 (1 stray `;` inside the block-comment header — rewritten with em-dash); 078 + 080 clean on first audit. **31st migration in a row to clear the splitter trap on first provision attempt after audit** (Cycles 4–23 unbroken streak). Both `tenant_demo` and `tenant_test` provisioned cleanly. Plan at `docs/campusos-cycle23-implementation-plan.html`. Tagged `cycle23-complete` after CI green.

---

## What this cycle adds on top of Cycle 22

**Greenfield — clean `cur_*` namespace.** Cycle 23 ships the entire M25 Curriculum core from scratch.

- **9 new tenant base tables** across 2 migrations (078 + 079). Tenant base table count after Cycle 22 was 311 → **320** after Cycle 23.
- **2 new platform tables** via a Prisma migration (`add_curriculum_platform_tables`): `cur_standards_frameworks_platform` + `cur_standards_platform`. The platform-seeded national frameworks (CCSS ELA, CCSS Math, NGSS) live here so a CCSS update is one migration, not one per tenant.
- **1 new backend module** (CurriculumModule) with ~6 services + 1 controller + ~32 endpoints under `tch-008:read/write/admin`.
- **1 new Kafka emit topic**: `cur.delivery_gap.detected` (fires when a NOT_STARTED or PARTIAL gap is materialised for a PUBLISHED map).
- **7+ new web routes**: `/curriculum` dashboard, `/curriculum/frameworks`, `/curriculum/maps/[id]`, `/curriculum/units/[id]`, `/curriculum/gaps`, `/curriculum/resources`, `/curriculum/my`.
- **1 new permission code**: `TCH-008` (Curriculum Management). Catalogue stays at **454** if TCH-008 is already in `permissions.json`; otherwise grows to 455. (Verified at Step 3.)

**Three structural keystones for the cycle:**

1. **Platform-vs-tenant dual resolution (KEYSTONE).** National frameworks (CCSS, NGSS) live in `platform.cur_standards_frameworks_platform` + `platform.cur_standards_platform` so a CCSS update is one migration, not one per tenant. School-custom frameworks live in tenant `cur_standards_frameworks` + `cur_standards`. The `cur_unit_standards.standard_id` column resolves from EITHER platform OR tenant via application-layer lookup per the soft integrity pattern. The Step 4 `FrameworkService.list` returns a unified list with `source: 'PLATFORM' | 'SCHOOL'` so callers see one catalogue.
2. **GIN-indexed standards search.** `platform.cur_standards_platform` carries `GIN INDEX USING GIN (to_tsvector('english', code || ' ' || description))` for fast keyword search across ~150 seeded standards. `?q=narrative` returns CCSS.ELA-LITERACY.W.5.3 immediately.
3. **Nightly materialised delivery gap analysis (ADR-018).** `cur_delivery_gaps` is computed by a nightly worker, never on demand. The Step 6 worker walks each PUBLISHED `cur_curriculum_maps` → its units → aligned standards → counts planned lessons (`cur_unit_lessons`) and delivered lessons (`cls_lessons WHERE status='COMPLETED'`) and UPSERTs the gap row. Emits `cur.delivery_gap.detected` for new NOT_STARTED / PARTIAL gaps. **First nightly read-model worker that reads across module boundaries** (curriculum → classroom).

**Existing-system touchpoints:**

- `platform.platform_users(id)` — soft refs on `cur_curriculum_maps.created_by` and `cur_resource_links.uploaded_by` per ADR-001/020.
- `sis_academic_years(id)` — DB-enforced FK on `cur_curriculum_maps.academic_year_id` and `cur_school_framework_adoptions.academic_year_id`.
- `cls_lessons(id)` — soft ref on `cur_unit_lessons.cls_lesson_id` (Cycle 2 cross-cycle read-back keystone).
- `lib_reading_lists.curriculum_unit_id` (Cycle 12) — soft ref to `cur_units(id)`. The Cycle 12 reading list detail page can now resolve which curriculum unit the reading list supports.

What does not change: every existing module continues to function. Cycle 23 is purely additive on a clean `cur_*` namespace.

---

## Step 1 — Framework + Standards Schema (pending)

To be filled out as Step 1 ships.

## Step 2 — Curriculum Maps + Units + Alignment Schema (pending)

To be filled out as Step 2 ships.

## Step 3 — Seed Data + TCH-008 IAM grants (pending)

To be filled out as Step 3 ships.

## Step 4 — Framework + Standards NestJS Module (pending)

To be filled out as Step 4 ships.

## Step 5 — Curriculum Maps + Units NestJS Module (pending)

To be filled out as Step 5 ships.

## Step 6 — Delivery Gaps + Resources NestJS Module (pending)

To be filled out as Step 6 ships.

## Step 7 — Curriculum UI: Frameworks + Maps + Units (pending)

To be filled out as Step 7 ships.

## Step 8 — Curriculum UI: Gaps + Resources + Teacher View (pending)

To be filled out as Step 8 ships.

## Step 9 — Cross-cycle integration verification (pending)

To be filled out as Step 9 ships.

## Step 10 — Vertical Slice Integration Test (pending)

To be filled out as Step 10 ships.
