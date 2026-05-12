# REVIEW NOTES — Phase 2 Cycle 20 (P2-20): IT Advanced

**Scope:** P2-20a (schema + seed + services) at `18308ed` + P2-20b (UI + integration tests + handoff/review docs) at this commit.
**Plan:** `docs/campusos-p2c20-it-advanced.html`
**Handoff:** `HANDOFF-P2C20.md`
**Dates:** 2026-05-12

This document is the peer-review scaffold for the full P2-20 cycle. It enumerates the load-bearing invariants, the live verification trail, and the documented carry-overs so the reviewer can move efficiently through the surface.

---

## 1. Cycle deliverable summary

10 tenant base tables across 2 migrations (`156_tech_remote_actions_audit.sql`, `157_tech_voip_monitoring.sql`), ~34 endpoints across 8 services, 3 Kafka emits (`tech.remote_action.issued`, `tech.usage.flagged`, `tech.monitoring.alert`), 7 new web routes + 3 extended web routes, 16 new pinned vertical-slice regression tests on top of the 23 P2-20a unit tests, 0 cross-schema FKs.

## 2. Structural keystones — what to read for

### 2.1 Remote actions IMMUTABILITY (per ADR-010)

**The contract.** `tech_remote_actions` is an audit trail. Once a row is INSERTed it is permanent. The only mutation path is the lifecycle transition `updateStatus()` which moves PENDING → SENT → COMPLETED / FAILED but cannot rewrite `action_type` / `justification` / `initiated_by` / `asset_id`.

**How it's enforced (three layers):**

1. **Schema CHECK** — `justification` requires `length(trim(...)) >= 20` so a bogus row cannot land even via direct SQL.
2. **Service layer** — `RemoteActionService` exposes only `create / getById / listForAsset / updateStatus`. No `update / delete / remove / patch` methods exist on the prototype. The P2-20a invariant test (`it-advanced.spec.ts`) and the P2-20b vertical-slice test (`it-advanced-vertical-slice.spec.ts` Scenario 1) both `Reflect.getMetadata` / `typeof proto.update` walk the prototype and pin the contract.
3. **`updateStatus()` lifecycle guard** — refuses to mutate a row whose `status` is already `COMPLETED` or `FAILED` (terminal). Pinned by the existing test "refuses to mutate a terminal-state remote action".

**What to verify in code review:** the service file `apps/api/src/it/remote-actions.service.ts`. No method named `update` / `delete` / `remove` / `patch`. The `updateStatus` method UPDATEs only `status / mdm_command_ref / completed_at / failure_reason`. Read the SQL string literally — every other column is omitted.

### 2.2 WIPE auto-reset to AVAILABLE

**The contract.** When a WIPE action is marked COMPLETED, the parent `tech_assets.status` flips to AVAILABLE inside the same tenant tx. The device is now in a known state (factory-reset) and free for redeployment. This invariant cannot be split across two transactions because a crash between them would leave a device the school thinks is wiped but the platform still shows as ASSIGNED.

**How it's enforced.** `RemoteActionService.updateStatus()` runs entirely inside `executeInTenantTransaction`. After the UPDATE on `tech_remote_actions`, if `row.action_type === 'WIPE' && dto.status === 'COMPLETED'`, the same `tx` issues `UPDATE tech_assets SET status='AVAILABLE'` against the asset that was wiped. The tx commits as one unit. Both the existing P2-20a test ("updateStatus() on WIPE + COMPLETED issues UPDATE on tech_assets to AVAILABLE in the same tx") and the new vertical-slice Scenario 2 pin this.

**What's intentionally NOT done:** the previous active assignment is NOT ended by the service this cycle — the auto-end-of-assignment-on-wipe is a Phase 2 polish item once the wipe-recovery workflow product decisions are clearer. The asset flips to AVAILABLE, which is the operational signal IT needs; the parent assignment row stays as the audit trail.

### 2.3 Inventory audit expected-vs-found computation

