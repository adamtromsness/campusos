# HANDOFF — Phase 2 Cycle 14 (P2-14: Behaviour Advanced)

**Status: COMPLETE pending peer review (2026-05-11).** Single session. All 8 implementation steps + Step 9 CI parity + Step 10 docs + Step 11 commit shipped. Plan at `docs/campusos-p2c14-behaviour-advanced.html`.

## Summary

P2-14 closes out the deferred M20 Behaviour .1 tables that Cycle 9 left for the restorative + preventive layer. 5 new tenant tables, ~20 endpoints across 5 services + 1 worker + 1 controller, 2 Kafka emits, no new IAM codes (reuses existing BEH-001 + BEH-002 from Cycle 9 + 11). The vertical slice goes from punitive discipline (Cycle 9 `sis_discipline_incidents`) → restorative justice conference with structured agreement actions → auto-resolution on full completion. Plus peer mediation, positive behaviour points + rewards marketplace, BIP teacher feedback collection.

Tenant base table count: **794 → 799** (one fresh provision of `tenant_demo` now counts 1144 tables including all partition leaves; the 799 figure is logical base tables only).

## Tables shipped (migration 145_sis_behaviour_advanced.sql)

1. **sis_restorative_justice_conferences** — 5-value `status` CHECK (SCHEDULED, IN_PROGRESS, AGREEMENT_REACHED, RESOLVED_SUCCESSFULLY, FAILED) with multi-column `resolved_chk` keeping `resolution_date` populated only on terminal states (RESOLVED_SUCCESSFULLY + FAILED). `harmed_party_ids UUID[]` with `cardinality > 0` CHECK so an empty array cannot land. `incident_id` FK CASCADE to Cycle 9 `sis_discipline_incidents`. INDEX(school, status) + INDEX(incident) + INDEX(offender).
2. **sis_rj_agreement_actions** — 3-value `status` CHECK (PENDING, COMPLETED, OVERDUE). Multi-column **`completed_chk` keystone** pinning `(completed_at, verified_by)` populated together when status=COMPLETED + both null on PENDING/OVERDUE. Partial INDEX `(due_date, status) WHERE status='PENDING'` is the OverdueActionWorker hot path. CASCADE on parent conference + student.
3. **sis_peer_mediations** — 4-value `status` CHECK (REFERRED, SCHEDULED, RESOLVED, UNRESOLVED). Two CHECK keystones — `parties_chk` enforcing party_a ≠ party_b, `mediator_chk` enforcing mediator is not either party. `is_mediator_trained` boolean defaults true.
4. **sis_behaviour_rewards** — 4-value `reward_type` CHECK (INDIVIDUAL, CLASS, DIGITAL, PHYSICAL). `points_cost > 0` CHECK. `quantity_available` nullable (NULL = unlimited). UNIQUE(school_id, reward_name). Soft-deactivate via `is_active=false` since redemption rows reference reward_id via SET NULL.
5. **sis_positive_behaviour_points** — Ledger-style table mirroring Cycle 6 `pay_ledger_entries`. `transaction_type` 2-value CHECK (AWARD, REDEMPTION). `points > 0` CHECK at the schema layer; direction carried by transaction_type. Multi-column **`redemption_chk` keystone** pinning `(category)` populated on AWARD + `(reward_id)` populated on REDEMPTION. Student balance = SUM(AWARD points) − SUM(REDEMPTION points). INDEX(student, awarded_at DESC) + INDEX(school, transaction_type) + partial INDEX on reward_id.

**Intra-tenant FKs**: 13 (CASCADE × 7 on student/conference children + SET NULL × 5 on facilitator/verifier/awarded_by/referred_by/reward_id + NO ACTION × 1 on incident).
**Cross-schema FKs**: 0 (school_id is a soft ref to platform.schools per ADR-001/020).

## API surface (~20 endpoints)

Controller path `/api/v1/behaviour/*` (consolidated):

