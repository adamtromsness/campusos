# Cycle 8 CAT — Service Tickets

**Status:** verified live on `tenant_demo` 2026-05-04 against the Step 9 build (`ca31197`). All 10 plan scenarios pass.

**Vertical slice:** teacher submits projector ticket → auto-assigned via subcategory `default_assignee_id` → SLA policy auto-linked → Cycle 7 TaskWorker creates AUTO task on assignee's list → admin posts public comment with first-response-clock-stop → admin posts internal comment hidden from requester → admin escalates to vendor with WO reference → admin resolves with note → Step 6 `TicketTaskCompletionConsumer` flips linked auto-task DONE within the same second → SLA metrics computed from timestamps → admin creates a problem from 2 unrelated tickets and batch-resolves them → requester reopens a RESOLVED ticket → 6 permission denial paths.

**Pre-conditions:**

- `pnpm seed` + `seed:sis` + `seed:classroom` + `seed:hr` + `seed:scheduling` + `seed:enrollment` + `seed:payments` + `seed:profile` + `seed:tasks` + `seed:tickets` all run on `tenant_demo`.
- `tsx src/build-cache.ts` rebuilt the IAM cache (7 personas).
- All four `dev.tkt.ticket.*` topics pre-created on Kafka via `kafka-topics.sh --create --if-not-exists` per the documented subscribe-before-publish race workaround.
- API running on `localhost:4000` from `pnpm --filter @campusos/api build && node apps/api/dist/main.js`.

## Schema preamble (10 checks)

```sql
-- Tenant logical base table count (exclude inherited partition leaves)
SELECT COUNT(*) FROM information_schema.tables t
WHERE table_schema='tenant_demo' AND table_type='BASE TABLE'
  AND NOT EXISTS (
    SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = t.table_schema AND c.relname = t.table_name
  );
-- expected: 132

-- Cycle 8 ticket tables (4 from Step 1 + 7 from Step 2)
SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='tenant_demo' AND table_name LIKE 'tkt\_%';
-- expected: 11

-- 0 cross-schema FKs
SELECT COUNT(*) FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_class ft ON ft.oid = c.confrelid
  JOIN pg_namespace fn ON fn.oid = ft.relnamespace
  WHERE c.contype='f' AND n.nspname='tenant_demo' AND fn.nspname <> 'tenant_demo';
-- expected: 0

-- 18 intra-tenant FKs across the tkt_* tables (4 from Step 1 + 14 from Step 2)
SELECT COUNT(*) FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE c.contype='f' AND n.nspname='tenant_demo' AND c.conname LIKE 'tkt_%';
-- expected: 18

-- Step 3 seed counts on tenant_demo
SELECT COUNT(*) FROM tenant_demo.tkt_categories;        -- expected: 3
SELECT COUNT(*) FROM tenant_demo.tkt_subcategories;      -- expected: 11
SELECT COUNT(*) FROM tenant_demo.tkt_sla_policies;       -- expected: 12
SELECT COUNT(*) FROM tenant_demo.tkt_vendors;            -- expected: 2
SELECT COUNT(*) FROM tenant_demo.tkt_tickets;            -- expected: 5
SELECT COUNT(*) FROM tenant_demo.tkt_problems;           -- expected: 1
```

All 10 checks pass.

## Scenario 1 — Submit + auto-assign + SLA link + envelope + admin notification

Teacher Rivera submits a ticket on IT/Hardware HIGH. Subcategory has `default_assignee_id=Sarah Mitchell` so the ticket should auto-assign to her, skip OPEN, and land in IN_PROGRESS with `first_response_at` populated.

