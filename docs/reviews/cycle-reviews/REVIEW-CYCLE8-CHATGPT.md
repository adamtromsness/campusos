# REVIEW-CYCLE8-CHATGPT

External post-cycle architecture review of Cycle 8 (Service Tickets) by
ChatGPT against `cycle8-complete` (SHA `fa0797c`) plus the post-tag
formatting commit (`9eb4874`). Cycle 8 is the **final cycle of Wave 1**,
so the review doubles as Wave 1 closeout.

## Verdict — APPROVED with major follow-ups

> **Approve Wave 1 completion. I do not see a new hard blocker that
> should stop you from moving to Wave 2. I do see several major
> follow-ups that should be queued before the platform gets much
> broader.**

The reviewer's executive scorecard:

| Area                               | Verdict               |
| ---------------------------------- | --------------------- |
| Tenant isolation                   | Pass                  |
| Module registration                | Pass                  |
| ADR-057 envelope                   | Pass                  |
| Ticket schema                      | Pass                  |
| Ticket lifecycle locking           | Pass                  |
| Ticket row-level visibility        | Pass                  |
| Task integration                   | Pass                  |
| Notification integration           | Pass with minor issue |
| Service-ticket permission model    | Major follow-up       |
| Problem management edge cases      | Major follow-up       |
| Outbox / event atomicity           | Accepted deviation    |
| Consumer tenant routing validation | Accepted deviation    |

No BLOCKING or REJECT items. Three of the five major follow-ups are
clean bug fixes and have been landed in this commit; two are
architectural decisions carried as Phase 2 backlog.

## Five major follow-ups — triage

| #           | Severity      | Finding                                                                                                                                                                                                                                                                                                                                                      | Resolution                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Follow-up 1 | ARCHITECTURAL | Service Tickets permission model is too IT-centered — `IT-001` gates every ticket / category / vendor / SLA / problem surface, but the module is described as a cross-domain helpdesk for IT, facilities, and HR support. Future cycles will create role-clarity friction.                                                                                   | **Phase 2 backlog.** Logged in `HANDOFF-CYCLE8.md` Phase 2 punch list. Three resolution options on the table — rename `IT-001` to "Helpdesk Tickets / Service Tickets," add a dedicated `TKT-001` function, or accept-list `it-001 OR fac-001 OR hr-support` per category. Decision deferred until the M65 Facilities cycle in Wave 2 surfaces the actual role overlap.                            |
| Follow-up 2 | BUG           | `TicketNotificationConsumer.fanOutResolved()` compared `ctx.requesterId` (a `platform_users.id`) to `event.payload.assigneeId` (an `hr_employees.id`). The check was meant to suppress the "your ticket was resolved" notification when the requester resolved their own ticket. The category mismatch made it never match — code path was effectively dead. | **Fixed in this commit.** Added `resolvedByAccountId: actor.accountId` to the `tkt.ticket.resolved` payload in both `TicketService.resolve` and `ProblemService.resolveBatch`. Consumer now compares `ctx.requesterId === event.payload.resolvedByAccountId` (both `platform_users.id`). Defaults to `null !== null` short-circuit when the field is absent so legacy events still notify cleanly. |
| Follow-up 3 | BUG           | `ProblemService.patch` allowed `status='KNOWN_ERROR'` without explicit `rootCause` validation. The DB CHECK requires it, so the call would fall through to a 23514 instead of a clean 400. Same gap on `assignedToId` / `vendorId` existence — create() validated them but patch() didn't.                                                                   | **Fixed in this commit.** Patch path now opens `executeInTenantTransaction`, locks the row + reads existing `root_cause`/`assigned_to_id`/`vendor_id` atomically, computes the post-patch effective shape, and rejects KNOWN_ERROR without effective rootCause + the assignee/vendor mutex + bogus FK targets — all with friendly 400s before the UPDATE fires.                                    |
| Follow-up 4 | BUG           | `tkt_tickets.location_id` is a soft cross-module ref to `sch_rooms` (intra-tenant but kept soft per ADR-001/020 so the ticket survives a Cycle 5 room being retired). Service didn't validate the supplied id resolved to a row in the tenant before insert.                                                                                                 | **Fixed in this commit.** `TicketService.create` adds an existence check inside the existing `executeInTenantContext` validation block. Bogus or cross-tenant `locationId` returns `400 "locationId does not match a room in this school"`.                                                                                                                                                        |
| Follow-up 5 | ARCHITECTURAL | `tkt_categories` UNIQUE(school_id, name) is global across the tree. Two top-level domains can't both have an "Other" or "Equipment" subcategory.                                                                                                                                                                                                             | **Phase 2 backlog.** Logged in `HANDOFF-CYCLE8.md`. The two demo schools (IT / Facilities / HR Support) don't trip this in practice since Step 3 seeds non-overlapping subcategory names. If the real-world catalogue starts colliding, switch to UNIQUE(school_id, parent_category_id, name) with a partial UNIQUE for top-level rows where parent_category_id IS NULL.                           |

