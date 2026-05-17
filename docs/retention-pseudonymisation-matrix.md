# Retention & Pseudonymisation Matrix

**Production-launch prerequisite.** Defines per-record-class retention
periods, lawful basis, and pseudonymisation rules for every personal-data
table across CampusOS.

P2-H4 Step 4 deliverable. Closes Plan IMP-09 and GPT COMP-01 audit
findings. Pairs with `dpo_pseudonymisation_log` workflow (Cycle 30).

## How to use this document

Each entry has:

- **Record class** — the data category, not a single table.
- **Tables** — concrete tenant tables (and platform tables where relevant).
- **Retention** — minimum + maximum, with legal driver.
- **Legal basis** (GDPR / UK GDPR Article 6/9): consent / contract /
  legal obligation / safeguarding / public task.
- **Pseudonymisation action** at retention end: pseudonymise (replace
  PII refs with token, keep aggregates) vs delete (hard-delete row).
- **Trigger** — what event or worker drives the action.

## Matrix

### Operational + Academic

| Record class                      | Tables                                                                                                                     | Retention                                                                         | Legal basis                    | Action at end                                                                                          | Trigger                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Student academic records          | `sis_students`, `sis_enrollments`, `cls_grades`, `cls_submissions`, `cls_assignments`, `sis_transcripts`, `pfl_portfolios` | 7 years post-graduation (FERPA + UK Equality Act)                                 | Legal obligation, public task  | Pseudonymise (replace `iam_person` refs with token; keep grades, assignment titles, transcript values) | Cycle 30 DPO sweep on `sis_students.graduated_at + 7 years` |
| Attendance records                | `sis_attendance_records`, `sis_attendance_evidence`, `sis_absence_requests`                                                | 7 years per partition; 3 years for evidence S3 objects                            | Legal obligation               | Pseudonymise (keep day-level rollups, drop per-event PII; delete evidence S3 keys)                     | Annual partition retention worker                           |
| Discipline incidents              | `sis_discipline_incidents`, `sis_discipline_actions`, `sis_discipline_incident_activity`                                   | 7 years (UK record retention guidance) or until student turns 25, whichever later | Legal obligation, safeguarding | Pseudonymise (`reported_by`, `reviewed_by`, narrative redacted; categorical fields kept)               | Cycle 30 DPO sweep                                          |
| Behaviour intervention plans      | `svc_behavior_plans`, `svc_behavior_plan_goals`, `svc_bip_teacher_feedback`                                                | 7 years post-graduation or until student turns 25, whichever later                | Legal obligation               | Pseudonymise                                                                                           | Cycle 30 DPO sweep                                          |
| Class participation, lesson plans | `cls_lessons`, `cls_lesson_attachments`, `cls_assignment_questions`, `cls_answer_key_entries`                              | 5 years                                                                           | Legitimate interest            | Hard-delete                                                                                            | Annual ops job                                              |

### Health + Safety

| Record class                                                         | Tables                                            | Retention                                                                                     | Legal basis                       | Action at end                                                                                     | Trigger                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Health records (medical conditions, immunisations, IEP, medications) | `hlth_*`                                          | 25 years (NHS / state-K-12 health record guidance)                                            | Legal obligation                  | Pseudonymise (`hr_employees` refs only; keep clinical data intact for medical-history continuity) | Cycle 30 DPO sweep on `sis_students.graduated_at + 25 years` |
| Nurse visit logs                                                     | `hlth_nurse_visits`                               | 7 years                                                                                       | Legal obligation                  | Hard-delete unless linked to a current `hlth_iep_plans` row                                       | Annual ops job                                               |
| Mandatory reports (CPS filings)                                      | `svc_mandatory_reports`                           | 25 years (US: 18-year-old + 7 years; UK: until subject turns 25)                              | Legal obligation                  | Pseudonymise (`reporter_person_id` redacted; report narrative kept)                               | Cycle 30 DPO sweep                                           |
| Wellbeing check-in responses                                         | `svc_wellbeing_responses`, `svc_wellbeing_alerts` | 3 years (clinical record retention proportional to wellbeing intent)                          | Consent + safeguarding            | Hard-delete responses; pseudonymise alerts (`subject_id` redacted; alert_type + outcome kept)     | Annual ops job                                               |
| Coordinated care notes                                               | `svc_coordinated_care_notes`                      | 7 years post-graduation                                                                       | Legal obligation                  | Pseudonymise                                                                                      | Cycle 30 DPO sweep                                           |
| Visitor sign-in log                                                  | `vis_sign_ins`, `vis_visitors`                    | 1 year (visitor names + DOB); 30 days (banned-person matches that did not result in incident) | Legitimate interest, safeguarding | Hard-delete                                                                                       | Quarterly ops job                                            |
| Visitor banned-persons                                               | `vis_banned_persons`                              | Indefinite while `is_active = true`. Court-order S3 keys: per court order, default 7 years    | Safeguarding, legal obligation    | Hard-delete row + S3 key when deactivated                                                         | Manual admin                                                 |

