# Cycle 5 Architecture Review — ChatGPT (Adversarial)

**Reviewer:** ChatGPT
**Scope:** Full Cycle 5 (Scheduling & Calendar — bell schedules, timetable with EXCLUSION constraints, rooms + bookings, calendar + day overrides, coverage requests + substitution timetable, CoverageConsumer, NestJS modules, web UI, vertical-slice CAT)
**Round 1 SHA under review:** `e214bdc` (CI fix — Cycle 5 COMPLETE through Step 10)
**Round 1 verdict:** **REJECT** — pending 2 BLOCKING fixes

**Verdict trail:**

| Round | Date           | SHA       | Verdict                                                |
| ----: | -------------- | --------- | ------------------------------------------------------ |
|     1 | April 28, 2026 | `e214bdc` | REJECT pending 2 BLOCKING fixes (4 DEVIATION + 9 PASS) |
|     2 | April 28, 2026 | `653fd4c` | Awaiting re-review — 4 fixes landed (2 BLOCKING + 2 actionable MAJOR) |

---

## Round 1 — Result: 9 PASS · 4 DEVIATION · 2 VIOLATION

Cycle 5 is strong, but two concurrency / state-machine bugs would block approval. Both are the same pattern flagged in Cycle 4 BLOCKING 1 (leave approve/reject/cancel) — read-then-write across tx boundaries.

### BLOCKING 1 — Room bookings can double-book under concurrency

**ADR violated:** None directly, but the Cycle 4 BLOCKING 1 fix established the locked-read-inside-tx pattern; the room-booking service did not carry it through.

**File:** `apps/api/src/scheduling/room-booking.service.ts` — `create()`

**Issue.** `RoomBookingService.create()` calls `assertNoConflicts()` first, then runs the INSERT in a separate `executeInTenantContext` block. The schema explicitly does NOT enforce booking-vs-booking or booking-vs-timetable overlap (the partial INDEX on `(room_id, start_at, end_at) WHERE status='CONFIRMED'` is a read-side index, not a UNIQUE / EXCLUSION). Two simultaneous POST `/room-bookings` requests targeting the same room and overlapping window can both pass `assertNoConflicts()` and both insert CONFIRMED rows. The schema accepts both; the timetable grid then shows two confirmed bookings overlapping; the next read of `assertNoConflicts` against any third booking would surface the conflict but the damage is done.

**Required fix.** Wrap conflict check + INSERT in one transaction and lock by room. Two reasonable strategies:

1. `pg_advisory_xact_lock(hashtext($roomId))` at the top of the tx so simultaneous bookings on the same room serialise on the lock; re-run `assertNoConflicts()` inside the lock; then INSERT.
2. Add an EXCLUSION constraint on `sch_room_bookings` for `(room_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&) WHERE status='CONFIRMED'` — schema-side guarantee, no app-layer concurrency to manage.

Option 1 is the lighter fix; option 2 is the durable guarantee. Either lands the contract.

**Triage (Claude):** VALID. Same shape as Cycle 4 BLOCKING 1; the CAT smoke runs serially so the race is invisible to it. Going with option 1 (advisory lock) as the minimum fix because option 2 requires a new migration + the booking-vs-timetable conflict can't be enforced at the schema layer anyway (it stays app-layer per the Step 2 out-of-scope decision).

### BLOCKING 2 — Room change request approve/reject has a status race

**ADR violated:** Same as BLOCKING 1.

**File:** `apps/api/src/scheduling/room-change-request.service.ts` — `approve()`, `reject()`

**Issue.** Both methods call `getById()` outside the transaction to read current status, then run the UPDATE inside `executeInTenantContext` without `FOR UPDATE` or a `WHERE status='PENDING'` predicate. Two admins simultaneously approving the same PENDING request would both pass the status check, both UPDATE, and both emit the audit fields — last writer wins, but both transactions appear to succeed.

**Required fix.** Move the status read inside the transaction with `FOR UPDATE`:

```sql
SELECT id, status FROM sch_room_change_requests WHERE id = $1::uuid FOR UPDATE
```

Then assert status='PENDING' under the lock, then run the UPDATE. Add `AND status='PENDING'` to the UPDATE WHERE clause as belt-and-braces.

**Triage (Claude):** VALID. Same pattern as Cycle 4 BLOCKING 1 fix.

