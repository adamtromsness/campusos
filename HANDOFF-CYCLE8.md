# Cycle 8 Handoff — Service Tickets

**Status:** Cycle 8 **IN PROGRESS** — Steps 1–9 (full schema + seed + ticket API + consumers + staff UI + admin UI + problem management UI) **DONE**. Step 10 (vertical-slice CAT) remains. Cycles 0–7 are COMPLETE + APPROVED. Cycle 8 is the final cycle of Wave 1 and ships the M60 Service Tickets module — a shared reactive ticketing engine that IT, facilities, and HR support all use. NOT a facilities management system (that is M65, a future cycle). This module handles reactive requests like "my projector is broken," "Room 204 needs a new light bulb," "I can't log in." It integrates with Cycle 7's Task Worker (ticket assignment creates a task on the assignee's to-do list) and the Cycle 7 Approval Workflows engine (ticket escalation can route through an approval chain).

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle8-implementation-plan.html`
**Vertical-slice deliverable:** Teacher submits a ticket "Projector not working in Room 101" under IT → Hardware → auto-assigned to the IT admin based on subcategory rules → SLA clock starts (4h response / 24h resolution for HIGH priority) → IT admin sees the ticket in their queue, adds an internal comment ("Ordered replacement lamp") → reassigns to facilities vendor → vendor reference recorded → admin resolves the ticket → requester gets a notification → ticket auto-closes after 48h if requester does not reopen → SLA metrics show response and resolution times on the admin dashboard.

This document tracks the Cycle 8 build at the same level of detail as `HANDOFF-CYCLE1.md` through `HANDOFF-CYCLE7.md`. It is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                              | Status      |
| ---- | -------------------------------------------------- | ----------- |
| 1    | Ticket Schema — Categories, SLA, Vendors           | **DONE**    |
| 2    | Ticket Schema — Tickets, Comments, Activity        | **DONE**    |
| 3    | Seed Data — Categories, SLA, Vendors, Sample Tickets | **DONE**    |
| 4    | Ticket NestJS Module — Core CRUD + Lifecycle       | **DONE**    |
| 5    | Ticket NestJS Module — Comments, Activity, Problems | **DONE**    |
| 6    | Ticket Notification Consumer + Auto-Task Wiring    | **DONE**    |
| 7    | Helpdesk UI — Submit + My Tickets                  | **DONE**    |
| 8    | Helpdesk Admin UI — Queue + Dashboard              | **DONE**    |
| 9    | Problem Management UI                              | **DONE**    |
| 10   | Vertical Slice Integration Test                    | **PENDING** |

---

## What this cycle adds on top of Cycles 0–7

Cycle 8 is the third cross-cutting cycle of Phase 3 Wave 1. It is the operational counterpart to Cycle 7: where Cycle 7 gave every persona a unified Tasks app and a shared approval engine, Cycle 8 gives every staff persona a unified Helpdesk surface where the ticket lifecycle is the first-class object.

- **Tickets (M60).** The first reactive support engine in CampusOS. Every staff member submits problems through one inbox (`/helpdesk/new`) regardless of whether the problem is IT, facilities, or HR-support shaped. The category tree (configured per school) routes the ticket to the right queue and the right SLA policy. Auto-assignment runs at submission time using the same ROLE-resolution helper the Cycle 7 WorkflowEngineService uses for ROLE-typed approval steps. Internal comments stay invisible to requesters. Activity log is immutable. Vendors are first-class entities so a ticket can be escalated to an external party and the audit trail records it.
- **Cycle 7 integration.** A new auto-task rule on `tkt.ticket.assigned` (seeded in Step 3) feeds the existing Cycle 7 Task Worker. When a ticket is assigned, the worker creates a TODO task on the assignee's list ("Resolve ticket: …"). When the ticket is resolved, the service emits `tkt.ticket.resolved` and a downstream consumer marks the linked task DONE via `source_ref_id` matching. This is the first time Cycle 7's Task Worker is exercised by a non-trivial domain producer outside its seeded set; the wiring tests the worker's runtime add-rule path.
- **Cycle 5 + Cycle 4 integration.** Tickets carry a soft `location_id` ref to `sch_rooms` so "Room 101 projector" links to the scheduling room for context. Internal assignees reference `hr_employees(id)` as a DB-enforced FK; vendor assignees reference `tkt_vendors(id)`. A multi-column CHECK enforces that a ticket has at most one of the two — never both.

What does not change: every existing module continues to function. Cycle 8 is purely additive on the request path.

---

## Step 1 — Ticket Schema — Categories, SLA, Vendors

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-03. Idempotent re-provision verified (zero new applies on the second run; the IF NOT EXISTS guards on every CREATE TABLE / CREATE INDEX work as designed). Splitter-clean — Python audit script (block-comment + line-comment + single-quoted-string aware with `''` escape handling) confirmed zero `;` outside legitimate statement terminators on the first attempt. Third cycle in a row to clear the splitter trap on first try.

**Migration:** `packages/database/prisma/tenant/migrations/028_tkt_categories_sla_vendors.sql`.

**Tables (4):**

1. **`tkt_categories`** — Hierarchical ticket categories. `school_id`, `parent_category_id` self-FK (nullable for top-level rows), `name TEXT NOT NULL`, `icon TEXT` nullable, `is_active BOOLEAN DEFAULT true`. UNIQUE INDEX on `(school_id, name)` enforced across the full tree (a child cannot share a name with a sibling or top-level row in the same school). Partial INDEX on `(parent_category_id) WHERE parent_category_id IS NOT NULL` for child-tree traversal. Self-FK uses **NO ACTION** so an admin must move or deactivate child rows before deleting a parent — audit trail wins over cleanup ergonomics. Examples once seeded in Step 3: IT (parent) → Hardware, Software, Network, Account Access. Facilities (parent) → Electrical, Plumbing, HVAC, Cleaning, Furniture. HR Support (parent) → Payroll Question, Benefits Question.

2. **`tkt_subcategories`** — Leaf-level classification with optional auto-assignment hints. `category_id` FK → `tkt_categories(id) ON DELETE CASCADE` (subcategories die with their parent). `name TEXT NOT NULL`. `default_assignee_id` FK → `hr_employees(id) ON DELETE SET NULL` (when the seeded admin leaves the school, auto-assignment gracefully falls back to the role-based path or unassigned instead of breaking the rule). `auto_assign_to_role TEXT` nullable — a role token like `'SCHOOL_ADMIN'` resolved at submission time the same way the Cycle 7 WorkflowEngineService resolves a ROLE-typed approver. UNIQUE(category_id, name). When both `default_assignee_id` and `auto_assign_to_role` are NULL the ticket lands in the admin queue unassigned. Partial INDEX `(default_assignee_id) WHERE default_assignee_id IS NOT NULL` for the future "tickets I am the default assignee for" admin view.

3. **`tkt_sla_policies`** — Per-(school, category, priority) SLA target hours. `priority TEXT` 4-value CHECK `LOW / MEDIUM / HIGH / CRITICAL`. `response_hours INT NOT NULL` with `> 0` CHECK; `resolution_hours INT NOT NULL` with `> 0` CHECK. **Multi-column `tkt_sla_policies_order_chk`** enforces `resolution_hours >= response_hours` so a misconfigured policy cannot ship where the ticket is breached on resolution before it can be breached on response. UNIQUE INDEX on `(school_id, category_id, priority)` so each (category, priority) pair has exactly one policy per school. INDEX on `(category_id)` for category-detail page reads. CASCADE on category delete (SLA rows are meaningless without their category). The Step 4 SlaService computes breach status from `tkt_tickets.created_at` and `now()` against this table — the clock is **not** stored as a countdown.

4. **`tkt_vendors`** — External vendor registry. `school_id`, `vendor_name TEXT NOT NULL`. `vendor_type TEXT` 9-value CHECK `IT_REPAIR / FACILITIES_MAINTENANCE / CLEANING / ELECTRICAL / PLUMBING / HVAC / SECURITY / GROUNDS / OTHER`. Contact fields (`contact_name`, `contact_email`, `contact_phone`, `website`) all nullable. `is_preferred BOOLEAN DEFAULT false` flags the vendor a school normally calls first; the Step 8 admin assignment dropdown sorts preferred vendors at the top. `notes TEXT`, `is_active BOOLEAN DEFAULT true`. UNIQUE INDEX on `(school_id, vendor_name)`. INDEX on `(school_id, is_active)` for the active-vendor list, plus a partial INDEX on `(school_id, is_preferred) WHERE is_preferred = true` for the "preferred-first" sort path.

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `tkt_categories.school_id → platform.schools(id)`
- `tkt_sla_policies.school_id → platform.schools(id)`
- `tkt_vendors.school_id → platform.schools(id)`

(`tkt_subcategories` has no cross-schema soft refs; its `default_assignee_id` is a DB-enforced FK to the tenant table `hr_employees` and so is intra-tenant.)

**FK summary — 4 new intra-tenant DB-enforced FKs:**

- `tkt_categories.parent_category_id → tkt_categories(id)` **NO ACTION** (refuses delete with children)
- `tkt_subcategories.category_id → tkt_categories(id) ON DELETE CASCADE`
- `tkt_subcategories.default_assignee_id → hr_employees(id) ON DELETE SET NULL`
- `tkt_sla_policies.category_id → tkt_categories(id) ON DELETE CASCADE`

0 cross-schema FKs.

**Tenant logical base table count after Step 1:** 121 → **125**.

(Aside: the prior Cycle 7 narrative in `CLAUDE.md` reported "120 base tables after Cycle 7 Step 2," but the live database actually shows 121. The off-by-one drift originated when Cycle 6.1's `sis_student_demographics` table was double-counted in the cycle text: Cycle 6.1's own narrative says "tenant base table count: **107** after Step 2" while the Phase 2 polish callout says Phase 2 brought the count from 106 → 108, missing the 6.1 Step 2 +1 in the chain. Real chain: 106 (end of Cycle 6) → 107 (Cycle 6.1 Step 2 adds `sis_student_demographics`) → 108 (Phase 2 adds `sch_calendar_event_rsvps`) → 109 (Phase 2 adds `sis_child_link_requests`) → 115 (Cycle 7 Step 1 adds 6 tsk_\*) → 121 (Cycle 7 Step 2 adds 6 wsk_\*). The Cycle 8 handoff uses 121 as the pre-step baseline so the math closes against the live database. The CLAUDE.md update for Step 1 carries the corrected total forward.)

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK with savepoints, 15 assertions, 14 verified empirically + 1 verified via `pg_constraint` catalog inspection):**

1. **T1 happy path** — 5 inserts across all 4 tables succeed (1 top-level category + 1 child category + 1 subcategory linking to a real `hr_employees` id + 1 SLA policy + 1 preferred vendor).
2. **T2 vendor_type CHECK** — `tkt_vendors_type_chk` rejects `vendor_type='BOGUS'`.
3. **T3 priority CHECK** — `tkt_sla_policies_priority_chk` rejects `priority='MID'` (only LOW / MEDIUM / HIGH / CRITICAL accepted).
4. **T4 response_chk** — `tkt_sla_policies_response_chk` rejects `response_hours=0`.
5. **T5 order_chk** — `tkt_sla_policies_order_chk` rejects `resolution_hours=4` when `response_hours=8` (resolution must be ≥ response).
6. **T6 categories UNIQUE** — `tkt_categories_school_name_uq` rejects a second row with the same `(school_id, name)`, even when `parent_category_id` differs (UNIQUE is across the full tree, not per parent).
7. **T7 subcategories UNIQUE** — `tkt_subcategories_category_name_uq` rejects a second leaf with the same `(category_id, name)`.
8. **T8 SLA UNIQUE** — `tkt_sla_policies_school_category_priority_uq` rejects a second policy on the same `(school, category, priority)`.
9. **T9 vendors UNIQUE** — `tkt_vendors_school_name_uq` rejects a second vendor with the same `(school, vendor_name)`.
10. **T10 parent NO ACTION** — DELETE on a top-level `tkt_categories` row with children is rejected by `tkt_categories_parent_category_id_fkey`.
11. **T11 bogus FK on subcategory.category_id** — INSERT with `category_id='00000000-…-0000'` rejected by `tkt_subcategories_category_id_fkey` (no matching row in `tkt_categories`).
12. **T12 bogus FK on default_assignee_id** — INSERT with phantom `hr_employees` UUID rejected by `tkt_subcategories_default_assignee_id_fkey`.
13. **T13 CASCADE on subcategory.category_id** — DELETE on the child category drops the linked subcategory; `count(*)` after delete is 0.
14. **T14 SET NULL on default_assignee_id when employee deleted** — verified via `pg_constraint` catalog inspection (`confdeltype='n'` on `tkt_subcategories_default_assignee_id_fkey`). Empirical destructive smoke against a temp `hr_employees` row was skipped because creating a temp employee requires a chain of `iam_person + platform_users` rows with their own NOT NULL constraints not directly relevant to this FK; the catalog readout is authoritative for FK action verification.
15. **T15 CASCADE on SLA policy when category dropped** — DELETE the parent category cascades through the child category → leaf subcategory and the SLA policy attached at the top level; `count(*)` of remaining SLA rows for the category id is 0.

**FK action verification via `pg_constraint`:**

```
tkt_categories_parent_category_id_fkey       NO ACTION
tkt_sla_policies_category_id_fkey            CASCADE
tkt_subcategories_category_id_fkey           CASCADE
tkt_subcategories_default_assignee_id_fkey   SET NULL
```

All 4 actions match the migration's declared intent.

**Sanity counts on `tenant_demo`:**

- 4 logical base tables under `tkt_*` (`information_schema.tables` filter on `tkt\_%` returns exactly 4 — none of these tables are partitioned, so the count matches the logical-table count directly).
- 4 `tkt_*` rows in `pg_constraint` for the new FKs (one per logical FK; no partition replication).
- 0 cross-schema FKs.

**Splitter audit:** Python state-machine audit (block-comment / line-comment / single-quoted-string aware) reports zero `;` inside any string literal or comment in the migration. Migration applied first try with no rewrite needed.

**What's deferred to later steps:**

- Step 2 lands `tkt_tickets` + `tkt_ticket_comments` + `tkt_ticket_attachments` + `tkt_ticket_tags` + `tkt_ticket_activity` (immutable audit) + `tkt_problems` + `tkt_problem_tickets`. The `tkt_tickets.subcategory_id` FK (added in Step 2) is **NO ACTION** so deactivating a subcategory does not orphan historical tickets — admins are expected to flip `is_active=false` rather than hard-delete leaves with ticket history.
- Step 3 seeds the category tree (IT / Facilities / HR Support, ~6 subcategories), the 12-row SLA matrix (3 categories × 4 priorities), and 2 vendors (preferred IT + facilities). Permission grants for `IT-001` + `FAC-001` (already in the catalogue at `permissions.json`) extend to Teacher / Staff (read+write) and School Admin / Platform Admin (admin via `everyFunction`). Cache rebuild runs after.
- Out of scope for the entire cycle (deferred per the plan): `tkt_ticket_asset_links` (requires M62 IT Infrastructure asset registry — future cycle), `tkt_vendor_updates` (requires `platform_vendor_accounts` vendor portal — future cycle), `tkt_knowledge_articles` (knowledge base — future polish), SLA breach cron worker (schema is ready, cron deferred to ops), ticket auto-close after 48h in RESOLVED state, email-to-ticket inbound, CSAT survey on ticket close.

---

## Step 2 — Ticket Schema — Tickets, Comments, Activity

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-03. Idempotent re-provision verified (zero new applies on the second run; the IF NOT EXISTS guards on every CREATE TABLE / CREATE INDEX work as designed). Splitter-clean — Python state-machine audit (block-comment / line-comment / single-quoted-string aware with `''` escape handling) confirmed zero `;` outside legitimate statement terminators on the first attempt. Fourth migration in a row to clear the splitter trap on first try.

**Migration:** `packages/database/prisma/tenant/migrations/029_tkt_tickets_and_activity.sql`.

**Tables (7):**

1. **`tkt_tickets`** — One row per support ticket. `school_id`, `category_id` (NOT NULL FK), `subcategory_id` (nullable FK), `requester_id` (NOT NULL soft ref to `platform.platform_users`), `assignee_id` (nullable FK to `hr_employees`), `vendor_id` (nullable FK to `tkt_vendors`), `vendor_reference` (nullable; nullable even when vendor_id is set because some vendors do not issue a WO/case number), `vendor_assigned_at` TIMESTAMPTZ, `title TEXT NOT NULL`, `description`, `priority TEXT NOT NULL DEFAULT 'MEDIUM'` 4-value CHECK `LOW / MEDIUM / HIGH / CRITICAL`, `status TEXT NOT NULL DEFAULT 'OPEN'` 7-value CHECK `OPEN / IN_PROGRESS / VENDOR_ASSIGNED / PENDING_REQUESTER / RESOLVED / CLOSED / CANCELLED`, `sla_policy_id` (nullable FK to `tkt_sla_policies`), `location_id` (soft ref to `sch_rooms` — kept soft so the ticket survives a room being retired in Cycle 5 scheduling), `first_response_at`, `resolved_at`, `closed_at`. Three multi-column CHECKs:
   - **`tkt_tickets_assignee_or_vendor_chk`** — `(assignee_id IS NULL OR vendor_id IS NULL)` — a ticket is assigned to either an internal employee or an external vendor, never both.
   - **`tkt_tickets_vendor_pair_chk`** — `vendor_id` and `vendor_assigned_at` must be all-set or all-null together; a stray timestamp without a vendor cannot ship.
   - **`tkt_tickets_resolved_chk`** — keeps `resolved_at` and `closed_at` in lockstep with status across the four lifecycle phases: working states (OPEN / IN_PROGRESS / VENDOR_ASSIGNED / PENDING_REQUESTER) ⇒ both NULL; RESOLVED ⇒ resolved_at NOT NULL, closed_at NULL; CLOSED ⇒ both NOT NULL (close requires prior resolve); CANCELLED ⇒ resolved_at NULL, closed_at NOT NULL (cancellation ends the lifecycle without resolution).

   Four indexes: `(school_id, status, created_at DESC)` for the admin queue hot path; partial `(assignee_id, status) WHERE assignee_id IS NOT NULL` for "tickets assigned to me"; partial `(vendor_id, status) WHERE vendor_id IS NOT NULL` for the vendor-side queue; `(requester_id, created_at DESC)` for "my submitted tickets".

2. **`tkt_ticket_comments`** — Append-only thread on a ticket. `ticket_id` FK CASCADE; `author_id` (soft ref to `platform.platform_users`); `body TEXT NOT NULL`; `is_internal BOOLEAN DEFAULT false` distinguishes staff-only notes from comments the requester sees. INDEX `(ticket_id, created_at)` for chronological thread render.

3. **`tkt_ticket_attachments`** — Signed-S3-URL pattern matching `hr_employee_documents` from Cycle 4. `ticket_id` FK CASCADE, `s3_key TEXT NOT NULL`, `filename`, `content_type`, `file_size_bytes BIGINT` with a non-negative CHECK, `uploaded_by` (soft ref). INDEX `(ticket_id, uploaded_at)`.

4. **`tkt_ticket_tags`** — Free-form admin tags. `ticket_id` FK CASCADE, `tag TEXT NOT NULL`. UNIQUE INDEX `(ticket_id, tag)` so a single tag cannot land twice on the same ticket. Secondary INDEX `(tag)` for cross-ticket "show me everything tagged X" filter.

5. **`tkt_ticket_activity`** — IMMUTABLE audit log per ADR-010 (service-side discipline — no DB trigger so emergency operator action remains possible). `ticket_id` FK CASCADE, `actor_id` UUID nullable (so system-driven entries like `SLA_BREACH` from a future cron worker can land without an actor), `activity_type TEXT NOT NULL` 7-value CHECK `STATUS_CHANGE / REASSIGNMENT / COMMENT / ATTACHMENT / ESCALATION / VENDOR_ASSIGNMENT / SLA_BREACH`, `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`. INDEX `(ticket_id, created_at)`. Metadata convention documented in COMMENT: STATUS_CHANGE rows carry `{from, to}`; REASSIGNMENT rows carry `{from_assignee_id, to_assignee_id}`; VENDOR_ASSIGNMENT rows carry `{vendor_id, vendor_reference}`; SLA_BREACH rows carry `{breach_type, hours_overdue}`.

6. **`tkt_problems`** — Root-cause grouping for related tickets. `school_id`, `title TEXT NOT NULL`, `description TEXT NOT NULL` (description is required because a problem without a description is just a tag), `category_id` (NOT NULL FK NO ACTION), `status TEXT DEFAULT 'OPEN'` 4-value CHECK `OPEN / INVESTIGATING / KNOWN_ERROR / RESOLVED`, `root_cause`, `resolution`, `workaround`, `assigned_to_id` (nullable FK to `hr_employees` SET NULL), `vendor_id` (nullable FK to `tkt_vendors` SET NULL), `created_by` (NOT NULL soft ref), `resolved_at`. Two multi-column CHECKs:
   - **`tkt_problems_assigned_or_vendor_chk`** — mirrors the ticket-level mutex (`assigned_to_id` XOR `vendor_id`).
   - **`tkt_problems_resolved_chk`** — OPEN / INVESTIGATING ⇒ `resolved_at` NULL; KNOWN_ERROR ⇒ `root_cause IS NOT NULL` AND `resolved_at` NULL (a known-error must have a documented cause but is not yet resolved); RESOLVED ⇒ `root_cause`, `resolution`, `resolved_at` all NOT NULL.

   Two indexes: `(school_id, status)` for the problem list, `(category_id)` for category-detail lookups.

7. **`tkt_problem_tickets`** — Many-to-many link between `tkt_problems` and `tkt_tickets`. `problem_id` FK CASCADE + `ticket_id` FK CASCADE (double-CASCADE since the link row has no meaning without either side). UNIQUE INDEX `(problem_id, ticket_id)` so a ticket cannot be linked twice to the same problem. Secondary INDEX `(ticket_id)` so the ticket detail page can quickly find any problems this ticket is part of.

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `tkt_tickets.requester_id → platform.platform_users(id)`
- `tkt_tickets.location_id → sch_rooms(id)` (intra-tenant but kept soft)
- `tkt_ticket_comments.author_id → platform.platform_users(id)`
- `tkt_ticket_attachments.uploaded_by → platform.platform_users(id)`
- `tkt_ticket_activity.actor_id → platform.platform_users(id)` (nullable — system rows allowed)
- `tkt_problems.created_by → platform.platform_users(id)`

**FK summary — 14 new intra-tenant DB-enforced FKs:**

| FK                                              | Action      |
| ----------------------------------------------- | ----------- |
| `tkt_tickets.category_id → tkt_categories(id)`        | NO ACTION   |
| `tkt_tickets.subcategory_id → tkt_subcategories(id)`  | NO ACTION   |
| `tkt_tickets.assignee_id → hr_employees(id)`          | SET NULL    |
| `tkt_tickets.vendor_id → tkt_vendors(id)`             | SET NULL    |
| `tkt_tickets.sla_policy_id → tkt_sla_policies(id)`    | SET NULL    |
| `tkt_ticket_comments.ticket_id → tkt_tickets(id)`     | CASCADE     |
| `tkt_ticket_attachments.ticket_id → tkt_tickets(id)`  | CASCADE     |
| `tkt_ticket_tags.ticket_id → tkt_tickets(id)`         | CASCADE     |
| `tkt_ticket_activity.ticket_id → tkt_tickets(id)`     | CASCADE     |
| `tkt_problems.category_id → tkt_categories(id)`       | NO ACTION   |
| `tkt_problems.assigned_to_id → hr_employees(id)`      | SET NULL    |
| `tkt_problems.vendor_id → tkt_vendors(id)`            | SET NULL    |
| `tkt_problem_tickets.problem_id → tkt_problems(id)`   | CASCADE     |
| `tkt_problem_tickets.ticket_id → tkt_tickets(id)`     | CASCADE     |

All 14 actions confirmed via `pg_constraint.confdeltype` catalog readout. 0 cross-schema FKs.

**Tenant logical base table count after Step 2: 125 → 132** (+7 logical `tkt_*` tables, none partitioned). Cycle 8 running total so far: 11 `tkt_*` tables (4 from Step 1 + 7 from Step 2).

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK with savepoints, 29 assertions, all green):**

1. **T1** — happy-path OPEN ticket inserts cleanly with `category_id`, `subcategory_id`, `requester_id`, `priority='HIGH'`, `status='OPEN'`, `sla_policy_id`.
2. **T2** — `tkt_tickets_status_chk` rejects `status='BOGUS'`.
3. **T3** — `tkt_tickets_priority_chk` rejects `priority='MID'`.
4. **T4** — `tkt_tickets_assignee_or_vendor_chk` rejects a row with both `assignee_id` AND `vendor_id` set. (Note: `tkt_tickets_resolved_chk` would also fire on the same row if it were structured differently; in this test the assignee_or_vendor_chk fires first as documented in the smoke output.)
5. **T5** — `tkt_tickets_vendor_pair_chk` rejects `vendor_id` set without `vendor_assigned_at`.
6. **T6** — `tkt_tickets_vendor_pair_chk` rejects `vendor_assigned_at` set without `vendor_id`.
7. **T7** — `tkt_tickets_resolved_chk` rejects status=OPEN with `resolved_at` set.
8. **T8** — `tkt_tickets_resolved_chk` rejects status=RESOLVED without `resolved_at`.
9. **T9** — `tkt_tickets_resolved_chk` rejects status=CLOSED without `closed_at`.
10. **T10** — `tkt_tickets_resolved_chk` rejects status=CANCELLED with `resolved_at` set (CANCELLED ends without resolution).
11. **T11** — Lifecycle round-trip OPEN → IN_PROGRESS → RESOLVED → CLOSED. Final state: `status='CLOSED'`, `has_resolved=t`, `has_closed=t`. The `resolved_chk` allows the timestamps to land in the same UPDATE statement as the status flip.
12. **T12** — Direct insert of a VENDOR_ASSIGNED ticket with `vendor_id` + `vendor_reference='WO-2026-0001'` + `vendor_assigned_at=now()` and no internal assignee succeeds.
13. **T13** — comment + activity inserts succeed against the active ticket: 2 comments (one public, one internal), 2 activity rows (one STATUS_CHANGE with metadata `{from, to}`, one SLA_BREACH with metadata `{breach_type, hours_overdue}` and `actor_id` NULL — system-row pattern).
14. **T14** — `tkt_ticket_activity_type_chk` rejects `activity_type='BOGUS'`.
15. **T15** — `tkt_ticket_tags_ticket_tag_uq` rejects a duplicate `(ticket_id, tag)` pair.
16. **T16** — `tkt_ticket_attachments_size_chk` rejects `file_size_bytes=-1`.
17. **T17** — NO ACTION on `tkt_subcategories` delete with referencing ticket. `tkt_tickets_subcategory_id_fkey` fires correctly.
18. **T18** — Top-level category NO ACTION verification chained through subcategory cleanup; the subcategory NO ACTION fires first (as expected — the test pre-deletes the subcategory rows and the ticket's subcategory_id FK rejects). The catalog confirms `tkt_tickets.category_id` is also NO ACTION; an empirical version of the category-only test would require deleting all referencing tickets first, which this smoke does not do.
19. **T19** — CASCADE on ticket delete drops 2 comments + 2 activity rows + 1 tag in one statement; counts go from `(2, 2, 1)` to `(0, 0, 0)`.
20. **T20** — `tkt_problems_resolved_chk` rejects `status='BOGUS'` (the resolved_chk OR-clause fires first — BOGUS does not match any of the 4 status branches in the multi-column predicate, same row-rejection as if `tkt_problems_status_chk` had fired; both constraints catch the bogus value).
21. **T21** — `tkt_problems_assigned_or_vendor_chk` rejects a row with both `assigned_to_id` and `vendor_id` set.
22. **T22** — `tkt_problems_resolved_chk` rejects KNOWN_ERROR without `root_cause`.
23. **T23** — `tkt_problems_resolved_chk` rejects RESOLVED with `root_cause` set but `resolution` missing.
24. **T24** — Happy-path: 1 problem in INVESTIGATING status + 2 link rows linking to two existing tickets succeed.
25. **T25** — `tkt_problem_tickets_pair_uq` rejects a duplicate `(problem_id, ticket_id)` pair.
26. **T26** — CASCADE on problem delete drops the 2 link rows (count goes 2 → 0).
27. **T27** — CASCADE on ticket delete drops the link row from the ticket side (count for ticket-1 goes 1 → 0).
28. **T28** — Bogus FK on `tkt_tickets.category_id` (UUID `00000000-…-0000`) rejected by `tkt_tickets_category_id_fkey`.
29. **T29** — Bogus FK on `tkt_ticket_comments.ticket_id` rejected by `tkt_ticket_comments_ticket_id_fkey`.

**FK action verification via `pg_constraint`:** All 14 `tkt_*` FKs in the migration round-trip through the catalog with the correct `confdeltype` value (NO ACTION 'a' / CASCADE 'c' / SET NULL 'n'). Output captured in the smoke transcript.

**Sanity counts on `tenant_demo`:**

- 11 logical `tkt_*` base tables (4 from Step 1 + 7 from Step 2).
- 14 rows in `pg_constraint` for the new FKs (one per logical FK; no partition replication since none of these tables are partitioned).
- 0 cross-schema FKs.
- Idempotent re-provision is a clean no-op on the SQL.

**Splitter audit:** Python state-machine audit reports zero `;` inside any string literal or comment. Migration applied first try with no rewrite needed.

**Constraint observation worth carrying forward:** When a multi-column CHECK is structured as a multi-branch OR (the resolved_chk pattern from Cycles 5–7 + this Step), Postgres evaluates the whole OR clause and reports the first CHECK whose name appears in the catalog ordering as the failing constraint. This means `tkt_problems_resolved_chk` is sometimes reported as the failing constraint when the actual issue is a `status_chk`-shaped violation — the OR clause's status-list filter rejects BOGUS before the standalone `status_chk` gets a chance. Same row-rejection outcome; the constraint name in the error message is just the first one to fire in the evaluation order. Cycle 5 documented this same observation for `sch_coverage_requests.assignment_chk` vs `status_chk`.

**What's deferred to later steps:**

- Step 3 seeds the category tree (6 categories + 9 subcategories), 12-row SLA matrix (3 categories × 4 priorities), 2 vendors, 5 sample tickets across the 5 status states, 3 sample comments (1 public + 1 internal + 1 resolution), 8 activity rows, 1 sample problem linking 2 tickets, 1 auto-task rule on `tkt.ticket.assigned`, plus permission grants for `IT-001` + `FAC-001`.
- Step 4 lands the request-path TicketService / CategoryService / SlaService / VendorService with ~18 endpoints. The service layer enforces the ticket auto-assignment chain (subcategory `default_assignee_id` → `auto_assign_to_role` → unassigned), records `first_response_at` on the first staff comment, and emits `tkt.ticket.{submitted,assigned,resolved}`.
- Step 5 lands CommentService / ActivityService / ProblemService — the activity log is written by a private `recordActivity()` helper called from every lifecycle path. The smoke verified that the audit table accepts every activity_type value and that CASCADE on the parent ticket drops the audit rows; the IMMUTABLE-by-discipline rule lives in the service code.

---

## Step 3 — Seed Data — Categories, SLA, Vendors, Sample Tickets

**Status:** DONE. New `packages/database/src/seed-tickets.ts` (idempotent, gated on `tkt_categories` row count for the demo school). `seed:tickets` script wired into `package.json`. `seed-iam.ts` updated to grant `IT-001:read+write` to Teacher and Staff. `iam_effective_access_cache` rebuilt: Teacher 38 → 40, Staff 18 → 20 (each gained 2 perms). All other personas unchanged.

**Permission grants:**

| Persona  | Perms before | Perms after | Delta              |
| -------- | -----------: | ----------: | ------------------ |
| Teacher  |           38 |          40 | +`IT-001:read+write` |
| Staff    |           18 |          20 | +`IT-001:read+write` |

School Admin and Platform Admin already hold `IT-001:admin` and `FAC-001:admin` via the `everyFunction: ['read','write','admin']` catalogue grant — no change needed there. Catalogue total stays at **447 functions × 3 tiers = 1341 permission codes** (no new entries; `IT-001` "Helpdesk Tickets" + `FAC-001` "Maintenance Tickets" are already in `permissions.json` from earlier cycles waiting for Cycle 8). Per the plan, FAC-001 read/write is **not** extended to non-admin staff — `IT-001` is the umbrella code the Step 4 TicketService will gate on for all ticket categories. School-side ticket admin paths (queue management, category tree editing, vendor management) reach `FAC-001:admin` via the `everyFunction` mechanism.

**What's seeded on `tenant_demo` (test tenant stays empty by convention — matches prior seeds):**

1. **3 top-level `tkt_categories`** — IT (icon=`computer`), Facilities (icon=`wrench`), HR Support (icon=`people`). All `is_active=true`. No nested categories this cycle; the hierarchy lives in `tkt_subcategories`.

2. **11 `tkt_subcategories`:**

   | Parent       | Subcategory       | default_assignee_id | auto_assign_to_role |
   | ------------ | ----------------- | -------------------: | ------------------: |
   | IT           | Hardware          | Sarah Mitchell (principal) | —                   |
   | IT           | Software          | —                    | —                   |
   | IT           | Network           | —                    | —                   |
   | IT           | Account Access    | —                    | —                   |
   | Facilities   | Electrical        | —                    | `SCHOOL_ADMIN`      |
   | Facilities   | Plumbing          | —                    | —                   |
   | Facilities   | HVAC              | —                    | —                   |
   | Facilities   | Cleaning          | —                    | —                   |
   | Facilities   | Furniture         | —                    | —                   |
   | HR Support   | Payroll Question  | —                    | —                   |
   | HR Support   | Benefits Question | —                    | —                   |

   IT/Hardware exercises the direct-assignee path; Facilities/Electrical exercises the role-resolution path. The other 9 leaves land tickets in the admin queue unassigned — the Step 4 TicketService will provide the default behaviour. Sarah Mitchell stands in as the IT admin for the demo since the `admin@` Platform Admin persona is intentionally NOT bridged to `hr_employees` per the Cycle 4 Step 0 design.

3. **12 SLA policies** — 3 categories × 4 priorities, identical shape across all 3 categories:

   | Priority  | response_hours | resolution_hours |
   | --------- | -------------: | ---------------: |
   | CRITICAL  |              1 |                4 |
   | HIGH      |              2 |                8 |
   | MEDIUM    |              4 |               24 |
   | LOW       |              8 |               72 |

   Live verification: `SELECT priority, response_hours, resolution_hours, c.name FROM tkt_sla_policies sla JOIN tkt_categories c ON c.id = sla.category_id` returned all 12 rows in the expected shape. In production each school would tune these per category; the demo uses one matrix.

4. **2 vendors:**
   - **Springfield IT Solutions** (`vendor_type=IT_REPAIR`, `is_preferred=true`, contact Patricia Nguyen `support@springfield-it.example` `+1-217-555-0420` `https://springfield-it.example`).
   - **Lincoln Maintenance Co** (`vendor_type=FACILITIES_MAINTENANCE`, `is_preferred=false`, contact Greg Owens `dispatch@lincoln-maintenance.example` `+1-217-555-0451` `https://lincoln-maintenance.example`).

