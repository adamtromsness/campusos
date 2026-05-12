# HANDOFF — Phase 2 Cycle 20 (P2-20): IT Advanced

**Status:** REVIEW-P2C20 ROUND 1 fixes applied (2026-05-12). Round 1 against `5823055` returned **FAIL** with 4 BLOCKING + 4 MAJOR. The fix commit lands all 4 BLOCKING + 2 actionable MAJORs (#2 + #3) + 16 new pinned regression tests in `apps/api/src/it/it-advanced-review-p2c20.spec.ts`. Awaiting Round 2 verdict before tagging `p2c20-complete`. **Original build trail preserved below.**

## REVIEW-P2C20 ROUND 1 fix log

**BLOCKING fixes:**

1. **Remote action school-scope** — `RemoteActionService.create()` / `listForAsset()` / `getById()` / `updateStatus()` all now school-scope through `tech_assets.school_id`. The create pre-flight reads `FROM tech_assets WHERE id = $1::uuid AND school_id = $2::uuid`. Reads JOIN `tech_assets a ON a.id = r.asset_id` with `WHERE a.school_id = $2::uuid`. The `updateStatus()` locked SELECT joins through `tech_assets` and locks `FOR UPDATE OF r`. The WIPE + COMPLETED `UPDATE tech_assets SET status='AVAILABLE'` carries `AND school_id = $2::uuid` for defence-in-depth. A School A IT admin can no longer issue / list / patch a remote action against a School B device by guessing UUIDs.

2. **Durable outbox for the 3 IT operational emits** — `tech.remote_action.issued` (RemoteActionService.create), `tech.usage.flagged` (DeviceUsageService.record), and `tech.monitoring.alert` (MonitoringService.recordResult — both DOWN/DEGRADED threshold-cross + RECOVERED) all flipped from best-effort `KafkaProducerService.emit()` AFTER tx commit to durable `OutboxService.enqueueInTx()` INSIDE the triggering tenant tx. Three new deterministic event-id helpers in `apps/api/src/it/event-ids.ts` — `deterministicRemoteActionIssuedEventId(actionId)` / `deterministicUsageFlaggedEventId(usageId)` / `deterministicMonitoringAlertEventId(alertId)` — produce v5-shaped UUIDs via `sha256(<key>:<topic>:v1)`. Retries land the same envelope; downstream consumer-side idempotency catches redelivery cleanly. `RemoteActionService` and `DeviceUsageService` constructors flipped from `kafka: KafkaProducerService` to `outbox: OutboxService`; `MonitoringService` constructor same. KafkaModule already exports OutboxService so no module-wiring change required.

3. **Device usage list / reload school-scope** — `DeviceUsageService.listForAsset()` now reads `FROM tech_device_usage_summaries u JOIN tech_assets a ON a.id = u.asset_id WHERE u.asset_id = $1::uuid AND a.school_id = $2::uuid`. The post-record reload adds `AND a.school_id = $2::uuid` so a leaked usage row id cannot surface a foreign-school summary.

4. **Monitoring alert acknowledge UPDATE + reload school-scope** — `MonitoringService.acknowledgeAlert()` post-lock UPDATE rewrites from `UPDATE tech_monitoring_alerts SET … WHERE id = $1` to `UPDATE tech_monitoring_alerts a SET … FROM tech_monitoring_checks c WHERE a.check_id = c.id AND a.id = $3 AND c.school_id = $4`. The reload adds the same `c.school_id` predicate.

**MAJOR fixes:**

- (#2) **Licence renewal post-lock UPDATE + reload school-scope** — `LicenceRenewalService.renew()` UPDATE on `tech_software_licences.expiry_date` now carries `AND school_id = $3::uuid`. The reload joins `tech_software_licences l` with `l.school_id = $2::uuid` predicate. The parent licence row was already locked under `(id, school_id)`; this is defence-in-depth matching the Phase 2 convention.

- (#3) **Inventory audit item reload + listItems school-scope** — `InventoryAuditService.scan()` reload now joins `tech_inventory_audit_items i → tech_inventory_audits au ON au.id = i.audit_id` with `WHERE i.id = $1::uuid AND au.school_id = $2::uuid`. `listItems()` rewritten with the same join + school predicate.

**MAJORs acknowledged + carried to Phase 2 punch list per the reviewer's gate decision:**

- (#1) RECOVERED idempotency under repeated HEALTHY calls — recommendation-class; the schema does not currently prevent two RECOVERED rows landing if the consumer-side idempotency claim fires twice on the same outbox envelope, but the durable outbox + deterministic event_id from BLOCKING 2 already prevents that for redeliveries. A second cron tick that records HEALTHY when no open alerts exist short-circuits before INSERT.
- (#4) Dedicated IT-admin role split — generic Staff role currently grants the broad IT-002..009 codes as the IT-admin stand-in. Joins the broader Wave-D Phase 2 role-split chain (Counsellor / Nurse / Librarian / AD / FSM / FM / Transportation Coordinator / Procurement Officer / Store Manager / IT Admin / Finance Officer / DPO).

**Test coverage:** vitest 963 → **979 passing across 47 spec files** (+16 new pinned regression tests in `apps/api/src/it/it-advanced-review-p2c20.spec.ts` across 5 REVIEW-P2C20 ROUND 1 describe blocks: BLOCKING 1 × 6 (create pre-flight school predicate + foreign-school 404 + listForAsset school predicate + getById school predicate + updateStatus locked SELECT joins tech_assets + WIPE asset UPDATE carries school_id); BLOCKING 2 × 3 (remote-action.issued + usage.flagged + monitoring.alert all land via OutboxService.enqueueInTx with deterministic v5 event_ids); BLOCKING 3 × 2 (listForAsset + post-record reload carry school_id); BLOCKING 4 × 2 (acknowledge UPDATE joins through tech_monitoring_checks + reload carries c.school_id); deterministic-event-id helpers × 3 (stable per row id + v5 marker + topic-distinct for the same row across the three helpers)). Existing P2-20a `it-advanced.spec.ts` (23 tests) + P2-20b `it-advanced-vertical-slice.spec.ts` (16 tests) re-stitched to use `makeKafka()` mock that exposes both `emit()` + `enqueueInTx()` shape so the existing assertions still pass.

**CI parity green:** format:check + lint:logs (857 files clean) + API build clean + web build clean + vitest 979/979 across 47 spec files.

No schema migrations in Round 1 — every fix is service-layer + new `event-ids.ts` helper + module-wiring (constructor signature flips from kafka to outbox; KafkaModule already exports OutboxService).

See `P2C20-REVIEW-NOTES.md` "REVIEW-P2C20 Round 1 verification trail" for the per-fix evidence table.

## Original P2-20 build state (preserved below)

**Status:** COMPLETE pending peer review. Built in one cycle (no split needed). Schema + seed + services shipped at `18308ed` (P2-20a Steps 1–5). UI + integration tests + handoff/review docs ship in this commit (P2-20b Steps 6–8).
**Plan:** `docs/campusos-p2c20-it-advanced.html`
**Review scaffold:** `P2C20-REVIEW-NOTES.md`
**Dates:** 2026-05-12

## Scope

P2-20 closes the M62 IT Infrastructure deferred-table surface — the 10 ERD tables deferred from Cycle 22. **Wave D (Module Completion)** continuation cycle. The IT admin gains formal MDM remote actions with immutable audit, software licence renewal tracking with cost history, device usage analytics with flagged-activity alerting, formal physical inventory audits with discrepancy reports, VOIP phone extension directory, versioned IT configuration documentation, infrastructure uptime monitoring with consecutive-failure alerting, and the canonical network infrastructure registry.

| Step      | Surface                                                                    | Tables | Endpoints | Emits | Commit                              |
| --------- | -------------------------------------------------------------------------- | ------ | --------- | ----- | ----------------------------------- |
| 1         | Schema — remote actions + licence renewals + usage + inventory audit (5)   | 5      | —         | —     | `18308ed` (P2-20a)                  |
| 2         | Schema — VOIP + documentation + monitoring + infrastructure-extension (5)  | 5      | —         | —     | `18308ed`                           |
| 3         | Seed data (10 sections, all 10 tables)                                     | —      | —         | —     | `18308ed`                           |
| 4         | Remote actions + inventory audit + licence renewal + device usage services | —      | ~16       | 2     | `18308ed`                           |
| 5         | VOIP + documentation + monitoring + infrastructure-extension services      | —      | ~18       | 1     | `18308ed`                           |
| 6         | IT Advanced UI (7 surfaces)                                                | —      | —         | —     | this commit (P2-20b)                |
| 7         | Vertical-slice integration tests (16 new tests)                            | —      | —         | —     | this commit                         |
| 8         | Flagged activity alert dashboard highlighting                              | —      | —         | (1)\* | wired at P2-20a, surfaced at P2-20b |
| **Total** |                                                                            | **10** | **~34**   | **3** |                                     |

\* The `tech.usage.flagged` emit lands in `DeviceUsageService.record()` in P2-20a. Step 8 ships the dashboard surface that highlights flagged devices on the IT landing page and on each device's detail page.

## Structural keystones

**Six keystones documented in the plan, all verified live + pinned by tests:**

1. **Remote actions IMMUTABLE per ADR-010** — `tech_remote_actions` has no `update()` / `delete()` / `remove()` / `patch()` methods on the service prototype. The only mutation path is the lifecycle `updateStatus()` which can transition PENDING → SENT → COMPLETED / FAILED but cannot rewrite `action_type` / `justification` / `initiated_by` / `asset_id`. The schema CHECK enforces `length(trim(justification)) >= 20` so a bogus short justification cannot land via direct SQL either. Pinned by tests in `it-advanced-vertical-slice.spec.ts` Scenario 1 + the existing P2-20a invariant test that walks the prototype.

2. **WIPE auto-reset to AVAILABLE** — `RemoteActionService.updateStatus()` on `(action_type='WIPE', status='COMPLETED')` issues `UPDATE tech_assets SET status='AVAILABLE'` inside the same `executeInTenantTransaction` as the action-status flip. Non-WIPE actions do NOT touch the parent asset. Pinned by Scenario 2 in `it-advanced-vertical-slice.spec.ts`.

3. **Inventory audit expected-vs-found computation** — `InventoryAuditService.create()` counts the population at start-time from `tech_assets` filtered by building scope. `scan()` resolves the asset_tag against the current school's catalogue inside the locked tenant tx — unknown tags land with `asset_id=null` and are counted as unrecorded by the `complete()` aggregate via `COUNT(*) FILTER (WHERE found = true AND asset_id IS NULL)`. The `complete()` UPDATE stamps `total_assets_found / total_assets_missing / total_assets_unrecorded / completed_at` atomically and refuses re-completion of an already-COMPLETED row.

4. **Licence renewal cascading expiry** — `LicenceRenewalService.renew()` runs INSERT renewal + UPDATE `tech_software_licences.expiry_date` inside one tenant tx. Pre-flight rejects new expiry ≤ current expiry. The renewal history feeds the licence cost chart; the `tech_software_licences.expiry_date` field stays the canonical "current expiry" for the licence dashboard utilisation pill.

5. **Monitoring alert state machine** — `MonitoringService.recordResult()` runs inside one tx with `SELECT … FOR UPDATE` on `tech_monitoring_checks`. On DOWN/DEGRADED → increments `consecutive_failures`; if it crosses `consecutive_failures_to_alert` → INSERTs a `tech_monitoring_alerts` row and emits `tech.monitoring.alert` with the full payload. On HEALTHY → looks up active (unresolved) alerts and UPDATEs `resolved_at = now()`, then INSERTs a RECOVERED row and emits the recovery envelope. Idempotent across redelivery.

6. **Versioned configuration documentation** — `ConfigDocumentationService.patch()` uses `SELECT … FOR UPDATE` on `tech_config_documentation` then `UPDATE … SET version = version + 1` inside the same tenant tx so two concurrent updates do not race the version number. The version counter is the canonical record of how many edits the document has accumulated. Pinned by Scenario 6.

## Endpoint inventory (~34 total)

**Remote actions (3):**

- `GET /it/devices/:assetId/remote-actions` — `it-002:read` — action history per asset
- `POST /it/devices/:assetId/remote-action` — `it-002:write` — issue new action (IMMUTABLE) + emit `tech.remote_action.issued`
- `PATCH /it/remote-actions/:id/status` — `it-002:write` — MDM callback / operator status update; WIPE+COMPLETED flips asset to AVAILABLE

**Inventory audits (7):**

- `GET /it/inventory-audits`
- `GET /it/inventory-audits/:id`
- `POST /it/inventory-audits` — start audit (computes total_assets_expected)
- `POST /it/inventory-audits/:id/scan` — per-asset scan (unknown tag → unrecorded)
- `GET /it/inventory-audits/:id/items` — full scan list
- `POST /it/inventory-audits/:id/complete` — finalise + compute totals
- `GET /it/inventory-audits/:id/report` — discrepancy report (missing + unrecorded + condition changes)

**Licence renewals (2):**

- `GET /it/licences/:id/renewals`
- `POST /it/licences/:id/renew` — atomic renewal + expiry update

**Device usage (3):**

- `GET /it/devices/:assetId/usage`
- `GET /it/device-usage/flagged` — flagged-activity hot path (Step 8 dashboard)
- `POST /it/devices/:assetId/usage` — daily summary; flagged=true → emit `tech.usage.flagged`

**Phone extensions (6):**

- `GET /it/phone-extensions` — search + department + includeInactive filters
- `GET /it/phone-extensions/:id`
- `POST /it/phone-extensions`
- `PATCH /it/phone-extensions/:id`
- `POST /it/phone-extensions/:id/assign`
- `POST /it/phone-extensions/:id/unassign`

**Configuration documentation (5):**

- `GET /it/documentation` — optional category filter
- `GET /it/documentation/:id`
- `POST /it/documentation` — creates v1
- `PATCH /it/documentation/:id` — locked-row UPDATE that increments version

**Monitoring (7):**

- `GET /it/monitoring`
- `GET /it/monitoring/:id`
- `POST /it/monitoring`
- `PATCH /it/monitoring/:id`
- `POST /it/monitoring/:id/result` — record check result; threshold-crossing creates alert + emit
- `GET /it/monitoring-alerts` — `?activeOnly=true`
- `PATCH /it/monitoring-alerts/:id/acknowledge`

**Infrastructure extension (P2-20 layer on Cycle 22 base, 3):**

- `GET /it/infrastructure/warranty-expiring?days=30` — warranty look-ahead
- `PATCH /it/infrastructure/:id/check` — stamps `last_checked_at`
- `PATCH /it/infrastructure/:id` — full field updates

## Kafka emits (3 total)

| Topic                       | Producer                           | When                                                                                         | Payload highlights                                                                                                     |
| --------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `tech.remote_action.issued` | `RemoteActionService.create()`     | After INSERT tx commits                                                                      | actionId, assetId, assetTag, actionType, initiatedBy, justification, mdmCommandRef, schoolId, sourceRefId              |
| `tech.usage.flagged`        | `DeviceUsageService.record()`      | When `flaggedActivity=true` AFTER INSERT tx commits                                          | usageId, assetId, assetTag, schoolId, summaryDate, screenTimeMinutes, appsUsed, summarySource, recordedBy, sourceRefId |
| `tech.monitoring.alert`     | `MonitoringService.recordResult()` | When alert row is created (DOWN/DEGRADED threshold cross OR RECOVERED on HEALTHY-after-DOWN) | alertId, checkId, systemName, alertType, schoolId, detectedAt, statusCode, responseTimeMs, errorMessage, sourceRefId   |

## Migrations

- `156_tech_remote_actions_audit.sql` — 5 tables (tech_remote_actions, tech_licence_renewals, tech_device_usage_summaries, tech_inventory_audits, tech_inventory_audit_items)
- `157_tech_voip_monitoring.sql` — 5 tables (tech_phone_extensions, tech_config_documentation, tech_monitoring_checks, tech_monitoring_alerts, tech_infrastructure_items)

Both splitter-safe additive; both `tenant_demo` and `tenant_test` provisioned cleanly. 0 cross-schema FKs.

## Seed (`seed-it-advanced.ts`, idempotent)

3 remote actions (LOCK COMPLETED, WIPE COMPLETED with asset reset, LOCATE PENDING — all with justification ≥ 20 chars) · 2 licence renewals (Photoshop + Google Workspace) · 10 device usage rows across 3 devices (1 with `flagged_activity=true`) · 1 COMPLETED audit (45 expected / 42 found / 2 missing / 1 unrecorded) with 8 audit items · 10 VOIP extensions (5 DESK / 3 CLASSROOM / 1 OFFICE / 1 FAX; 7 assigned, 3 unassigned) · 3 config docs (NETWORK_TOPOLOGY v2 with diagram / WIFI v1 / BACKUP v3) · 3 monitoring checks (SIS API HTTP 5min / Payment Gateway HTTP 5min / Email Server PING 10min) · 5 alerts (2 active DOWN, 1 RECOVERED, 1 DEGRADED acknowledged, 1 RECOVERED) · 8 infrastructure items (2 SWITCH, 3 ACCESS_POINT, 1 SERVER, 1 FIREWALL, 1 PRINTER; 1 MAINTENANCE).

## IAM (catalogue unchanged; existing IT-001..009 codes extended)

P2-20a `seed-iam.ts` adds the IT-006 (Monitoring) and IT-007 (VOIP / Infrastructure) and IT-009 (Documentation) grants to the Staff role (covering the IT admin stand-in until a dedicated IT-admin role splits). School Admin and Platform Admin pick up admin tier via `everyFunction`. No new permission codes — every Step 4/5 endpoint reuses the IT-001..009 catalogue Cycle 22 already shipped.

## Web routes (Step 6)

| Route                                      | Surface                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/it` (existing — extended)                | IT landing — surfaces active monitoring alerts + flagged-usage devices at the top so IT admins see them first; nav grid now includes Inventory audits / VOIP directory / Documentation / Monitoring tiles                                                          |
| `/it/assets/[id]` (existing — extended)    | Device detail — new `RemoteActionsPanel` (button + Modal with 7-action picker, justification textarea with min-20 counter, WIPE warning panel, status pills, Mark-completed admin button) and `UsagePanel` (rose-tinted flagged-activity rows with apps_used list) |
| `/it/inventory-audits`                     | Audit list — table with status pills + Start-audit Modal                                                                                                                                                                                                           |
| `/it/inventory-audits/[id]`                | Audit detail — header stat panel (Expected / Found / Missing / Unrecorded), scan form (auto-focus tag input, condition picker, Mark-found / Mark-missing / Complete buttons), live scan list, discrepancy report panel on COMPLETED                                |
| `/it/licences` (existing — extended)       | Licence registry — Renewals → button per row opens RenewalsModal with renewal history list + Record-renewal sub-form (date picker, cost, notes)                                                                                                                    |
| `/it/phone-extensions`                     | VOIP directory — searchable directory table (extension number / type pill / assignee / display name / location / department), department filter, includeInactive toggle, Add-extension Modal, per-row Unassign action                                              |
| `/it/documentation`                        | Document library — filter chip grid (All / 7 categories), document cards with category pill + version badge + content preview + diagram indicator, New-document Modal with markdown textarea + S3 key                                                              |
| `/it/documentation/[id]`                   | Document detail — version badge, Edit button (warns "creates v{N+1}"), Markdown content viewer, edit form with diff-aware save (no-changes detection) inside locked-row UPDATE                                                                                     |
| `/it/monitoring`                           | Uptime board — rose banner when active alerts exist (top 3 inlined + Review link), per-check card with status pill + 3 Record buttons (HEALTHY / DEGRADED / DOWN), Acknowledge inline form per active alert with notes textarea, New-check Modal                   |
| `/it/infrastructure` (existing — extended) | Network gear registry — amber-tinted "Warranty expiring in 30 days" banner with per-row days-left pill (rose if overdue, amber if ≤14d, emerald otherwise), per-row Mark-checked action                                                                            |

Build sizes (web): `/it/assets/[id]` 4.38 kB · `/it/inventory-audits` 3.48 kB · `/it/inventory-audits/[id]` 4.22 kB · `/it/licences` 3.23 kB · `/it/phone-extensions` 3.79 kB · `/it/documentation` 3.54 kB · `/it/documentation/[id]` 3.24 kB · `/it/monitoring` 4.32 kB · `/it/infrastructure` 2.4 kB · `/it` 3.05 kB.

## Vertical-slice integration tests (Step 7)

`apps/api/src/it/it-advanced-vertical-slice.spec.ts` — **16 new tests across 8 describe blocks** covering the 7 plan scenarios + concurrent-action audit shape + asset-not-found 404 short-circuit:

1. **Scenario 1 — Remote action IMMUTABLE** (3 tests):
   - `create()` happy path emits `tech.remote_action.issued` envelope.
   - `create()` rejects justification < 20 trimmed chars with 400.
   - Service prototype has no UPDATE/DELETE/REMOVE/PATCH methods — only `create`, `getById`, `listForAsset`, `updateStatus` (the lifecycle transition).
2. **Scenario 2 — WIPE auto-reset to AVAILABLE** (2 tests):
   - `updateStatus()` on WIPE + COMPLETED issues `UPDATE tech_assets SET status='AVAILABLE'` inside the same tx.
   - Non-WIPE COMPLETED does NOT flip the asset.
3. **Scenario 3 — Inventory audit lifecycle** (1 test):
   - Start (10 expected) → scan 7 found + 1 unknown (`assetId=null`) → complete → totals = (found=7, missing=2, unrecorded=1).
4. **Scenario 4 — Licence renewal** (1 test):
   - Renew from 2026-12-31 → 2027-12-31 at $500 writes the renewal INSERT and the licence expiry UPDATE inside one tx.
5. **Scenario 5 — Monitoring alert state machine** (2 tests):
   - Crossing the threshold creates DOWN alert row and emits `tech.monitoring.alert` with full payload.
   - HEALTHY after DOWN resolves the active alert and emits a RECOVERED envelope.
6. **Scenario 6 — Documentation versioning** (1 test):
   - `patch()` runs `UPDATE … SET version = version + 1` inside locked-row tx.
7. **Scenario 7 — Visibility** (4 tests):
   - Teacher cannot issue remote action (Forbidden).
   - Teacher cannot conduct inventory audit (Forbidden).
   - Admin can read documentation.
   - Teacher cannot read flagged-usage dashboard (Forbidden — Step 8 dashboard gate).
8. **Concurrent remote actions** (1 test):
   - Two parallel `create()` calls against the same asset both succeed and both emit (the IMMUTABLE invariant is "every issuance is an audit row"; no schema constraint enforces "at most one PENDING per asset" because each row is a distinct audit entry).
9. **Asset-not-found short-circuit** (1 test):
   - Issuing against a missing asset 404s without writing the audit INSERT.

## Step 8 — Flagged activity alert + dashboard highlighting

Already wired in P2-20a's `DeviceUsageService.record()`: when `flagged_activity=true` is recorded, the service emits `tech.usage.flagged` AFTER the tenant tx commits with `usageId / assetId / assetTag / schoolId / summaryDate / screenTimeMinutes / appsUsed / summarySource / recordedBy / sourceRefId` so a future Cycle 14 NotificationConsumer (Phase 2 punch list) can fan out an IT-admin notification. Step 8's contribution is the dashboard surface:

- **`/it` landing page** — when `useItFlaggedDeviceUsage` returns rows, an amber-tinted banner renders above the stat panel with the device count and the top 5 flagged devices (link to the device detail + apps_used list inline).
- **`/it/assets/[id]` device detail** — the `UsagePanel` renders each daily summary as a card; rows with `flaggedActivity=true` get rose-tinted borders, a "Flagged activity" badge, and the apps_used list expanded verbatim so the IT admin can triage.

The plan's "IT admin reviews the apps_used list for the flagged day and decides whether to issue a remote action or escalate" flow is wired end-to-end: the flagged-usage banner deep-links to the device, the usage panel surfaces the apps, and the same page hosts the Issue-action Modal.

## CI parity

- format:check ✓ (855 files clean)
- lint:logs ✓ (855 files clean)
- API build clean
- Web build clean (all 10 IT routes render; 7 new P2-20b routes + 3 existing extended routes)
- vitest **963/963** across 46 spec files (was 947 before P2-20b; +16 new tests landed)

## Carry-overs to Phase 2 punch list

1. **Live MDM API integration** (Jamf / Intune / Mosyle) — `tech.remote_action.issued` lands cleanly but a real MDM dispatcher consumer is future work. Today the operator manually updates `status` via the PATCH endpoint as the MDM provider responds.
2. **Automated device usage analytics from MDM sync** — manual entry today via `POST /it/devices/:assetId/usage`; future enhancement integrates with MDM provider analytics APIs.
3. **Real HTTP health check execution** — the `MonitoringWorker` is a manual-result recorder today; live HTTP ping from a worker requires egress to monitored URLs which is a deployment-time configuration.
4. **Cycle 14 NotificationConsumer wiring on `tech.usage.flagged`** — emit lands cleanly; consumer ships in a future Wave-2 polish cycle that connects flagged-activity to IT-admin IN_APP notifications.
5. **Network topology auto-discovery** — content filtering rule management + guest WiFi provisioning are deliberately out of scope.

## Files touched (P2-20b)

**New:**

- `apps/web/src/hooks/use-it-advanced.ts` (~30 hooks)
- `apps/web/src/lib/it-advanced-format.ts` (label maps + pill class maps + helpers)
- `apps/web/src/app/(app)/it/inventory-audits/page.tsx`
- `apps/web/src/app/(app)/it/inventory-audits/[id]/page.tsx`
- `apps/web/src/app/(app)/it/phone-extensions/page.tsx`
- `apps/web/src/app/(app)/it/documentation/page.tsx`
- `apps/web/src/app/(app)/it/documentation/[id]/page.tsx`
- `apps/web/src/app/(app)/it/monitoring/page.tsx`
- `apps/api/src/it/it-advanced-vertical-slice.spec.ts` (16 tests across 8 describe blocks)
- `HANDOFF-P2C20.md` (this file)
- `P2C20-REVIEW-NOTES.md`

**Extended:**

- `apps/web/src/lib/types.ts` (+ ~30 P2-20 DTO types and payloads)
- `apps/web/src/app/(app)/it/page.tsx` (flagged-usage + monitoring banners + 4 new nav tiles)
- `apps/web/src/app/(app)/it/assets/[id]/page.tsx` (RemoteActionsPanel + UsagePanel)
- `apps/web/src/app/(app)/it/licences/page.tsx` (Renewals → modal with history + record sub-form)
- `apps/web/src/app/(app)/it/infrastructure/page.tsx` (warranty-expiring banner + Mark-checked action)
- `CLAUDE.md` (P2-20 status documented)

**Total Wave D / Cycle 20 footprint at the close of P2-20b:** 10 tenant `tech_*` base tables across 2 migrations (156 + 157), ~34 endpoints across 8 services, 3 Kafka emits, 7 new web routes + 3 extended web routes, 16 new pinned regression tests, 963 vitest tests across 46 spec files.
