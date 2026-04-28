# Cycle 4 Architecture Review — ChatGPT (Adversarial)

**Reviewer:** ChatGPT
**Scope:** Full Cycle 4 (HR & Workforce Core — HR-Employee identity bridge, employees + positions schema, leave management, certifications + training compliance, onboarding, NestJS modules, web UI, vertical-slice CAT)
**Round 1 SHA under review:** `efbcb44` (Step 10 — vertical-slice CAT, Cycle 4 COMPLETE)
**Round 1 verdict:** **REJECT** — pending 1 BLOCKING fix
**Round 2 SHA under review:** _pending re-review after fix commit_
**Final verdict:** _pending Round 2_

**Verdict trail:**

| Round | Date           | SHA         | Verdict                                              |
| ----: | -------------- | ----------- | ---------------------------------------------------- |
|     1 | April 28, 2026 | `efbcb44`   | REJECT pending 1 BLOCKING fix (3 MAJOR + 10 PASS)    |
|     2 | _pending_      | _post-fix_  | _to be filled in after Round 2 re-review_            |

---

## Round 1 — Result: 10 PASS · 3 DEVIATION · 1 VIOLATION

Cycle 4 is strong overall, but the leave lifecycle has a real concurrency bug. Reviewer would not approve until `approve / reject / cancel` are made transactionally status-safe.

### BLOCKING 1 — Leave approve/reject/cancel can double-apply balances under concurrency

**ADR violated:** None directly, but the Cycle 2 BLOCKING 2 fix established the at-least-once + serialised-write pattern for tenant writes; the leave lifecycle did not carry it through.

**File:** `apps/api/src/hr/leave.service.ts` — `approve()`, `reject()`, `cancel()`

**Issue.** Each method calls `loadForReview(id, 'PENDING')` *outside* the transaction, then runs the balance UPDATE + status UPDATE inside a separate `executeInTenantTransaction`. Two simultaneous admin actions can both pass the PENDING check, both enter their respective transactions, and both apply the balance deltas + the status flip. The non-negative balance CHECKs from migration 012 catch *some* underflow patterns (e.g. double-cancel from `pending=0`) but do not catch double-decrement of `pending` plus double-increment of `used` on a concurrent approve. The visible symptom would be `used` running ahead of reality; balances drift; `available = accrued - used - pending` goes negative under load.

**Required fix.** Move the status read inside the transaction and lock it: `SELECT … FROM hr_leave_requests WHERE id = $1 FOR UPDATE`. Then verify status and update balances inside the same transaction. For approve/reject, require `status='PENDING'` after the lock. For cancel, use the locked previous status to decide whether to subtract from `pending` or `used`.

**Triage (Claude):** VALID. Real concurrency bug — the existing tests didn't drive it because the CAT runs serially. The fix is straightforward and lands in the same commit as the Round-1 follow-up.

### MAJOR 1 — `ON_LEAVE` employees lose `actor.employeeId`

**File:** `apps/api/src/iam/actor-context.service.ts` — `resolveEmployeeId()`

The schema allows `employment_status IN ('ACTIVE','ON_LEAVE','TERMINATED','SUSPENDED')`, but the resolver filters `employment_status = 'ACTIVE'`. An employee marked ON_LEAVE may lose access to `/leave`, `/staff/me`, certifications, documents, and other own-profile surfaces. `ON_LEAVE` should be the "still-employed-but-not-working" state, not the "access disabled" state.

**Required fix:** Resolve `employeeId` for `ACTIVE` and `ON_LEAVE`. `TERMINATED` + `SUSPENDED` stay excluded.

**Triage (Claude):** VALID. The implicit semantic was wrong — `ON_LEAVE` should keep portal access (the employee may still need to file leave-extension requests, view certs, etc.).

### MAJOR 2 — Compliance dashboard UI permission and API authorization don't fully align

**Files:** `apps/web/src/components/shell/apps.tsx` + `apps/api/src/hr/training-compliance.service.ts::getDashboard`

The web tile gates on `sch-001:admin OR hr-004:admin`, but the API service-layer admin check accepts only `actor.isSchoolAdmin` (i.e. `sch-001:admin`). Current seed masks this because Teacher / Staff hold neither admin code, but a future HR-Compliance Admin role with `hr-004:admin` would see the tile and still get 403 from the service.

**Required fix:** Either narrow the UI to `sch-001:admin` only, or widen the service to also accept tenant-scoped `hr-004:admin`.

**Triage (Claude):** VALID. The plan's intent was for `hr-004:admin` to be the dedicated compliance-admin gate; widen the service so the contract is consistent.

### MAJOR 3 — `hr.leave.coverage_needed` can duplicate if idempotency claim fails after emit

**File:** `apps/api/src/hr/leave-notification.consumer.ts` — `emitCoverageNeeded`

`processWithIdempotency` claims the inbound event_id only after the `process()` callback succeeds (Cycle 2 BLOCKING 2 pattern — at-least-once semantics). If the republish to `hr.leave.coverage_needed` succeeds but the post-process idempotency claim fails, a Kafka redelivery re-runs `process()`, generating a fresh UUIDv7 for the republished envelope. Cycle 5's future consumer would see a different event_id and process the dup.

**Acceptable while Cycle 4 is publish-only**, but should be fixed before Cycle 5 consumes the event.

**Required fix:** Use a deterministic event_id for the republish (e.g. UUIDv5 derived from the inbound event_id + a stable suffix) so a Kafka redelivery republish carries the same event_id and Cycle 5's idempotency table catches the dup.

**Triage (Claude):** VALID. Fixing it now (rather than deferring) closes the gap before Cycle 5 even starts consuming.

### Strong passes (10 PASS)

