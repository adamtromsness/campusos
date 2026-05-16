# P2C28 Review Notes — Community .1 Bundle

**Scope:** P2-28a Groups Advanced (commit `37d1f98`) + P2-28b Clubs + Meetings Advanced (commit `1b38294`) + P2-28c Student Services Advanced (this commit).
**Plan:** [`docs/campusos-p2c28-community-bundle.html`](docs/campusos-p2c28-community-bundle.html)
**Handoff:** [`HANDOFF-P2C28.md`](HANDOFF-P2C28.md)
**Reviewer brief:** Verify the 9 structural keystones across all three sub-cycles. P2-28 is the bundled cycle covering 4 community modules at .1 depth.

---

## Reviewer scope checklist

For each keystone below, the reviewer should:

1. **Read the relevant service + schema** — does the code match the claim?
2. **Trace authorisation** — does every write path refuse STUDENT / GUARDIAN at the service layer (not just at the controller gate)?
3. **Check tenant isolation** — every direct-object reference query carries `school_id` or joins through a table that does.
4. **Verify atomicity** — multi-statement writes are inside `executeInTenantTransaction` with `SELECT … FOR UPDATE` where state-machine transitions or counter updates happen.
5. **Confirm immutability** — IMMUTABLE-class tables (svc_referral_activity, ext_votes structurally anonymous) have no UPDATE / DELETE methods exposed at the service layer.

---

## Dimension 1 — Poll anonymity (P2-28a)

**Claim:** `grp_poll_votes.voter_id` is nullable. Anonymous polls write `voter_id=NULL` — structural anonymity at the schema layer, not enforced by application logic alone. Non-anonymous polls protected from double-vote by **partial UNIQUE INDEX** on `(poll_id, voter_id, option_id) WHERE voter_id IS NOT NULL`.

**Evidence:**

- Schema: [`packages/database/prisma/tenant/migrations/171_grp_polls_events_resources.sql`](packages/database/prisma/tenant/migrations/171_grp_polls_events_resources.sql) — `grp_poll_votes.voter_id UUID NULL` + the partial UNIQUE INDEX.
- Service: [`apps/api/src/groups-advanced/poll.service.ts`](apps/api/src/groups-advanced/poll.service.ts) `vote()` — checks `poll.allows_anonymous` and writes `voter_id=NULL` when true. Atomic vote_count INCREMENT inside locked tenant tx with SELECT ... FOR UPDATE on parent poll.

**Reviewer attention:**

- Confirm the partial UNIQUE INDEX shape — anonymous votes must be able to coexist on the same option (multiple NULL voter_ids are allowed by Postgres partial UNIQUE).
- Verify the service never reads `voter_id` from an anonymous poll's votes — reconstruction risk if it does.

---

## Dimension 2 — Election structural anonymity (P2-28b, already shipped Cycle 17)

**Claim:** `ext_votes` has **NO `voter_id` column**. The schema cannot reconstruct who voted for whom — anonymity is structural. `ext_election_voter_check` records WHO voted (PK on `(election_id, student_id)`) without linking to HOW they voted.

**Evidence:**

- Schema: [`packages/database/prisma/tenant/migrations/060_ext_elections_service.sql`](packages/database/prisma/tenant/migrations/060_ext_elections_service.sql) — ext_votes table definition; grep for `voter_id` returns zero hits in either table.
- P2-28b plan headers list the 4 election tables as "new" but they already shipped in Cycle 17. P2-28b only ships the 6 truly-new tables.

**Reviewer attention:**

- The Cycle 17 ElectionService and VoteService are the authoritative request paths. Confirm P2-28b did not introduce a path that writes a voter_id-bearing audit log on the side.

---

## Dimension 3 — Atomic budget ledger (P2-28b)

**Claim:** `ext_budget_transactions` INSERT and parent `ext_club_budgets.spent_amount` UPDATE commit together inside one tenant tx. EXPENSE bumps spent up, REFUND bumps spent down, ALLOCATION bumps allocated, ADJUSTMENT carries rationale only. Refuses EXPENSE that would exceed allocated and REFUND that would drive spent below zero.

**Evidence:**