5. **5 sample tickets** covering 5 of the 7 lifecycle states (PENDING_REQUESTER and CANCELLED are deliberately omitted — they require the Step 4 TicketService to drive transitions in production):

   | # | Title                              | Category          | Priority  | Status            | Assignee           |
   | - | ---------------------------------- | ----------------- | --------- | ----------------- | ------------------ |
   | 1 | Projector not working in Room 101  | IT/Hardware       | HIGH      | OPEN              | Sarah Mitchell     |
   | 2 | Leaking faucet in staff bathroom   | Facilities/Plumbing | MEDIUM  | IN_PROGRESS       | Sarah Mitchell     |
   | 3 | Can't access gradebook             | IT/Software       | HIGH      | RESOLVED          | Sarah Mitchell     |
   | 4 | Light out in hallway B             | Facilities/Electrical | LOW   | VENDOR_ASSIGNED   | Lincoln Maintenance Co |
   | 5 | Payroll date question              | HR Support/Payroll | LOW      | CLOSED            | Sarah Mitchell     |

   Requesters span Rivera (T1, T3, T5), Park (T2), and Hayes (T4) so the demo exercises the row-scope filter the Step 4 service will apply. Every ticket has its `sla_policy_id` populated so the SLA breach computation has a target. T2 has `first_response_at` populated; T3 and T5 have `first_response_at` + `resolved_at`; T4 has `first_response_at` + `vendor_assigned_at` + `vendor_reference='WO-2026-0451'`; T5 has `first_response_at` + `resolved_at` + `closed_at` populated end-to-end (passes the `resolved_chk` lifecycle invariant).