- HR bridge is now real: `actor.employeeId` is populated and old `personId` comparisons have been retired.
- Tenant isolation still uses `SET LOCAL search_path` inside interactive transactions.
- CAT verifies 74 tenant base tables and 0 cross-schema FKs.
- HR endpoints are permission-protected.
- ADR-057 envelope support remains intact.
- Kafka consumer retry/DLQ behavior from Cycle 3 is preserved.
- (Plus 4 implicit passes for the other Cycle 1–3 invariants the cycle didn't disturb.)

---

## Fix log (REVIEW-CYCLE4 fixes — landed for Round 2)

All four findings addressed in a single follow-up commit. Build clean (`pnpm --filter @campusos/api build` exits 0), all four fixes verified live against `tenant_demo`.

### BLOCKING 1 — Leave lifecycle race

**Files:** `apps/api/src/hr/leave.service.ts`

`approve / reject / cancel` now run a single `executeInTenantTransaction` that:

1. `SELECT lr.id, lr.employee_id, e.account_id, lr.leave_type_id, lr.days_requested, lr.status FROM hr_leave_requests lr JOIN hr_employees e ON e.id = lr.employee_id WHERE lr.id = $1 FOR UPDATE OF lr` — locks the request row.
2. Validates `status` against the expected value (`PENDING` for approve/reject, no requirement for cancel — uses the locked status to choose `used` vs `pending` reversal).
3. Runs the balance UPDATE + status UPDATE in the same tx.

A new private helper `lockAndValidate(tx, id, requireStatus)` encapsulates steps 1+2; the three lifecycle methods use it. The previous `loadForReview` is kept for the `cancel` ownership pre-flight (cheap read outside the tx so a non-owner doesn't acquire a lock just to be 403'd) and for `getById`'s row-fetch.

**Smoke:** 5 parallel approve curls against the same PENDING request — 1 returned 200, 4 returned `400 "Leave request … is in status APPROVED; expected PENDING"`. PD balance moved cleanly from `pending=1 used=0 → pending=0 used=1`. Pre-fix this would have applied 5× the deltas.

### MAJOR 1 — Resolver includes ON_LEAVE

**File:** `apps/api/src/iam/actor-context.service.ts::resolveEmployeeId`

```diff
-WHERE person_id = $1::uuid AND employment_status = 'ACTIVE'
+WHERE person_id = $1::uuid AND employment_status IN ('ACTIVE', 'ON_LEAVE')
```

`TERMINATED` + `SUSPENDED` stay excluded — those are the access-disabled states.

**Smoke:** flipped Rivera's `employment_status` to `ON_LEAVE` and `GET /employees/me` returned 200 with `employmentStatus: 'ON_LEAVE'`. Flipped to `TERMINATED` and `/employees/me` returned 404 with the correct "no employee record" message.

### MAJOR 2 — Compliance dashboard widens to `hr-004:admin`

**File:** `apps/api/src/hr/training-compliance.service.ts::getDashboard`

`TrainingComplianceService` now injects `PermissionCheckService`. The admin check is:

```ts
var allowed = actor.isSchoolAdmin;
if (!allowed) {
  var tenant = getCurrentTenant();
  allowed = await this.permCheck.hasAnyPermissionInTenant(
    actor.accountId, tenant.schoolId, ['hr-004:admin'],
  );
}
if (!allowed) throw new ForbiddenException(…);
```

Same scope-chain helper as every other tenant-bounded admin check (`PermissionCheckService.hasAnyPermissionInTenant`). The web tile in `apps.tsx` already gates on `sch-001:admin OR hr-004:admin`; the API now matches.

**Smoke:** principal@ (sch-001:admin) GET /compliance/dashboard → 200 with the seeded counts. teacher@ (no admin code) → 403 with the unchanged error message.

### MAJOR 3 — `hr.leave.coverage_needed` deterministic event_id

**Files:** `apps/api/src/kafka/event-envelope.ts`, `apps/api/src/kafka/kafka-producer.service.ts`, `apps/api/src/hr/leave-notification.consumer.ts`

1. Added optional `eventId?: string` to `EnvelopeOptions` and `EmitOptions`. When supplied, `envelopeFromOptions` uses it instead of generating a fresh UUIDv7. When omitted, the existing UUIDv7 path runs unchanged.
2. `LeaveNotificationConsumer.emitCoverageNeeded` derives a deterministic UUID from the inbound `hr.leave.approved` event_id via `sha1(inbound_event_id + ':hr.leave.coverage_needed.v1').slice(0, 16)`, formatted as a v5-shaped UUID (high nibble of byte 6 = 5, variant bits set per RFC 4122). The implementation lives in a small `deterministicCoverageEventId` helper in the consumer file. We use `node:crypto.createHash` instead of the `uuid` package because `@campusos/api` doesn't depend on `uuid`; the byte layout matches what `uuid.v5(name, namespace)` would produce, so a future migration to the package is drop-in.
3. The republish also sets `correlationId: event.eventId` so the trace chain `inbound → republish` is preserved on the wire.

**Smoke:** submitted a fresh leave request, approved it, observed `dev.hr.leave.approved.event_id = 019dd574-74f8-7994-99b3-6cf741aa6327` and `dev.hr.leave.coverage_needed.event_id = c5e8825c-e0c1-51a7-9481-307ad03d3c91`. Independently computed the expected hash in Python — match. UUID v5 marker (`'5'` at index 14) is in place. `correlation_id` on the coverage envelope equals the inbound event_id. A Kafka redelivery would produce the exact same event_id; Cycle 5's consumer idempotency table will catch it.

---

## Round 2 — _pending_

Once the four fixes commit, the cycle is ready for re-review. Expected outcome (mirroring Cycle 3's trail): re-review at the new SHA returns APPROVED. The Round 2 entry in the table at the top will be filled in after that re-review lands.