- Service: [`apps/api/src/clubs-meetings-advanced/club-budget.service.ts`](apps/api/src/clubs-meetings-advanced/club-budget.service.ts) `recordTransaction()` — single `executeInTenantTransaction` with `SELECT … FOR UPDATE` on the budget row before the UPDATE + INSERT.

**Reviewer attention:**

- Verify the FOR UPDATE lock is on `ext_club_budgets` not on `ext_budget_transactions` — concurrent EXPENSE submissions need to serialise on the parent.
- Confirm the cap check uses the locked snapshot, not a fresh read.

---

## Dimension 4 — AI minutes lockstep (P2-28b)

**Claim:** `mtg_ai_minutes` has UNIQUE(meeting_id). Multi-column status / generated_chk / approved_chk lockstep enforces lifecycle PENDING → GENERATED → APPROVED at the schema layer. Regenerate is refused on APPROVED minutes — approved minutes are the canonical record.

**Evidence:**

- Schema: [`packages/database/prisma/tenant/migrations/172_ext_elections_budgets_mtg.sql`](packages/database/prisma/tenant/migrations/172_ext_elections_budgets_mtg.sql) — multi-column CHECK constraints.
- Service: [`apps/api/src/clubs-meetings-advanced/ai-minutes.service.ts`](apps/api/src/clubs-meetings-advanced/ai-minutes.service.ts).

**Reviewer attention:**

- Confirm the AI stub writes `model_version='STUB_VERSION_0'` so P3-A1 can swap the implementation without disturbing the surface.

---

## Dimension 5 — IMMUTABLE referral activity log (P2-28c, Cycle 11 invariant)

**Claim:** `svc_referral_activity` is IMMUTABLE per ADR-010. Service-side discipline. No UPDATE method exposed. No DELETE method exposed. The only writer is `ReferralActivityService.recordActivity(tx, ...)` (Cycle 11) and `CrisisEscalationService.escalate()` (P2-28c) — both write inside the parent referral's tenant tx. CASCADE on parent svc_referrals hard-delete takes the audit with it (mirrors Cycle 8 tkt_ticket_activity and Cycle 10 hlth_health_access_log).

**Evidence:**

- Schema: [`packages/database/prisma/tenant/migrations/036_svc_caseloads_referrals.sql`](packages/database/prisma/tenant/migrations/036_svc_caseloads_referrals.sql) — `svc_referral_activity` table definition with `ON DELETE CASCADE` from svc_referrals.
- Cycle 11 service: [`apps/api/src/counselling/referral-activity.service.ts`](apps/api/src/counselling/referral-activity.service.ts) — sole writer.
- P2-28c service: [`apps/api/src/student-services-advanced/crisis-escalation.service.ts`](apps/api/src/student-services-advanced/crisis-escalation.service.ts) `escalate()` writes ESCALATED rows inside locked tx.

**Reviewer attention:**

- Verify the P2-28c CrisisEscalationService does not expose any UPDATE / DELETE on svc_referral_activity (greps).
- The Cycle 11 ReferralActivityService is the canonical writer. P2-28c only re-uses the contract by writing through the same INSERT pattern from inside a different service's tx.
- Confirm the CASCADE on hard-delete is intentional — the audit follows the parent referral only if the referral itself is deleted, which should be exceptional.

---

## Dimension 6 — CRISIS auto-escalation (P2-28c)

**Claim:** `CrisisEscalationService.escalate(referralId)` locks the parent svc_referrals row FOR UPDATE inside one tenant tx, flips priority to URGENT, advances SUBMITTED / TRIAGED status to ACCEPTED, writes an ESCALATED row to svc_referral_activity, then emits `svc.referral.escalated` outside the tx with full envelope shape including `previousPriority` for audit. Refuses already-URGENT-ACCEPTED rows with 400 (idempotent surfacing). Refuses terminal statuses (COMPLETED / CANCELLED / DECLINED).

**Evidence:**

- Service: [`apps/api/src/student-services-advanced/crisis-escalation.service.ts`](apps/api/src/student-services-advanced/crisis-escalation.service.ts) `escalate()`.

**Reviewer attention:**