**Restorative Justice (8 endpoints)** — gated on `beh-001:read` + `beh-001:write`:
- `GET /rj-conferences` + `GET /rj-conferences/:id` (admin/staff)
- `POST /rj-conferences` (counsellor/admin)
- `PATCH /rj-conferences/:id` (lifecycle transitions)
- `GET /rj-conferences/:id/actions`
- `POST /rj-conferences/:id/actions`
- `PATCH /rj-actions/:id/complete` — **auto-resolution keystone**: when every action lands COMPLETED, the service flips the conference to RESOLVED_SUCCESSFULLY inside the same tenant tx + emits `beh.rj_conference.resolved` via durable outbox.

**Peer Mediation (5 endpoints)** — `beh-001:read` + `beh-001:write`:
- `GET /peer-mediations` (status filter) + `GET /peer-mediations/:id`
- `POST /peer-mediations` (teacher referral)
- `PATCH /peer-mediations/:id` (counsellor/admin scheduling + resolution)
- `GET /peer-mediators` (trained mediator directory)

**Positive Behaviour (6 endpoints)**:
- `POST /positive-points` (`beh-001:write`) — emits `beh.positive_points.awarded`.
- `GET /positive-points/:studentId` (`beh-001:read`)
- `GET /rewards` (`beh-001:read`)
- `POST /rewards` (`beh-001:admin`) — admin-configured marketplace
- `PATCH /rewards/:id` (`beh-001:admin`)
- `POST /rewards/:id/redeem` (`beh-001:read`) — students can redeem own; admin can redeem on behalf. **Locked-row tx** validates balance ≥ points_cost AND decrements quantity_available atomically.

**Category Config (2 endpoints)**:
- `GET /positive-categories` (`beh-001:read`) — falls back to default Respect/Responsibility/Leadership when no config.
- `PATCH /positive-categories` (`beh-001:admin`) — backed by tenant-scoped `school_config` JSONB. (The plan referenced `platform_tenant_configs` which does not exist; tenant `school_config` is the canonical key/value JSONB home from Cycle 0.)

**BIP Teacher Feedback (3 endpoints, no new table — reuses Cycle 11 svc_bip_teacher_feedback)**:
- `GET /bip/:planId/feedback` (`beh-002:read`)
- `POST /bip/:planId/request-feedback` (`beh-002:write`) — counsellor requests; partial UNIQUE on `(plan_id, teacher_id) WHERE submitted_at IS NULL` rejects double-requests.
- `PATCH /bip-feedback/:id` (`beh-002:read` + service-layer row-scope on `teacher_id`) — teacher submits.

## Kafka emits

- **`beh.rj_conference.resolved`** (durable via `OutboxService.enqueueInTx`) — fires when every agreement action lands COMPLETED. Deterministic event_id via `sha256(conferenceId + ':beh.rj_conference.resolved:v1')` → v5-shaped UUID. Payload: `{conferenceId, schoolId, offenderStudentId, harmedPartyIds, resolvedAt, actionCount, sourceRefId}`. `source_module='behaviour-advanced'`.
- **`beh.positive_points.awarded`** (best-effort via `KafkaProducerService.emit`) — fires on every AWARD insert for the Cycle 3 NotificationConsumer parent fan-out. Deterministic event_id via `sha256(transactionId + ':beh.positive_points.awarded:v1')`. Payload: `{transactionId, schoolId, studentId, category, points, reason, awardedAt, sourceRefId}`.

## Worker

**OverdueActionWorker** (`overdue-action.worker.ts`) — periodic sweep every 6 hours (configurable via `BEH_OVERDUE_SWEEP_INTERVAL_MS`). Walks every active school via `platform.schools` + `executeInExplicitSchema` and runs:
```
UPDATE sis_rj_agreement_actions SET status='OVERDUE', updated_at=now()
WHERE status='PENDING' AND due_date < CURRENT_DATE
```
Uses the partial INDEX `(due_date, status) WHERE status='PENDING'` from migration 145 as the hot path. Best-effort: a per-tenant error is logged + skipped without aborting the remaining tenants. Returns `{tenantsScanned, rowsFlipped}` per run. Notification fan-out to the facilitator is the Cycle 14 NotificationConsumer wiring item (Phase 2 punch list).

## Seed (seed-behaviour-advanced.ts)

