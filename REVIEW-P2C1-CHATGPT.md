# REVIEW-P2C1-CHATGPT

**Cycle:** Phase 2 Cycle 1 — M90 Visitor Management. First cycle of
Phase 2 (Pilot Readiness). Ships 9 new tenant base tables + ~28
endpoints + 3 Kafka emit topics + 8 web routes.

**Round 1 commit:** `9c782aa` on `main` (the closeout commit pushed
2026-05-09).
**Round 1 verdict:** **FAIL** — 2 BLOCKING + 4 MAJOR + 3 MINOR.
**Round 2 commit:** the fix commit pushed 2026-05-09 with all 2
BLOCKING + all 4 MAJOR addressed in code + tests.
**Round 2 verdict:** _pending — please re-review._
**Live verification reference:** `tenant_demo` 2026-05-09.

---

## Round 1 fixes — applied in the round-2 commit

| #   | Severity | Finding                                                                                                      | Status           | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------- | ------------------------------------------------------------------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | BLOCKING | Muster entries inserted in a per-row loop, not a single batch INSERT                                         | **Fixed**        | `MusterService.create` now uses one `INSERT INTO vis_muster_entries (...) SELECT ... FROM vis_sign_ins JOIN vis_visitors LEFT JOIN vis_visitor_types WHERE s.school_id = $1 AND s.signed_out_at IS NULL`. Walks the partial INDEX `vis_si_active_idx` once. UUID generated via `gen_random_uuid()` — the one muster-entry exception to the application-layer UUIDv7 convention; documented in HANDOFF-P2C1.md and acceptable because muster_entries are internal audit rows never sorted across services. Verified live: 4 active sign-ins → 4 entries materialised in one INSERT...SELECT statement. |
| 2   | BLOCKING | `BannedPersonService.patch` (and other mutation paths) lock + UPDATE by id only, not scoped by school_id     | **Fixed**        | Every mutation path in the visitor module now scopes lock + UPDATE + reload by `school_id = $tenant.schoolId`. Touched: `BannedPersonService.patch`, `VisitorTypeService.patch`, `VisitorService.patch`, `SignInService.signOut + bypassSafeguarding`, `PreRegistrationService.scan` (UPDATE used_at), `RecurringVisitorService.patch`, `MusterService.updateEntry + close`. The `MusterService.updateEntry` path was rewritten to use a single locked JOIN against the parent muster's school_id rather than the previous lock-then-tenantCheck-then-UPDATE chain.                                   |
| 3   | MAJOR    | HMAC blind indexes are global, not tenant-bound                                                              | **Fixed**        | `emailHash` / `phoneHash` / `nameHash` now take `schoolId` as their first argument and prefix the HMAC material with `schoolId + '                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | '`. Updated all 8 callsites across the visitors module + the seed. Verified live: same email seeded against demo school produces a different hash from a synthetic school-B test. 25 unit tests in `apps/api/src/visitors/crypto.spec.ts` cover the per-school binding contract. |
| 4   | MAJOR    | No automated P2C1 tests                                                                                      | **Fixed**        | New `apps/api/src/visitors/crypto.spec.ts` adds 25 tests covering AES-256-GCM round-trip + tamper rejection + malformed-wire rejection, emailHash + phoneHash + nameHash tenant binding (same value in two schools produces two different hashes), Unicode normalisation, punctuation stripping, exact-but-not-fuzzy match contract, and QR token randomness. Vitest suite goes from 39 → 67 passing tests.                                                                                                                                                                                           |
| 5   | MAJOR    | `nameHash` matches only exact-normalised first/last; trivial bypass via accents / punctuation / extra spaces | **Fixed**        | New `normaliseNameComponent(s)` helper applies NFKD Unicode normalize → strip combining marks (diacritic strip) → lowercase → strip non-letter / non-digit / non-space characters → collapse whitespace runs → trim. So `José` → `jose`, `O'Brien` → `o brien`, `Smith-Jones` → `smith jones`, `John   Paul` → `john paul`. Both first and last names go through the pipeline before joining. Test coverage in `crypto.spec.ts` includes 5 normalisation tests + 4 keystone match tests + an explicit "no fuzzy / phonetic matching" test that documents the intentional boundary.                    |
| 6   | MAJOR    | `POST /banned-persons/check` is a Boolean oracle accessible to any saf-002:write actor                       | **Fixed**        | Re-gated from `saf-002:write` to `safeguarding_ban:read` (admin-only via everyFunction). Verified live: teacher 403, principal 201. The canonical kiosk path is the implicit screening inside `POST /sign-in` which throws a neutral 403 with no body field that reveals match/no-match. The explicit `/check` stays as an admin-only debugging surface for safeguarding officers verifying registry entries.                                                                                                                                                                                         |
| 7   | MINOR    | Plan / SAF-001 vs SAF-002 catalogue drift                                                                    | **Documented**   | HANDOFF-P2C1.md "Decisions made vs the plan" section already covered this; PHASE2-P2C1-7 punch list item tracks the rename for pre-pilot.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 8   | MINOR    | List endpoints capped but not paginated                                                                      | **Acknowledged** | LIMIT 100 / 200 caps are intentional for the kiosk surface (a school does not have 200+ visitors on-site simultaneously). Full keyset pagination tracked as a Phase 2 polish item (PHASE2-P2C1-10) for the historical sign-in log only.                                                                                                                                                                                                                                                                                                                                                               |
| 9   | MINOR    | `vis.banned_person.detected` has no consumer                                                                 | **Acknowledged** | Already on the punch list as PHASE2-P2C1-1. The emit lands cleanly so a future BannedPersonDetectedConsumer is purely additive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