---

## Major deviations / follow-ups

These are accepted but worth tracking:

### MAJOR 1 — CoverageConsumer trusts event tenant routing fields

**File:** `apps/api/src/notifications/consumers/notification-consumer-base.ts` (the `unwrapEnvelope` helper) used by `CoverageConsumer`.

**Issue.** `unwrapEnvelope` reconstructs `schemaName = 'tenant_' + subdomain` from the inbound envelope/headers and pins context to that schema without validating the (`tenant_id`, `subdomain`) pair against `platform_tenant_routing`. An attacker who can write to a Kafka topic could pin the consumer to the wrong tenant.

**Triage (Claude):** ACCEPTED DEVIATION. This affects every consumer in the system (Cycles 3 + 4 + 5), not just Cycle 5's `CoverageConsumer`. Hardening belongs in the consumer base, behind a defence-in-depth flag, and applies retroactively. Not Cycle 5 scope; Phase 2 punch list. The current model assumes Kafka topic ACLs prevent forged events from internal services.

### MAJOR 2 — `sch.coverage.needed` emit is best-effort after DB commit

**File:** `apps/api/src/scheduling/coverage.consumer.ts`

**Issue.** The consumer commits the OPEN coverage row inserts in a transaction, then emits `sch.coverage.needed` outside the tx. If the broker is unreachable when the emit fires, coverage rows exist but the admin-feed event is absent.

**Triage (Claude):** ACCEPTED DEVIATION. The coverage board UI is DB-driven (`useCoverageRequests` polls `/coverage`), not event-driven, so a missing emit doesn't break the user-visible flow. Future consumers that genuinely need the event would need a transactional outbox pattern; not currently the case. Documented in HANDOFF Step 6 already.

### MAJOR 3 — DayOverrideService duplicate race returns raw DB conflict

**File:** `apps/api/src/scheduling/day-override.service.ts` — `create()`

**Issue.** Pre-checks for an existing override on (school_id, override_date) outside the tx, then INSERTs. A concurrent create can still hit the schema's UNIQUE constraint and surface as a raw 500 / Prisma error instead of the friendly 409 the service intends.

**Required fix.** Wrap pre-check + INSERT in one tx, catch SQLSTATE 23505 on the constraint name, rethrow as `ConflictException` with the same friendly message.

**Triage (Claude):** VALID and small. Will fix in the same Round-2 commit — preserves the friendly-409 contract under the race.

### MAJOR 4 — Migration COMMENT mismatch on `sch_timetable_slots.teacher_id`

**File:** `packages/database/prisma/tenant/migrations/016_sch_timetable_and_bookings.sql`

**Issue.** The COMMENT on `sch_timetable_slots.teacher_id` reads `Soft FK to hr_employees(id)` but the column actually carries a real DB-enforced `REFERENCES hr_employees(id)` FK declaration. The schema is correct (intra-tenant FKs are enforced per the convention); the comment is wrong and would mislead a reader who took it at face value.

**Required fix.** Rewrite the COMMENT text to match the schema reality. Reminder: cannot include `;` inside the COMMENT string per the splitter trap.

**Triage (Claude):** VALID and trivial. Will fix in the same Round-2 commit.

---

## Strong passes (9)

- Cycle 5 scope and review contract are clearly documented (`REVIEW-CYCLE5-HANDOFF-CHATGPT.md`).
- Scheduling module is registered in `AppModule`.
- Tenant execution still uses interactive transaction + `SET LOCAL search_path` (REVIEW-CYCLE1 fix preserved).
- ADR-057 envelope is intact in `KafkaProducerService.emit`.
- Timetable EXCLUSION constraints exist for both teacher and room overlaps (`sch_timetable_slots_teacher_no_overlap`, `sch_timetable_slots_room_no_overlap`).
- `TimetableService.listForStudent` (Step 9) uses `StudentService.assertCanViewStudent` for row-scope.
- `CoverageService.list` is correctly row-scoped for non-admin staff (absent OR assigned).
- `CoverageService.assign` uses `SELECT … FOR UPDATE` and status validation (the model fix the BLOCKINGs above are missing).
- `CalendarService` correctly admin-scopes draft visibility.

---

## Fix priority order (Round 1)