6. **3 sample comments:**
   - **T1 public:** "It started failing during 3rd period yesterday. The bulb still lights but no image on either input." — from Rivera, the requester.
   - **T2 internal:** "Need to order a P-trap replacement. Logged with maintenance for Friday." — from Mitchell. `is_internal=true`; the requester (Park) will not see this when the Step 4 CommentService filters comment lists for non-staff readers.
   - **T3 resolution:** "Cleared the cache and reset the gradebook permissions. Please confirm you can access again." — from Mitchell. Public, lands in T3's thread along with the RESOLVED status flip.

7. **8 activity rows** tracing lifecycle transitions across the 5 tickets:

   | Ticket | activity_type     | metadata                              | actor          |
   | ------ | ----------------- | ------------------------------------- | -------------- |
   | T1     | COMMENT           | `{is_internal:false}`                 | Rivera         |
   | T2     | STATUS_CHANGE     | `{from:OPEN, to:IN_PROGRESS}`         | Mitchell       |
   | T2     | COMMENT           | `{is_internal:true}`                  | Mitchell       |
   | T3     | STATUS_CHANGE     | `{from:OPEN, to:RESOLVED}`            | Mitchell       |
   | T3     | COMMENT           | `{is_internal:false}`                 | Mitchell       |
   | T4     | VENDOR_ASSIGNMENT | `{vendor_id, vendor_reference}`       | Mitchell       |
   | T4     | REASSIGNMENT      | `{from_assignee_id:null, to_vendor_id}` | Mitchell     |
   | T5     | STATUS_CHANGE     | `{from:OPEN, to:CLOSED}`              | Mitchell       |

   Total = 8 — matches the plan. T5's STATUS_CHANGE is a single roll-up entry (OPEN → CLOSED) rather than three discrete transitions because the historical seed represents a closed-out audit row; the Step 4 service in production will write 3 rows (OPEN → IN_PROGRESS → RESOLVED → CLOSED) as the lifecycle plays out.

8. **1 problem with 2 link rows** — "Network switch failure in Building A" — `status=INVESTIGATING`, `category_id=IT`, `assigned_to_id=Sarah Mitchell`, `created_by=principal@`. Linked to T1 (Projector) and T3 (Gradebook access). This is an architectural problem of the kind the Step 5 ProblemService.resolve admin endpoint will batch-resolve: documenting the root cause once and flipping every linked OPEN/IN_PROGRESS ticket to RESOLVED in one transaction. The seed leaves the problem in INVESTIGATING so the Step 9 UI has an in-flight row to render.

9. **1 auto-task rule** on `tkt.ticket.assigned`:
   - `priority='HIGH'`, `task_category='ADMINISTRATIVE'`, `due_offset_hours=24`, `is_system=true`, `is_active=true`.
   - `target_role=NULL` so the Step 4 Cycle 7 TaskWorker uses its `payload.recipientAccountId / accountId` fallback. The Step 4 TicketService will need to map the assignee's `hr_employees.id` to `platform_users.id` before emitting (similar to the AbsenceRequestNotificationConsumer's school-admin lookup pattern); the seed leaves the rule in place so the Step 4 implementation has a target rule to wire.
   - 1 `tsk_auto_task_actions` row: `action_type='CREATE_TASK'`, `sort_order=0`, empty `action_config`.
   - Title template: `Resolve ticket: {ticket_title}` — Worker's `template-render.ts` substitutes `{ticket_title}` from the event payload.
   - Description template: `SLA: {resolution_hours}h. Priority: {priority}.`

   Plan-time clarification: the plan says "due_offset = resolution_hours from the SLA policy." The seed sets a fixed 24h offset (matching the MEDIUM priority default) because `due_offset_hours` is a constant on the rule row, not a per-ticket lookup; the Step 4 service can override the offset by passing `dueAtOverride` in the event payload (a future TaskWorker enhancement). For the demo, 24h is a reasonable default that matches the MEDIUM SLA — HIGH and CRITICAL tickets will land in the same 24h-offset task and the assignee can self-prioritise from the priority field.