Idempotent, gated on `sis_restorative_justice_conferences` row count for the demo school. Wired as `seed:behaviour-advanced` in `package.json` + into `seed-all.ts` chain after the P2-13 sub-cycles.

- **1 RJ conference** (AGREEMENT_REACHED) linked to a Cycle 9 incident.
- **3 agreement actions**: 1 COMPLETED (letter of apology, verified by Hayes), 1 PENDING (workshop attendance, due +14d), 1 OVERDUE (check-in, due −2d).
- **2 peer mediations**: 1 RESOLVED (friendship conflict with outcome), 1 REFERRED (pending scheduling).
- **15 positive behaviour AWARDs** across 4 students × 3 categories (Respect / Responsibility / Leadership).
- **4 rewards**: Homework Pass (50pt INDIVIDUAL unlimited) / Extra Recess (100pt CLASS unlimited) / Sticker (10pt PHYSICAL, qty=50) / Digital Badge (25pt DIGITAL unlimited).
- **2 REDEMPTIONs**: Maya redeems Homework Pass (50pt), Aiden redeems Sticker (10pt — quantity_available 50 → 49).

## Tests (21 new pinned regression tests)

`apps/api/src/behaviour-advanced/behaviour-advanced.spec.ts` — 21 tests covering:
- S1: deterministic event-id helpers v5-shape + topic-uniqueness
- S2-S7: RestorativeJusticeService authority, validation, auto-resolution, illegal-transition rejection
- S8-S10: PeerMediationService service-layer CHECK shadowing + teacher referral happy path
- S11-S15: PositiveBehaviourService award/redeem with balance + quantity validation + admin-only catalogue
- S16-S17: CategoryConfigService admin-only + default fallback
- S18-S19: BipFeedbackService counsellor-only + already-submitted rejection
- S20-S21: OverdueActionWorker constructibility + 17-route controller permission metadata regression

**Full suite**: vitest **709 → 730 tests** across 34 spec files. All green.

## CI parity

- `pnpm format:check` ✅
- `pnpm lint:logs` ✅ (787 files clean)
- `pnpm --filter @campusos/api build` ✅
- `pnpm --filter @campusos/web build` ✅ (4 new web routes: `/behaviour/restorative-justice`, `/behaviour/restorative-justice/[id]`, `/behaviour/peer-mediation`, `/behaviour/positive`)
- `pnpm --filter @campusos/api test` ✅ (730/730)

## Cross-module dependencies

- **Cycle 9 `sis_discipline_incidents`** — RJ conferences are initiated from a discipline incident; FK is CASCADE so a deleted incident drops the conference (defensible — the conference has no meaning without its source incident).
- **Cycle 9 `sis_students`** — referenced by RJ conferences (offender), agreement actions (assigned), peer mediations (mediator + 2 parties), positive points.
- **Cycle 4 `hr_employees`** — referenced by facilitator, verifier, awarded_by, referred_by. All SET NULL so audit survives staff leaving.
- **Cycle 11 `svc_bip_teacher_feedback`** — extended by the BIP feedback service via new endpoints. No new table.
- **Cycle 0 `school_config`** — used for positive_behaviour_categories JSONB config storage.

## Plan deviations

1. **Migration number** — Plan says `131_sis_behaviour_advanced.sql` but 131 was already used by Cycle 22 `131_ath_streaming_officials.sql`. Used **145** to continue the sequence cleanly.
2. **Category config storage** — Plan says `platform_tenant_configs` but this table does not exist in the platform schema. Used tenant-scoped `school_config` (the canonical key/value JSONB config table established in Cycle 0). Same functional outcome — tenant-scoped configuration.
3. **`points > 0` CHECK + REDEMPTION direction** — Plan's "points INT NOT NULL CHECK(>0)" is preserved at the schema level. Direction (award vs spend) is carried by a `transaction_type` column (AWARD or REDEMPTION). Balance = SUM(AWARD) − SUM(REDEMPTION). Mirrors Cycle 6 `pay_ledger_entries` ledger pattern. Multi-column `redemption_chk` keeps category populated on AWARD + reward_id populated on REDEMPTION.

## Known limitations / Phase 2 punch list