### Financial

| Record class                         | Tables                                                                                                           | Retention                                       | Legal basis                       | Action at end                                                                                                                                                                          | Trigger                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| GL entries (the ledger)              | `fin_gl_entries`                                                                                                 | 7 years post-fiscal-year (HMRC / IRS retention) | Legal obligation (tax + contract) | Pseudonymise (`reference_id` ↦ `iam_person` refs replaced with token via `dpo_pseudonymisation_log`; financial fields, amounts, accounts, dates all kept; foreign-key shape preserved) | Cycle 30 DPO sweep against the fiscal-year cutoff |
| Invoices + payments + refunds        | `pay_invoices`, `pay_payments`, `pay_refunds`, `pay_credit_notes`, `pay_payment_reversals`, `pay_ledger_entries` | 7 years post-fiscal-year                        | Legal obligation                  | Pseudonymise (`account_holder_id`, `created_by` redacted; amount + status preserved)                                                                                                   | Cycle 30 DPO sweep                                |
| Payment plans + instalments          | `pay_payment_plans`, `pay_payment_plan_installments`                                                             | 7 years post-close                              | Legal obligation                  | Pseudonymise                                                                                                                                                                           | Cycle 30 DPO sweep                                |
| Lunch account balance + transactions | `pay_lunch_accounts`, `pay_lunch_account_transactions`, `pay_lunch_account_balance_transfers`                    | 7 years post-graduation                         | Legal obligation                  | Pseudonymise                                                                                                                                                                           | Cycle 30 DPO sweep                                |
| Procurement vouchers + receipts      | `prc_purchase_orders`, `prc_goods_receipts`, `prc_returns`                                                       | 7 years post-fiscal-year                        | Legal obligation                  | Pseudonymise (`requested_by`, `received_by` redacted)                                                                                                                                  | Cycle 30 DPO sweep                                |
| Budget commitments + transfers       | `fin_budgets`, `fin_budget_lines`, `prc_budget_commitments`, `fin_budget_transfers`, `fin_journal_batches`       | 7 years post-fiscal-year                        | Legal obligation                  | Pseudonymise                                                                                                                                                                           | Cycle 30 DPO sweep                                |
| Reconciliation runs                  | `rpt_gl_reconciliation`                                                                                          | 2 years                                         | Legitimate interest               | Hard-delete                                                                                                                                                                            | Annual ops job                                    |

### Counselling + Safeguarding

| Record class                                   | Tables                                                                | Retention                                                          | Legal basis                    | Action at end                                                                                                       | Trigger            |
| ---------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Counselling sessions + notes (FERPA-protected) | `svc_sessions`, `svc_session_notes`, `svc_session_participants`       | 7 years post-graduation or until subject turns 25, whichever later | Legal obligation, safeguarding | Pseudonymise (`counselor_id`, `student_id`, note text redacted; categorical fields preserved for outcome analytics) | Cycle 30 DPO sweep |
| Caseload + referral history                    | `svc_caseloads`, `svc_referrals`, `svc_referral_activity` (IMMUTABLE) | 7 years post-graduation                                            | Legal obligation               | Pseudonymise (audit chain preserved; PII redacted)                                                                  | Cycle 30 DPO sweep |
| MTSS interventions + progress                  | `svc_mtss_tiers`, `svc_interventions`, `svc_intervention_progress`    | 7 years post-graduation                                            | Legal obligation               | Pseudonymise                                                                                                        | Cycle 30 DPO sweep |

### HR + Workforce