**Verification (live counts on `tenant_demo`):**

```
categories: 3                  tickets_open: 1
subcategories: 11              tickets_in_progress: 1
subcategories_with_default: 1  tickets_resolved: 1
subcategories_with_role: 1     tickets_vendor_assigned: 1
sla_policies: 12               tickets_closed: 1
vendors: 2                     comments: 3
preferred_vendors: 1           comments_internal: 1
tickets: 5                     activity: 8
                               problems: 1
                               problem_tickets: 2
                               auto_task_rules_tkt: 1
                               auto_task_actions_tkt: 1
```

All counts match the plan exactly. Idempotent re-run logs `tkt_categories already populated for demo school — skipping` with no INSERTs. `tenant_test` stays empty (`tkt_categories=0, tkt_tickets=0, tkt_problems=0`) — matches the test-tenant convention from prior seed scripts.

**Plan vs. catalogue reconciliation:** The plan's `IT-001` and `FAC-001` codes both already exist in `packages/database/data/permissions.json` (groups "IT & Technology" and "Facilities & Maintenance" respectively). No catalogue changes were needed. The plan's grant of "IT-001:admin + FAC-001:admin to School Admin/Platform Admin" is already in place via the `everyFunction: ['read','write','admin']` block on those two roles — no explicit row needed in `rolePermsSpec`. Only the Teacher and Staff IT-001 grants are net-new.

**Sample assignee resolution:** `findEmployeeId('principal@demo.campusos.dev')` returns Sarah Mitchell's `hr_employees.id` via the joined query through `platform.iam_person → platform.platform_users → hr_employees`. This mirrors the seed-tasks.ts pattern. Used for IT/Hardware's `default_assignee_id`, the assignee on T1/T2/T3/T5, and the problem's `assigned_to_id`.

**What's deferred to later steps:**

- Step 4 lands TicketService + CategoryService + SlaService + VendorService with ~18 endpoints. The auto-assignment chain (subcategory `default_assignee_id` → `auto_assign_to_role` → unassigned) is implemented in TicketService.create. The service emits `tkt.ticket.{submitted,assigned,resolved}` events — `tkt.ticket.assigned` feeds the Cycle 7 TaskWorker via the auto-task rule seeded in this step.
- Step 5 lands CommentService + ActivityService + ProblemService. The activity log is written by a private `recordActivity()` helper called from every lifecycle path. The seed left 8 activity rows in place for the Step 9 UI to render but the Step 5 service is the canonical writer going forward.
- Step 6 lands TicketNotificationConsumer subscribing to `tkt.ticket.{submitted,assigned,commented,resolved}` and routing to the Cycle 3 NotificationQueueService.

---

## Step 4 — Ticket NestJS Module — Core CRUD + Lifecycle

**Status:** DONE. New `apps/api/src/tickets/` with 4 services + 4 controllers + 1 DTO module + `TicketsModule`. Wired into `AppModule.imports` after `WorkflowsModule`. **18 endpoints** (5 categories + 2 SLA + 3 vendors + 8 tickets). Build clean, all routes mapped on boot, live smoke verified end-to-end on `tenant_demo`.

**Files:**

- `apps/api/src/tickets/dto/ticket.dto.ts` — DTOs with `class-validator` (CreateTicketDto with priority/category/subcategory/title/description/locationId; AssignTicketDto with `assigneeEmployeeId`; AssignVendorDto with `vendorId` + optional `vendorReference`; ResolveTicketDto with optional resolution note; CancelTicketDto with optional reason; ListTicketsQueryDto with status/priority/category/assignee/vendor/dateRange/includeTerminal filters; full Category / Subcategory / SLA / Vendor CRUD shapes; const arrays for `TICKET_PRIORITIES`, `TICKET_STATUSES`, `VENDOR_TYPES` driving `IsIn` validators).
- `apps/api/src/tickets/category.service.ts` + `category.controller.ts` — 5 endpoints. `GET /ticket-categories` returns the tree with subcategories inlined (single LEFT JOIN to `hr_employees`+`iam_person` for the default-assignee name); admin POST/PATCH on category + subcategory.
- `apps/api/src/tickets/sla.service.ts` + `sla.controller.ts` — 2 endpoints + the static `SlaService.computeSnapshot(input, policyId)` helper used by TicketService at read time. The clock is computed not stored: snapshot returns `responseHoursRemaining` / `resolutionHoursRemaining` (negative = breached) plus boolean `responseBreached` / `resolutionBreached`. Returns nulls when the matching timestamp is already populated (response done once `first_response_at` lands; resolution done once `resolved_at` lands). `upsert()` is admin-only and INSERTs or UPDATEs by `(school, category, priority)` so the matrix can be reshaped without a delete-then-recreate dance.
- `apps/api/src/tickets/vendor.service.ts` + `vendor.controller.ts` — 3 endpoints. `GET /ticket-vendors` sorts `is_preferred DESC, vendor_name ASC` so the Step 8 admin assignment dropdown shows preferred vendors at the top. POST + PATCH admin-only with UNIQUE(school, vendor_name) catch.
- `apps/api/src/tickets/ticket.service.ts` + `ticket.controller.ts` — **the keystone.** 8 endpoints (`GET /tickets` + `GET /tickets/:id` + `POST /tickets` + `PATCH /:id/{assign,assign-vendor,resolve,close,reopen,cancel}`). All 6 lifecycle transitions use `executeInTenantTransaction` with `SELECT … FOR UPDATE` on the ticket row — the locked-read pattern from Cycles 4–7. Emits `tkt.ticket.{submitted,assigned,resolved}`.
- `apps/api/src/tickets/tickets.module.ts` — wires the 4 services + 4 controllers, imports `TenantModule + IamModule + KafkaModule`.

**Auto-assignment chain at submission time:** `TicketService.create()` resolves the assignee in this order:

1. If `subcategoryId` is set and the subcategory has `default_assignee_id` (a `hr_employees` row), use that.
2. Else if the subcategory has `auto_assign_to_role`, resolve the role via the same lookup the WorkflowEngineService uses for ROLE-typed approvers. The `roleTokenToName()` exported helper from `workflow-engine.service.ts` is reused (`'SCHOOL_ADMIN'` → `'School Admin'`); the resolved `platform_users.id` is then bridged through `iam_person` → `hr_employees` to land an `assignee_id` (FK to `hr_employees(id)` on the ticket). Returns null when the role only resolves to a person without an `hr_employees` row (e.g. the `admin@` Platform Admin persona which is intentionally not bridged per Cycle 4 Step 0) — the ticket lands unassigned with a LOG line.
3. Else leave assignee NULL — the ticket lands in OPEN status and waits for the admin queue.

When auto-assignment lands an internal employee, status flips OPEN → IN_PROGRESS and `first_response_at` is populated (the system acknowledges on the assignee's behalf). Otherwise status=OPEN with `first_response_at` NULL until the first admin / assignee comment lands.

**SLA auto-link at submission:** `SlaService.lookupPolicyId(categoryId, priority)` finds the matching `tkt_sla_policies` row and denormalises its id onto the ticket. Returns null when no policy is configured — admin UI can then suggest configuring one.

**Locked-row state machine transitions** (every PATCH endpoint runs `SELECT … FOR UPDATE` on the ticket row inside `executeInTenantTransaction`):

| Endpoint                             | Permission     | From states                                                          | To state         | Side effects                                                                                          |
| ------------------------------------ | -------------- | -------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| `PATCH /:id/assign`                  | `it-001:admin` | OPEN, IN_PROGRESS, VENDOR_ASSIGNED, PENDING_REQUESTER                | IN_PROGRESS      | Sets `assignee_id`, clears vendor fields, sets `first_response_at` if NULL. Emits `tkt.ticket.assigned`. |
| `PATCH /:id/assign-vendor`           | `it-001:admin` | OPEN, IN_PROGRESS, VENDOR_ASSIGNED, PENDING_REQUESTER                | VENDOR_ASSIGNED  | Sets `vendor_id` + `vendor_reference` + `vendor_assigned_at`, clears `assignee_id`. No `tkt.ticket.assigned` emit (auto-task targets internal employees, not vendors). |
| `PATCH /:id/resolve`                 | `it-001:write` | non-terminal                                                         | RESOLVED         | Sets `resolved_at`. Optional resolution note inserted as a public `tkt_ticket_comments` row in same tx. Emits `tkt.ticket.resolved`. |
| `PATCH /:id/close`                   | `it-001:write` | RESOLVED                                                             | CLOSED           | Sets `closed_at`. Requester or admin only.                                                             |
| `PATCH /:id/reopen`                  | `it-001:write` | RESOLVED                                                             | OPEN             | Clears `resolved_at`. Requester or admin only. CLOSED is terminal — admin path only.                  |
| `PATCH /:id/cancel`                  | `it-001:write` | OPEN, IN_PROGRESS, VENDOR_ASSIGNED, PENDING_REQUESTER                | CANCELLED        | Sets `closed_at`, keeps `resolved_at` NULL per `resolved_chk`. Cancelling a RESOLVED ticket is rejected (use close instead). Requester or admin. |

Every transition writes a `tkt_ticket_activity` row via the private `recordActivity()` helper — STATUS_CHANGE / REASSIGNMENT / VENDOR_ASSIGNMENT / COMMENT entries with structured `metadata` JSONB matching the Step 3 seed shape.

**Row scope on GET /tickets:** admin sees all; non-admin sees `requester_id = actor.accountId` OR `assignee_id = actor.employeeId` (when actor has an `hr_employees` row). The two predicate paths exist because the referenced columns are different identity types — `requester_id` is a soft `platform.platform_users.id` ref, `assignee_id` is a DB-enforced FK to `hr_employees.id`. `GET /tickets/:id` short-circuits with 404 (not 403) when neither path matches, matching the don't-leak-existence pattern from prior cycles.

**Permission gating:**

- `it-001:read` — list + read tickets, categories, vendors, SLA matrix.
- `it-001:write` — submit ticket + lifecycle transitions on tickets the caller can act on.
- `it-001:admin` — category / subcategory / SLA / vendor CRUD; ticket assign + assign-vendor.

`fac-001:admin` is reached via the School Admin / Platform Admin `everyFunction` block — same admin tier as `it-001:admin` per the Step 3 seed plan.

**Kafka emits** (3 topics, all wired through `KafkaProducerService.emit(...)` so the ADR-057 envelope wraps every payload with `event_type` / `source_module:'tickets'` / `tenant_id` / fresh `event_id` + `correlation_id`):

- `tkt.ticket.submitted` — fires on every successful POST. Payload: `{ticketId, schoolId, categoryId, subcategoryId, title, priority, status, requesterId, slaPolicyId}`.
- `tkt.ticket.assigned` — fires on POST when auto-assignment landed an internal employee, AND on every successful `PATCH /:id/assign`. Payload includes the assignee's resolved `accountId` + `recipientAccountId` (Sarah's `platform_users.id`, both fields kept for Cycle 7 TaskWorker fallback compatibility), `ticket_title` / `priority` / `resolution_hours` placeholders for the seeded auto-task title-template, plus `sourceRefId: dto.id` so the worker's per-(owner, source_ref_id) Redis dedup catches "different event_id but same logical assignment" if a future endpoint re-emits.
- `tkt.ticket.resolved` — fires on every successful resolve. Payload: `{ticketId, schoolId, title, priority, status, assigneeId, requesterId, resolvedAt}`. Step 6 will subscribe a notification consumer to this topic.

**TaskWorker side-fix:** the existing `pickSourceRefId(payload)` helper in `apps/api/src/tasks/task.worker.ts` had a per-domain candidate list (`assignmentId`, `gradeId`, `requestId`, etc.) that did not include the universal `sourceRefId` field. Cycle 8 emits use that universal name. **Extended the candidate list** to include `sourceRefId` / `source_ref_id` (universal escape hatch) at the top of the list, plus `ticketId` / `ticket_id` for completeness. Verified live: with the fix, the auto-task created from a fresh `tkt.ticket.assigned` event has `source_ref_id` populated to the ticket's id. Without the fix, the auto-task lands with `source_ref_id=NULL` (functionally fine for one-shot creation but breaks the per-(owner, source_ref_id) Redis dedup that Cycle 7 documented).

**Live verification on `tenant_demo` 2026-05-03** (10 scenarios, all pass):