## Live verification of the 3 fixes (`tenant_demo`, 2026-05-04)

### Follow-up 2 — resolver self-notification

Sarah Mitchell submits an IT ticket and immediately resolves it:

```
ticket created    → requesterName=Sarah Mitchell, status=OPEN
ticket resolved   → status=RESOLVED, resolvedAt populated

Notifications queued for the smoke ticket:
  ticket.submitted | admin@demo.campusos.dev
  ticket.submitted | principal@demo.campusos.dev
  (NO ticket.resolved row — self-notification correctly suppressed)

Wire envelope on dev.tkt.ticket.resolved:
  resolvedByAccountId = 019dc92d-087d-7442-abf5-d16bc2fe960d   (Sarah)
  requesterId         = 019dc92d-087d-7442-abf5-d16bc2fe960d   (Sarah)
  match? True ← consumer correctly suppresses
```

### Follow-up 3 — ProblemService.patch validation

Targeting the seeded "Network switch failure in Building A" problem
(starts in INVESTIGATING with no `root_cause`):

```
F3a: PATCH status=KNOWN_ERROR (no rootCause + no existing rootCause)
     → 400 "KNOWN_ERROR requires a root_cause — provide rootCause in the
            patch payload, or set it on a separate PATCH first"

F3b: PATCH status=KNOWN_ERROR + rootCause="…switch packet loss"
     → 200 status=KNOWN_ERROR rootCause="F3 smoke — switch packet loss"

F3c: PATCH assignedToId=00000000-0000-…
     → 400 "assignedToId does not match an hr_employees row"

F3e: PATCH assignedToId=<real> + vendorId=<real>  (mutex)
     → 400 "A problem cannot be assigned to both an employee and a
            vendor — clear one before setting the other"
```

The mutex check correctly fires before the FK lookups when both are
set, surfacing the more useful error to the caller.

### Follow-up 4 — locationId validation

```
POST /tickets with locationId=00000000-0000-…
  → 400 "locationId does not match a room in this school"

POST /tickets with locationId=<Room 101's actual id>
  → 201 ticket created with locationId stored
```

## Two architectural follow-ups — Phase 2 backlog

These are tracked in `HANDOFF-CYCLE8.md`'s Phase 2 punch list. Neither
is blocking:

- **Permission model rename / split** (Follow-up 1). Defer until the
  M65 Facilities cycle surfaces real cross-functional admin overlap.
  Until then, `IT-001` is functioning as the de-facto helpdesk
  function (the Step 3 seed already grants Teacher and Staff
  `IT-001:read+write` even for facilities + HR-support tickets,
  matching the cross-domain helpdesk intent).
- **Category uniqueness** (Follow-up 5). The seed's three categories
  (IT / Facilities / HR Support) and 11 subcategories don't trip the
  global UNIQUE constraint. If a real-world catalogue starts
  colliding ("Other" under IT + "Other" under Facilities), the
  migration to a per-parent-scoped UNIQUE is straightforward
  (recreate with a partial INDEX on `(school_id, parent_category_id, name)`
  for non-null parent + `(school_id, name) WHERE parent_category_id IS NULL`
  for top-level).

## Four accepted deviations carried to Wave 2

These are existing architectural decisions reaffirmed by the reviewer:

1. **Consumer tenant routing trusts headers.** `unwrapEnvelope` builds
   `schemaName = 'tenant_' + subdomain` from the `tenant-subdomain`
   header without validating against `platform_tenant_routing`.
   Already accepted in REVIEW-CYCLE3 + REVIEW-CYCLE5; remains a Phase 2
   item.
2. **Best-effort eventing, no outbox.** `KafkaProducerService.emit()`
   never throws and logs failures instead. Acceptable for Wave 1
   demo / pilot readiness; needs an outbox pattern for finance,
   emergency, and workflow-critical paths once real schools go live.
3. **Tenant header accepted in production.** `TenantResolverMiddleware`
   accepts `X-Tenant-Subdomain` in every environment. Permission checks
   prevent most cross-tenant data exposure but the header pathway
   should be tightened once the production frontend can rely on
   subdomain routing.
4. **Platform-scope permission mode is future work.**
   `PermissionGuard` denies protected routes when no tenant context
   exists. Fine for Wave 1 school-facing modules; v11 CRM / OPS /
   platform business modules will need a platform-scope authorization
   path.

## Closing

**Wave 1 is approved to close.** All eight Wave 1 cycles (0 — Platform
Foundation; 1 — SIS + Attendance; 2 — Classroom; 3 — Communications; 4 —
HR; 5 — Scheduling; 6 — Enrollment + Payments; 6.1 — Profile + Household
polish; 7 — Tasks + Approvals; 8 — Service Tickets) are now post-review.
The platform has the complete core operational stack and is ready for
Wave 2 (Student Services — Behaviour, Health, Counselling, Library,
Athletics & Clubs).

Tag `cycle8-approved` lands on the closeout commit that ships these
three fixes plus the two backlog items. The four accepted deviations
move forward to Wave 2 as the Phase 2 punch list.
