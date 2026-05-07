# Cycle 30 Handoff — Data Governance & Compliance

**Status:** Cycle 30 **COMPLETE pending peer review** — Wave 7 (Analytics & Governance) closing cycle. All 10 steps shipped + vertical-slice CAT verified live on `tenant_demo` 2026-05-07. Cycle 30 builds the M120 DPO Compliance Suite — all 12 ERD tables in scope per ADR-052. The regulatory compliance backbone that makes CampusOS pilot-ready for schools operating under GDPR, UK GDPR, FERPA, and COPPA simultaneously. The DPO role is scoped at ORGANISATION level so a single Data Protection Officer can query `dpo_*` tables across every school in their organisation. **The 72-hour breach notification countdown is the highest-urgency automated escalation in CampusOS.**

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle30-implementation-plan.html`
**Vertical-slice deliverable:** DPO creates ROPA (5 processing activities — one high_risk with no DPIA = gap) → registers retention policies → compliance dashboard surfaces the DPIA gap → DPO creates DPIA + links it → registers 4 third-party processors (2 with DPA gaps) → publishes Privacy Notice v2.1 → records parent consent → laptop with student records stolen → breach logged + 72-hour countdown starts + URGENT task created + `dpo.breach.discovered` envelope on the wire → DPO notifies supervisory authority within 72 hours → David Chen submits SAR for Maya's data + 30-day clock starts → DPO compiles cross-module data export → erasure request for withdrawn student → academic records retained (FERPA), audit_log.metadata pseudonymised with opaque token → pseudonymisation_log records the operation (IMMUTABLE) → Maya turns 18 → `platform_students.data_subject_is_self=true` → Maya is now the data subject for all future SARs.

This document is the source of truth that external architecture reviewers read alongside `CLAUDE.md`.

---

## Step status

| Step | Title                                                          | Status |
| ---- | -------------------------------------------------------------- | ------ |
| 1    | ROPA + Retention + DPIA Schema                                 | Done   |
| 2    | Processors + DPAs + Breach Records Schema                      | Done   |
| 3    | SARs + Erasure + Consent + Privacy + Pseudonymisation Schema   | Done   |
| 4    | Seed Data + DPO-001..005 IAM grants                            | Done   |
| 5    | ROPA + Retention + DPIA NestJS Module                          | Done   |
| 6    | Processors + Breach NestJS Module + 72-hour countdown keystone | Done   |
| 7    | SARs + Erasure + Consent + Privacy NestJS Module               | Done   |
| 8    | DPO UI — Compliance Dashboard + ROPA + Processors              | Done   |
| 9    | DPO UI — Breach + SARs + Erasure + Consent + Privacy           | Done   |
| 10   | Vertical Slice Integration Test                                | Done   |

---

## What this cycle adds on top of Cycle 29

**Greenfield — clean `dpo_*` namespace.** Cycle 30 ships the M120 DPO Compliance Suite from scratch. **Wave 7 (Analytics & Governance) closes here** (Cycle 26 Finance opened Wave 6; Cycle 27 Procurement; Cycle 28 School Store; Cycle 29 Analytics opened Wave 7).

- **12 new tenant base tables** across 3 migrations (098 + 099 + 100). Note: the plan's filenames (092/093/094) are out of date — those slots were taken by Cycle 28 Store; Cycle 29 used 095/096/097; Cycle 30 uses 098/099/100.
- **1 new backend module** (GovernanceModule) with **10 services + 1 controller + ~34 endpoints** under `dpo-001:read/write/admin` (ROPA + retention + DPIA) + `dpo-002:read/write/admin` (processors + DPAs) + `dpo-003:read/write/admin` (breach management) + `dpo-004:read/write/admin` (SARs + erasure) + `dpo-005:read/write/admin` (consent + privacy notices).
- **1 new Kafka emit topic**: `dpo.breach.discovered` (fires AFTER breach INSERT commits; Cycle 7 TaskWorker creates URGENT task with 72-hour deadline when `supervisory_authority_notification_required=true`).
- **5 new permission codes**: DPO-001 (ROPA + retention), DPO-002 (processors + DPAs), DPO-003 (breach management), DPO-004 (SARs + erasure), DPO-005 (consent + privacy notices). Catalogue 160 → **165 functions × 3 tiers = 495 permissions**.
- **1 new web app tile** (Data Governance under DPO-001:read with new `ShieldIcon`) + **11 new web routes** (5 in Step 8 + 6 in Step 9).

**Six structural keystones for the cycle:**

1. **72-HOUR BREACH NOTIFICATION COUNTDOWN (REGULATORY KEYSTONE).** `dpo_data_breach_records.discovery_date` starts the GDPR Article 33 supervisory authority notification window. On INSERT with `supervisory_authority_notification_required=true`, the Cycle 7 TaskWorker creates an URGENT escalating task; the `dpo.breach.discovered` Kafka envelope fires AFTER tx commits with the breach context payload. The 70-hour PAGE-level alert is wired through the auto-task rule's `due_offset_hours=70`. **A missed 72-hour window is a regulatory violation** — this is the highest-urgency automated escalation in CampusOS.

2. **DPIA + DPA COMPLIANCE GAP DETECTION.** Two schema-level gap rules surface on the DPO compliance dashboard:
   - `dpo_processing_activities.high_risk_processing=true AND dpia_id IS NULL` → DPIA gap.
   - `dpo_third_party_processors.dpa_in_place=false` → DPA gap.
     Both surface as red rows on the ROPA / processor registers + as gap-count cards on the unified `/governance` dashboard.

3. **30/45-DAY SAR DEADLINE TRACKING.** `dpo_subject_access_requests.deadline_date` is computed from `dpo_compliance_dashboard_config.sar_default_deadline_days` (30 days GDPR default; 45 days FERPA when applicable). Status flips from RECEIVED → IN_PROGRESS / EXTENSION_REQUESTED → COMPLETED / DENIED / OVERDUE. The Step 8 dashboard surfaces overdue + due-soon SARs as a stat card.

4. **AUDIT LOG FIELD-LEVEL PSEUDONYMISATION (ADR-010 + ADR-052).** `ErasureService.pseudonymise(erasureRequestId)` runs an UPDATE against `platform.platform_audit_log.metadata` JSONB for the data subject's rows, replacing PII identifier paths with the opaque token (e.g. `psd_<uuid>`), and writes one immutable row per (target_table, target_field) into `dpo_pseudonymisation_log`. `dpo_pseudonymisation_log` has NO UPDATE / NO DELETE methods exposed — service-side discipline matches Cycle 8 `tkt_ticket_activity` and Cycle 10 `hlth_health_access_log`.

5. **AGE-18 RIGHTS TRANSFER.** `platform.platform_students.data_subject_is_self` (already in the schema) is the boolean that flips `false → true` when the student turns 18. SARService refuses parent-submitted requests after the flip — only the student themselves (or their guardian via explicit student authorisation) can submit a SAR for their own data. Pre-existing parent-submitted SARs continue to process per their original deadline. Cycle 30 ships the read path that respects the flag; the actual flip is a future scheduled job.

6. **IMMUTABLE PSEUDONYMISATION LOG.** `dpo_pseudonymisation_log` is append-only at the service layer — no UPDATE, no DELETE methods exposed. Mirrors Cycle 8 `tkt_ticket_activity` + Cycle 10 `hlth_health_access_log` + Cycle 11 `svc_referral_activity`. The audit chain is verifiable: every `dpo_pseudonymisation_log` row points at a `dpo_erasure_requests` row (the user-facing rationale), and the `pseudonymisation_token` is the opaque identifier that survived the erasure.

**Existing-system touchpoints:**

- `iam_person(id)` — soft refs from `dpo_subject_access_requests.data_subject_id`, `dpo_erasure_requests.data_subject_id`, `dpo_processing_consent_records.data_subject_id`, `dpo_pseudonymisation_log.data_subject_id`.
- `platform_users(id)` — soft refs from every `*_by` audit column (created_by, reviewed_by, signed_by, published_by, completed_by, approved_by, reported_by, requested_by, pseudonymised_by).
- `platform.platform_audit_log` — mutation target of `ErasureService.pseudonymise()`. The `metadata` JSONB column is rewritten with opaque tokens for the data subject.
- `platform.platform_students.data_subject_is_self` — read by SARService to enforce age-18 rights transfer.
- `tsk_auto_task_rules` (Cycle 7) — Step 4 seed adds a rule for `dpo.breach.discovered` → URGENT task with 72-hour deadline.

What does not change: every existing module continues to function. Cycle 30 is purely additive on a clean `dpo_*` namespace.

---

## Per-step records

### Step 1 — ROPA + Retention + DPIA schema (098)

Migration `098_dpo_ropa.sql` lands 3 logical base tables:

- `dpo_processing_activities` (Article 30 ROPA): UNIQUE(school, name); 6-value `legal_basis` CHECK; `cardinality(data_categories) > 0` + `cardinality(data_subjects) > 0` non-empty CHECKs; soft circular refs to `dpo_retention_policies` + `dpo_dpias` (no DB FK to avoid migration ordering deadlock); partial INDEX `dpo_pa_high_risk_no_dpia_idx ON (school_id) WHERE high_risk_processing=true AND dpia_id IS NULL` is the **DPIA gap rule** the dashboard reads.
- `dpo_retention_policies`: UNIQUE(school, data_category); 3-value `review_frequency` CHECK ANNUAL/BIENNIAL/ON_CHANGE.
- `dpo_dpias` (Article 35): 5-value `status` CHECK SCOPING/IN_PROGRESS/COMPLETED/APPROVED/REJECTED; nullable 3-value `residual_risk_level` CHECK LOW/MEDIUM/HIGH; `risks_identified` JSONB array.

0 cross-schema FKs. Splitter `;`-in-string trap caught + fixed pre-provision (1 stray `;` in block-comment description rewritten as em-dash). Smoke green (9 assertions in tx). Idempotent re-provision verified on `tenant_demo` and `tenant_test`.

### Step 2 — Processors + DPAs + Breach schema (099)

Migration `099_dpo_processors_breach.sql` lands 3 logical base tables:

- `dpo_third_party_processors` (Article 28): 9-value `processor_type` CHECK; nullable 4-value `transfer_mechanism` CHECK; `dpa_in_place=false` is the **DPA gap rule**; partial INDEX `dpo_proc_dpa_gap_idx ON (school_id) WHERE dpa_in_place=false`.
- `dpo_data_processing_agreements`: DB-enforced FK CASCADE to `dpo_third_party_processors`; 4-value `status` CHECK DRAFT/ACTIVE/EXPIRED/TERMINATED; `effective_to >= effective_from` CHECK.
- `dpo_data_breach_records`: 8-value `breach_type` CHECK; 4-value `risk_level` CHECK; 4-value `risk_to_individuals` CHECK; 4-value `status` CHECK; `cardinality(personal_data_categories_involved) > 0`; `estimated_affected_individuals >= 0` CHECK; **multi-column `resolved_chk` keystone** keeps (status, is_resolved, resolved_at) in lockstep — RESOLVED requires both is_resolved=true AND resolved_at NOT NULL, every other state requires both NULL/false. Partial INDEX `dpo_breach_pending_notification_idx ON (discovery_date) WHERE supervisory_authority_notification_required=true AND supervisory_authority_notified_at IS NULL` is the 72-hour countdown query path.

0 cross-schema FKs. 1 intra-tenant FK CASCADE. Splitter trap fixed pre-provision (1 stray `;` in COMMENT ON TABLE rewritten as period). 11-assertion smoke including both directions of resolved_chk lockstep.

### Step 3 — SARs + Erasure + Consent + Privacy + Pseudonymisation schema (100)

Migration `100_dpo_sars_erasure.sql` lands 6 logical base tables:

- `dpo_subject_access_requests`: 4-value `request_type` CHECK ACCESS/RECTIFICATION/PORTABILITY/RESTRICTION; 6-value `status` CHECK; **multi-column `completed_chk`** keeps completed_at populated only for COMPLETED/DENIED.
- `dpo_erasure_requests`: 5-value `status` CHECK RECEIVED/REVIEWING/PARTIALLY_COMPLETED/COMPLETED/DENIED; **multi-column `completed_chk`** mirroring SARs but accepting PARTIALLY_COMPLETED in the terminal set; 3 TEXT[] columns categorising the erasure outcome (erased / retained / pseudonymised).
- `dpo_processing_consent_records`: 3-value `consent_method` CHECK DIGITAL/PAPER/VERBAL.
- `dpo_privacy_notices`: UNIQUE(school, version); `superseded_at` is the supersession marker; partial INDEX `dpo_privacy_school_current_idx ON (school_id, effective_from DESC) WHERE superseded_at IS NULL` for the current-notice query.
- `dpo_pseudonymisation_log` (**IMMUTABLE per ADR-010**): NO ACTION FK to `dpo_erasure_requests` so the audit chain survives erasure deletion; `rows_pseudonymised >= 0` CHECK; service-side discipline — no UPDATE / no DELETE methods exposed.
- `dpo_compliance_dashboard_config`: UNIQUE(school) one config per school; `breach_escalation_hours` bounded 1..72 CHECK so the 70-hour task escalation default sits inside the GDPR window.

1 DB-enforced FK NO ACTION (pseudo log → erasure). 0 cross-schema FKs. Splitter audit clean on first try.

**Cycle 30 schema phase complete: 12 dpo\_\* tables across 3 migrations (098 + 099 + 100). 0 cross-schema FKs. 1 intra-tenant FK CASCADE + 1 NO ACTION = 2 FK rows.** Both `tenant_demo` and `tenant_test` provisioned cleanly.

### Step 4 — Seed + DPO-001..005 IAM grants

- Catalogue grew 160 → **165 functions × 3 tiers = 495 permissions** (+15 DPO codes).
- `seed-dpo.ts` (idempotent, gated on `dpo_processing_activities` row count) wired as `seed:dpo`. Live counts on `tenant_demo`: pa=5 (1 DPIA gap), rp=3, dpia=1 APPROVED, proc=4 (2 DPA gaps), dpa=2 ACTIVE, breach=1 (18h elapsed, 54h remaining), sar=1 IN_PROGRESS, erasure=1 PARTIALLY_COMPLETED, pseudo=1 (47 audit rows), consent=3 (2 active + 1 withdrawn), notice=1 v2.1 PUBLISHED, config=1.
- IAM extended: Parent gains DPO-004:read+write (47 perms total, +2 — SAR self-service); Student gains DPO-004:read+write (52, +2); Staff (DPO stand-in) gains DPO-001..005:read+write (168, +10); School Admin / Platform Admin pick up the admin tier via everyFunction (495 each, +15).

### Step 5 — ROPA + Retention + DPIA NestJS module

- `apps/api/src/governance/` opens with **3 services**: RopaService (processing activities + retention policies CRUD with DPIA gap tagging + retention review-due flag computation), DpiaService (DPIA lifecycle SCOPING → IN_PROGRESS → COMPLETED → APPROVED/REJECTED with terminal-status guards).
- DPO scope = School Admin OR holds `dpo-001:write`. Tightened in Step 7 below for SAR + erasure surfaces to also require `personType=STAFF` so parents holding `dpo-004:write` for self-service can't bypass.

### Step 6 — Processors + Breach NestJS module + 72-hour countdown keystone

- ProcessorService (processors + DPAs CRUD; DPA gap tagging on `dpa_in_place=false` OR `dpa.status=EXPIRED`; create-DPA path back-links the processor + flips `dpa_in_place=true` atomically inside the same tx; status flips on the DPA cascade-update the processor's `dpa_in_place` flag).
- **BreachService — THE 72-HOUR COUNTDOWN KEYSTONE.** `create()` runs in `executeInTenantTransaction`; on commit, when `supervisoryAuthorityNotificationRequired=true`, emits `dpo.breach.discovered` with payload `{breachId, schoolId, breachTitle, breachType, discoveryDate, notificationDeadline = discovery + 72h, riskLevel, riskToIndividuals, estimatedAffectedIndividuals, reportedByAccountId, sourceRefId}`. The Cycle 7 TaskWorker subscribes to this topic and creates an URGENT 72-hour escalating task — the `dpo_compliance_dashboard_config.breach_escalation_hours=70` default gives a 2-hour buffer before the regulatory deadline. Wire envelope captured live on `dev.dpo.breach.discovered` 2026-05-07.
- `notifySupervisoryAuthority()`/`notifyDataSubjects()` flip the corresponding timestamp + (for SA) auto-promote status UNDER_INVESTIGATION → NOTIFIED. `resolve()` flips to RESOLVED + stamps `is_resolved=true` + `resolved_at` atomically in lockstep with the multi-column `resolved_chk`.

### Step 7 — SARs + Erasure + Consent + Privacy NestJS module

- **SarService — AGE-18 RIGHTS TRANSFER KEYSTONE.** Three personas can submit a SAR: (a) DPO-internal callers (school admin OR STAFF + dpo-004:write) on anyone's behalf; (b) GUARDIAN actors via `assertGuardianLink(actor, dataSubjectId)` joining sis_student_guardians + sis_guardians; (c) STUDENT actor for own data (matched on `actor.personId === input.dataSubjectId`). **Age-18 keystone** — when `platform_students.data_subject_is_self=true`, the GUARDIAN path is refused with `"This student is the data subject for their own data (age 18+). Only the student or a DPO administrator can submit a SAR for their data."` Read row scope: DPO-internal sees all; GUARDIAN sees own-submitted + own-children's via the same guardian-link join; STUDENT sees own; nobody else.
- **ErasureService — AUDIT LOG PSEUDONYMISATION KEYSTONE.** `pseudonymiseAuditLog(actor, erasureId, {targetTable, targetField})` runs cross-schema: rewrites `platform.platform_audit_log.metadata` JSONB for rows where `actor_id = data_subject_id OR (entity_type='iam_person' AND entity_id=data_subject_id)`, replacing the metadata with `{"pseudonymised": "<token>"}` where token is `psd_<16-hex>`. Then INSERTs one row into `dpo_pseudonymisation_log` with `(target_table, target_field, rows_pseudonymised, pseudonymisation_token, pseudonymised_by)`. The pseudonymisation log is **IMMUTABLE per ADR-010** — no UPDATE / no DELETE methods exposed at the service layer.
- ConsentService (record + withdraw consent; the schema's UNIQUE keys allow multiple records per (subject, processing activity) so withdrawal events are append-only); PrivacyNoticeService (publish flips `superseded_at` on every prior published notice for the school in one tx so the "current notice" query returns exactly one row); ComplianceConfigService (auto-creates default row on first read; admin-only update bounded 1..72 hours on breach escalation).

**Cycle 30 endpoint count: 49** under `dpo-001:read/write/admin` through `dpo-005:read/write/admin`. **1 Kafka emit topic**: `dpo.breach.discovered`. Module imports TenantModule + IamModule + KafkaModule and lives between AnalyticsModule and the global guards.

### Step 8 — DPO UI: dashboard + ROPA + processors

- New `Data Governance` launchpad tile gated on `dpo-001:read` (intentionally not surfaced to parents — they reach SAR self-service via the future parent portal route, not the full Governance tile). New `ShieldIcon` (Heroicons shield-check).
- `apps/web/src/lib/governance-format.ts` ships per-status pill maps for SAR/erasure/breach/DPIA/DPA + `formatBreachCountdown(hoursRemaining)` returning `{label, tone}` colour-coded across green (>36h) / amber (12-36h) / red (≤12h or overdue).
- `apps/web/src/hooks/use-governance.ts` ships **20 React Query hooks** + 9 mutations covering every endpoint of Steps 5–7.
- 5 routes: `/governance` (dashboard with 8-stat header + 72-hour breach countdown panel + overdue SARs panel + module nav chips), `/governance/processing-activities` (ROPA list with DPIA gap chip filter + per-row status pills), `/governance/processing-activities/[id]` (activity detail with inlined linked DPIA card), `/governance/retention` (retention policies with review-due chip filter), `/governance/processors` (processor register with DPA gap chip filter + transfer mechanism column).

### Step 9 — DPO UI: breach + SARs + erasure + consent + privacy

- 6 routes: `/governance/breaches` (register with pending-notification chip filter + per-row 72h countdown badge colour-coded + risk pill + status pill), `/governance/breaches/[id]` (detail with structured sections + admin Notify-supervisory-authority Modal capturing reference number + Mark-resolved button with confirm), `/governance/sars` (queue with 6 status filter chips + days-until-deadline column with overdue-row tinting), `/governance/erasures` (request list with categories chip triplet + admin **Pseudonymise audit log button** opening confirm + IMMUTABLE pseudonymisation log table below), `/governance/consents` (consent ledger with active-only chip filter + state pills), `/governance/privacy-notices` (version timeline with Current pill + supersession dates).

**Cycle 30 web surface: 11 routes** (5 in Step 8 + 6 in Step 9).

### Step 10 — Vertical Slice Integration Test

`docs/cycle30-cat-script.md` ships the reproducible end-to-end walkthrough. 10-check schema preamble + 10 plan scenarios verified live on `tenant_demo` 2026-05-07:

- S1 6 permission denial paths (teacher /dashboard 403, student /processors 403, parent /breaches 403, parent /erasures 403, principal /dashboard 200, parent /sars 200 row-scoped to own).
- S2 SAR row scope (parent David Chen sees 1 SAR for Maya, principal sees 1 across the school).
- S3 dashboard rollup all 15 stats match expected post-seed shape.
- S4 ROPA gap query returns 1 row (AI Tutor without DPIA).
- S5 processor DPA gap query returns 2 rows (OpenAI no DPA + Google expired).
- S6 seeded breach 72-hour countdown read returns 18h-since/53h-remaining.
- **S7 KEYSTONE** breach create + `dpo.breach.discovered` envelope captured live with `notificationDeadline = discovery + 72h` + `source_module=governance` + full ADR-057 envelope shape.
- S8 supervisory authority notification flips status UNDER_INVESTIGATION → NOTIFIED + reference recorded.
- S9 parent self-service SAR submission (parent → Maya for PORTABILITY succeeds; bogus dataSubjectId rejected with friendly guardian-link gate message).
- **S10 PSEUDONYMISATION KEYSTONE** writes IMMUTABLE log row with opaque token `psd_<16hex>`.

**Cycle 30 ships clean to peer review. Wave 7 (Analytics & Governance) closes here.**
