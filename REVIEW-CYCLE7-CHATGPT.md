# REVIEW-CYCLE7-CHATGPT

External post-cycle architecture review of Cycle 7 (Tasks & Approval
Workflows) by ChatGPT against `cycle7-complete` (initial SHA `bbea63a`,
post-format SHA `c6e7732`).

## Round 1 — REJECT pending fixes

Reviewer flagged **2 BLOCKING + 3 MAJOR** issues. All 5 valid.

### Triage table

| #          | Severity | Finding                                                                                                                                                                                                                                     | Verdict | Resolution                                                                                                                                                                                                                                         |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BLOCKING 1 | CRITICAL | TaskWorker swallows ack/task INSERT failures with `logger.warn; continue;` — outer `processWithIdempotency` then claims the event. Redis dedup is also claimed BEFORE insert, so a failed insert blocks future retry for that owner/source. | VALID   | Fixed: rethrow on insert failure + release Redis claim before rethrow; add Redis SET NX dedup to ack inserts and lookup-existing on dedup hit.                                                                                                     |
| BLOCKING 2 | HIGH     | `POST /approvals` exposed via `ops-001:write` which Teacher / Parent / Student / Staff all hold; engine accepts arbitrary `requestType` + `referenceId` + `referenceTable` without ownership / type validation.                             | VALID   | Fixed: gate `POST /approvals` on `ops-001:admin`. Domain modules (LeaveService etc.) submit programmatically and bypass. Defence-in-depth: allowlist of `referenceTable` values + strict regex + per-tenant existence check on the referenced row. |
| MAJOR 3    | MEDIUM   | `approval.request.resolved` payload omits the final approver's account id; `LeaveApprovalConsumer` falls back to requester id, so `hr_leave_requests.reviewed_by` is wrong for engine-driven approvals.                                     | VALID   | Fixed: engine emits `approverAccountId` (the actor whose action resolved the request) on both `advanceStep` (APPROVED / REJECTED) and `withdraw` (WITHDRAWN). Consumer's existing `?? p.requesterId` fallback stays as transition defence.         |
| MAJOR 4    | MEDIUM   | `TaskService.create()` admin delegation does not validate `assigneeAccountId` belongs to the current tenant — admin in tenant A could land a task on a foreign UUID.                                                                        | VALID   | Fixed: new `assertAssigneeInCurrentTenant` mirrors the Cycle 6.1 ProfileService pattern — verifies `platform_users.id` has a `sis_students` / `sis_guardians` / `hr_employees` projection in the calling tenant.                                   |
| MAJOR 5    | DOC-ONLY | `POST /approvals/:id/withdraw` `@ApiOperation` summary says "does NOT emit approval.request.resolved" but the engine DOES emit it (Step 10 close-out wired the WITHDRAWN cascade).                                                          | VALID   | Fixed: rewrote summary to describe the actual behavior (emits with `status='WITHDRAWN'` so source-module consumers cascade-cancel the underlying domain row).                                                                                      |

### Live verification (`tenant_demo`, 2026-05-03)

**BLOCKING 2** — three layers all fire:

```
Teacher POST /approvals → 403 (ops-001:admin required, was ops-001:write)
Parent  POST /approvals → 403
Admin   POST /approvals + valid-format UUID + 'hr_leave_requests'
        → 400 "Referenced row hr_leave_requests/<uuid> not found"
Admin   POST /approvals + valid-format UUID + 'platform_users'
        → 400 "referenceTable 'platform_users' is not in the workflow allowlist"
Admin   POST /approvals + 'DROP TABLE x' (regex injection guard)
        → 400 "referenceTable must be a snake_case identifier"
```

**MAJOR 3** — leave audit trail is now accurate. End-to-end smoke:

- Rivera submits 1-day Sick leave for 2026-10-15
- Engine creates approval request + Step 1
- Sarah (admin@principal) approves Step 1 + Step 2
- LeaveApprovalConsumer fires within ~1s
- `hr_leave_requests.reviewed_by = 019dc92d-087d-7442-abf5-d16bc2fe960d`
  (Sarah's accountId), NOT `019dc92d-0882-7442-abf5-e33e03046357`
  (Rivera/requester's accountId)
- Wire envelope captured on `dev.approval.request.resolved`:

```json
{
  "event_type": "approval.request.resolved",
  "source_module": "workflows",
  "payload": {
    "requestType": "LEAVE_REQUEST",
    "status": "APPROVED",
    "approverAccountId": "019dc92d-087d-7442-abf5-d16bc2fe960d",
    "requesterId": "019dc92d-0882-7442-abf5-e33e03046357"
  }
}
```

**MAJOR 4** — admin POST /tasks with bogus assigneeAccountId 400s with
`"assigneeAccountId does not belong to a user in this school"`; with
Maya's real accountId, the task lands cleanly with `ownerName=Maya Chen
createdForName=Sarah Mitchell`.

**BLOCKING 1** — positive smoke confirms TaskWorker still creates tasks
on `cls.assignment.posted` (count went 4 → 5 within 4s of teacher
publishing). The rethrow + Redis-release path is a defensive change that
is hard to trigger naturally; static review confirms the patch shape:

```ts
} catch (e: any) {
  if (dedupKey) await this.redis.releaseIdempotency(dedupKey);
  this.logger.error('... released Redis claim, rethrowing for retry: ' + msg);
  throw e;
}
```

Combined with `processWithIdempotency`'s claim-after-success semantics
(read-only `isClaimed` on arrival, `claim()` only after `process()`
returns), a thrown error means Kafka redelivers and the same logical
work retries. Owners whose insert already succeeded keep their Redis
claim and skip cleanly on retry. For acknowledgements, the same Redis
dedup pattern landed (was previously missing entirely) plus
`lookupExistingAck` so a redelivery can link the existing ack id into
the companion CREATE_TASK.

**MAJOR 5** — controller summary updated; no behavior change.

## Round 2

To be filed by the reviewer after these fixes land.
