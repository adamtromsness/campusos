# REVIEW-P2C1-CHATGPT

**Cycle:** Phase 2 Cycle 1 — M90 Visitor Management. First cycle of
Phase 2 (Pilot Readiness). Ships 9 new tenant base tables + ~28
endpoints + 3 Kafka emit topics + 8 web routes.

**Round 1 commit:** `9c782aa` on `main` (the closeout commit pushed
2026-05-09).
**Round 1 verdict:** _pending — please review and respond with verdict
+ findings._
**Live verification reference:** `tenant_demo` 2026-05-09.

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
  + 3 entries, 1 settings).
- Step 5 — `apps/api/src/visitors/` foundation (crypto.ts,
  visitor.service.ts with VisitorTypeService + VisitorService +
  SignInSettingsService).
- Step 6 — `sign-in.service.ts` + `banned-person.service.ts`
  (SignInService keystone + PreRegistrationService + RecurringVisitorService
  + BannedPersonService).
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

| # | Severity | Area | Finding (one line) | Triage |
| --- | --- | --- | --- | --- |
|   |   |   |   |   |

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