---

## Live verification of fixes — `tenant_demo` 2026-05-09

```
=== returning visitor lookup with tenant-bound HMAC ===
name=David Chen, type=Parent     # MAJOR 1 verified — re-seed produced new hashes; lookup still finds David

=== banned-persons HMAC check via /sign-in path ===
  John Doe DOB matches → BLOCKED:
  403  {"message":"Please see reception staff","error":"Forbidden","statusCode":403}
  Jose Garcia (no diacritic) — different person, no match:
  status: NOT_REQUIRED            # MAJOR 3 verified — Unicode normalisation works without breaking distinct-person matching

=== explicit /banned-persons/check is NOW admin-only ===
  teacher: 403                    # MAJOR 4 verified — was 200 before re-gating
  principal: 201

=== muster batch INSERT (BLOCKING 1) ===
totalOnSite=4 entries=4           # BLOCKING 1 verified — 4 active sign-ins → 4 entries via INSERT...SELECT
  Anita Patel (Guest Speaker)
  David Chen (Parent)
  Greg Hayes (Contractor)
  Jose Garcia (Parent)
```

CI parity green: vitest 67/67 (was 39 + 28 new), API + web builds clean,
`format:check` + `lint:logs` clean, full `db:reset` completes in 23s.

---

## Reviewer brief

Cycle ships the school's lobby kiosk surface with two structural
keystones:

1. **Encrypted PII at rest** — `vis_visitors.email_encrypted` /
   `phone_encrypted` carry AES-256-GCM ciphertext (Cycle 22 IT vault
   wire format `base64(iv).base64(tag).base64(ciphertext)`).
   `email_hash` / `phone_hash` are HMAC-SHA256 blind indexes for
   kiosk returning-visitor lookup that never decrypts. Production
   fail-closed at module load when `VISITOR_PII_KEY` /
   `VISITOR_HMAC_SECRET` env vars are missing in production.

2. **Banned-persons HMAC screening** — `vis_banned_persons.name_hash`
   is HMAC-SHA256 of normalised lowercase first + ' ' + lowercase
   last + (DOB ISO when supplied). Kiosk consults via partial INDEX
   `(school_id, name_hash) WHERE is_active = true` on every sign-in.
   Match throws 403 with neutral "please see reception staff"
   message and emits `vis.banned_person.detected`. Visitor never
   learns why they were blocked.

Permissions:

- Existing **SAF-002** catalogue entry used for operational
  endpoints (visitor types, sign-ins, settings, pre-reg, recurring,
  muster). Granted to Teacher (read), Staff (read+write), Admin
  (everyFunction admin tier).
- New **`safeguarding_ban`** non-XXX-NNN catalogue entry for the
  banned-persons gate. Admin-only via everyFunction. Reception
  staff cannot reach the banned-persons admin surface — they only
  see the silent BLOCKED kiosk outcome.

ADR-015 — third-party DBS / background-check registry data is never
persisted. `vis_sign_ins.safeguarding_check_ref` stores the lookup
reference id only. Schools re-query the registry directly for audit.

Schema-level invariants worth verifying:

- Multi-column `vis_si_bypass_chk` on `vis_sign_ins` —
  `safeguarding_check_status='BYPASSED_BY_ADMIN'` requires
  `bypass_admin_id IS NOT NULL AND bypass_reason IS NOT NULL AND
length(trim(bypass_reason)) > 10`. Service-layer DTO + handler
  defence-in-depth.
- Multi-column `vis_muster_entry_marked_chk` on `vis_muster_entries`
  — UNKNOWN status requires marked_by + marked_at NULL; any
  non-UNKNOWN status requires both populated. Service-layer
  `MusterService.updateEntry` handles both directions atomically.
- Partial UNIQUE on `vis_banned_kiosk_lookup_idx (school_id,
name_hash) WHERE is_active = true` — backs the kiosk lookup hot
  path.