1. **Notification fan-out to facilitator on OVERDUE actions** — OverdueActionWorker flips rows but the Cycle 14 NotificationConsumer wiring that pages the facilitator is not yet in place. Schema state change is the load-bearing observation today.
2. **Behaviour pattern detection AI** — Deferred per the plan (requires AI Inference service).
3. **Parent-visible positive behaviour feed** — Backend supports the read; no parent-facing UI shipped this cycle.
4. **Peer mediator training programme integration** — `is_mediator_trained` is a single boolean on `sis_peer_mediations`. Future integration with P2-4 HR Training would maintain a `sis_peer_mediator_training` roster table.
5. **Positive behaviour leaderboards** — Deferred per the plan (privacy concerns; opt-in only).
6. **Whole-class reward redemption workflow** — `reward_type=CLASS` is in the schema; redemption flows currently target individual students. The class-redemption workflow ships in a follow-up.
7. **`beh.rj_conference.resolved` consumer** — Emit lands durably via outbox today; no Cycle 3 NotificationConsumer wires the parent IN_APP fan-out for the resolution event. Ships when a real school onboarding flow needs the parent acknowledgement.

## Files added / modified

```
NEW: packages/database/prisma/tenant/migrations/145_sis_behaviour_advanced.sql
NEW: packages/database/src/seed-behaviour-advanced.ts
NEW: apps/api/src/behaviour-advanced/event-ids.ts
NEW: apps/api/src/behaviour-advanced/dto/behaviour-advanced.dto.ts
NEW: apps/api/src/behaviour-advanced/restorative-justice.service.ts
NEW: apps/api/src/behaviour-advanced/peer-mediation.service.ts
NEW: apps/api/src/behaviour-advanced/positive-behaviour.service.ts
NEW: apps/api/src/behaviour-advanced/category-config.service.ts
NEW: apps/api/src/behaviour-advanced/bip-feedback.service.ts
NEW: apps/api/src/behaviour-advanced/overdue-action.worker.ts
NEW: apps/api/src/behaviour-advanced/behaviour-advanced.controller.ts
NEW: apps/api/src/behaviour-advanced/behaviour-advanced.module.ts
NEW: apps/api/src/behaviour-advanced/behaviour-advanced.spec.ts
NEW: apps/web/src/hooks/use-behaviour-advanced.ts
NEW: apps/web/src/app/(app)/behaviour/restorative-justice/page.tsx
NEW: apps/web/src/app/(app)/behaviour/restorative-justice/[id]/page.tsx
NEW: apps/web/src/app/(app)/behaviour/peer-mediation/page.tsx
NEW: apps/web/src/app/(app)/behaviour/positive/page.tsx
NEW: P2C14-REVIEW-NOTES.md
NEW: HANDOFF-P2C14.md
MOD: packages/database/package.json (seed:behaviour-advanced script)
MOD: packages/database/src/seed-all.ts (chain entry after sis-advanced-c)
MOD: apps/api/src/app.module.ts (BehaviourAdvancedModule registered after BehaviorPlansModule)
MOD: CLAUDE.md (P2-14 status header)
```

## Live verification snippet (run against `tenant_demo`)

```sql
SET search_path TO tenant_demo, platform, public;
SELECT
  (SELECT COUNT(*) FROM sis_restorative_justice_conferences)  AS confs,            -- 1
  (SELECT COUNT(*) FROM sis_rj_agreement_actions)             AS actions,          -- 3
  (SELECT COUNT(*) FROM sis_rj_agreement_actions WHERE status='COMPLETED') AS done,-- 1
  (SELECT COUNT(*) FROM sis_rj_agreement_actions WHERE status='OVERDUE')   AS overdue,-- 1
  (SELECT COUNT(*) FROM sis_peer_mediations)                  AS mediations,       -- 2
  (SELECT COUNT(*) FROM sis_behaviour_rewards)                AS rewards,          -- 4
  (SELECT COUNT(*) FROM sis_positive_behaviour_points WHERE transaction_type='AWARD')      AS awards,     -- 15
  (SELECT COUNT(*) FROM sis_positive_behaviour_points WHERE transaction_type='REDEMPTION') AS redemptions; -- 2
```

Awaiting peer review verdict before tagging `p2c14-complete`.