- The FULL automatic CRISIS-category bridge into Cycle 11 `ReferralService.create` is **deferred** — when `svc_referral_types.referral_category=CRISIS`, the Cycle 11 create path should call the same escalation helper inside its tx. P2-28c ships the manual endpoint as the counsellor's queue-driven safety net.
- Confirm the emit fires AFTER the tx commits (not inside) so a broker hiccup cannot roll back the user's action.
- The Kafka emit topic is `svc.referral.escalated`. Future Cycle 14 notification consumer wires this to admin / counsellor IN_APP fan-out.

---

## Dimension 7 — Wellbeing longitudinal aggregation (P2-28c)

**Claim:** `svc_wellbeing_longitudinal` is materialised annually from `svc_wellbeing_responses` joined to `svc_wellbeing_questions` for the domain label. The materialised rows carry **no individual check-in data** — only aggregated domain scores per academic year, trend direction (IMPROVING / STABLE / DECLINING relative to prior year, ±0.3 threshold), checkin_count, flagged_count. Idempotent UPSERT on (student_id, academic_year, domain). Read surface is staff-only; materialise endpoint is school-admin-only.

**Evidence:**

- Schema: [`packages/database/prisma/tenant/migrations/173_svc_agency_longitudinal.sql`](packages/database/prisma/tenant/migrations/173_svc_agency_longitudinal.sql) — `svc_wellbeing_longitudinal` table.
- Service: [`apps/api/src/student-services-advanced/wellbeing-longitudinal.service.ts`](apps/api/src/student-services-advanced/wellbeing-longitudinal.service.ts) `materialise()`.

**Reviewer attention:**

- Verify the SQL aggregate joins through `c.school_id = $tenant.schoolId` — must not leak cross-school data even if a stale tenant context exists.
- The materialised row's source aggregation reads `svc_wellbeing_responses.numeric_response`. Confirm text responses are excluded from the avg.
- Trend computation reads the prior-year row in the same table — first-ever year correctly defaults to STABLE.
- Confirm no individual check-in IDs leak into the materialised row schema (no `checkin_id` column).

---

## Dimension 8 — External agency referral consent gate (P2-28c)

**Claim:** `svc_agency_referrals.status` lifecycle REFERRED → CONTACTED → ACTIVE_SERVICE → DISCHARGED. The CONTACTED → ACTIVE_SERVICE transition is refused unless `consent_obtained=true`. Schools cannot release student information to outside agencies without parent consent.

**Evidence:**

- Schema: [`packages/database/prisma/tenant/migrations/173_svc_agency_longitudinal.sql`](packages/database/prisma/tenant/migrations/173_svc_agency_longitudinal.sql) — `svc_agency_referrals` 4-value status CHECK.
- Service: [`apps/api/src/student-services-advanced/agency-referral.service.ts`](apps/api/src/student-services-advanced/agency-referral.service.ts) `patch()` — `ALLOWED_TRANSITIONS` map + explicit consent check before allowing ACTIVE_SERVICE.

**Reviewer attention:**

- Confirm the consent check happens **after** the transition validation — both must pass.
- Verify the consent_obtained flag can be flipped in the same PATCH that drives status to ACTIVE_SERVICE (single-shot update).
- The error message must explicitly reference parent consent — surfaces directly to the operator.

---

## Dimension 9 — MTSS team meeting coordination (P2-28c)

**Claim:** P2-28c MtssTeamMeetingService maps the new 3-value `tierChangeRecommended` token (MAINTAIN / ESCALATE / DE_ESCALATE) onto the existing Cycle 11 5-value outcome enum (NO_CHANGE / TIER_UP / TIER_DOWN / EXIT / CONTINUE_WITH_ADJUSTMENT) at the service layer. Both the new endpoint and the legacy Cycle 11 MTSS controller coexist on the same row without a schema change. EXIT and CONTINUE_WITH_ADJUSTMENT round-trip as `null` recommendation on the new surface.

**Evidence:**

- Service: [`apps/api/src/student-services-advanced/mtss-team-meeting.service.ts`](apps/api/src/student-services-advanced/mtss-team-meeting.service.ts) — `RECOMMENDATION_TO_OUTCOME` + `OUTCOME_TO_RECOMMENDATION` maps.