```bash
JIM=$(login teacher@demo.campusos.dev)
SARAH=$(login principal@demo.campusos.dev)
IT_CAT=$(psql_demo "SELECT id::text FROM tenant_demo.tkt_categories WHERE name='IT';")
HW_SUB=$(psql_demo "SELECT s.id::text FROM tenant_demo.tkt_subcategories s
  JOIN tenant_demo.tkt_categories c ON c.id=s.category_id
  WHERE c.name='IT' AND s.name='Hardware';")

TICKET=$(curl -sS -X POST -H "Authorization: Bearer $JIM" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"categoryId\":\"$IT_CAT\",\"subcategoryId\":\"$HW_SUB\",\"priority\":\"HIGH\",\"title\":\"Projector broken in Room 101\",\"description\":\"CAT smoke — verifying full Cycle 8 flow\"}" \
  "http://localhost:4000/api/v1/tickets")

echo "$TICKET" | jq '{id, status, priority, assigneeName, slaPolicyId, firstResponseAt, sla:{r:.sla.responseHours, x:.sla.resolutionHours}}'
# → { "id": "019df073-…", "status": "IN_PROGRESS", "priority": "HIGH",
#     "assigneeName": "Sarah Mitchell",
#     "slaPolicyId": "019df018-60d9-…",
#     "firstResponseAt": "2026-05-04T00:46:07+00",
#     "sla": { "r": 2, "x": 8 } }

TICKET_ID=$(echo "$TICKET" | jq -r '.id')
```

Status flipped to IN_PROGRESS (auto-assignment skips OPEN), Sarah Mitchell auto-assigned via subcategory rule, SLA policy linked (HIGH = 2h response / 8h resolution), `firstResponseAt` populated since auto-assignment counts as the system acknowledging on her behalf.

The `dev.tkt.ticket.submitted` envelope is on Kafka with `source_module:'tickets'` and full ADR-057 shape; the `dev.tkt.ticket.assigned` envelope carries the `recipientAccountId` Sarah's `platform_users.id` for the Cycle 7 TaskWorker.

```sql
-- Admins receive ticket.submitted notifications
SELECT pu.email FROM tenant_demo.msg_notification_queue n
JOIN platform.platform_users pu ON pu.id = n.recipient_id
WHERE n.payload->>'ticket_id' = $TICKET_ID AND n.notification_type = 'ticket.submitted';
-- → principal@demo.campusos.dev
-- → admin@demo.campusos.dev
```

## Scenario 2 — TaskWorker creates auto-task on assignee's list

Within ~3 seconds, the Cycle 7 TaskWorker reacts to `tkt.ticket.assigned` and writes a TODO row on Sarah's list using the seeded `tkt.ticket.assigned` rule (Step 3).

```sql
SELECT t.id::text, t.source_ref_id::text, t.status, t.task_category, pu.email AS owner, LEFT(t.title, 60)
FROM tenant_demo.tsk_tasks t JOIN platform.platform_users pu ON pu.id = t.owner_id
WHERE t.source_ref_id = $TICKET_ID AND t.source = 'AUTO';
-- → 019df073-1735-… | <ticket-id> | TODO | ADMINISTRATIVE | principal@… | Resolve ticket: Projector broken in Room 101
```

`source_ref_id` matches the ticket id (the Step 4 universal `sourceRefId` payload field is recognised by the Step 4 `pickSourceRefId` worker fix). This linkage is what powers the Step 6 DONE-cascade in S6 below.

## Scenario 3 — First public comment bumps `first_response_at` + activity row + requester notification

Reset `first_response_at = NULL` to simulate a ticket where auto-assignment didn't bump it (e.g. a ticket that landed in OPEN and waited for a manual first response). Sarah posts a public comment "Checking the lamp." — first staff comment counts as the SLA-stop response.

```bash
psql_demo "UPDATE tenant_demo.tkt_tickets SET first_response_at = NULL WHERE id = '$TICKET_ID';"

curl -sS -X POST -H "Authorization: Bearer $SARAH" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"body":"Checking the lamp."}' \
  "http://localhost:4000/api/v1/tickets/$TICKET_ID/comments" | jq '{id, authorName, isInternal}'
# → { "id": "019df073-…", "authorName": "Sarah Mitchell", "isInternal": false }
```

Activity log + ticket state after S3:

```sql
SELECT first_response_at FROM tenant_demo.tkt_tickets WHERE id = $TICKET_ID;
-- → 2026-05-04 00:46:36.429642+00 (bumped to now())

SELECT activity_type, metadata FROM tenant_demo.tkt_ticket_activity WHERE ticket_id = $TICKET_ID;
-- → STATUS_CHANGE  {"to":"IN_PROGRESS","from":null,"reason":"submitted"}
-- → REASSIGNMENT   {"reason":"auto-assigned at submission","to_assignee_id":"…"}
-- → COMMENT        {"is_internal":false,"first_response_bump":true}
```

The `metadata.first_response_bump: true` flag captures the SLA-stop event. The `dev.tkt.ticket.commented` envelope payload carries `firstResponseBumped: true` — Cycle 6 TicketNotificationConsumer routes this to Rivera (the requester):

```sql
SELECT pu.email FROM tenant_demo.msg_notification_queue n
JOIN platform.platform_users pu ON pu.id = n.recipient_id
WHERE n.notification_type='ticket.commented' AND n.payload->>'ticket_id' = $TICKET_ID;
-- → teacher@demo.campusos.dev
```

## Scenario 4 — Internal comment hidden from requester, visible to staff

```bash
curl -sS -X POST -H "Authorization: Bearer $SARAH" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"body":"Need to order a replacement.","isInternal":true}' \
  "http://localhost:4000/api/v1/tickets/$TICKET_ID/comments" | jq '{isInternal}'
# → { "isInternal": true }

# Requester view
curl -sS -H "Authorization: Bearer $JIM" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/tickets/$TICKET_ID/comments" | jq 'length, .[].isInternal'
# → 1
# → false

# Admin view
curl -sS -H "Authorization: Bearer $SARAH" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/tickets/$TICKET_ID/comments" | jq 'length, .[].isInternal'
# → 2
# → false
# → true
```

Visibility filter at `CommentService.list` correctly hides `is_internal=true` rows from the requester. The `ticket.commented` notification for the internal row routes to admin@ Platform Admin (NOT to Rivera) — Cycle 6 fan-out matrix verified live in the Step 6 smoke.

## Scenario 5 — Vendor assignment with WO reference clears internal assignee

```bash
VENDOR=$(psql_demo "SELECT id::text FROM tenant_demo.tkt_vendors WHERE vendor_name='Springfield IT Solutions';")

curl -sS -X PATCH -H "Authorization: Bearer $SARAH" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"vendorId\":\"$VENDOR\",\"vendorReference\":\"WO-2026-0451\"}" \
  "http://localhost:4000/api/v1/tickets/$TICKET_ID/assign-vendor" | jq '{status, assigneeId, vendorName, vendorReference}'
# → { "status": "VENDOR_ASSIGNED", "assigneeId": null,
#     "vendorName": "Springfield IT Solutions", "vendorReference": "WO-2026-0451" }
```

