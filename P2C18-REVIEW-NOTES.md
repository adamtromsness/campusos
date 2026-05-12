# P2-18 Facilities Advanced — Peer Review Scaffold

**Target SHA:** Round 1 closeout commit (REVIEW-P2C18 Round 2 input).
**Plan:** `docs/campusos-p2c18-facilities-advanced.html`
**Handoff:** `HANDOFF-P2C18.md`
**Previous cycle:** P2-17 (REVIEW-P2C17 — Round 2 PASS).
**Wave:** Opens Wave D (Module Completion).

## Round 1 verdict

REVIEW-P2C18-CHATGPT Round 1 against `c739ad8` + `e1307e6` returned
**FAIL** with 6 BLOCKING + 2 MAJOR. Round 1 fix commit lands all 6
BLOCKING + 17 pinned regression tests + retains MAJORs on the Phase 2
punch list. See `HANDOFF-P2C18.md` "REVIEW-P2C18 Round 1 fix log"
section for the per-fix verification trail.

| #     | Finding                                                            | Severity | Verdict (Round 1)                   | Verification                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------ | -------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 3 emits best-effort after commit                                   | BLOCKING | **FIXED**                           | All three flipped to `OutboxService.enqueueInTx` INSIDE the triggering tx. Deterministic event_ids per helper. Tests R-B1a–d.                                                                                        |
| 2     | CleaningIssueTicketConsumer trusts payload + writes Tickets tables | BLOCKING | **FIXED with documented exception** | Envelope-vs-payload validation + school-scoped category lookup + school-scoped admin requester fallback + envelope-id on INSERT. Architectural move into TicketsModule carried to Phase 2 punch list. Tests R-B2a–d. |
| 3     | Cleaning route helpers ID-only                                     | BLOCKING | **FIXED**                           | school_id predicates added to getRouteById, patchRoute, listStops, replaceStops lock, listStopCompletions. Tests R-B3a–d.                                                                                            |
| 4     | Zone inspection getById not school-scoped                          | BLOCKING | **FIXED**                           | JOIN now carries `z.school_id = $2::uuid`. Test R-B4a.                                                                                                                                                               |
| 5     | Asset spaceId ID-only on create + missing on patch                 | BLOCKING | **FIXED**                           | Create + patch both run `fac_spaces JOIN fac_buildings ON school_id + asset.buildingId` validation before INSERT/UPDATE. Tests R-B5a–b.                                                                              |
| 6     | Energy getReading not school-scoped                                | BLOCKING | **FIXED**                           | JOIN through fac_utility_meters with `m.school_id = $2::uuid`. Test R-B6a.                                                                                                                                           |
| MAJ-1 | Facilities Manager role split                                      | MAJOR    | **CARRIED**                         | Phase 2 / pre-pilot punch list — joins broader role-split chain.                                                                                                                                                     |
| MAJ-2 | Buildings/spaces helpers inherited ID-only paths                   | MAJOR    | **CARRIED**                         | Pre-dates P2-18; on the hardening punch list.                                                                                                                                                                        |

This file scaffolds the per-finding triage table for the
REVIEW-P2C18-CHATGPT review across BOTH sub-cycles. The reviewer
should fill the Verdict + Verification columns. Phase 2 / pre-pilot
follow-ups belong on the project punch list, not as cycle blockers.

## Dimensions in scope

1. Cleaning route completion → auto-ticket flow (P2-18a)
2. Zone inspection FAIL → auto-work-order (P2-18a)
3. Supply stocktake discrepancy → ADJUSTMENT fan-out (P2-18a)
4. Work order attachments + parts cost summary (P2-18a)
5. Fire drill compliance + 90-day overdue alert (P2-18b)
6. Asset lifecycle install → maintain → decommission → dispose (P2-18b)
7. Asset disposal SAFETY KEYSTONE — DECOMMISSIONED gate (P2-18b)
8. Energy reading consumption auto-compute (P2-18b)
9. Energy target comparison + actual-vs-target summary (P2-18b)
10. Space utilisation rate + underused-rooms detection (P2-18b)
11. Sustainability initiative tracking (P2-18b)
12. Test coverage (P2-18a 20 specs + P2-18b 18 specs)
13. Permission code distribution (FAC-001..005)
14. Cross-cycle FK + soft-ref discipline (ADR-001/020)
15. Splitter discipline (migrations 151 + 152)

## Reviewer triage table — fill on Round 1

| Finding | Severity | Component | One-line | Verdict | Verification |
| ------- | -------- | --------- | -------- | ------- | ------------ |
|         |          |           |          |         |              |

Severity tiers: BLOCKING (cycle cannot close) / MAJOR (recommendation
to fix before next cycle) / MINOR (style or doc cleanup) /
OBSERVATION (Phase 2 punch list candidate).

## Reviewer attention items already documented in HANDOFF

The handoff already records these as Phase 2 / pre-pilot follow-ups —
the reviewer should accept them unless the finding gates the cycle:

1. Cycle 14 NotificationConsumer wiring for `fac.fire_drill.overdue`.
2. Cycle 7 TaskWorker rule for `fac.route_stop.issue_noted`.
3. Maintenance-record partition strategy when volume scales.
4. Energy reading bulk upload endpoint.
5. Structured sustainability outcome tracking.
6. Asset photo + warranty document attachments table.
7. Facilities Manager role split — joins the broader role-split chain.

## Per-sub-cycle keystone proofs the reviewer should cache-bust

### P2-18a

- `apps/api/src/facilities/cleaning-route.service.ts`:
  `patchStopCompletion` emits `fac.route_stop.issue_noted` AFTER tx
  commit with deterministic event_id.
- `apps/api/src/facilities/zone-inspection.service.ts`: `create`
  inserts the auto-work-order BEFORE the inspection insert inside one
  tenant tx, back-filling `follow_up_work_order_id`.
- `apps/api/src/facilities/supply-audit.service.ts`:
  `completeStocktake` walks discrepancies + creates ADJUSTMENT
  transactions + updates current_quantity, all in one tenant tx.
- `apps/api/src/facilities/cleaning-issue-ticket.consumer.ts`: claims
  AFTER successful tkt_tickets insert (REVIEW-CYCLE2 BLOCKING 2
  pattern).

### P2-18b

- `apps/api/src/facilities/asset.service.ts::dispose`: locks parent
  fac_assets FOR UPDATE inside the tenant tx, validates
  `status='DECOMMISSIONED'`, then INSERTs disposal. 23505 on
  `UNIQUE(asset_id)` translates to 409.
- `apps/api/src/facilities/asset.service.ts::decommission`: stamps
  `status='DECOMMISSIONED'` + `decommissioned_at=now()` +
  `decommissioned_by=$personId` in the same UPDATE so the schema
  `decom_chk` multi-column CHECK never fires mid-flight.
- `apps/api/src/facilities/energy.service.ts::recordReading`: locks
  parent meter FOR UPDATE inside the tx, reads the most-recent earlier
  reading, computes `consumption = current - prior`, refuses readings
  that drop below the prior (meters only count up), INSERTs with
  consumption pre-materialised. NULL on the first reading per meter.
- `apps/api/src/facilities/fire-drill.service.ts::compliance`:
  LEFT JOIN against the most-recent drill per building, flags rows
  older than 90 days, emits `fac.fire_drill.overdue` per overdue
  building with deterministic event_id from
  `deterministicFireDrillOverdueEventId(buildingId, today_iso)`.
- `apps/api/src/facilities/event-ids.ts`: SHA-256 first 16 bytes
  formatted as v5-shape UUID. Used for both
  `fac.route_stop.issue_noted` (P2-18a) and `fac.fire_drill.overdue`
  (P2-18b).

## Splitter audit

Migration 152 cleared the splitter `;`-in-string trap on first
attempt. Python audit before provisioning verified zero stray
semicolons in block comments or string literals.

Migration 151 (P2-18a) also clean on first audit.

## Test coverage

- `apps/api/src/facilities/facilities-advanced.spec.ts` — 20 tests
  covering P2-18a (S1–S16 + bonus).
- `apps/api/src/facilities/facilities-assets.spec.ts` — 18 tests
  covering P2-18b (S1–S13 + bonus 2).

Total Facilities Advanced specs: **38 tests** across 2 spec files.

Vitest overall: 848 passing across 40 spec files.

## Known design decisions to reconfirm at review

1. **Energy reading auto-compute lives in the service, not a DB
   trigger.** The Postgres splitter cuts on every `;` regardless of
   quoting context, so a CREATE FUNCTION block with embedded
   semicolons would break the tenant provisioning. Service-side compute
   inside a single tenant tx with a meter-row FOR UPDATE lock gives the
   same guarantee (ACID + serialised against concurrent inserts on the
   same meter).
2. **`fac_asset_disposals.UNIQUE(asset_id)` is the schema-side
   belt-and-braces.** The cross-row `status='DECOMMISSIONED'` invariant
   cannot be encoded as a CHECK. The service is the authoritative gate
   per the Cycle 6 invoice cancel-and-refund precedent.
3. **`fac_space_utilization_records.utilisation_rate` is materialised
   at insert time** rather than computed at read. The underused-spaces
   dashboard runs AVG(utilisation_rate) and a partial INDEX
   `(space_id, record_date DESC) WHERE utilisation_rate IS NOT NULL
AND utilisation_rate < 0.5` covers the hot path. Materialisation
   simplifies the dashboard query at the cost of a tiny denormalisation.
4. **`fac_fire_drills.met_target` is materialised at insert time.**
   `evacuation_time_seconds <= target_evacuation_seconds` is a simple
   computation but storing it materialised means the compliance
   dashboard can filter on it directly without re-reading the prior
   target on every row.

## Gate decision

The reviewer's gate decision should reflect the typical Wave C / Wave D
shape:

- **PASS** if no BLOCKING findings remain after Round 1 fixes.
- **REJECT pending fixes** if BLOCKING findings need a Round 1 commit.

Either way, MAJOR findings move to Phase 2 / pre-pilot punch list
items per the project convention (see HANDOFF Phase 2 punch list).
