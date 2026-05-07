# REVIEW-CYCLE30-CHATGPT

**Cycle:** 30 — Data Governance & Compliance (M120 DPO Compliance Suite, Wave 7 close).
**Round 1 commit:** `cycle30-complete` at `cc55a81`.
**Round 1 verdict:** _pending peer review_.
**Live verification reference:** `tenant_demo` 2026-05-07.

---

## Reviewer brief

Cycle 30 ships the regulatory compliance backbone that makes CampusOS pilot-ready under GDPR, UK GDPR, FERPA, and COPPA simultaneously. **Wave 7 (Analytics & Governance) closes here.**

The cycle's six structural keystones, in priority order:

1. **72-HOUR BREACH NOTIFICATION COUNTDOWN.** `BreachService.create` emits `dpo.breach.discovered` AFTER tx commits when `supervisoryAuthorityNotificationRequired=true`. Cycle 7 TaskWorker creates an URGENT 72-hour escalating task. **A missed window is a regulatory violation** — this is the highest-urgency automated escalation in CampusOS. Verify the envelope shape on `dev.dpo.breach.discovered` matches ADR-057, with `notificationDeadline = discovery + 72h` and the Cycle 7 TaskWorker contract honoured (default `breach_escalation_hours=70` gives a 2-hour buffer before the regulatory deadline).
2. **DPIA + DPA gap detection.** Two schema-level partial INDEXes back the dashboard gap rules. Verify the partial INDEX predicates match the ROPA / processor list filter queries.
3. **30/45-day SAR deadline tracking.** `dpo_subject_access_requests.deadline_date` computed from config; multi-column `completed_chk` keeps `completed_at` in lockstep with status. Verify the OVERDUE state is enforced at the schema layer.
4. **AUDIT LOG FIELD-LEVEL PSEUDONYMISATION.** `ErasureService.pseudonymiseAuditLog` runs cross-schema — rewrites `platform.platform_audit_log.metadata` JSONB and writes one row per `(target_table, target_field)` to the IMMUTABLE `dpo_pseudonymisation_log`. **The first surface in CampusOS that mutates `platform.platform_audit_log` from a tenant-scoped service.** Verify the cross-schema mutation discipline.
5. **AGE-18 RIGHTS TRANSFER.** `SarService` refuses GUARDIAN-submitted requests when `platform_students.data_subject_is_self=true`. Verify the refusal message + that pre-existing parent-submitted SARs continue to process per their original deadline.
6. **IMMUTABLE pseudonymisation log.** `dpo_pseudonymisation_log` is append-only at the service layer (no UPDATE / no DELETE methods exposed). NO ACTION FK to `dpo_erasure_requests` so the audit chain survives erasure deletion.

**Note on parent erasure scope (defence-in-depth):** Parent holds `dpo-004:write` for SAR self-service, but `ErasureService.hasDpoScope` and `SarService.hasDpoScope` (mutation path) tighten to **also require `personType === 'STAFF'`** so parents can't read the erasure register or mutate any SAR's status. The mutation path `SarService.hasDpoScope` is separate from the create path, where the GUARDIAN row scope at submission is the actual gate.

---

## Verification surface

### Schema (12 dpo\_\* base tables across 3 migrations)

```
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='tenant_demo' AND table_name LIKE 'dpo_%'"
# Expect: 12
```

| Migration                     | Tables                                                                                                                                                            | FKs                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 098_dpo_ropa.sql              | dpo_processing_activities, dpo_retention_policies, dpo_dpias                                                                                                      | 0 DB-enforced (soft circular)      |
| 099_dpo_processors_breach.sql | dpo_third_party_processors, dpo_data_processing_agreements, dpo_data_breach_records                                                                               | 1 CASCADE (DPA → processor)        |
| 100_dpo_sars_erasure.sql      | dpo_subject_access_requests, dpo_erasure_requests, dpo_processing_consent_records, dpo_privacy_notices, dpo_pseudonymisation_log, dpo_compliance_dashboard_config | 1 NO ACTION (pseudo log → erasure) |

**0 cross-schema FKs.** Tenant base table count: 371 → **383**.

### Backend module

`apps/api/src/governance/`:

- `governance.module.ts` — wires 10 services + 1 controller; imports TenantModule + IamModule + KafkaModule
- `ropa.service.ts` — RopaService (processing activities + retention policies)
- `dpia.service.ts` — DpiaService (lifecycle SCOPING → IN_PROGRESS → COMPLETED → APPROVED/REJECTED with terminal-status guards)
- `processors.service.ts` — ProcessorService (processors + DPAs; create-DPA backlinks processor + flips dpa_in_place=true atomically; status flips on DPA cascade-update the processor's flag)
- `breach.service.ts` — **BreachService — 72-HOUR COUNTDOWN KEYSTONE**
- `sar.service.ts` — **SarService — AGE-18 RIGHTS TRANSFER KEYSTONE** (three-persona row scope)
- `erasure.service.ts` — ErasureService + ConsentService + PrivacyNoticeService + ComplianceConfigService (4 services; ErasureService is the **AUDIT LOG PSEUDONYMISATION KEYSTONE**)
- `governance.controller.ts` — 49 endpoints under dpo-001..005:read/write/admin
- 1 Kafka emit: `dpo.breach.discovered`

### Web surface

11 routes under `/governance/*`:

- `/governance` — compliance command-centre (8-stat header + breach countdown panel + overdue SARs panel)
- `/governance/processing-activities` + `/[id]` — ROPA list + activity detail with linked DPIA card
- `/governance/retention` — retention policies with review-due chip
- `/governance/processors` — processor register with DPA gap chip
- `/governance/breaches` + `/[id]` — breach register with 72h countdown badges + admin Notify-SA Modal
- `/governance/sars` — SAR queue with overdue tinting
- `/governance/erasures` — erasure list with Pseudonymise audit log button + IMMUTABLE log table
- `/governance/consents` — consent ledger
- `/governance/privacy-notices` — version timeline

New tile: `Data Governance` gated on `dpo-001:read`, ShieldIcon.

### IAM

Catalogue 480 → 495 permissions (5 new DPO codes × 3 tiers).

| Persona | DPO grants                            | Total perms |
| ------- | ------------------------------------- | ----------- |
| Admin   | DPO-001..005 read+write+admin         | 495 (+15)   |
| Parent  | DPO-004:read+write (SAR self-service) | 47 (+2)     |
| Student | DPO-004:read+write                    | 52 (+2)     |
| Staff   | DPO-001..005:read+write               | 168 (+10)   |
| Teacher | (none)                                | unchanged   |

### Live verification on `tenant_demo` 2026-05-07

The Step 10 CAT script at `docs/cycle30-cat-script.md` walks 10 plan scenarios end-to-end. All 10 pass:

- S1 6 permission denial paths (teacher /dashboard 403, student /processors 403, parent /breaches 403, parent /erasures 403, principal /dashboard 200, parent /sars 200 row-scoped)
- S2 SAR row scope (parent David Chen sees 1 SAR for Maya, principal sees 1 across the school)
- S3 dashboard rollup all 15 stats match expected post-seed shape
- S4 ROPA gap query returns 1 (AI Tutor without DPIA)
- S5 processor DPA gap query returns 2 (OpenAI no DPA + Google expired)
- S6 seeded breach 72-hour countdown computes correctly (53h remaining for 18h-elapsed)
- **S7 KEYSTONE** breach create + `dpo.breach.discovered` envelope captured live with `notificationDeadline = discovery + 72h`
- S8 SA notification flips status UNDER_INVESTIGATION → NOTIFIED + reference recorded
- S9 parent self-service SAR submission (parent → Maya for PORTABILITY succeeds; bogus dataSubjectId rejected with friendly guardian-link gate message)
- **S10 KEYSTONE** audit log pseudonymisation writes IMMUTABLE log row with opaque token `psd_<16hex>`

### Phase 2 punch list (carry-over)

7 reviewer-attention items already documented in HANDOFF-CYCLE30.md:

1. DPO role split from generic Staff to ORGANISATION-scoped role per ADR-052
2. Audit log pseudonymisation generalisation beyond `platform_audit_log.metadata`
3. Age-18 transfer scheduled cron to flip `data_subject_is_self`
4. DPIA + DPA review reminder workers
5. Privacy notice consent re-acceptance flow
6. Cross-school SAR aggregation for org-scoped operators
7. `dpo.breach.discovered` outbox migration (highest-priority emit in CampusOS)

---

## What I'd particularly like reviewed

1. **Cross-schema mutation discipline.** `ErasureService.pseudonymiseAuditLog` writes to `platform.platform_audit_log` from a tenant-scoped service. Is the WHERE clause on the platform-side UPDATE tight enough? Are there other identifier paths in the metadata JSONB that should be pseudonymised but aren't?
2. **Age-18 keystone correctness.** Is the GUARDIAN refusal message + path the right place to enforce the rights transfer? Should there be a back-fill for pre-existing parent-submitted SARs that pass the deadline after the flip?
3. **Pseudonymisation log immutability.** No UPDATE / no DELETE methods are exposed at the service layer. The `dpo_pseudonymisation_log_erasure_request_id_fkey` is `NO ACTION`. Is there any path through Prisma + the controller that could override the immutability invariant?
4. **Parent + student dpo-004:write tightening.** Parent has dpo-004:write for SAR self-service but the SAR mutation path + the entire erasure surface tighten to require `personType=STAFF`. Is this two-tier check the right pattern, or should `dpo-004:write` be split into `dpo-004:write` (DPO mutate) + a new `dpo-004:submit` (data subject self-service)?
5. **Breach 72h countdown contract.** The `notificationDeadline` is computed as `discovery + 72h` and the Step 4 seed config sets `breach_escalation_hours=70` for a 2-hour buffer. Is the buffer wired correctly into the Cycle 7 auto-task rule? (The task rule exists in the seed but reviewer should verify the rule fires the URGENT task at the right timestamp.)
6. **DPIA gap rule parity.** The partial INDEX `dpo_pa_high_risk_no_dpia_idx` predicate matches the ROPA list query in the service. Are both sides identical so the DB planner uses the index?

---

## Round 1 — pending

Reviewer to fill in the triage table once the round 1 verdict is in.