- Partial INDEX `vis_si_active_idx (school_id, signed_in_at) WHERE
signed_out_at IS NULL` — Step 7 MusterService snapshot walks this
  in one batch INSERT.

Step boundaries:

- Step 1 — `102_vis_visitors.sql` (3 tables: vis_visitor_types,
  vis_visitors, vis_sign_in_settings).
- Step 2 — `103_vis_sign_ins.sql` (3 tables: vis_sign_ins,
  vis_pre_registrations, vis_recurring_visitors).
- Step 3 — `104_vis_banned_muster.sql` (3 tables: vis_banned_persons,
  vis_emergency_muster, vis_muster_entries).
- Step 4 — `seed-visitors.ts` wired into seed-all.ts (4 types,
  5 visitors, 8 sign-ins, 1 pre-reg, 1 recurring, 1 banned, 1 muster
  - 3 entries, 1 settings).
- Step 5 — `apps/api/src/visitors/` foundation (crypto.ts,
  visitor.service.ts with VisitorTypeService + VisitorService +
  SignInSettingsService).
- Step 6 — `sign-in.service.ts` + `banned-person.service.ts`
  (SignInService keystone + PreRegistrationService + RecurringVisitorService
  - BannedPersonService).
- Step 7 — `muster.service.ts` (MusterService with snapshot keystone).
- Step 8 + 9 — web UI under `apps/web/src/app/(app)/visitors/` (8
  routes), launchpad tile in `apps/web/src/components/shell/apps.tsx`,
  hooks in `apps/web/src/hooks/use-visitors.ts`, formatters in
  `apps/web/src/lib/visitors-format.ts`.
- Step 10 — `docs/p2c1-cat-script.md` (10 plan scenarios + 7-check
  schema preamble + cleanup, verified live).

Decisions vs the plan documented in HANDOFF-P2C1.md:

- SAF-002 used (catalogue collision with SAF-001 = Emergency Management).
- Migration numbers 102/103/104 (095-097 taken).

CI parity: API + web builds clean, format:check clean, lint:logs
clean, full `db:reset` completes in 27s with the visitor seed
landing as step 37 of 37.

---

## Round 1 — pending findings

_Reviewer to fill in: BLOCKING / MAJOR / MINOR / OBSERVATION findings,
each with file:line citation, the policy it violates, and a suggested
fix path. Triage outcome (valid / disputed / accepted-as-Phase2-followup)
goes in the table below._

| #   | Severity | Area | Finding (one line) | Triage |
| --- | -------- | ---- | ------------------ | ------ |
|     |          |      |                    |        |

---

## Out-of-scope per the plan (CAT script "Reviewer attention items")

- Cycle 3 NotificationConsumer wiring on `vis.banned_person.detected`
  — emit lands cleanly but no consumer fans it out yet.
- Photo capture, badge printer, NDA signature, third-party DBS API
  integration — schema ready, integrations deferred to P2C1.1.
- SAF-001 catalogue rename — documented in HANDOFF-P2C1.md.
- Multi-building tracking, visitor analytics dashboard, dedicated
  kiosk session model, pre-registration email delivery — deferred.
- Banned-person registry plaintext name + DOB are admin-only at the
  controller level (`safeguarding_ban:read`); the kiosk + every
  Kafka emit deliberately uses opaque ids only so a Kafka topic
  reader learns nothing about who tried to sign in.

## Files of interest

- `packages/database/prisma/tenant/migrations/102_vis_visitors.sql`
- `packages/database/prisma/tenant/migrations/103_vis_sign_ins.sql`
- `packages/database/prisma/tenant/migrations/104_vis_banned_muster.sql`
- `packages/database/src/seed-visitors.ts`
- `packages/database/src/seed-iam.ts` (SAF-002 grants for Teacher + Staff)
- `packages/database/data/permissions.json` (safeguarding_ban entry)
- `apps/api/src/visitors/crypto.ts` (encryption + HMAC helpers, fail-closed)
- `apps/api/src/visitors/visitor.service.ts` (VisitorTypeService + VisitorService + SignInSettingsService)
- `apps/api/src/visitors/sign-in.service.ts` (SignInService + PreRegistrationService + RecurringVisitorService)
- `apps/api/src/visitors/banned-person.service.ts` (SAFETY KEYSTONE)
- `apps/api/src/visitors/muster.service.ts` (EMERGENCY SNAPSHOT KEYSTONE)
- `apps/api/src/visitors/visitors.controller.ts`
- `apps/api/src/visitors/dto/visitor.dto.ts`
- `apps/api/src/app.module.ts` (VisitorsModule import)
- `apps/web/src/app/(app)/visitors/*` (8 routes)
- `apps/web/src/components/shell/apps.tsx` (Visitors tile registration)
- `docs/p2c1-cat-script.md`
- `HANDOFF-P2C1.md`