1. **S1** — teacher `GET /ticket-categories` returns 3 cats with subcategories inlined (IT 4 / Facilities 5 / HR Support 2).
2. **S2** — teacher `GET /ticket-vendors` returns Springfield IT Solutions (preferred) first, Lincoln Maintenance Co second.
3. **S3** — teacher `GET /ticket-sla` returns 12 policies grouped by category × priority urgency.
4. **S4 keystone** — teacher (Rivera) `POST /tickets` on IT/Hardware HIGH → response shows `assigneeName: 'Sarah Mitchell'` (auto-assigned via subcategory.default_assignee_id), `status: 'IN_PROGRESS'`, `slaPolicyId` populated, `firstResponseAt` populated, `sla.responseHours: 2`, `sla.resolutionHours: 8`, `sla.responseBreached: false`. **Two ADR-057 envelopes captured live on the wire** — `dev.tkt.ticket.submitted` with `event_type='tkt.ticket.submitted'`, `source_module='tickets'`, full payload; and `dev.tkt.ticket.assigned` with `accountId` + `recipientAccountId` set to Sarah's `platform_users.id`, `ticket_title` + `resolution_hours: 8` + `priority: HIGH` placeholders, `sourceRefId` set to the new ticket's id. Cycle 7 TaskWorker fired within ~3s and created an AUTO/ADMINISTRATIVE task on Sarah's list titled `Resolve ticket: Smoke ticket — Hardware`.
5. **S5** — admin `GET /tickets?includeTerminal=true` returns all 6 tickets (5 seed + 1 smoke) sorted by priority urgency.
6. **S6** — teacher `GET /tickets?includeTerminal=true` returns 4 rows (Rivera is requester on T1 + T3 + T5 + smoke); T2 and T4 (Park's + Hayes's) correctly filtered out.
7. **S7** — admin `PATCH /:id/assign-vendor` with Springfield IT Solutions + `vendorReference='WO-SMOKE-01'` → response shows `status: 'VENDOR_ASSIGNED'`, `assigneeId: null`, `vendorName: 'Springfield IT Solutions'`. The schema-level `tkt_tickets_assignee_or_vendor_chk` mutex is satisfied because we cleared the assignee in the same UPDATE.
8. **S8** — admin `PATCH /:id/resolve` with `resolution: 'Vendor swapped the projector lamp.'` → response shows `status: 'RESOLVED'`, `resolvedAt` populated. The optional resolution note landed as a public `tkt_ticket_comments` row in the same transaction.
9. **S9** — requester (teacher) `PATCH /:id/close` → response shows `status: 'CLOSED'`, `closedAt` populated. Multi-column `resolved_chk` satisfied (CLOSED requires both `resolved_at` and `closed_at` NOT NULL — both already populated by the prior resolve).
10. **S10 — 7 permission denial paths:** student GET /tickets 403 (no `it-001:read`); parent POST /tickets 403 (no `it-001:write`); teacher POST /ticket-categories 403 (no `it-001:admin`); teacher POST /ticket-vendors 403 (admin only); teacher PATCH /:id/assign 403 (admin only); parent GET /tickets/:id 403 (no `it-001:read` at the gate); teacher GET /tickets/:T2_id 404 (row scope — Rivera is neither requester nor assignee on Park's plumbing ticket).

**Iteration issue caught and resolved during smoke:** initial smoke command pasted `IT_CAT` from a `psql -tA -c "SET ...; SELECT ..."` command — the `SET` command tag concatenated to the UUID, breaking the POST. Switched to schema-qualified queries (`SELECT id FROM tenant_demo.tkt_categories WHERE name = 'IT'`) without the leading `SET search_path`. Same iteration trap documented for prior cycles' smoke scripts.

**Smoke residue cleanup:** `DELETE FROM tsk_tasks WHERE title LIKE 'Resolve ticket: Smoke ticket%'` (drops the 2 AUTO tasks the worker created across the two smoke runs); `DELETE FROM tkt_tickets WHERE title LIKE 'Smoke ticket%'` (drops the 2 smoke tickets — CASCADE drops their comments + activity rows automatically). Tenant restored to post-Step-3 seed state. Confirmed via `count(*)` on both tables.

**What's deferred to later steps:**

- Step 5 lands `CommentService` + `ActivityService` + `ProblemService` — extracts `recordActivity()` from inside TicketService into a dedicated injectable so multiple services can call it. Adds `GET /tickets/:id/comments` + `POST /tickets/:id/comments` (with `is_internal` filter for non-staff readers) + `GET /tickets/:id/activity` (read-only timeline) + 6 `/problems` endpoints (list / detail / create / patch / link / resolve-batch).
- Step 6 ships `TicketNotificationConsumer` subscribing to `tkt.ticket.{submitted,assigned,commented,resolved}` — fans out IN_APP notifications via the Cycle 3 NotificationQueueService. The auto-task wiring is **already live** through the `tkt.ticket.assigned` rule seeded in Step 3 plus the `pickSourceRefId` fix from this step.
- Cycle 7 carry-over noted: the worker fix to recognise `sourceRefId` / `ticketId` is a small additive change to `pickSourceRefId` that benefits any future emitter that wants per-(owner, source_ref_id) Redis dedup without adding a per-domain alias to the candidate list.

---

## Step 5 — Ticket NestJS Module — Comments, Activity, Problems

**Status:** DONE. New `apps/api/src/tickets/activity.service.ts` + `comment.service.ts` + `problem.service.ts` + matching controllers + DTO extensions. Total cycle endpoint count: **27** (18 from Step 4 + 9 new — 1 activity + 2 comments + 6 problems). Build clean on first try, all routes mapped on boot, live smoke verified end-to-end on `tenant_demo`.

**Files:**

- `apps/api/src/tickets/dto/ticket.dto.ts` — extended with comment / activity / problem shapes (`TicketCommentResponseDto`, `CreateCommentDto`, `TicketActivityResponseDto`, `ProblemResponseDto`, `CreateProblemDto`, `UpdateProblemDto`, `LinkTicketsDto`, `ResolveProblemDto`, `ListProblemsQueryDto`, plus `ACTIVITY_TYPES` + `PROBLEM_STATUSES` const arrays). Required `@IsArray()` + `@ArrayMinSize(1)` + `@IsUUID('all', { each: true })` on every `ticketIds` array DTO field — without those decorators the global `forbidNonWhitelisted: true` ValidationPipe drops the property silently. Tripped during smoke and fixed before the second run.
- `apps/api/src/tickets/activity.service.ts` + `activity.controller.ts` — 1 read endpoint `GET /tickets/:id/activity` under `it-001:read` with row-scope guard (admin OR requester OR assignee, else 404 — same don't-leak-existence convention as `TicketService.getById`). The `ActivityService.record(tx, ticketId, actorId, type, metadata)` public method is the canonical writer; Step 4's `TicketService.recordActivity()` private helper now delegates to it so the audit log goes through one path.
- `apps/api/src/tickets/comment.service.ts` + `comment.controller.ts` — 2 endpoints `GET /tickets/:id/comments` + `POST /tickets/:id/comments` under `it-001:read` / `it-001:write`. Visibility model implemented at the service layer (admin sees all; assignee sees all; requester sees `is_internal=false` only; non-participant non-admin → 404). POST runs everything in one `executeInTenantTransaction`: INSERT into `tkt_ticket_comments` → if first staff comment AND `first_response_at` IS NULL bump it to `now()` (stops the SLA response clock; staff = anyone other than the requester) → ActivityService.record(...) for the COMMENT row. Emits `tkt.ticket.commented` outside the tx with `firstResponseBumped` flag so the Step 6 notification consumer can surface a "ticket has been responded to" UX cue. Comments on CLOSED / CANCELLED tickets rejected with 403 (caller must reopen first). Public `writeInTx(tx, ticketId, authorId, body, isInternal)` helper added for ProblemService and any future caller that needs an audit-only comment without the full POST path.
- `apps/api/src/tickets/problem.service.ts` + `problem.controller.ts` — 6 endpoints under `it-001:read` (read paths) + `it-001:admin` (writes). All read + write paths short-circuit non-admins at the service layer with 403 (reads) — service-layer admin gate matches Cycle 6 RefundService precedent. Total read/write/admin gating still works because `it-001:admin` is held only via School Admin / Platform Admin's `everyFunction` block.
  - `GET /problems` — list with linked-ticket ids inline; sorted by status urgency then created_at desc; filters `status` + `categoryId`.
  - `GET /problems/:id` — detail with linked tickets array.
  - `POST /problems` — admin creates; optional `ticketIds` array seeds links at creation; multi-column DB CHECK enforces `assigned_to_id` XOR `vendor_id` (also surfaced at the service layer with a friendlier error).
  - `PATCH /problems/:id` — locks the row FOR UPDATE, updates non-status-RESOLVED fields. **Status RESOLVED is rejected here** with a friendly 400 — the batch ticket-flip is a separate code path on `/resolve`. The schema's multi-column `resolved_chk` would also reject a half-populated RESOLVED PATCH (it requires root_cause + resolution + resolved_at all NOT NULL); we surface the 400 before the constraint fires.
  - `POST /problems/:id/link` — adds more tickets. Validates each ticket id exists, deduplicates against already-linked rows in the same tx so the schema's UNIQUE(problem_id, ticket_id) never fires.
  - `PATCH /problems/:id/resolve` — **the keystone batch-resolve endpoint.** Locks the problem row + every linked ticket whose status is in (`OPEN`, `IN_PROGRESS`, `VENDOR_ASSIGNED`, `PENDING_REQUESTER`) using `FOR UPDATE OF t` inside one tenant transaction. Flips problem to RESOLVED with `root_cause` + `resolution` + optional `workaround` + `resolved_at = now()`. Batch-flips every locked ticket to RESOLVED + `resolved_at = now()` and writes a STATUS_CHANGE activity row per ticket (metadata `{from, to: 'RESOLVED', reason: 'batch resolved via problem ID', problem_id}`). Tickets already in RESOLVED / CLOSED / CANCELLED are skipped (the `WHERE t.status = ANY($2)` filter). Emits one `tkt.ticket.resolved` event per flipped ticket OUTSIDE the tx (so a broker hiccup can't roll back), each with `resolvedViaProblemId` + `sourceRefId` populated. Returns `{problem, ticketsFlipped: string[]}` so the Step 9 admin UI can surface the count.
- `apps/api/src/tickets/tickets.module.ts` — extended providers + controllers + exports lists with the 3 new services.

**Comment visibility model (clarified):**

| Caller             | Sees public | Sees internal |
| ------------------ | :---------: | :-----------: |
| Admin              |     ✅      |      ✅       |
| Assignee on ticket |     ✅      |      ✅       |
| Requester          |     ✅      |      ❌       |
| Non-participant    |  404 — fail-closed without leaking existence    |

`POST` honours `is_internal=true` only when the caller is admin or assignee. Requesters who try to set it are silently demoted to `is_internal=false` (the staff/internal distinction is a staff-side concern; surfacing a 400 to a requester whose comment was still saved would be confusing).

**First-response bump rule:** a comment from anyone other than the requester counts as "the first staff response." When `tkt_tickets.first_response_at IS NULL` and the comment author is the assignee or admin, the same UPDATE that touches `updated_at` also sets `first_response_at = now()`. The activity row carries `metadata.first_response_bump: true` so the audit trail records which comment landed the SLA response stop. Subsequent staff comments do not re-bump (the field is monotonic).

**Live verification on `tenant_demo` 2026-05-03** (12 scenarios, all pass):

1. **A1** — Rivera (T1 requester) GET activity → 1 row (the seed COMMENT). `actorName: 'James Rivera'`.
2. **A2** — Sarah (admin) GET activity for the same ticket → same 1 row.
3. **A3** — Rivera GET T3 activity → 2 rows (STATUS_CHANGE OPEN→RESOLVED + COMMENT).
4. **A4** — David Chen (parent, no `it-001:read`) GET activity → 403 at the gate.
5. **C1** — Rivera GET comments on T1 → 1 (seed public) before any new posts.
6. **C2** — admin posts public comment "I will swing by Room 101 after lunch." → response shows `isInternal: false`, `firstResponseAt` on T1 bumps from NULL to now() (verified in DB).
7. **C3** — admin posts internal comment "ordered a replacement lamp" with `isInternal=true` → response confirms `isInternal: true`. Comment count on T1 = 3.
8. **C5** — Rivera (requester) GET comments → sees 2 (seed + C2 public). C3 internal correctly filtered out.
9. **C6** — admin GET comments → sees all 3.
10. **C7** — Rivera tries to POST with `isInternal: true` → response shows `isInternal: false` (silent demote).
11. **C8** — T1 activity now 4 rows: seed COMMENT, then C2 with `first_response_bump: true`, then C3 with `first_response_bump: false` (already bumped), then C7 with `first_response_bump: false` (requester comment doesn't bump).
12. **C9** — Kafka envelope on `dev.tkt.ticket.commented` captured live with full ADR-057 shape: `event_type='tkt.ticket.commented'`, `source_module='tickets'`, payload `{ticketId, schoolId, commentId, authorId, isInternal:false, firstResponseBumped:true, sourceRefId}`. (The Step 6 notification consumer will key on `firstResponseBumped` to surface a different message to the requester.)
13. **P1** — admin GET /problems → 1 row (the seed) with `ticketIds: 2`.
14. **P2** — teacher GET /problems → 403 (service-layer admin-only).
15. **P3** — admin GET /problems/:id → details with `ticketIds: [T1, T3]` inline.
16. **P4** — admin PATCH status=KNOWN_ERROR with `rootCause` → response shows `status: KNOWN_ERROR, rootCause` populated.
17. **P5** — admin PATCH status=RESOLVED via main endpoint → 400 with the friendly `Use POST /problems/:id/resolve` message.
18. **P6** — admin POST /:id/link with T2 → response shows 3 ticketIds.
19. **P7** — duplicate link of T2 → silent skip; count stays at 3.
20. **P9 keystone** — admin PATCH /:id/resolve with rootCause + resolution + workaround → response shows `problem.status: RESOLVED`, `ticketsFlipped: [T1, T2]` (T3 already RESOLVED so skipped). DB confirms all 3 linked tickets are now RESOLVED with `resolved_at` populated; T1 was OPEN→RESOLVED; T2 was IN_PROGRESS→RESOLVED; T3 was already RESOLVED so left untouched.
21. **P11** — T1 activity now has 5 rows including the new STATUS_CHANGE with `metadata: {from: 'OPEN', to: 'RESOLVED', reason: 'batch resolved via problem 019df018-610e-…', problem_id}`.
22. **P12** — Kafka envelope on `dev.tkt.ticket.resolved` captured live for the second flipped ticket (T2): full ADR-057 shape with `resolvedViaProblemId` + `sourceRefId` + `assigneeId: <Sarah>` + `requesterId: <Park>` populated.
23. **Permission denials** — teacher POST /problems 403; teacher PATCH /:id/resolve 403; teacher GET /tickets/:T2/activity 404 (row scope, T2 is Park's not Rivera's); teacher POST /tickets/:T2/comments 404 (same row scope).

**Iteration issues caught and resolved during smoke:**

- **Missing class-validator decorators on array DTOs.** `LinkTicketsDto.ticketIds` and `CreateProblemDto.ticketIds` shipped without `@IsArray()` + `@IsUUID('all', { each: true })`. The global `ValidationPipe` with `forbidNonWhitelisted: true` then dropped the property silently and the controller saw an empty body, returning `"property ticketIds should not exist"`. Pattern to remember for any future array DTO field. Fix: add the validators and `@ArrayMinSize(1)` where the empty case should error explicitly.
- **API-fully-up wait.** Earlier smoke runs fired `dev-login` while the 11 Kafka consumer subscribes were still in flight — the API responded with empty bodies. Resolved by waiting until the `Nest application successfully started` log line lands (typically ~30s on a cold cache). Same pattern documented in prior cycles.

**Smoke residue cleanup** (live SQL on `tenant_demo`):

- DELETE 3 smoke comments (C2 / C3 / C7) — bodies starting with `Smoke C`.
- DELETE 3 COMMENT activity rows that the bumping wrote (filter on `metadata ? 'first_response_bump'`).
- DELETE 2 STATUS_CHANGE activity rows from the batch resolve (filter on `metadata->>'reason' LIKE '%batch resolved via problem%'`).
- UPDATE T1 → `first_response_at = NULL`, `status = 'OPEN'`, `resolved_at = NULL` (revert the SLA bump + the batch resolve).
- UPDATE T2 → `status = 'IN_PROGRESS'`, `resolved_at = NULL` (revert the batch resolve; the seed had it IN_PROGRESS).
- DELETE the link row for T2 (the smoke linked it to the problem; seed only had T1 + T3).
- UPDATE problem row → back to `status = 'INVESTIGATING'`, root_cause / resolution / workaround / resolved_at all NULL (the seed shape).

Post-cleanup verification: T1 has 1 comment (seed), `first_response_at` is NULL, status=OPEN. Problem is back to INVESTIGATING with no resolved_at. Link table back to 2 rows (T1 + T3, the original seed). Tenant is at the post-Step-3 seed shape.

**What's deferred to later steps:**

- Step 6 lands `TicketNotificationConsumer` subscribing to `tkt.ticket.{submitted,assigned,commented,resolved}` — fans out IN_APP notifications via the Cycle 3 NotificationQueueService. The auto-task wiring is **already live** through the `tkt.ticket.assigned` rule seeded in Step 3 plus the `pickSourceRefId` fix from Step 4. Step 6 also wires a downstream consumer on `tkt.ticket.resolved` to mark linked auto-tasks DONE via the `source_ref_id = ticket_id` match (the field that's been in the payload from Step 4).
- The `tkt_ticket_attachments` table is shipped + tested at the schema layer (Step 2) but no service / endpoint surface yet — Step 7 will add the upload UI when the helpdesk staff surface lands.

---

## Step 6 — Ticket Notification Consumer + Auto-Task Wiring

**Status:** DONE. Two new Kafka consumers wired in: `TicketNotificationConsumer` (in `apps/api/src/notifications/consumers/`) fans out IN_APP notifications via the Cycle 3 NotificationQueueService for the four ticket lifecycle topics; `TicketTaskCompletionConsumer` (in `apps/api/src/tasks/`) closes the auto-task DONE-cascade on `tkt.ticket.resolved`. Build clean on first try, both consumers subscribe successfully on boot, live smoke verified end-to-end on `tenant_demo` with the IN_APP delivery worker confirming the requester + assignee see the notifications in Redis.

**Files:**

- `apps/api/src/notifications/consumers/ticket-notification.consumer.ts` — new consumer subscribed under group `ticket-notification-consumer` to all four topics: `dev.tkt.ticket.submitted`, `dev.tkt.ticket.assigned`, `dev.tkt.ticket.commented`, `dev.tkt.ticket.resolved`. Uses the standard `unwrapEnvelope` + `processWithIdempotency` claim-after-success pattern from `notification-consumer-base.ts` (REVIEW-CYCLE2 BLOCKING 2). Per-event the consumer:
  1. Loads `TicketContext` — denormalised join across `tkt_tickets + tkt_categories + hr_employees + platform.iam_person + platform.platform_users` to surface the assignee's `platform_users.id` (when one exists) without re-querying for each event type.
  2. Routes to one of four `fanOutXxx()` methods.
  3. Calls `NotificationQueueService.enqueue()` once per recipient with `idempotencyKey = '<type>:<eventId>:<recipient>'` so a Kafka redelivery never enqueues twice.

- `apps/api/src/tasks/ticket-task-completion.consumer.ts` — new consumer subscribed under group `ticket-task-completion-consumer` to `dev.tkt.ticket.resolved` only. Per event, runs `UPDATE tsk_tasks SET status='DONE', completed_at=COALESCE(completed_at, now())` with `WHERE source='AUTO' AND source_ref_id=$ticketId AND status NOT IN ('DONE', 'CANCELLED') RETURNING ...` — captures the flipped rows so we can emit one `task.completed` per row outside the tx. The `NOT IN (DONE, CANCELLED)` filter is the schema-side belt-and-braces; a Kafka redelivery lands a no-op since the rows are already DONE. The deliberate choice to live in `apps/api/src/tasks/` rather than alongside the other consumers in `notifications/consumers/`: it's a Tasks-domain side effect (DB write + emit), not a notification fan-out.

- `apps/api/src/notifications/notifications.module.ts` — registers `TicketNotificationConsumer` in the providers list.
- `apps/api/src/tasks/tasks.module.ts` — registers `TicketTaskCompletionConsumer` in the providers list.

**Notification fan-out matrix:**

| Topic                  | Recipient(s)                                                  | Notification type   | Notes |
| ---------------------- | -------------------------------------------------------------- | ------------------- | ----- |
| `tkt.ticket.submitted` | Every account with `sch-001:admin` (school admins + Platform Admin) | `ticket.submitted`  | Same `loadSchoolAdminAccounts` lookup as `AbsenceRequestNotificationConsumer`. |
| `tkt.ticket.assigned`  | The assignee — `payload.recipientAccountId` (Step 4 emit pre-resolved) with fallback to the context-loaded `assigneeAccountId`. | `ticket.assigned`   | Vendor assignments deliberately do not emit `tkt.ticket.assigned` (Step 4 design — vendors don't have a Tasks app). |
| `tkt.ticket.commented` (public, requester author) | Assignee + admins (admins only when assignee is null so the comment doesn't dead-letter). | `ticket.commented`  | Excludes the author from the recipient set. |
| `tkt.ticket.commented` (public, staff author) | Requester only.                                                 | `ticket.commented`  | The "first staff response" UX cue — payload includes `first_response_bumped` flag. |
| `tkt.ticket.commented` (internal) | Assignee + other admins (NOT the requester — internal stays staff-side). | `ticket.commented`  | Author always excluded. |
| `tkt.ticket.resolved`  | Requester only.                                                 | `ticket.resolved`   | Skipped when requester == resolver (admin resolving own self-submitted ticket). Payload includes `resolved_at` + `resolved_via_problem_id`. |

The `deep_link` field on every payload is `/helpdesk/<ticketId>` so the Step 7 staff UI can navigate the recipient straight to the detail page from the bell.

**Auto-task DONE-cascade flow (closes the Step 3 + Step 4 loop):**

1. Step 3 seeded a `tkt.ticket.assigned` rule in `tsk_auto_task_rules` — Cycle 7 TaskWorker reaction creates an AUTO/ADMINISTRATIVE task on the assignee's list.
2. Step 4 emits `tkt.ticket.assigned` with `sourceRefId: ticketId` so the worker stores the linkage on `tsk_tasks.source_ref_id` (after the Step 4 worker fix to recognise the universal `sourceRefId` field).
3. **Step 6** subscribes to `tkt.ticket.resolved` and runs the `UPDATE … RETURNING` against the tenant schema. Every flipped task gets a `task.completed` Kafka emit so the Cycle 3 notification pipeline can fan it out (the existing `task.completed` consumer chain handles delivery).

The plan called for "a new auto-task condition on this topic marks the linked task DONE." We chose a dedicated consumer rather than extending the `tsk_auto_task_actions.action_type` enum because the schema's enum is a 3-value CHECK constraint (CREATE_TASK / CREATE_ACKNOWLEDGEMENT / SEND_NOTIFICATION). Adding `MARK_TASK_DONE` would require a tenant migration + worker change. A focused consumer keeps the TaskWorker focused on creation and lets Step 6 ship without touching the Cycle 7 surface — future cycles can generalise into a rule engine if more inverse flows arrive.

**Live verification on `tenant_demo` 2026-05-03** (13 scenarios, all pass):

- **N1** — Teacher Rivera POSTs an IT/Hardware HIGH ticket "Step 6 Smoke — Notification" → response shows `assigneeName: 'Sarah Mitchell'` (auto-assigned via the seeded subcategory.default_assignee_id), `status: IN_PROGRESS`.
- **N2** — `ticket.submitted` queue rows: 2 — `admin@` (Platform Admin) + `principal@` (Sarah Mitchell). Both are correctly fanned out via the `sch-001:admin` lookup.
- **N3** — `ticket.assigned` queue: 1 row to `principal@` (the auto-resolved Sarah). Payload includes the `recipientAccountId` field the Step 4 emit pre-populated.
- **N4** — Sarah POSTs a public comment → response `isInternal: false`. The Step 5 first-response bump on the ticket already happened on the auto-assignment path so this comment is a follow-up, not the first response.
- **N5** — `ticket.commented` queue: 1 row to `teacher@` Rivera (the requester) with `is_internal=false`, `first_response_bumped=false`.
- **N6** — Sarah POSTs an internal comment → `isInternal: true`.
- **N7** — `ticket.commented` queue still has only 1 row routed to teacher@; the internal comment did NOT fan out to the requester. The fan-out matrix correctly routed the internal comment to admin@ Platform Admin (Sarah excluded as the author). Verified via `SELECT count(*) WHERE notification_type='ticket.commented' AND email='teacher@…'` returning 1, plus the second row visible to admin@.
- **N8** — Pre-resolve state: AUTO task on Sarah's list `Resolve ticket: Step 6 Smoke — Notification` status=TODO, `source_ref_id` populated to the smoke ticket id.
- **N10** — Sarah resolves the ticket → status=RESOLVED, resolvedAt populated.
- **N11** — Post-resolve state: AUTO task flipped from TODO → DONE with `completed_at` populated to the same second the ticket resolved at. **Auto-task DONE-cascade verified live.**
- **N12** — `ticket.resolved` queue: 1 row to teacher@ Rivera (the requester) with `payload.ticket_title='Step 6 Smoke — Notification'`.
- **N13** — TicketTaskCompletionConsumer log line captured: `[ticket-task-completion] flipped 1 auto-task(s) DONE for ticket 019df044-…`.
- **IN_APP delivery via Redis ZSET (after the 10s NotificationDeliveryWorker tick):** Rivera's `notif:inapp:<accountId>` ZSET top entry is the `ticket.resolved` notification with full payload; entry below is the `ticket.commented` from N4. Sarah's ZSET top entries are `ticket.assigned` + `ticket.submitted`. **Full pipeline (Kafka → consumer → queue → delivery worker → Redis) verified end-to-end.**
- **Iteration issue caught (test-data only):** initial smoke SQL used column name `recipient_account_id` but the actual column on `msg_notification_queue` is `recipient_id`. Fixed and re-ran. Worth noting for the Step 10 CAT cleanup script.

**Smoke residue cleanup:** drop the AUTO task (already DONE) + the 6 `ticket.*` queue rows + the smoke ticket (CASCADE drops the 2 smoke comments + 4 activity rows). Redis ZSET entries for the 2 smoke notifications also removed via `ZREM`. Tenant restored to post-Step-3 seed state. No new artifacts left behind.

**Total Cycle 8 consumers now: 2 (Step 6).** Total Kafka topics emitted by the cycle: 4 (`tkt.ticket.submitted` / `assigned` / `commented` / `resolved` from Steps 4 + 5) + 1 republish (`task.completed` from the DONE-cascade in Step 6).

**What's deferred to later steps:**

- Step 7 lands the helpdesk staff UI (`/helpdesk/new`, `/helpdesk`, `/helpdesk/:id`) — the deep links the notification payloads point at finally have a destination.
- Step 8 lands the helpdesk admin UI with the SLA dashboard + category/vendor management.
- Step 9 lands the problem management UI (the Step 5 ProblemService is already complete on the API side).
- Step 10 lands the vertical-slice CAT walking the full plan flow end-to-end.
- The notification descriptor map in `apps/web/src/components/notifications/NotificationBell.tsx` will need 4 new entries (one per `ticket.*` notification type) so the bell renders human-readable titles — punted to Step 7 since it ships alongside the helpdesk UI.

---

## Step 7 — Helpdesk UI — Submit + My Tickets

**Status:** DONE. New `Helpdesk` launchpad tile + 3 routes ship the staff-facing ticket lifecycle on the web. Build clean (one minor fix-up during the first build — `EmptyState` uses `action` not `actions`, `useToast()` returns `{toast}` not `{show}`). All 3 routes register cleanly in the Next.js build output. No API changes required — every new surface sits on the 27 endpoints from Steps 4 + 5.

**Files:**

- `apps/web/src/lib/types.ts` — extended with the full Cycle 8 DTO surface: `TicketPriority` / `TicketStatus` / `VendorType` / `TicketActivityType` / `ProblemStatus` union types; `TicketCategoryDto` + `TicketSubcategoryDto` (the categories endpoint inlines subcategories); `TicketSlaPolicyDto` + `TicketVendorDto`; `TicketSlaSnapshotDto` (computed at read time); `TicketDto` with the SLA snapshot inlined; `TicketCommentDto` + `TicketActivityDto`; payloads (`CreateTicketPayload`, `AssignTicketPayload`, `AssignVendorPayload`, `ResolveTicketPayload`, `CancelTicketPayload`, `CreateTicketCommentPayload`); `ListTicketsArgs` filter shape; `ProblemDto` (used by Step 9's admin surface).
- `apps/web/src/lib/tickets-format.ts` — new helper module mirroring the Cycle 7 `tasks-format.ts` pattern. `TICKET_PRIORITIES` + `TICKET_STATUSES` const arrays; per-enum label maps + pill class maps (LOW gray / MEDIUM sky / HIGH amber / CRITICAL rose); `slaUrgency(sla)` returns a 4-state `green | amber | red | none` (green when both windows healthy; amber when remaining < 25% of the budget; red when either window is breached; none when both windows are closed or no policy is linked); `formatSlaRemaining(sla)` renders "2h left" / "30m left" / "Overdue 4h" / "Overdue 2d"; `isTicketLive(status)` excludes CLOSED + CANCELLED for the badge counter; `formatTicketAge(createdAt)` renders relative timestamps for list rows.
- `apps/web/src/hooks/use-tickets.ts` — 13 React Query hooks: `useTickets(args)` (refetch on focus, 30s staleTime), `useTicket(id)`, `useCreateTicket`, `useAssignTicket(id)` / `useAssignVendor(id)` (admin-only mutations — used in Step 8 admin queue), `useResolveTicket(id)`, `useCloseTicket(id)`, `useReopenTicket(id)`, `useCancelTicket(id)`, `useTicketComments(ticketId)` (15s staleTime — comments refresh during a live conversation), `usePostTicketComment(ticketId)`, `useTicketActivity(ticketId)`, `useTicketCategories()` (5min staleTime — config rarely changes), `useTicketVendors()`, `useTicketSla()`. The shared `invalidateTicket(qc, id)` helper invalidates the matching query keys on every lifecycle mutation **plus the Tasks badge query** — because resolving a ticket flips the linked auto-task to DONE via the Step 6 cascade, so the Tasks badge needs to refresh.
- `apps/web/src/components/shell/icons.tsx` — adds `LifebuoyIcon` (Heroicons-style outline lifebuoy ring with 9 strokes for the 4 quadrants + handles + central frame). Same SVG conventions as the rest of the icons file.
- `apps/web/src/components/shell/apps.tsx` — adds the `'helpdesk'` AppKey + BadgeKey, registers the Helpdesk tile gated on `it-001:read` between Calendar and Compliance with `routePrefix: '/helpdesk'` so any nested route (`/helpdesk/new`, `/helpdesk/:id`) keeps the tile lit. Description copy: "Submit a ticket and track requests."
- `apps/web/src/hooks/use-app-badges.ts` — extends `AppBadges` with `helpdesk: number`. The badge counter calls `useTickets({ includeTerminal: false })` gated on `it-001:read` so personas without the perm don't 403, then filters to `isTicketLive(status)` (not CLOSED + CANCELLED). Server-side row scope at `TicketService.list` already restricts non-admins to their own tickets, so the count matches what the page shows.
- `apps/web/src/components/notifications/NotificationBell.tsx` — adds 4 entries to `describeNotification()` (one per `ticket.*` notification type) so the bell renders human-readable titles + subtitles. `ticket.commented` surfaces "Internal note on …" or "New reply on …" depending on `is_internal`, and shows the SLA-clock-stopped subtitle when `first_response_bumped=true`. `iconFor()` returns `LifebuoyIcon` for any `ticket.*`; `colorFor()` uses teal-100 / teal-700.

**Three new routes:**

- **`/helpdesk`** — My Tickets list. 4 filter chips (Open / In progress / Resolved / All). Each row shows: 8-char ticket id (uppercased) prefix, priority pill, status pill, SLA indicator dot (green/amber/red/none) with `formatSlaRemaining` text when active, title (truncated), then a one-line meta row "Category / Subcategory · Assigned to X (or Vendor: Y, or Unassigned) · Nh ago." Click-through navigates to `/helpdesk/:id`. List is sorted by the API's default ordering (priority urgency then created_at desc). Page size: **7.89 kB / 114 kB First Load JS**.

- **`/helpdesk/new`** — Submit ticket form. Category dropdown (3 top-level cats from `/ticket-categories`); when a category is picked, the subcategory dropdown populates with its subcategories (or hides itself if none). Title field (required, 200 chars). Description textarea (4000 chars). Priority chip group LOW / MEDIUM / HIGH / CRITICAL with MEDIUM as default. Submit button disabled until category + title are non-empty. Submit calls `useCreateTicket()` and on success Toasts either "Submitted — auto-assigned to {assignee}" or "Submitted — routed to the helpdesk queue" then navigates to the detail page. Page size: **8.86 kB / 115 kB**.

- **`/helpdesk/[id]`** — Ticket detail. Header card with priority + status + SLA pill strip; description (preserves whitespace); 4-cell metadata grid (Category, Requester, Assigned to, SLA target). Lifecycle action bar conditionally renders:
  - **Mark resolved** (assignee or admin, working state) — calls `useResolveTicket`.
  - **Close ticket** + **Reopen** (requester or admin, RESOLVED state).
  - **Cancel** (requester or admin, working state) with `window.confirm`.
  
  **Comment thread** below: oldest-first list with internal comments rendered amber-tinted (`bg-amber-50 ring-amber-200`) plus an "Internal" badge. Reply form at the bottom for active participants; staff (assignee + admin) get an "Internal note" checkbox; requester sees "Visible to staff and the requester." hint text instead. Reply form hidden when the ticket is in CLOSED or CANCELLED. **Activity timeline** at the bottom — read-only chronological list. The `ActivityMetadata` helper renders STATUS_CHANGE rows as "OPEN → RESOLVED · reason: …", VENDOR_ASSIGNMENT rows as "Assigned to vendor · WO-…", and COMMENT rows as "Internal note · stopped the SLA response clock" or "Public comment". Page size: **9.96 kB / 116 kB**.

**Live verification on `tenant_demo` 2026-05-03** (4 read-path scenarios, no mutations — UI sources data from the existing 27-endpoint surface):

- **UI1** — teacher GET `/tickets?includeTerminal=true&limit=200` → 3 rows visible to Rivera (T1 OPEN + T3 RESOLVED + T5 CLOSED — Rivera is the requester on all three; T2 Park's plumbing and T4 Hayes's hallway light correctly filtered out by row scope).
- **UI2** — teacher GET `/ticket-categories` → 3 categories with subcategories inlined (`Facilities` 5 / `HR Support` 2 / `IT` 4) — feeds the New Ticket form's cascading dropdowns.
- **UI3** — teacher GET `/tickets/:T1/comments` → 1 comment from James Rivera (the seed public comment), `isInternal: false`.
- **UI4** — teacher GET `/tickets/:T1/activity` → 1 row (COMMENT activity by James Rivera).

The full mutation paths (submit + lifecycle transitions + comment post including internal-comment-hidden-from-requester) are already verified live in Steps 4 + 5 + 6 smoke runs against the same 27-endpoint surface. Step 7 is purely additive on the web side — no new API endpoints were needed.

**Full Web build output for the 3 new routes:**

```
├ ○ /helpdesk                           7.89 kB         114 kB
├ ƒ /helpdesk/[id]                      9.96 kB         116 kB
├ ○ /helpdesk/new                       8.86 kB         115 kB
```

`/helpdesk` and `/helpdesk/new` prerender as static; `/helpdesk/[id]` is server-rendered on demand (matches the `/tasks/[id]` and `/staff/[id]` precedent — dynamic route id).

**Iteration issues caught and resolved:**

- **`EmptyState` prop is `action` not `actions`.** The Cycle 7 / 6 / 5 EmptyState calls pass `action={<Link>...</Link>}`; the original `/helpdesk/[id]` first draft used `actions={...}` and TypeScript caught it on the first build. Trivial rename. Worth remembering for future code that lifts an EmptyState from another file by hand rather than auto-completion.
- **`useToast()` returns `{toast}` not `{show}`.** The Cycle 6 / 7 surfaces I cribbed the pattern from also got this wrong locally; the canonical helper signature is `const { toast } = useToast()` followed by `toast(message, variant?)` where variant is `'success' | 'error' | 'info'`. Updated 8 call sites in the detail + new pages.
- **Unused TS bindings.** `isParticipant` was dead code (computed but never referenced); `TicketStatus` was imported but unused. Both removed before the second build.

The third build attempt was clean. Total build time across the 3 attempts: ~30 seconds. The notification descriptor wiring was zero-touch because the Step 6 emit payloads already include `ticket_title`, `priority`, `category_name`, `is_internal`, `first_response_bumped`, and `resolved_via_problem_id` exactly the way the bell descriptor expects them.

**What's deferred to later steps:**

- Step 8 lands the **admin** Helpdesk UI — the queue view (`/helpdesk/admin`), SLA dashboard (`/helpdesk/admin/sla`), category tree editor (`/helpdesk/admin/categories`), and vendor management (`/helpdesk/admin/vendors`). The admin surface uses the same hooks but adds the assign + assign-vendor flows that Step 4 already exposes on the API.
- Step 9 lands the problem management UI — `/helpdesk/admin/problems` list + detail + the create-from-ticket flow. The Step 5 ProblemService is already complete on the API side.
- Step 10 lands the vertical-slice CAT walking the full plan flow end-to-end (submit → auto-assign → SLA clock → comment → vendor → resolve → notification → task complete).
- **Attachment upload UI** is deferred. The schema's `tkt_ticket_attachments` table exists from Step 2 but has no service / endpoint surface yet — Step 7 ships the comment + activity reads but no attachment upload + signed-URL flow. The `tkt_ticket_tags` table is similarly schema-only this cycle.

---

## Step 8 — Helpdesk Admin UI — Queue + Dashboard

**Status:** DONE. 4 new admin routes under `/helpdesk/admin/*` plus 7 admin-write hooks added to `use-tickets.ts` and 7 payload DTOs added to `apps/web/src/lib/types.ts`. Build clean on first try, all 4 routes register at the expected sizes.

**Files:**

- `apps/web/src/lib/types.ts` — adds 7 admin payload types: `CreateTicketCategoryPayload` / `UpdateTicketCategoryPayload`, `CreateTicketSubcategoryPayload` / `UpdateTicketSubcategoryPayload`, `CreateTicketVendorPayload` / `UpdateTicketVendorPayload`, `UpsertTicketSlaPayload`. The Subcategory + Vendor update payloads use `string | null` for nullable fields so callers can clear `default_assignee_id` / `auto_assign_to_role` / contact fields explicitly.
- `apps/web/src/hooks/use-tickets.ts` — extends with 7 admin mutation hooks: `useCreateTicketCategory`, `useUpdateTicketCategory(id)`, `useCreateTicketSubcategory`, `useUpdateTicketSubcategory(id)`, `useCreateTicketVendor`, `useUpdateTicketVendor(id)`, `useUpsertTicketSla`. Each invalidates the matching `['tickets', 'categories'|'vendors'|'sla']` query key on success so the admin pages refresh without manual refetches. The Cycle 8 hook count grows to 20.

**4 new routes:**

- **`/helpdesk/admin`** (Admin Queue) — admin-only queue gated on `it-001:admin OR sch-001:admin` (the second is the everyFunction-derived School Admin path). 4-control filter bar (status / priority / category / SLA urgency) — first 3 are server-side, SLA urgency filter is client-side because the snapshot is computed not stored. Per-row table with SLA dot indicator + remaining-time text; ticket id prefix + title link; status pill + priority pill + category/subcategory + assignee/vendor/Unassigned label + relative age. Per-row **Assign** + **Vendor** action buttons. Breached rows get a `bg-rose-50/40` row tint at the top (sort respects the API's priority-then-created order, but the SLA breached count is surfaced in the page header). **Assign Modal** — searchable employee picker pulling from `useEmployees()` filtered to `employmentStatus='ACTIVE'`. **Assign Vendor Modal** — vendor dropdown sorted preferred-first (the API already orders this way) with optional vendor-reference text input. Both modals use the existing `Modal` shell + `useToast()` for the success/error feedback. Page size **5.19 kB / 118 kB First Load**.

- **`/helpdesk/admin/sla`** (SLA Dashboard) — admin-only stats dashboard. Pulls `useTickets({includeTerminal: true, limit: 500})` and computes the dashboard client-side via the local `computeDashboard(tickets)` function. **4 stat cards:** Open tickets (with critical+high count subtitle); Avg response (time from submit to first staff comment, computed from `firstResponseAt - createdAt`); Avg resolution (time from submit to resolved); SLA compliance (resolved-within-target / total-resolved %). The compliance card auto-tones `good`/`warn`/`bad` based on the % (≥90 green, ≥70 amber, <70 red). **By-priority histogram** (4 cards, CRITICAL first). **Breached tickets list** — every live ticket whose SLA snapshot is `red`, with deep-link to detail and full pill row. **Per-category breakdown table** — open / breached / resolved / within-SLA % per category. **SLA matrix table** — the configured `tkt_sla_policies` rows for the school. Time-series volume chart deferred this cycle (would need a histogram endpoint we don't ship). Page size **3.07 kB / 115 kB**.

- **`/helpdesk/admin/categories`** (Category Tree Editor) — admin-only tree of categories with subcategories inlined. Each category card shows name + active flag + Edit + Add subcategory buttons. Subcategory rows show name + auto-assignment hint ("Auto-assigns to {employee}" / "Routes to role {ROLE_TOKEN}" / "Lands in admin queue"). **Category Modal** (create/edit) — name + icon + isActive toggle (edit only). **Subcategory Modal** — name + auto-assignment picker (employee dropdown OR role token input — picking one clears the other so the schema's mutex CHECK never fires; the modal's pickEmployee/pickRole helpers enforce this) + isActive toggle. Employee picker filters to active employees only. Role token input has `pattern="^[A-Z][A-Z0-9_]*$"` and force-uppercases the input. Includes inactive subcategories in the editor view via `useTicketCategories(isAdmin, true)` so admins can re-activate retired leaves. Page size **6.62 kB / 116 kB**.

- **`/helpdesk/admin/vendors`** (Vendor Management) — admin-only vendor list with type pill + ★ Preferred badge + Inactive label + contact info grid (name / email / phone / website link) + notes. Add / Edit Modal exposes every column (`vendorName`, `vendorType` from the 9-value enum dropdown, `contactName`, `contactEmail`, `contactPhone`, `website`, `isPreferred` checkbox, `notes` textarea, `isActive` toggle on edit). Update payload uses the `string | null` shape so clearing a contact field actually clears it — the diff logic compares `formField.trim() !== (vendor.contactName ?? '')` then sends either `null` or the new value. Page size **3.89 kB / 116 kB**.

**Cross-page navigation:** every admin page header has a "← Back to queue" link, plus the queue header carries SLA dashboard / Categories / Vendors quick-links so admins can hop between the 4 surfaces without a sidebar trip. The Helpdesk launchpad tile's `routePrefix: '/helpdesk'` (set in Step 7) means all 4 admin routes keep the tile lit.

**Permission gating:** every admin page guards on `hasAnyPermission(user, ['it-001:admin', 'sch-001:admin'])` and renders an "Admin only" `EmptyState` when the caller lacks both. The backend service-layer `it-001:admin` permission check (held only via the School Admin / Platform Admin `everyFunction` block) is the actual access gate; the UI guard prevents rendering the editor for non-admins to begin with.

**Build sizes for the 4 new admin routes:**

```
├ ○ /helpdesk/admin                  5.19 kB         118 kB
├ ○ /helpdesk/admin/categories       6.62 kB         116 kB
├ ○ /helpdesk/admin/sla              3.07 kB         115 kB
├ ○ /helpdesk/admin/vendors          3.89 kB         116 kB
```

All 4 prerender as static content. Combined Cycle 8 web surface is now 7 routes (3 staff + 4 admin). Total cycle web hook count grew from 13 to 20.

**No API changes required** — Step 8 sits entirely on the 27-endpoint surface from Steps 4 + 5. The `POST /ticket-categories` / `PATCH /ticket-categories/:id` / `POST /ticket-subcategories` / `PATCH /ticket-subcategories/:id` / `POST /ticket-vendors` / `PATCH /ticket-vendors/:id` / `POST /ticket-sla` endpoints all shipped in Step 4.

**No iteration issues caught during build** — first build clean. The 7 admin pages were cribbed from the same EmptyState + Modal + Toast patterns Step 7 settled on, so the conventions held without rework.

**What's deferred to later steps:**

- Step 9 lands the **problem management UI** (`/helpdesk/admin/problems` list + detail). The Step 5 ProblemService is already complete on the API side with 6 endpoints; Step 9 is purely additive on the web side.
- Step 10 ships the **vertical-slice CAT** — `docs/cycle8-cat-script.md` walks the full plan flow end-to-end on `tenant_demo` (submit → auto-assign → SLA clock → comment → vendor → resolve → notification → task complete → SLA metrics).
- **Bulk actions on the admin queue** (assign-many, change-priority-many, close-many) are documented in the plan but punted to a future polish pass — the per-row Assign/Vendor buttons cover the 80% case for the demo.
- **SLA matrix editor** — the dashboard surfaces the configured policies read-only with a link to the seed; the `useUpsertTicketSla` hook is wired for a future polish pass that adds a per-row edit modal.
- **Ticket volume time-series chart** on the SLA dashboard — would need a histogram endpoint to aggregate the activity log; punted to ops dashboards.

---

## Step 9 — Problem Management UI

**Status:** DONE. 2 new admin routes (`/helpdesk/admin/problems` list + `[id]` detail) + 6 new problem hooks in `use-tickets.ts` + 5 new payload DTOs in `types.ts` + the **Create problem from this ticket** flow on the staff detail page + a Problems quick-link from the admin queue header. Build clean after 3 trivial fix-ups (rule-of-hooks ordering on the detail page; unused import in the list page; unescaped apostrophe in JSX).

**Files:**

- `apps/web/src/lib/types.ts` — adds `CreateProblemPayload`, `UpdateProblemPayload` (with `Exclude<ProblemStatus, 'RESOLVED'>` for the status field — RESOLVED is rejected by `PATCH /problems/:id` server-side, callers must use the dedicated `/resolve` endpoint), `LinkProblemTicketsPayload`, `ResolveProblemPayload`, `ResolveProblemResponse` (`{problem, ticketsFlipped: string[]}` matching the API shape), `ListProblemsArgs`.
- `apps/web/src/hooks/use-tickets.ts` — adds 6 problem hooks: `useProblems(args)` (30s stale + refetch on focus), `useProblem(id)`, `useCreateProblem`, `useUpdateProblem(id)`, `useLinkProblemTickets(id)`, `useResolveProblem(id)`. The shared `invalidateProblem(qc, id)` helper invalidates the problems list + the per-id detail; `useResolveProblem` additionally invalidates `['tickets']`, `['tasks']`, `['notifications']` because the batch-flip cascade resolves linked tickets which fires `tkt.ticket.resolved` → `TicketTaskCompletionConsumer` → linked auto-tasks DONE → notification fan-out. Cycle 8 web hook count grows from 20 to 26.
- `apps/web/src/lib/tickets-format.ts` — adds `PROBLEM_STATUSES` const array, `PROBLEM_STATUS_LABELS` map, `PROBLEM_STATUS_PILL` map (OPEN rose / INVESTIGATING sky / KNOWN_ERROR amber / RESOLVED emerald — same colour grammar as ticket statuses).

**`/helpdesk/admin/problems`** (Problems List) — admin-only list with 5-state filter chips (All / Open / Investigating / Known Error / Resolved). Per-row card shows status pill + category pill + linked-ticket count + title + 2-line description preview + assignee/vendor + relative age. Click-through to detail. Header subtitle counts open problems (status NOT RESOLVED). Page size **3.1 kB / 114 kB**.

**`/helpdesk/admin/problems/[id]`** (Detail) — admin-only with three sections + three modals:

- **Header card** — status pill + category pill + assignee/vendor labels + description; 3 fields (Root cause, Resolution, Workaround) rendered as `Field` rows ("Not set" italic when empty + hint text below). Resolved problems show a green `Resolved {timestamp}` line. Action bar (hidden on RESOLVED): Edit details / Link more tickets / Resolve problem (right-aligned, emerald).
- **Linked tickets list** — pulls `useTickets({includeTerminal:true, limit:500})` and filters client-side by `problem.ticketIds` so each row can render the ticket's current status pill + priority pill + relative age + click-through to `/helpdesk/:id`.

  *Hook ordering note:* the `useMemo` over `linkedTickets` runs before the early-return paths so React's rule of hooks is satisfied. Memo dependency is `ticketIds.join('|')` rather than the array reference so the memo doesn't churn on every parent re-render.
- **Edit Problem Modal** — title / description / status dropdown (3 values; RESOLVED is excluded from the dropdown because the dedicated Resolve button is the right path) / root_cause / workaround. Sends only the fields that changed via diff comparison so the API doesn't see no-op writes.
- **Link Tickets Modal** — search bar filters live tickets (Open / In progress / Vendor assigned / Pending requester) by title or category substring; checkbox list with multi-select; submit button shows the selected count. Excludes already-linked tickets and CLOSED/CANCELLED ones. Empty state when nothing matches the search or every visible ticket is already linked.
- **Resolve Modal** — the **keystone batch-resolve flow**. Required `rootCause` + `resolution`, optional `workaround`. Top of the modal carries an amber warning that the action is irreversible from the UI and explains the fan-out: every linked ticket in OPEN / IN_PROGRESS / VENDOR_ASSIGNED / PENDING_REQUESTER will flip to RESOLVED, emit one `tkt.ticket.resolved` per flipped ticket, and stop the SLA clock. A preview list shows exactly which tickets will flip (already-resolved ones are excluded since the API skips them). On success, the toast says "Problem resolved — N linked ticket(s) flipped to RESOLVED" with the count from the `ResolveProblemResponse.ticketsFlipped` array.

  Page size **6.7 kB / 118 kB**.

**Create-problem-from-ticket flow:** `/helpdesk/[id]` (staff detail, Step 7) gains an admin-only "Create problem from this ticket" button (right-aligned in the action bar with violet styling so it's visually distinct from the resolve/cancel actions). The button opens a `CreateProblemFromTicketModal` that pre-populates `categoryId` from the ticket and seeds `ticketIds: [ticket.id]` on the create payload. Title + description are required. On success the modal navigates to the new problem's detail page so the admin can immediately link more tickets or write the root cause. Modal copy explains the pre-population so the admin knows the link is automatic.

**Admin queue header** — adds a Problems quick-link between SLA dashboard and Categories so admins can hop into the problem surface without the sidebar.

**Cycle 8 web surface is now 9 routes** (3 staff + 4 admin + 2 problems). 26 web hooks total in `use-tickets.ts`.

**Build sizes for the 2 new problem routes:**

```
├ ○ /helpdesk/admin/problems         3.1 kB         114 kB
├ ƒ /helpdesk/admin/problems/[id]    6.7 kB         118 kB
```

The list page prerenders as static; the detail page is server-rendered on demand (matches the dynamic-id convention from `[id]` routes elsewhere in the app).

**Iteration issues caught and resolved:**

- **Rule-of-hooks ordering.** The first draft put `useState(createProblemOpen)` after the early returns on the staff detail page, and the `useMemo(linkedTickets)` after `if (!problem.data) return …` on the problem detail page. ESLint's `react-hooks/rules-of-hooks` fired on both. Fix: hoist the hook calls above any conditional returns, then read `problem.data?.ticketIds ?? []` and feed an empty fallback into the memo so the linked-tickets render path tolerates the loading state.
- **Unused `PROBLEM_STATUSES` import.** Pulled into the list page's import block but never referenced (the chip array uses inline strings). Removed.
- **Unescaped apostrophe.** `aren't` in the Link Tickets modal description tripped `react/no-unescaped-entities`. Replaced with `aren&apos;t`.

Third build clean. No backend changes — Step 9 sits entirely on the 6 problem endpoints from Step 5 (`GET /problems`, `GET /problems/:id`, `POST /problems`, `PATCH /problems/:id`, `POST /problems/:id/link`, `PATCH /problems/:id/resolve`).

**What's deferred to Step 10:**

- The vertical-slice CAT — `docs/cycle8-cat-script.md` walking the full plan flow end-to-end on `tenant_demo` (submit → auto-assign → SLA clock → comment → vendor → resolve → notification → task complete → SLA metrics → problem batch-resolve).
- Per-problem assignee + vendor edit (the `assignedToId` / `vendorId` fields on the schema and `UpdateProblemPayload` are wired but no Edit Modal field for them yet — the Resolve flow is the dominant happy path; future polish can add a dropdown).
- Bulk problem-from-multiple-tickets selection on the admin queue (today admins use one ticket as the seed, then Link more tickets in the modal — covers the demo flow but a future polish lets multi-select on the queue feed the create flow).

---

## Step 10 — Pending

- **Step 10 — Vertical slice CAT.** `docs/cycle8-cat-script.md`. The full plan-time scenario walked end-to-end on `tenant_demo`.

---

## Operational notes

- **Migration discipline.** Cycle 8 follows the splitter trap rule from Cycles 4–7: no `;` inside any string literal, default expression, COMMENT, or CHECK predicate. Block-comment header (no `--` line comments at file head — the splitter cuts the first statement otherwise). `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` for idempotency.
- **Cycle 7 dependency.** The `tkt.ticket.assigned` auto-task rule seeded in Step 3 depends on the Cycle 7 Task Worker being up. The worker auto-discovers `tsk_auto_task_rules.trigger_event_type` at boot and subscribes to the matching env-prefixed Kafka topic. Adding the new rule at runtime requires a worker restart (documented limitation from Cycle 7 Step 4) — we will run `seed:tickets` then bounce the API in dev. Production deploys naturally restart the worker so this is not an ongoing concern.
- **Permission catalogue.** `IT-001` ("Helpdesk Tickets") and `FAC-001` ("Maintenance Tickets") both exist in `packages/database/data/permissions.json` (the seed has carried them forward from earlier cycles unused). Step 3 grants read+write to Teacher / Staff. School Admin and Platform Admin already hold all three tiers via the `everyFunction` mechanism so no extra rolePermsSpec rows needed for admin paths. Cache rebuild after.
- **No new ADR.** Cycle 8 is implemented entirely under existing ADRs (ADR-001 / ADR-020 soft cross-schema FKs, ADR-010 immutable audit log discipline, ADR-011 sole-writer convention adapted to tickets, ADR-033 M60/M65 boundary).

---

## Closing pre-conditions for the cycle

When all 10 steps are done, the closing handoff entry will record:

- **Build clean.** `pnpm --filter @campusos/api build` + `pnpm --filter @campusos/web build` + `pnpm format:check` all clean.
- **Tag.** `cycle8-complete` tag on the closeout commit.
- **Post-cycle architecture review.** A new `REVIEW-CYCLE8-CHATGPT.md` mirrors the prior cycle template; Round 1 + Round 2 verdicts inline. `cycle8-approved` tag after the final APPROVED verdict.
- **Wave 1 close.** Cycle 8 completes Wave 1 of the delivery plan. The closing CLAUDE.md update marks Wave 1 as done and the platform as ready for Wave 2 (Student Services — Behaviour, Health, Counselling, Library, Athletics & Clubs).
