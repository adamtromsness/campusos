# Cycle 22 Handoff — IT Infrastructure

**Status:** Cycle 22 **COMPLETE + REVIEW-CYCLE22 fixes applied** — Wave 4 (Campus Operations) cycle 4 / final. All 10 steps shipped + vertical-slice CAT verified live on `tenant_demo` 2026-05-06. Round 1 of REVIEW-CYCLE22-CHATGPT (against `cycle22-complete` at `6638090`) returned **Reject pending fixes** with 6 BLOCKING + 4 MAJOR; all 6 BLOCKING fixes landed in the closeout commit (REVIEW-CYCLE22 fix commit) with live verification on `tenant_demo` 2026-05-06. The 4 MAJORs (items 34 / 35 / 36 / 37) carry to the Wave 2–4 Phase 2 punch list for the broader role-split work before pilot. See `REVIEW-CYCLE22-CHATGPT.md` for the triage table + verification trail. Awaiting Round 2 verdict. Cycle 22 ships the M62 IT Infrastructure module — 16 of the 26 ERD tables in scope (10 deferred to Cycle 22.1: tech_remote_actions, tech_licence_renewals, tech_device_usage_summaries, tech_inventory_audits + items, tech_phone_extensions, tech_config_documentation, tech_monitoring_checks + alerts). The IT Administrator is the **ninth specialist operator persona** after the nurse, counsellor, librarian, athletic director, enrolment officer, transportation coordinator, food service manager, and facilities manager. **Closes Wave 4.**

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle22-implementation-plan.html`
**Vertical-slice deliverable:** IT admin creates 2 asset categories (Chromebook + iPad with depreciation years) → registers 10 devices with sequential asset tags → assigns IT-CB-001 to Maya (condition: EXCELLENT) → uploads warranty document → Maya damages it; teacher files damage report (MODERATE, photo) → IT admin opens WARRANTY_CLAIM repair → device flips to REPAIR → IT admin registers 3 software licences (Google Workspace SITE, Adobe Creative Suite PER_SEAT 25 seats, Zoom SUBSCRIPTION) → assigns Adobe to Rivera and 3 others → IT admin stores Wi-Fi admin credential in vault (CRITICAL tier, AES-256) → admin views credential → immutable access_log row written → MDM sync shows IT-CB-005 STALE_CHECKIN alert → admin registers 5 infrastructure items (2 switches, 2 access points, 1 server) → creates Q3 procurement order (10 Chromebooks, ORDERED) → new student selects Chromebook from device options catalogue during ENROLMENT (ADR-066).

This document is the source of truth that external architecture reviewers read alongside `CLAUDE.md`.

---

## Step status

| Step | Title                                                        | Status   |
| ---- | ------------------------------------------------------------ | -------- |
| 1    | Asset + Assignment + Documents Schema                        | Complete |
| 2    | Licences + Credential Vault Schema                           | Complete |
| 3    | MDM + Infrastructure + Procurement + Device Selection Schema | Complete |
| 4    | Seed Data + IT-002..006 IAM grants                           | Complete |
| 5    | Asset + Assignment NestJS Module                             | Complete |
| 6    | Licences + Credential Vault NestJS Module                    | Complete |
| 7    | MDM + Infrastructure + Procurement + Selection NestJS Module | Complete |
| 8    | IT UI — Assets + Licences + Vault                            | Complete |
| 9    | IT UI — MDM + Infrastructure + Procurement + Selection       | Complete |
| 10   | Vertical Slice Integration Test                              | Complete |

**Final cycle totals:** 16 tech\_\* base tables across 3 migrations (075/076/077); tenant base table count 295 → **311**; ~11 intra-tenant FKs; 0 cross-schema FKs. **52 endpoints** under `it-002..it-006:read/write/admin` across 12 services + 1 controller (AssetCategoryService + AssetService + AssignmentService + AssetDocumentService + DamageReportService + RepairRecordService in `assets.service.ts`; LicenceService + CredentialVaultService — **SECURITY KEYSTONE** — in `licences.service.ts`; MdmService + InfrastructureService + ProcurementService + DeviceSelectionService in `mdm.service.ts`). **1 Kafka emit topic** (`tech.licence.near_capacity`). **10 web routes** (`/it`, `/it/assets`, `/it/assets/[id]`, `/it/licences`, `/it/vault`, `/it/mdm`, `/it/infrastructure`, `/it/procurement`, `/it/device-options`, `/it/my-device`). IAM: Teacher gains IT-002:read+write + IT-003:read+write + IT-004:read (5 new perms); Student gains IT-002:read + IT-003:read+write (3 new); Staff covering IT admin gains IT-002..006 read+write (10 new perms). Catalogue stays at **454**. Vertical-slice CAT at `docs/cycle22-cat-script.md` walks 10 plan scenarios end-to-end with the AES-256-GCM credential-vault tier check verified live + the `tech.licence.near_capacity` envelope captured live on the wire. **Splitter trap clean** on all three migrations after audit; **30th migration in a row to clear the splitter trap on first provision attempt after audit** (Cycles 4–22 unbroken). Both `tenant_demo` and `tenant_test` provisioned cleanly. Plan at `docs/campusos-cycle22-implementation-plan.html`. Tagged `cycle22-complete` after CI green.

---

## What this cycle adds on top of Cycle 21

**Greenfield — clean `tech_*` namespace.** Cycle 22 ships the entire M62 IT Infrastructure core from scratch.

- **16 new tenant base tables** across 3 migrations (075 + 076 + 077). Tenant base table count after Cycle 21 was 295 → **311** after Cycle 22.
- **1 new backend module** (ItModule) with ~12 services + 1 controller + ~38 endpoints under `it-002..it-006:read/write/admin`.
- **1 new Kafka emit topic**: `tech.licence.near_capacity` (fires when used_seats / total_seats ≥ 0.80).
- **9+ new web routes**: `/it` dashboard, `/it/assets`, `/it/licences`, `/it/credentials` (security UI), `/it/mdm`, `/it/infrastructure`, `/it/procurement`, `/it/device-selection`, `/it/my-devices`.
- **5 existing permission codes wired up**: `IT-002` (Device Fleet — assets / assignments / damage / repair / infrastructure), `IT-003` (Device Selection), `IT-004` (Software & Licensing), `IT-005` (Credential Vault), `IT-006` (System Monitoring — MDM). Catalogue stays at **454** — IT-001..009 already in `permissions.json` from earlier waves.

**Two structural keystones for the cycle:**

1. **Encrypted Credential Vault per ADR-065 (SECURITY KEYSTONE).** `tech_credential_vault` stores shared service credentials (vendor portals, API keys, SSL certificates, Wi-Fi passwords) encrypted with AES-256 using a separate encryption key from student data. Access is tiered (STANDARD / ELEVATED / CRITICAL) — the `CredentialVaultService.getById` enforces actor's access tier ≥ credential's `access_tier` before decrypting and returning the password. Every credential access (view, copy, modify, create, delete) writes an immutable `tech_credential_access_log` row in the same tenant tx as the read/mutation. The access log is append-only at the service layer (no UPDATE / no DELETE methods exposed) per ADR-010 — mirrors the Cycle 8 `tkt_ticket_activity` and Cycle 21 `fac_work_order_activity` patterns.
2. **Software licence seat-utilisation auto-emit.** `tech_software_assignments.licence_id` partial UNIQUE on `(licence_id, assignee_id)` caps to one assignment per (licence, user). On INSERT the parent `tech_software_licences.used_seats++` inside the same tenant tx; on DELETE it decrements. When `used_seats / total_seats >= 0.80`, the service emits `tech.licence.near_capacity` after the tx commits. SITE licences (no seat cap) skip the emit.

**Existing-system touchpoints:**

- `platform_users(id)` — soft refs on `tech_asset_assignments.assigned_to_id`, `tech_software_assignments.assignee_id`, `tech_credential_access_log.accessed_by`, `tech_mdm_alerts.resolved_by`, `tech_device_selections.approved_by` per ADR-001/020.
- `iam_person(id)` — soft ref on `tech_device_selections.person_id` (the new student or staff making the selection).
- `tkt_vendors(id)` — DB-enforced FK on `tech_repair_records.vendor_id` and `tech_procurement_orders.vendor_id`. Re-uses the Cycle 8 vendor catalogue.
- `hr_employees(id)` — DB-enforced FK on `tech_procurement_orders.ordered_by` (the IT admin who placed the order).
- `wsk_approval_requests(id)` — soft ref on `tech_procurement_orders.linked_approval_id` for approval-routed orders.
- `tech_assets.procurement_order_id` — soft ref to `tech_procurement_orders` (forward-compat: order may not exist when asset is registered).

What does not change: every existing module continues to function. Cycle 22 is purely additive on a clean `tech_*` namespace.

---

## Step 1 — Asset + Assignment + Documents Schema (complete)

**Migration:** `packages/database/prisma/tenant/migrations/075_tech_assets.sql`. 4 logical base tables. **Slot 075 because 070-074 are taken** (Cycle 20 used 068-071, Cycle 21 used 072-074).

- `tech_asset_categories` — `school_id UUID NOT NULL`, `name TEXT NOT NULL`, `depreciation_years INT > 0` CHECK, `maintenance_interval_months INT > 0` CHECK when set, `is_active BOOLEAN`. UNIQUE(school_id, name).
- `tech_assets` — `school_id UUID NOT NULL`, `category_id UUID FK NO ACTION` (audit-preserving — admin must reassign or deactivate before category delete), `asset_tag TEXT NOT NULL`, `serial_number`, `make`, `model`, `purchase_date DATE`, `purchase_cost NUMERIC(10,2) >= 0` CHECK, 5-value `status` CHECK (AVAILABLE, ASSIGNED, REPAIR, RETIRED, LOST), `warranty_expiry DATE`, soft `procurement_order_id UUID` (forward-compat). UNIQUE(school_id, asset_tag) — the scannable tag is the stable handle. INDEX(school_id, status). Partial INDEX(warranty_expiry) WHERE warranty_expiry IS NOT NULL for the warranty-soon-expiring dashboard.
- `tech_asset_assignments` — `asset_id UUID FK NOT NULL` ON DELETE NO ACTION (audit), soft `assigned_to_id UUID NOT NULL` to `platform_users`, `assigned_at TIMESTAMPTZ NOT NULL`, `returned_at TIMESTAMPTZ`, 4-value `condition_at_assign` CHECK (EXCELLENT, GOOD, FAIR, DAMAGED), 4-value `condition_at_return` CHECK or NULL while not returned, `notes`. **Multi-column `returned_chk`** keeping `returned_at` and `condition_at_return` lockstep (both NULL while active, both populated on return). Partial INDEX(assigned_to_id) WHERE returned_at IS NULL — active-assignments hot path.
- `tech_asset_documents` — `asset_id UUID FK NOT NULL` CASCADE (documents are meaningless without their asset), 4-value `document_type` CHECK (INVOICE, WARRANTY, INSURANCE, MANUAL), `s3_key TEXT NOT NULL`, `uploaded_at TIMESTAMPTZ`, soft `uploaded_by`. INDEX(asset_id, document_type).

**4 new intra-tenant DB-enforced FKs**: 1 NO ACTION (`tech_assets.category_id → tech_asset_categories`), 1 NO ACTION (`tech_asset_assignments.asset_id → tech_assets`), 1 CASCADE (`tech_asset_documents.asset_id → tech_assets`); 0 cross-schema FKs.

**Tenant logical base table count after Step 1: 295 → 299**.

---

## Step 2 — Licences + Credential Vault Schema (pending)

**Migration:** `packages/database/prisma/tenant/migrations/076_tech_licences_vault.sql`. 4 logical base tables.

- `tech_software_licences` — `school_id UUID NOT NULL`, `software_name`, `vendor`, 3-value `licence_type` CHECK (PER_SEAT, SITE, SUBSCRIPTION), `total_seats INT > 0` CHECK or NULL for SITE, `used_seats INT >= 0 DEFAULT 0` CHECK with **multi-column `seats_chk`** that `used_seats <= total_seats` when total_seats is set, `expiry_date DATE`, `annual_cost NUMERIC(10,2) >= 0`. INDEX(school_id, expiry_date). Partial INDEX(school_id) WHERE used_seats >= 0.80 \* total_seats AND total_seats IS NOT NULL — the seat-utilisation alert dashboard.
- `tech_software_assignments` — `licence_id UUID FK CASCADE`, soft `assignee_id`, `assigned_at TIMESTAMPTZ`, `last_used_at TIMESTAMPTZ`. UNIQUE(licence_id, assignee_id) caps to one assignment per (licence, user). The Step 6 LicenceService increments / decrements `used_seats` inside the same tenant tx that writes the assignment row.
- `tech_credential_vault` — **SECURITY KEYSTONE per ADR-065.** `school_id UUID NOT NULL`, `service_name TEXT NOT NULL`, 7-value `credential_type` CHECK (VENDOR_PORTAL, SERVICE_ACCOUNT, API_KEY, SSL_CERTIFICATE, WIFI_CREDENTIAL, ADMIN_SHARED, OTHER), `username`, `encrypted_password TEXT NOT NULL` (AES-256, separate key from student data), `url`, `last_rotated_at`, `rotation_due_at`, `expiry_date`, 3-value `access_tier` CHECK (STANDARD, ELEVATED, CRITICAL), `notes`. INDEX(school_id, credential_type). Partial INDEX(expiry_date) WHERE expiry_date IS NOT NULL for rotation alerts. **The schema does not store the encryption key** — the Step 6 service derives it from `process.env.IT_VAULT_KEY` (or a placeholder for development) and applies AES-256-GCM via Node's `crypto` module.
- `tech_credential_access_log` — **IMMUTABLE per ADR-010.** `credential_id UUID FK CASCADE`, soft `accessed_by UUID NOT NULL`, 5-value `access_type` CHECK (VIEW, COPY, MODIFY, CREATE, DELETE), `accessed_at TIMESTAMPTZ NOT NULL`. NO UPDATE, NO DELETE methods on the service surface. INDEX(credential_id, accessed_at DESC).

---

## Step 3 — MDM + Infrastructure + Procurement + Device Selection Schema (pending)

**Migration:** `packages/database/prisma/tenant/migrations/077_tech_mdm_procurement.sql`. 8 logical base tables.

- `tech_mdm_sync_logs` — 4-value `mdm_provider` CHECK (JAMF, INTUNE, MOSYLE, GOOGLE), `is_compliant BOOLEAN`, `compliance_details JSONB`. INDEX(asset_id, sync_at DESC).
- `tech_mdm_alerts` — 6-value `alert_type` CHECK (STALE_CHECKIN, POLICY_VIOLATION, JAILBREAK_DETECTED, ENCRYPTION_DISABLED, UNAUTHORISED_APP, LOW_STORAGE), `is_resolved BOOLEAN DEFAULT false` with multi-column `resolved_chk` keeping resolved_by + resolved_at all-set or all-null with `is_resolved`. Partial INDEX(asset_id) WHERE is_resolved=false.
- `tech_damage_reports` — 4-value `severity` CHECK (MINOR, MODERATE, MAJOR, WRITE_OFF), `photo_s3_keys TEXT[]`, soft `reported_by UUID NOT NULL`. INDEX(asset_id, reported_at DESC).
- `tech_repair_records` — `damage_report_id UUID FK SET NULL`, `vendor_id UUID FK(tkt_vendors) SET NULL`, 3-value `repair_type` CHECK (INTERNAL, EXTERNAL_VENDOR, WARRANTY_CLAIM), 4-value `status` CHECK (PENDING, IN_REPAIR, COMPLETE, WRITTEN_OFF). On INSERT the Step 5 service flips parent `tech_assets.status='REPAIR'`.
- `tech_infrastructure_items` — 9-value `item_type` CHECK (SWITCH, ACCESS_POINT, SERVER, ROUTER, FIREWALL, PRINTER, NAS, UPS, OTHER), 3-value `status` CHECK (ACTIVE, MAINTENANCE, DECOMMISSIONED). Partial UNIQUE(school_id, serial_number) WHERE serial_number IS NOT NULL.
- `tech_procurement_orders` — 6-value `status` CHECK (DRAFT, SUBMITTED, APPROVED, ORDERED, DELIVERED, CANCELLED), DB-enforced FK to `hr_employees(ordered_by)` + `tkt_vendors(vendor_id)`, soft `linked_approval_id` to `wsk_approval_requests`. INDEX(school_id, status).
- `tech_device_options` — School-configurable device catalogue (ADR-066). UNIQUE(school_id, option_name). `software_available TEXT[]`, `cost_difference NUMERIC(8,2)`.
- `tech_device_selections` — Per-person ADR-066 selection record. `person_id UUID FK iam_person`, `option_id UUID FK NO ACTION`, 3-value `selection_context` CHECK (ENROLMENT, REFRESH, NEW_HIRE), 5-value `status` CHECK (SELECTED, APPROVED, PROVISIONING, PROVISIONED, CANCELLED). Partial INDEX(status) WHERE status IN ('SELECTED', 'APPROVED', 'PROVISIONING') for the active-pipeline hot path.

**Cycle 22 schema phase total:** 16 tech\_\* tables, ~22 intra-tenant FKs, 0 cross-schema FKs. Tenant base table count: 295 → **311**.

---

(Steps 4–10 fill in as the cycle progresses.)