**Reviewer attention:**

- This is a deliberate compromise to avoid a schema migration just for the recommendation token. Verify nothing else depends on the recommendation being a separate column.
- UNIQUE(team_meeting_id, student_id) on Cycle 11 schema catches duplicate-discussion attempts — service translates to 400.

---

## Reviewer-attention items (cross-cycle)

### Test coverage (Wave 2 Phase 2 backlog)

P2-28a/b/c ship without dedicated vitest unit + integration coverage. Joins the broader Wave 2 Phase 2 test-hardening cycle. The existing vitest 1452/1452 covers the P2-27 surface; the P2-28 services are exercised only through the build + ts-check + the schema smoke tests during provisioning. Cycle 19+ should add the P2-28 test suite.

### CAT script

A vertical-slice Customer Acceptance Test covering the four community surfaces end-to-end is the Step 10-equivalent deliverable. Not in this commit — lands once peer review is in motion.

### Schema migration numbering

Plan headers said `159 / 160 / 161` but those slots were taken by Cycle 22 (Alumni) migrations. P2-28 used `171 / 172 / 173` matching the running provisioning order. No functional impact — same situation as P2-27 (plan said `156-158`, repo uses `168-170`).

### Plan over-count

Plan headers list 27 tables; reality is 17 truly-new tables + 3 additive columns + 10 already-shipped tables (4 from Cycle 17 elections, 6 from Cycle 11 svc). Same pragmatic call P2-26 and P2-27 made. The plan is the spec; the reality is the ERD intent matched against what's already in repo.

### Permission codes

Plan referenced SVC-001..003 for P2-28c but the existing COU-001..004 catalogue entries already cover the equivalent surface. Adding new SVC codes would create a parallel grant tree with no functional benefit. Same call P2-28b made on its plan-listed CLB-001..004 + MTG-001..002 codes — all already in catalogue.

### CrisisEscalationService bridge into Cycle 11 ReferralService.create

P2-28c ships the manual `CrisisEscalationService.escalate` endpoint. The full bridge — Cycle 11 ReferralService.create reads `svc_referral_types.referral_category` and auto-escalates CRISIS-category referrals at submission time — is deferred to avoid changing Cycle 11 service mid-bundle. The audit + Kafka contracts are already wired; only the create-time call needs the bridge in a future cycle.

### Wellbeing longitudinal seed

Materialisation works on real Cycle 11.1 response data. P2-28c does not ship a `seed-wellbeing-longitudinal.ts` baseline — the dashboard will be empty until the first academic year's responses land. Pre-pilot polish.

---

## Decision: review approach

P2-28 is a bundle cycle. Recommend single-pass review across all three sub-cycles together since the dependencies are cleanly partitioned along module boundaries. Each sub-cycle is independently shippable but the peer review can fairly cover them in one pass.

If the reviewer prefers per-sub-cycle review, the natural split is:

- **P2-28a (Groups)** — 5 services, poll anonymity + resource versioning + invitation atomicity.
- **P2-28b (Clubs + Meetings)** — 5 services, election structural anonymity (already shipped Cycle 17) + atomic budget ledger + AI minutes lockstep.
- **P2-28c (Student Services)** — 5 services, IMMUTABLE activity log (already shipped Cycle 11) + CRISIS escalation + consent gate + longitudinal aggregation.

---

## How to verify locally

```bash
# Provision schemas (idempotent)
pnpm --filter @campusos/database provision --subdomain=demo

# Confirm migration 173 applied
psql -h localhost -U campusos campusos_dev -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'tenant_demo' AND table_name IN ('svc_agency_referrals', 'svc_wellbeing_longitudinal');"
# Expect: count = 2

# CI parity
pnpm --filter @campusos/api build
pnpm format:check
pnpm lint:logs
```

---

## Approval criteria

For each dimension above, mark **PASS** or **FAIL** with a brief rationale. PASS requires the keystone matches code AND tenant isolation holds AND atomicity is preserved AND immutability invariants are honoured.

**Reviewer's gate:** Accept if all 9 dimensions PASS. If any FAILS, file the specific finding (file:line, expected vs actual) and the cycle returns to a fix commit.