| Record class                           | Tables                                                           | Retention                                                                                             | Legal basis                           | Action at end                                                                         | Trigger                                                      |
| -------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Employee profile, position assignments | `hr_employees`, `hr_employee_positions`, `hr_emergency_contacts` | 7 years post-termination                                                                              | Legal obligation, contract            | Pseudonymise (DOB + emergency contact PII redacted; position history kept anonymised) | Cycle 30 DPO sweep on `hr_employees.terminated_at + 7 years` |
| Employee documents                     | `hr_employee_documents` (S3-backed)                              | 7 years post-termination; verification docs (DBS, work auth) per legal cycle                          | Legal obligation                      | Hard-delete S3 objects; metadata row pseudonymised + retained                         | Cycle 30 DPO sweep                                           |
| Payroll records                        | `hr_payroll_records`, `hr_payroll_deductions`                    | 7 years post-fiscal-year                                                                              | Legal obligation (tax)                | Pseudonymise                                                                          | Cycle 30 DPO sweep                                           |
| Leave + absence requests               | `hr_leave_requests`, `hr_leave_balances`                         | 7 years post-termination                                                                              | Legal obligation                      | Pseudonymise                                                                          | Cycle 30 DPO sweep                                           |
| Performance reviews + appraisals       | `hr_appraisals`, `hr_lesson_observations`                        | 7 years post-termination                                                                              | Legal obligation, legitimate interest | Pseudonymise                                                                          | Cycle 30 DPO sweep                                           |
| Recruitment + applications             | `hr_job_postings`, `hr_applications`, `hr_offers`                | 1 year for rejected applicants; 7 years post-termination for accepted (rolls into employee retention) | Legitimate interest, contract         | Rejected: hard-delete. Accepted: pseudonymise.                                        | Cycle 30 DPO sweep                                           |

### Audit + Logs

| Record class                            | Tables                                         | Retention                                                                                                  | Legal basis              | Action at end                                                                                                                                                                   | Trigger                    |
| --------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Platform audit log                      | `platform.platform_audit_log`                  | 7 years (matches financial); 25 years for safety-critical events flagged in `metadata.severity = 'safety'` | Legal obligation         | Pseudonymise (`actor_id`, `data_subject_id` redacted; `entity_type`, `action`, `action_category`, timestamp preserved). P2-H2 added the cross-module pseudonymisation pipeline. | Cycle 30 DPO sweep         |
| Health access log                       | `hlth_health_access_log` (IMMUTABLE)           | 25 years (matches health record retention)                                                                 | Legal obligation         | Pseudonymise (`accessor_account_id`, `student_id` redacted)                                                                                                                     | Cycle 30 DPO sweep         |
| Ticket activity (IMMUTABLE)             | `tkt_ticket_activity`                          | 3 years post-ticket-close                                                                                  | Legitimate interest      | Hard-delete                                                                                                                                                                     | Annual ops job             |
| Behaviour referral activity (IMMUTABLE) | `svc_referral_activity`                        | 7 years post-graduation                                                                                    | Legal obligation         | Pseudonymise                                                                                                                                                                    | Cycle 30 DPO sweep         |
| Incident timeline (IMMUTABLE)           | `inc_incident_timeline`                        | 25 years                                                                                                   | Legal obligation, safety | Pseudonymise                                                                                                                                                                    | Cycle 30 DPO sweep         |
| Kafka outbox                            | `platform.platform_outbox`                     | 30 days post-`published_at` (successful rows); kept indefinitely if `failed_at IS NOT NULL`                | Legitimate interest      | Hard-delete                                                                                                                                                                     | Daily ops job              |
| Kafka DLQ                               | `platform.platform_dlq_messages`               | 90 days post-`resolved_at`; indefinite while unresolved                                                    | Legitimate interest      | Hard-delete                                                                                                                                                                     | Daily ops job              |
| Idempotency claims                      | `platform.platform_event_consumer_idempotency` | 7 days                                                                                                     | n/a (operational)        | Hard-delete                                                                                                                                                                     | Daily ops job              |
| Notification queue                      | `msg_notification_queue` (SENT)                | 30 days                                                                                                    | Legitimate interest      | Hard-delete                                                                                                                                                                     | Daily ops job              |
| Notification log                        | `msg_notification_log`                         | 1 year per partition                                                                                       | Legitimate interest      | Hard-delete partition                                                                                                                                                           | Monthly partition rotation |
| Trace / telemetry / structured logs     | exported to Loki / equivalent                  | 30 days hot / 1 year cold / 7 years archive (financial events only)                                        | Legitimate interest      | External; SRE owns                                                                                                                                                              | n/a                        |

### Identity + Governance