Schema-level `tkt_tickets_assignee_or_vendor_chk` mutex satisfied — the same UPDATE clears the internal `assignee_id` and sets `vendor_id` + `vendor_reference` + `vendor_assigned_at = now()`. Status flips to VENDOR_ASSIGNED. `tkt.ticket.assigned` is **not** emitted on this path (Step 4 design — vendors don't have a Tasks app).

## Scenario 6 — Resolve + Step 6 auto-task DONE-cascade

```bash
# Pre-resolve task state
psql_demo "SELECT status, completed_at FROM tenant_demo.tsk_tasks WHERE source_ref_id='$TICKET_ID' AND source='AUTO';"
-- → TODO | (null)

curl -sS -X PATCH -H "Authorization: Bearer $SARAH" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"resolution":"Lamp replaced, projector working."}' \
  "http://localhost:4000/api/v1/tickets/$TICKET_ID/resolve" | jq '{status, resolvedAt}'
# → { "status": "RESOLVED", "resolvedAt": "2026-05-04T00:47:03+00" }

sleep 4

# Post-resolve: TicketTaskCompletionConsumer flipped the linked auto-task DONE
psql_demo "SELECT status, completed_at FROM tenant_demo.tsk_tasks WHERE source_ref_id='$TICKET_ID' AND source='AUTO';"
-- → DONE | 2026-05-04 00:47:03.908907+00
```

Consumer log line captured:

```
[ticket-task-completion] flipped 1 auto-task(s) DONE for ticket 019df073-16d5-…
```

`completed_at` matches the resolve timestamp to the same second. `ticket.resolved` notification queued for Rivera (the requester):

```sql
SELECT pu.email FROM tenant_demo.msg_notification_queue n
JOIN platform.platform_users pu ON pu.id = n.recipient_id
WHERE n.notification_type='ticket.resolved' AND n.payload->>'ticket_id' = $TICKET_ID;
-- → teacher@demo.campusos.dev
```

## Scenario 7 — SLA metrics computed from timestamps

```sql
SELECT
  ROUND(EXTRACT(EPOCH FROM (first_response_at - created_at))/60.0, 1) || ' min' AS response_time,
  ROUND(EXTRACT(EPOCH FROM (resolved_at - created_at))/60.0, 1) || ' min' AS resolution_time,
  CASE WHEN resolved_at - created_at <= INTERVAL '8 hours' THEN 'within 8h SLA ✓' ELSE 'breached' END AS verdict
FROM tenant_demo.tkt_tickets WHERE id = $TICKET_ID;
-- → 0.5 min | 0.9 min | within 8h SLA ✓
```

The `/helpdesk/admin/sla` dashboard aggregates these metrics across the school's resolved-ticket history client-side from the cached `useTickets` list — same arithmetic, just averaged.

## Scenario 8 — Problem grouping + batch-resolve

Admin creates a new problem linking T1 (OPEN — Projector seed) + T2 (IN_PROGRESS — Plumbing seed) and resolves it. The `ProblemService.resolveBatch` keystone locks both tickets `FOR UPDATE OF t` in one transaction, flips the problem to RESOLVED with root_cause + resolution + resolved_at populated, and batch-flips matching tickets to RESOLVED with one `tkt.ticket.resolved` emit per flipped ticket.

```bash
T1=$(psql_demo "SELECT id::text FROM tenant_demo.tkt_tickets WHERE title='Projector not working in Room 101';")
T2=$(psql_demo "SELECT id::text FROM tenant_demo.tkt_tickets WHERE title='Leaking faucet in staff bathroom';")

PROBLEM=$(curl -sS -X POST -H "Authorization: Bearer $SARAH" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"CAT smoke — Network switch failure in Building A\",\"description\":\"Recurring infra issue\",\"categoryId\":\"$IT_CAT\",\"ticketIds\":[\"$T1\",\"$T2\"]}" \
  "http://localhost:4000/api/v1/problems")
PROB_ID=$(echo "$PROBLEM" | jq -r '.id')

# Pre-resolve
psql_demo "SELECT title, status FROM tenant_demo.tkt_tickets WHERE id IN ('$T1','$T2') ORDER BY title;"
-- → Leaking faucet in staff bathroom | IN_PROGRESS
-- → Projector not working in Room 101 | OPEN

# Resolve-batch
curl -sS -X PATCH -H "Authorization: Bearer $SARAH" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"rootCause":"Building A core switch packet loss","resolution":"Replaced switch + verified link health."}' \
  "http://localhost:4000/api/v1/problems/$PROB_ID/resolve" \
  | jq '{problem:{status:.problem.status}, ticketsFlipped:.ticketsFlipped|length}'
# → { "problem": { "status": "RESOLVED" }, "ticketsFlipped": 2 }

# Post-resolve — both linked tickets flipped to RESOLVED
psql_demo "SELECT title, status FROM tenant_demo.tkt_tickets WHERE id IN ('$T1','$T2') ORDER BY title;"
-- → Leaking faucet in staff bathroom | RESOLVED
-- → Projector not working in Room 101 | RESOLVED
```

Already-resolved tickets are skipped by the `WHERE t.status = ANY('{OPEN, IN_PROGRESS, VENDOR_ASSIGNED, PENDING_REQUESTER}')` filter in the resolveBatch query — verified live in the Step 5 smoke (T3 was already RESOLVED so the original T1+T3 problem in the seed only flipped T1 — same skip behaviour applies here).

## Scenario 9 — Reopen — RESOLVED → OPEN, `resolved_at` cleared

```bash
T3=$(psql_demo "SELECT id::text FROM tenant_demo.tkt_tickets WHERE title='Can''t access gradebook';")

# T3 is RESOLVED in the seed; Rivera is the requester
psql_demo "SELECT status, resolved_at FROM tenant_demo.tkt_tickets WHERE id='$T3';"
-- → RESOLVED | 2026-04-12 16:30:00+00

curl -sS -X PATCH -H "Authorization: Bearer $JIM" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/tickets/$T3/reopen" | jq '{status, resolvedAt}'
# → { "status": "OPEN", "resolvedAt": null }
```

`resolved_at` cleared in the same UPDATE that flipped status to OPEN — the schema's multi-column `resolved_chk` is satisfied because `OPEN ⇒ resolved_at IS NULL`. Activity log captures the reopen STATUS_CHANGE row.

## Scenario 10 — 6 permission denial paths

```bash
STU=$(login student@demo.campusos.dev)
DAVID=$(login parent@demo.campusos.dev)
JIM=$(login teacher@demo.campusos.dev)

# Student POST /tickets — 403 (no it-001:write)
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Authorization: Bearer $STU" \
  -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" \
  -d "{\"categoryId\":\"$IT_CAT\",\"title\":\"phantom\"}" \
  "http://localhost:4000/api/v1/tickets"
# → 403

# Parent GET /tickets — 403 (no it-001:read)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $DAVID" \
  -H "X-Tenant-Subdomain: demo" "http://localhost:4000/api/v1/tickets"
# → 403

# Teacher POST /ticket-categories — 403 (no it-001:admin)
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Authorization: Bearer $JIM" \
  -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" \
  -d '{"name":"phantom"}' "http://localhost:4000/api/v1/ticket-categories"
# → 403

# Teacher POST /ticket-vendors — 403 (admin only)
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Authorization: Bearer $JIM" \
  -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" \
  -d '{"vendorName":"phantom","vendorType":"OTHER"}' \
  "http://localhost:4000/api/v1/ticket-vendors"
# → 403

# Teacher GET /problems — 403 (admin-only at service layer)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $JIM" \
  -H "X-Tenant-Subdomain: demo" "http://localhost:4000/api/v1/problems"
# → 403

# Teacher GET /tickets/:T2 — 404 (row scope on Park's plumbing ticket)
T2_ID=$(psql_demo "SELECT id::text FROM tenant_demo.tkt_tickets WHERE title='Leaking faucet in staff bathroom';")
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $JIM" \
  -H "X-Tenant-Subdomain: demo" "http://localhost:4000/api/v1/tickets/$T2_ID"
# → 404 (row-scope filter — Rivera is neither requester nor assignee on T2; service returns 404 not 403 to match the don't-leak-existence pattern)
```

All 6 denials behave exactly as designed. The mix of gate-tier 403 (no `it-001:read|write|admin`) and service-layer 404 (row scope on the per-ticket detail) covers both the permission catalogue gates and the don't-leak-existence pattern from prior cycles.

## Cleanup script

Restores `tenant_demo` to the post-Step-3 seed state. Run after the smoke completes.

```sql
-- Drop the smoke ticket (CASCADE drops 2 comments + 4 activity rows)
DELETE FROM tenant_demo.tkt_tickets
WHERE title = 'Projector broken in Room 101' AND description LIKE 'CAT smoke%';

-- Drop the smoke problem + its link rows
DELETE FROM tenant_demo.tkt_problems
WHERE title = 'CAT smoke — Network switch failure in Building A';

-- Drop the smoke notification queue rows (5 — submitted×2, assigned, commented×2 from S3, resolved)
DELETE FROM tenant_demo.msg_notification_queue
WHERE notification_type LIKE 'ticket.%' AND payload->>'ticket_id' IN (
  SELECT id::text FROM tenant_demo.tkt_tickets WHERE title = 'Projector broken in Room 101'
);

-- Drop the AUTO task created by Step 6 (already-DONE row, but no longer linked)
DELETE FROM tenant_demo.tsk_tasks
WHERE source = 'AUTO' AND title = 'Resolve ticket: Projector broken in Room 101';

-- Restore T1 + T2 + T3 to their seed states
UPDATE tenant_demo.tkt_tickets SET status='OPEN', resolved_at=NULL, updated_at=now()
WHERE title='Projector not working in Room 101';
UPDATE tenant_demo.tkt_tickets SET status='IN_PROGRESS', resolved_at=NULL, updated_at=now()
WHERE title='Leaking faucet in staff bathroom';
UPDATE tenant_demo.tkt_tickets
SET status='RESOLVED', resolved_at='2026-04-12 16:30:00+00', updated_at=now()
WHERE title='Can''t access gradebook';

-- Drop the batch-resolve activity rows from S8 (matches the metadata.reason LIKE pattern)
DELETE FROM tenant_demo.tkt_ticket_activity
WHERE metadata->>'reason' LIKE '%batch resolved via problem%';

-- Drop the reopen activity row from S9
DELETE FROM tenant_demo.tkt_ticket_activity
WHERE activity_type='STATUS_CHANGE' AND metadata->>'reason' = 'reopened by requester or admin';
```

After cleanup the tenant returns to the post-Step-3 shape: 3 categories / 11 subcategories / 12 SLA / 2 vendors / 5 tickets (in their original states) / 1 problem (the seeded one with T1+T3 linked, INVESTIGATING).

## Closing

**All 10 plan scenarios pass.** Cycle 8 ships clean to the post-cycle architecture review.

The vertical slice exercises every key integration point in the cycle:

- Schema multi-column CHECKs (resolved_chk, assignee_or_vendor_chk, vendor_pair_chk, problem resolved_chk) all enforce the right invariants — every state-machine transition runs through `executeInTenantTransaction` + `SELECT … FOR UPDATE`.
- The auto-assignment chain (`subcategory.default_assignee_id → auto_assign_to_role → admin queue`) routes the demo ticket directly to Sarah without admin intervention.
- The Cycle 7 TaskWorker reacts to `tkt.ticket.assigned` and creates an AUTO task with `source_ref_id` populated (the Step 4 `pickSourceRefId` worker fix is the load-bearing piece here).
- Step 6's `TicketTaskCompletionConsumer` closes the loop on `tkt.ticket.resolved` — the linked auto-task flips DONE within the same second as the resolve.
- Step 6's `TicketNotificationConsumer` fan-out matrix correctly routes public/internal comments to the right inboxes (admin sees internal, requester does not).
- The problem batch-resolve keystone locks both linked tickets `FOR UPDATE OF t` in one transaction and emits one `tkt.ticket.resolved` per flipped ticket.
- 6 permission denials covering gate-tier 403 + service-layer row-scope 404.

Reviewer attention items (non-blocking, Phase 2 polish):

- **Bulk actions on the admin queue.** Per-row Assign + Vendor work fine for the demo. Bulk assign / bulk close + bulk priority change are documented in the plan but punted to a future polish pass.
- **SLA matrix per-row edit modal.** Read-only on the dashboard this cycle. The `useUpsertTicketSla` hook is wired and the API endpoint exists; future polish lands a `<EditSlaPolicyModal>`.
- **Ticket volume time-series chart.** Would need a histogram aggregation endpoint that this cycle does not ship; punted to ops dashboards.
- **Attachment upload UI.** `tkt_ticket_attachments` is in the schema (Step 2) and the read path is wired into the activity log (`ATTACHMENT` activity_type), but no upload service or signed-URL flow yet — Phase 3 ops.
- **Email-to-ticket inbound + CSAT survey on close.** Documented in the plan as deferred per Wave 1 scope; both are Phase 3 ops.
- **Reviewer carry-over flagged in HANDOFF-CYCLE8.md** — bulk problem-from-multiple-tickets (today admins use one ticket as the seed then Link more in the modal); per-problem assignee/vendor edit (the schema + payload support it but no Edit Modal field yet); SLA breach cron worker (schema has the `SLA_BREACH` activity_type wired but no cron emits it yet).