**The contract.** `InventoryAuditService.complete()` computes three totals atomically from the audit-items roster:

- `total_assets_found = COUNT(*) WHERE found = true AND asset_id IS NOT NULL` (known assets that were physically present)
- `total_assets_unrecorded = COUNT(*) WHERE found = true AND asset_id IS NULL` (asset tags scanned that don't exist in the system catalogue — surprise devices)
- `total_assets_missing = total_assets_expected - total_assets_found` (known assets that should have been there but weren't scanned)

**How it's enforced.** `complete()` runs inside `executeInTenantTransaction` with `SELECT … FOR UPDATE` on the audit row, refuses re-completion of already-COMPLETED rows, runs the aggregate `COUNT(*) FILTER (WHERE found = true AND asset_id IS NOT NULL) AS found_known, COUNT(*) FILTER (WHERE found = true AND asset_id IS NULL) AS unrecorded` query, computes missing from expected − found_known, then stamps all four counters + `status='COMPLETED'` + `completed_at` atomically.

**Edge case: scanning an unknown tag.** `scan()` resolves the tag against `tech_assets WHERE school_id = $tenant AND asset_tag = $tag`. A miss returns `null` for `asset_id`, the INSERT lands with `asset_id=null`, and the complete() aggregate counts it as unrecorded. Verified in Scenario 3.

**Edge case: scanning an already-scanned tag.** Schema has `UNIQUE(audit_id, asset_tag)`. A 23505 surfaces as `BadRequestException(\`Asset tag ${tag} has already been scanned in this audit\`)`.

### 2.4 Licence renewal expiry cascade

**The contract.** Renewing a software licence atomically records the renewal history row AND updates the parent licence's `expiry_date` to the new value, inside one tenant tx. The renewal history is the cost ledger; the parent licence carries the "what's the current expiry" view used by the licence dashboard utilisation pill.

**Pre-flight.** `newExpiryDate <= previousExpiryDate` returns 400 (operators sometimes type a year wrong; refuse rather than corrupt the licence).

**How it's enforced.** `LicenceRenewalService.renew()` opens `executeInTenantTransaction`, reads the current licence with `FOR UPDATE`, validates the date, inserts the renewal row, updates the licence's `expiry_date`. Both writes commit together.

### 2.5 Monitoring alert state machine

**The contract.** The check has a `consecutive_failures` counter and a `consecutive_failures_to_alert` threshold. Each `recordResult()` either:

- **HEALTHY** → reset counter to 0; if there were open (unresolved) alerts → mark them resolved and INSERT a RECOVERED alert row + emit `tech.monitoring.alert` with `alertType='RECOVERED'`.
- **DEGRADED / DOWN** → increment counter; if the post-increment value EQUALS the threshold → INSERT a DOWN/DEGRADED alert row + emit `tech.monitoring.alert`.

The "equals the threshold" (not "≥") condition means each consecutive sequence creates at most one alert. The counter resets on HEALTHY.

**How it's enforced.** `MonitoringService.recordResult()` opens `executeInTenantTransaction`, takes `SELECT … FOR UPDATE` on the check, computes the new counter + new status (HEALTHY/DEGRADED/DOWN), runs UPDATE on the check, then either INSERTs an alert (on threshold cross or recovery) or skips. The `tech.monitoring.alert` emit fires AFTER the tx commits.

**Idempotency under redelivery.** Same-event redelivery would re-increment the counter past the threshold and NOT re-fire the alert (because the condition is EQUALS the threshold). Real-world idempotency is the responsibility of the upstream worker that records results — today that's manual, so this is a deferred concern.

### 2.6 Versioned configuration documentation

**The contract.** Updates to `tech_config_documentation` atomically increment `version` inside a locked-row tenant tx so two concurrent edits never land the same version number.

**How it's enforced.** `ConfigDocumentationService.patch()` opens `executeInTenantTransaction`, takes `SELECT … FOR UPDATE`, then runs `UPDATE … SET version = version + 1, …`. The version+1 expression is computed by Postgres, so concurrent transactions serialise on the row lock and the second one reads the bumped value. Verified in Scenario 6.

---

## 3. Live verification trail

The 7 plan scenarios are pinned by the new `apps/api/src/it/it-advanced-vertical-slice.spec.ts` file (16 tests, all pass) on top of the existing P2-20a `it-advanced.spec.ts` (23 tests, all still pass).

**Vitest summary at this commit:** 963/963 tests pass across 46 spec files.

---

## 4. Carry-overs to Phase 2 punch list (acknowledged at handoff)

1. **Live MDM API integration** (Jamf / Intune / Mosyle) — `tech.remote_action.issued` lands cleanly; a real MDM dispatcher consumer is future work. Today the operator manually updates `status` via the PATCH endpoint as the MDM provider responds.
2. **Automated device usage analytics from MDM sync** — manual entry today; future integrates with MDM provider analytics APIs.
3. **Real HTTP health check execution** — manual result recording today; live ping from a worker requires egress to monitored URLs (deployment-time configuration).
4. **Cycle 14 NotificationConsumer wiring on `tech.usage.flagged`** — emit lands cleanly; consumer ships in a future Wave-2 polish cycle that fans out the flag to IT-admin IN_APP notifications.
5. **End-of-assignment-on-WIPE** — the asset flips to AVAILABLE on WIPE+COMPLETED, which is the operational signal IT needs. Auto-ending the active `hr_employees` / student assignment is a polish item once the wipe-recovery product workflow is clearer.
6. **Network topology auto-discovery / content filtering rules / guest WiFi provisioning** — deliberately out of scope.

---

## 5. Files for the reviewer

### Code (P2-20a — already in repo at `18308ed`)

- `apps/api/src/it/remote-actions.service.ts` — RemoteActionService + InventoryAuditService + LicenceRenewalService + DeviceUsageService
- `apps/api/src/it/voip-monitoring.service.ts` — PhoneExtensionService + ConfigDocumentationService + MonitoringService + InfrastructureExtensionService
- `apps/api/src/it/it-advanced.controller.ts` — single controller for all 34 endpoints
- `apps/api/src/it/dto/it.dto.ts` — DTO surface
- `apps/api/src/it/it-advanced.spec.ts` — 23 unit tests (P2-20a)
- `packages/database/prisma/tenant/migrations/156_tech_remote_actions_audit.sql`
- `packages/database/prisma/tenant/migrations/157_tech_voip_monitoring.sql`
- `packages/database/src/seed-it-advanced.ts`
- `packages/database/src/seed-iam.ts` (extended grants)

### Code (P2-20b — this commit)

- `apps/api/src/it/it-advanced-vertical-slice.spec.ts` — 16 vertical-slice integration tests
- `apps/web/src/hooks/use-it-advanced.ts` — ~30 React Query hooks
- `apps/web/src/lib/it-advanced-format.ts` — label maps + pill class maps + date helpers
- `apps/web/src/lib/types.ts` (extended) — ~30 P2-20 DTO types
- `apps/web/src/app/(app)/it/page.tsx` (extended) — flagged-usage + monitoring banners + 4 new nav tiles
- `apps/web/src/app/(app)/it/assets/[id]/page.tsx` (extended) — RemoteActionsPanel + UsagePanel
- `apps/web/src/app/(app)/it/licences/page.tsx` (extended) — Renewals → modal
- `apps/web/src/app/(app)/it/infrastructure/page.tsx` (extended) — warranty banner + Mark-checked
- `apps/web/src/app/(app)/it/inventory-audits/page.tsx` — audit list + Start Modal
- `apps/web/src/app/(app)/it/inventory-audits/[id]/page.tsx` — audit detail + scan form + discrepancy report
- `apps/web/src/app/(app)/it/phone-extensions/page.tsx` — VOIP directory
- `apps/web/src/app/(app)/it/documentation/page.tsx` — doc library + create Modal
- `apps/web/src/app/(app)/it/documentation/[id]/page.tsx` — doc detail + edit form (creates v{N+1})
- `apps/web/src/app/(app)/it/monitoring/page.tsx` — uptime board + alerts + Record-result buttons + New-check Modal

### Documentation

- `docs/campusos-p2c20-it-advanced.html` — plan
- `HANDOFF-P2C20.md` — handoff
- `P2C20-REVIEW-NOTES.md` — this file
- `CLAUDE.md` — project status updated with P2-20 complete

---

## 6. Reviewer checklist

- [ ] Migrations 156 + 157 reproduce on `tenant_demo` + `tenant_test` from scratch.
- [ ] `RemoteActionService` has no UPDATE / DELETE / REMOVE / PATCH method on the prototype.
- [ ] `RemoteActionService.create()` rejects justification < 20 trimmed chars.
- [ ] `RemoteActionService.updateStatus()` on WIPE + COMPLETED issues `UPDATE tech_assets SET status='AVAILABLE'` inside the same tenant tx.
- [ ] `InventoryAuditService.complete()` computes totals from `tech_inventory_audit_items` and stamps `status='COMPLETED'` atomically.
- [ ] `LicenceRenewalService.renew()` runs INSERT renewal + UPDATE licence expiry inside one tenant tx; refuses backwards date.
- [ ] `MonitoringService.recordResult()` crosses the threshold to INSERT alert + emit `tech.monitoring.alert`; HEALTHY resolves active alerts.
- [ ] `ConfigDocumentationService.patch()` uses locked-row UPDATE with `version = version + 1`.
- [ ] `DeviceUsageService.record()` emits `tech.usage.flagged` AFTER the tx commits when `flaggedActivity=true`.
- [ ] All 3 Kafka emit topics carry `sourceModule='it'`, populated `tenant_id`, and `sourceRefId` matching the originating row id.
- [ ] CI parity green: format:check, lint:logs, API build, web build, vitest 963/963.
- [ ] Web routes render without runtime errors (verified at build time — all 10 IT routes ship).

---

## 7. Permission gate distribution (verification matrix)

| Endpoint family          | Read gate     | Write gate     | Held by (per IAM seed)            |
| ------------------------ | ------------- | -------------- | --------------------------------- |
| Remote actions           | `it-002:read` | `it-002:write` | Staff (IT admin stand-in) + Admin |
| Inventory audits         | `it-002:read` | `it-002:write` | Staff + Admin                     |
| Licence renewals         | `it-004:read` | `it-004:write` | Staff + Admin                     |
| Device usage             | `it-002:read` | `it-002:write` | Staff + Admin                     |
| Phone extensions         | `it-007:read` | `it-007:write` | Staff + Admin                     |
| Documentation            | `it-009:read` | `it-009:write` | Staff (read all IT) + Admin       |
| Monitoring               | `it-006:read` | `it-006:write` | Staff + Admin (admins configure)  |
| Infrastructure extension | `it-007:read` | `it-007:write` | Staff + Admin                     |

Teachers, parents, and students are gated out of every P2-20 endpoint. The Step 8 flagged-usage dashboard endpoint `GET /it/device-usage/flagged` additionally has a service-layer `assertItAdmin` guard that requires `actor.isSchoolAdmin` OR `it-002:admin` / `it-006:read` — verified in Scenario 7 ("DeviceUsage flagged-list refuses non-IT-admin caller").

---

## 8. Carry-over: dedicated IT-admin role split

The IAM seed grants the broad `it-002..009` codes to the generic Staff role as an IT-admin stand-in. A dedicated `IT_ADMIN` role with the IT-\* codes held alone (and removed from Staff) is the proper pre-pilot split — joins the broader Wave-2/Wave-D Phase 2 role-split chain (Counsellor / Nurse / Librarian / AD / FSM / FM / Transportation Coordinator / Procurement Officer / Store Manager / IT Admin / Finance Officer / DPO).