| Priority | Finding                                               | Risk                                               | Effort                                                   |
| -------: | ----------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
|    🔴 P0 | BLOCKING 1 — Room booking double-book under load      | Two confirmed overlapping bookings; visible UI bug | Small (1 tx + advisory lock; or new EXCLUSION migration) |
|    🔴 P0 | BLOCKING 2 — Room change approve/reject status race   | Last-writer-wins on parallel approve / reject      | Small (1 SELECT FOR UPDATE + status WHERE on UPDATE)     |
|    🟠 P1 | MAJOR 3 — Day override duplicate race raw DB conflict | UX regression on a concurrent admin op             | Tiny (pre-check + 23505 catch)                           |
|    🟡 P2 | MAJOR 4 — Migration COMMENT mismatch                  | Misleading docs; no runtime impact                 | Trivial (comment text only)                              |
|     ⚪ — | MAJOR 1 — Consumer envelope tenant validation         | Defence-in-depth; not Cycle 5 scope                | Phase 2                                                  |
|     ⚪ — | MAJOR 2 — `sch.coverage.needed` emit best-effort      | Acceptable given DB-driven UI                      | Phase 2 if needed                                        |

---

## Gate decision (Round 1)

**REJECT pending fixes.**

Fix BLOCKING 1 and BLOCKING 2 first; MAJOR 3 + 4 are tiny and folded into the same commit. After those land, Cycle 5 should be approvable.

---

## Round 2 — Fixes applied (single commit, ready for re-review)

All 4 actionable findings landed. The 2 MAJORs flagged as accepted deviations (1 + 2) remain on the Phase 2 punch list and are unchanged.

### Fix 1 — Room booking concurrency (BLOCKING 1)

**File:** `apps/api/src/scheduling/room-booking.service.ts` — `create()`

`create()` now wraps the conflict check + INSERT in a single `executeInTenantTransaction`. At the top of the transaction, the service takes a per-room PostgreSQL advisory transaction lock:

```sql
SELECT pg_advisory_xact_lock(hashtext('sch_room_bookings:' || $1))
```