| Record class                        | Tables                                                                           | Retention                                                                                                                                                          | Legal basis                | Action at end                                                                                                             | Trigger            |
| ----------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| iam_person (the canonical identity) | `platform.iam_person`                                                            | Indefinite while any projection (sis_students, sis_guardians, hr_employees, alumni) is active; 25 years after the last projection is hard-deleted or pseudonymised | Contract, legal obligation | Pseudonymise (first/last name, DOB, all phone/email columns redacted; `id` preserved as opaque token for back-references) | Cycle 30 DPO sweep |
| Platform users (auth identity)      | `platform.platform_users`                                                        | Linked to `iam_person`. On opt-out or termination: account_status flipped to TERMINATED; row preserved for audit.                                                  | Contract                   | Pseudonymise after `iam_person` pseudonymisation                                                                          | Cycle 30 DPO sweep |
| Family households                   | `platform.platform_families`, `platform.platform_family_members`                 | Indefinite while any member is active; 7 years after last member departure                                                                                         | Contract                   | Pseudonymise (address, phone redacted)                                                                                    | Cycle 30 DPO sweep |
| DPO request log                     | `dpo_subject_access_requests`, `dpo_erasure_requests`, `dpo_data_breach_records` | 7 years from request close                                                                                                                                         | Legal obligation           | Hard-delete                                                                                                               | Annual ops job     |
| Pseudonymisation log (IMMUTABLE)    | `dpo_pseudonymisation_log`                                                       | 25 years (the audit chain)                                                                                                                                         | Legal obligation           | Pseudonymise (`pseudonymised_by` redacted; token + counts retained)                                                       | Cycle 30 DPO sweep |
| Consent records                     | `dpo_consent_records`                                                            | 7 years post-revocation                                                                                                                                            | Legal obligation           | Pseudonymise                                                                                                              | Cycle 30 DPO sweep |
| Privacy notices (published)         | `dpo_privacy_notices`                                                            | Indefinite (the published-version audit chain)                                                                                                                     | Legal obligation           | None                                                                                                                      | n/a                |

## Pseudonymisation Mechanism

Per ADR-052, pseudonymisation is **token replacement at the column
level**, not row deletion. The reference shape is preserved so:

- `fin_gl_entries.reference_id` still points at a row that exists.
- `platform.platform_audit_log.actor_id` still has a valid UUID — but
  the UUID no longer resolves to a real `iam_person` row because the
  parent row has had its PII columns redacted.
- Aggregates (counts, sums, averages) continue to work; cohort analytics
  remain possible.

The token is opaque (random UUID v7 prefixed with `psd_`) and is logged
to `dpo_pseudonymisation_log` so the audit chain has the before / after
mapping at a single source. The mapping itself is **not** stored in
production tables — the token is one-way.

The worker that executes pseudonymisation lives in `dpo_pseudonymisation_log`
write path on `ErasureService.pseudonymiseAuditLog` (Cycle 30 keystone)
and the corresponding per-domain pseudonymisers that Phase 3 ops will
expand to cover each row class in this matrix.

## Implementation Status

As of P2-H4:

- The schema columns and the `dpo_pseudonymisation_log` table exist.
- `ErasureService.pseudonymiseAuditLog` (Cycle 30) is the only
  pseudonymisation pipeline wired today; covers `platform_audit_log`.
- Per-domain pseudonymisers for every row class above are Phase 3
  ops work; one per record class (academic / health / financial /
  HR / counselling) plus the cross-cutting log pipeline.
- Annual partition retention drops for `sis_attendance_records`,
  `msg_notification_log`, `msg_moderation_log`, `pay_ledger_entries`,
  `evt_ticket_scans`, `trn_vehicle_positions`, `trn_geofence_events`,
  `platform.platform_audit_log` are Phase 3 ops work.

## Audit + Review

This matrix is reviewed annually by the DPO and aligned with the
published privacy notice. Any change to retention duration requires:

- DPO sign-off.
- Legal review.
- Update to the privacy notice and re-consent if necessary.
- Update to `dpo_processing_activities` lawful basis if changed.

## Cross-references

- `docs/ai-data-policy.md` — AI provider data flow and opt-out matrix.
- `docs/migration-orchestration.md` — schema evolution + retention worker
  scheduling.
- ADR-052 — Pseudonymisation strategy.
- ADR-040 — Health record KMS isolation.
- Cycle 30 — DPO compliance suite implementation.