The lock is keyed on `'sch_room_bookings:' + roomId` (string-prefixed so it can't collide with future advisory locks on other resources). Two simultaneous booking attempts on the same room serialise on the lock; the second tx waits, sees the first's INSERT inside its conflict check, and 409s. Different rooms hash to different keys → no contention. The lock auto-releases at `COMMIT` / `ROLLBACK`.

`assertNoConflicts` was renamed to `assertNoConflictsInTx` and now takes the active `PrismaClient` so the conflict check runs inside the same tx (and same lock) as the INSERT. The booking-vs-booking and booking-vs-timetable predicates are unchanged.

**Verified live (2026-04-28):** 5 parallel `POST /room-bookings` for Library 2030-04-15 09:00–10:00 → exactly 1 landed 201, the other 4 returned `409 Conflict — "Room is already booked for an overlapping window (booking <id-of-the-winner>)"`. Cleanup dropped the 1 confirmed booking.

### Fix 2 — Room change approve/reject status race (BLOCKING 2)

**File:** `apps/api/src/scheduling/room-change-request.service.ts` — `approve()`, `reject()`

Both methods now run inside `executeInTenantTransaction`. The first SQL inside the tx is a locked status read:

```sql
SELECT status, requested_room_id::text AS requested_room_id
FROM sch_room_change_requests WHERE id = $1::uuid FOR UPDATE
```

The status check and the UPDATE both happen under the row lock. The UPDATE WHERE clause adds `AND status = 'PENDING'` as belt-and-braces. A 404 path fires when the row doesn't exist (locked read returns 0 rows); a 400 fires when the locked status is anything other than PENDING. The optional `approvedRoomId` validation also moves inside the tx so the approve path never lands a row with NULL `requested_room_id` after the lock.

**Verified live (2026-04-28):** 5 parallel `PATCH /room-change-requests/:id/approve` against the same PENDING row → exactly 1 landed 200 (`status=APPROVED`), the other 4 returned `400 Bad Request — "Request is in status APPROVED; only PENDING requests can be approved"`. Cleanup dropped the smoke RCR.

### Fix 3 — DayOverrideService duplicate-race translation (MAJOR 3)

**File:** `apps/api/src/scheduling/day-override.service.ts` — `create()`

Pre-check + INSERT now run inside one `executeInTenantTransaction`. A try/catch around the tx body catches both shapes the duplicate-race surfaces as:

- The pre-check sees the existing row (sequential case) → throws `ConflictException` with the friendly message inside the tx.
- The pre-check passes but a concurrent INSERT lands first (race case) → `INSERT` raises SQLSTATE 23505 / Prisma `P2002` on `sch_calendar_day_overrides_school_date_uq`. The catch outside the tx detects either the SQLSTATE or the P2002 marker on `e.meta.code` and rethrows the same `ConflictException`.

Either path returns the friendly 409; raw DB errors no longer leak through.

**Verified live (2026-04-28):** 5 parallel `POST /calendar/overrides` for `2031-12-25` → exactly 1 landed 201, the other 4 returned `409 Conflict — "A day override already exists for 2031-12-25 — DELETE it first"`. Cleanup dropped the 1 created row.

### Fix 4 — Migration COMMENT mismatch (MAJOR 4)

**File:** `packages/database/prisma/tenant/migrations/016_sch_timetable_and_bookings.sql`

The COMMENT on `sch_timetable_slots.teacher_id` was rewritten from `"Soft FK to hr_employees(id) per ADR-055"` to `"DB-enforced FK to hr_employees(id) — both sides are tenant-scoped per the Cycle 4 Step 0 staff identity convention, so the FK is real (not soft per ADR-001/020). [...]"`. The remaining narrative (nullable for TBD slots, NULL-vs-NULL EXCLUSION semantics) is preserved.

The new COMMENT body contains zero `;` characters — the splitter trap is unchanged. The COMMENT was applied to the live `tenant_demo` (`COMMENT ON COLUMN` is naturally idempotent so re-provisioning is safe); a fresh provision picks up the new text via the migration file.

The reviewer also flagged the other "Soft FK" comments in 016 + 017 implicitly. Spot-checked them: `sch_room_bookings.booked_by`, `sch_room_change_requests.requested_by` and `.reviewed_by`, `sch_calendar_events.school_id` and `.created_by`, `sch_calendar_day_overrides.school_id` and `.created_by` — all correctly described as "Soft FK" because none of those columns has a `REFERENCES` declaration. Migration 017's coverage / substitution comments correctly say "DB-enforced FK" where the FK is real. Only `teacher_id` was wrong.

### MAJOR 1 + 2 — Accepted deviations (Phase 2 punch list)

- **MAJOR 1** (consumer envelope tenant validation) — affects every consumer in the system, not just Cycle 5; hardening belongs in `notification-consumer-base.ts` behind a defence-in-depth flag and applies retroactively. Tracked in the Phase 2 punch list.
- **MAJOR 2** (`sch.coverage.needed` best-effort emit after DB commit) — accepted because the coverage board UI is DB-driven, not event-driven, so a missing emit doesn't break the user-visible flow. Future event consumers needing the emit would adopt a transactional outbox pattern; out of Cycle 5 scope.

### Verification summary

- API + web build clean (`pnpm --filter @campusos/api build`, `pnpm --filter @campusos/web build`).
- `pnpm format:check` clean.
- All 7 unit tests pass (vitest — health controller + tenant context specs).
- Three live concurrency smokes (booking, RCR approve, day override) all verified `1 winner / 4 losers` exactly. No race wedges through.
- All smoke residue cleaned up — `tenant_demo` is back to seed state.

### Round-2 fix summary table

| Finding    | Fix                                                                           | Lines changed | Live verification                  |
| ---------- | ----------------------------------------------------------------------------- | ------------: | ---------------------------------- |
| BLOCKING 1 | `executeInTenantTransaction` + `pg_advisory_xact_lock` + in-tx conflict check |           ~40 | 5 parallel → 1 win + 4×409         |
| BLOCKING 2 | `SELECT … FOR UPDATE` + `WHERE status='PENDING'` belt-and-braces              |           ~50 | 5 parallel → 1 win + 4×400         |
| MAJOR 3    | One-tx pre-check + 23505 / P2002 catch → `ConflictException`                  |           ~25 | 5 parallel → 1 win + 4×409         |
| MAJOR 4    | COMMENT text rewrite                                                          |             1 | `col_description` matches new text |

The fixes land in commit **`653fd4c`**. Cycle 5 is now ready for Round 2 re-review.
