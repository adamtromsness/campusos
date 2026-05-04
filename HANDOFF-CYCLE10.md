# Cycle 10 Handoff — Health & Wellness

**Status:** Cycle 10 **IN PROGRESS** — Steps 1 + 2 of 10 done. Cycle 10 is the **second cycle of Wave 2 (Student Services)** and ships the M23 Health module — 14 of the 17 ERD tables (3 telehealth tables deferred). Plus the immutable HIPAA access log brings the total to 15 new tenant base tables. Cycle 10 is the **most access-restricted module in the system**: the `hlth_*` tables are flagged in the ERD for a separate HIPAA-compliant KMS key. For the dev / demo phase the tables ship without field-level encryption but the access control layer is strict from day one — every read endpoint is gated by a dedicated `health_record:read` permission AND writes a row to `hlth_health_access_log` before the response body leaves the server.

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle10-implementation-plan.html`
**Vertical-slice deliverable:** Nurse creates Maya's health record (blood type A+, peanut allergy SEVERE) → adds asthma condition (MODERATE, ACTIVE, with management plan) → records 3 immunisations (2 CURRENT, 1 OVERDUE) → sets up albuterol inhaler with morning schedule slot → logs today's administration → logs a wheezing-episode nurse visit (treatment given, parent notified, not sent home) → creates a 504 plan with EXTENDED*TIME accommodation → `iep.accommodation.updated` fires → SIS consumer upserts `sis_student_active_accommodations` (ADR-030) → teacher sees the accommodation on Maya's classroom profile without ever touching `hlth*\*` → nurse runs a vision screening with REFER result → dietary profile created with peanut allergen + POS alert flag → parent sees Maya's health summary with immunisation compliance and medication schedule (PII-stripped: no IEP details, no admin notes, no medication administration log).

This document tracks the Cycle 10 build at the same level of detail as `HANDOFF-CYCLE1.md` through `HANDOFF-CYCLE9.md`. It is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                                       | Status   |
| ---- | ----------------------------------------------------------- | -------- |
| 1    | Health Records Schema — Records, Conditions, Immunisations  | **DONE** |
| 2    | Medication Schema — Meds, Schedule, Administration          | **DONE** |
| 3    | IEP/504 + Nurse + Screening + Dietary Schema                | TODO     |
| 4    | Seed Data — Maya's Health Record + IEP + Sample Visits      | TODO     |
| 5    | Health Records NestJS Module — Records + Conditions + Imms  | TODO     |
| 6    | Medication NestJS Module — Meds + Schedule + Administration | TODO     |
| 7    | IEP/504 + Nurse + Screening + Dietary NestJS Modules        | TODO     |
| 8    | Health UI — Nurse Dashboard + Student Health Record         | TODO     |
| 9    | Health UI — IEP Editor + Screening + Parent View            | TODO     |
| 10   | Vertical Slice Integration Test                             | TODO     |

---

## What this cycle adds on top of Cycles 0–9

Cycle 10 is the second cross-cutting cycle of Wave 2. It introduces the highest-sensitivity data domain in the platform: a student's medical record, IEP/504 plan, medication administration log, nurse visits, screening results, and dietary profile. The access control posture is intentionally stricter than every prior cycle.

- **Health Records (M23, 14 tables in scope).** The full medical-record lifecycle from health record (one per student, UNIQUE on student_id) through conditions, immunisations, medications with administration logging, nurse visits with live office roster, IEP/504 plans with goals + services + accommodations, screenings, and dietary profiles. Permission codes **HLT-001** through **HLT-005** gate reads + writes — these were already in `permissions.json` waiting for Cycle 10.
- **HIPAA access log.** Every health read endpoint writes an immutable `hlth_health_access_log` row before returning data. The 9-value `access_type` enum covers every per-domain read shape (VIEW_RECORD / VIEW_CONDITIONS / VIEW_IMMUNISATIONS / VIEW_MEDICATIONS / VIEW_VISITS / VIEW_IEP / VIEW_SCREENING / VIEW_DIETARY / EXPORT). The Step 5 `HealthAccessLogService.recordAccess` helper is the only writer and is called by every Step 5–7 service that reads health data.
- **IEP accommodation read model (ADR-030).** Teachers do not read `hlth_*` tables. They read the existing `sis_student_active_accommodations` table populated by the Step 7 `IepAccommodationConsumer` Kafka consumer. When `IepPlanService` mutates accommodations it emits `iep.accommodation.updated` with the full accommodation set; the consumer upserts the read model. This is the keystone integration with Wave 1 — the Cycle 1 student profile already renders accommodations from this table; Cycle 10 finally populates it from the source of truth.
- **Wave 1 + 2 integrations.** Cycle 4 HR provides `hr_employees(id)` for medication-administered-by, IEP case manager, nurse, and screening-by refs. Cycle 1 SIS provides `sis_students(id)` for the master student id used by every health table. Cycle 3 Notifications gets a future surface (parent notification on medication administered + nurse visit sent-home). Cycle 5 Scheduling provides the timetable that the IEP accommodation read model joins through.
- **Telehealth deferred (3 tables).** `hlth_telehealth_providers`, `hlth_telehealth_sessions`, `hlth_telehealth_documents` require video platform integration + the future `platform_signature_requests` table. Out of scope this cycle.

What does not change: every existing module continues to function. Cycle 10 is purely additive on the request path.

---

## Step 1 — Health Records Schema — Records, Conditions, Immunisations

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-04. Idempotent re-provision verified (zero new applies on the second run; the IF NOT EXISTS guards on every CREATE TABLE / CREATE INDEX work as designed; tenant base table count stable at 143). Splitter-clean — Python audit script (block-comment + line-comment + single-quoted-string aware with `''` escape handling) confirmed zero `;` outside legitimate statement terminators on the first attempt. Seventh migration in a row to clear the splitter trap on first try (Cycles 4–10 unbroken streak).

**Migration:** `packages/database/prisma/tenant/migrations/032_hlth_health_records.sql`.

**Tables (4):**

1. **`hlth_student_health_records`** — One health record per student. `school_id`, `student_id` NOT NULL FK to `sis_students(id)` ON DELETE CASCADE (the conservative privacy choice when a student is removed — consistent with Cycle 9 `sis_discipline_incidents.student_id`), `blood_type TEXT` nullable, `allergies JSONB NOT NULL DEFAULT '[]'::jsonb` (structured array of `{allergen, severity, reaction, notes}`; the Step 9 dietary integration reads `severity = 'SEVERE'` entries to drive the POS allergen alert flag), `emergency_medical_notes TEXT` nullable (free-form notes that surface on the emergency card and to substitutes through the Cycle 5 substitution timetable when a student needs special handling on a covered day), `physician_name TEXT`, `physician_phone TEXT`. **UNIQUE INDEX on `(student_id)`** so the Step 5 `HealthRecordService` can upsert without a manual lookup. INDEX on `(school_id)` for the school-wide compliance dashboards. Step 5 `HealthRecordService` is the canonical writer; reads always go through the service so the `hlth_health_access_log` row is recorded before the response body leaves the server.

2. **`hlth_medical_conditions`** — Per-record condition row. `health_record_id` NOT NULL FK to `hlth_student_health_records(id)` ON DELETE CASCADE (a condition has no meaning without its parent health record), `condition_name TEXT NOT NULL`, `diagnosis_date DATE` nullable, `is_active BOOLEAN NOT NULL DEFAULT true`, `severity TEXT NOT NULL` 3-value CHECK `MILD / MODERATE / SEVERE`, `management_plan TEXT` nullable (internal staff-side text — the Step 5 `ConditionService` `rowToDto` strips this from the parent payload; never visible to teachers or parents). INDEX on `(health_record_id, is_active)` for the active-conditions hot path. The Step 5 service writes `is_active = false` rather than `DELETE` on resolution so the historical timeline is preserved.

3. **`hlth_immunisations`** — Per-record vaccine row. `health_record_id` NOT NULL FK to `hlth_student_health_records(id)` ON DELETE CASCADE, `vaccine_name TEXT NOT NULL`, `administered_date DATE` nullable, `due_date DATE` nullable, `administered_by TEXT` nullable (free-form text — captures external clinic or school nurse name; intentionally NOT a soft FK to `hr_employees` because parent-supplied immunisation records often reference clinic names that have no employee record), `status TEXT NOT NULL` 3-value CHECK `CURRENT / OVERDUE / WAIVED`. INDEX on `(health_record_id, vaccine_name)` and `(health_record_id, status)`. The Step 5 `HealthRecordService` rolls up status counts across the school for the immunisation compliance dashboard — `WAIVED` rows count as compliant; `OVERDUE` rows drive the admin queue.

4. **`hlth_health_access_log`** — IMMUTABLE per ADR-010. Service-side discipline. No UPDATE. No DELETE. `school_id`, `accessed_by UUID NOT NULL` (soft to `platform.platform_users(id)` per ADR-001 — captures the actor account id stamped from `actor.accountId`), `student_id UUID NOT NULL` REFERENCES `sis_students(id)` NO ACTION (refuses delete of a student who has audit log entries — forces admin to archive the audit trail before student removal; the audit log outlives normal record cleanup), `access_type TEXT NOT NULL` **9-value CHECK** `VIEW_RECORD / VIEW_CONDITIONS / VIEW_IMMUNISATIONS / VIEW_MEDICATIONS / VIEW_VISITS / VIEW_IEP / VIEW_SCREENING / VIEW_DIETARY / EXPORT`, `ip_address TEXT` nullable, `accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()`. INDEX on `(student_id, accessed_at DESC)` for the per-student audit query and INDEX on `(accessed_by, accessed_at DESC)` for the per-actor audit query. Every Step 5 to 7 health read endpoint writes a row here BEFORE returning data via the Step 5 `HealthAccessLogService.recordAccess(actor, studentId, accessType)` helper — the only writer.

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `hlth_student_health_records.school_id → platform.schools(id)`
- `hlth_health_access_log.school_id → platform.schools(id)`
- `hlth_health_access_log.accessed_by → platform.platform_users(id)` (soft per ADR-001)

**FK summary — 4 new intra-tenant DB-enforced FKs:**

| FK                                                                           | Action    |
| ---------------------------------------------------------------------------- | --------- |
| `hlth_student_health_records.student_id → sis_students(id)`                  | CASCADE   |
| `hlth_medical_conditions.health_record_id → hlth_student_health_records(id)` | CASCADE   |
| `hlth_immunisations.health_record_id → hlth_student_health_records(id)`      | CASCADE   |
| `hlth_health_access_log.student_id → sis_students(id)`                       | NO ACTION |

0 cross-schema FKs.

**Tenant logical base table count after Step 1:** 139 → **143**.

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction with savepoints, 11 assertions, all green):**

- T1 happy-path health record insert (Maya, A+, peanut allergy SEVERE JSONB, Dr. Lee).
- T2 UNIQUE(student_id) rejects 2nd record for same student.
- T3 condition `severity_chk` rejects `BOGUS`.
- T4 condition happy path (Asthma MODERATE ACTIVE with management_plan).
- T5 condition FK rejects bogus `health_record_id`.
- T6 immunisation `status_chk` rejects `BOGUS`.
- T7 immunisation happy path (DTaP CURRENT 2024-09-15).
- T8 access log `access_type_chk` rejects `BOGUS`.
- T9 access log happy path with all 9 enum values inserted in one statement.
- T10 access log NO ACTION FK refuses delete of student with audit entries (the immutable-audit invariant — admin must archive log first).
- T11 CASCADE on health_record delete drops conditions + immunisations cleanly.

All 4 FK delete actions confirmed via `pg_constraint.confdeltype` catalog readout: CASCADE 'c' / CASCADE 'c' / CASCADE 'c' / NO ACTION 'a'. Idempotent re-provision verified — `pnpm --filter @campusos/database provision --subdomain=demo` runs cleanly on the already-migrated tenant; tenant base table count stable at 143.

**Splitter `;`-in-string trap not tripped** — Python state-machine audit (block-comment + line-comment + single-quoted-string aware with `''` escape handling) reports zero `;` outside legitimate statement terminators. Seventh migration in a row to clear the splitter trap on first attempt (Cycles 4–10 unbroken streak). The COMMENT strings on the JSONB allergies column and the access_type column were drafted with periods and "and" instead of semicolons from the start.

**Out of scope this step (deferred to Step 5):** the request-path API. The schema ships now; the `HealthRecordService`, `ConditionService`, `ImmunisationService`, and `HealthAccessLogService` land in Step 5 along with the HIPAA access logging discipline at the controller layer. Reads from non-staff personas (parent self-service for own child) ship with the Step 5 row-scope filter that strips `management_plan` from conditions and the full `emergency_medical_notes` field from the parent payload.

---

## Step 2 — Medication Schema — Meds, Schedule, Administration

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-04. Idempotent re-provision verified (zero new applies on the second run; tenant base table count stable at 146). Splitter-clean — Python audit script confirmed zero `;` outside legitimate statement terminators on the first attempt. Eighth migration in a row to clear the splitter trap (Cycles 4–10 unbroken).

**Migration:** `packages/database/prisma/tenant/migrations/033_hlth_medications.sql`.

**Tables (3):**

1. **`hlth_medications`** — Per-record prescribed medication. `health_record_id` NOT NULL FK to `hlth_student_health_records(id)` ON DELETE CASCADE (a medication has no meaning without its parent health record), `medication_name TEXT NOT NULL`, `dosage TEXT` nullable, `frequency TEXT` nullable (free-form prescribing-physician text — the structured scheduled times live in `hlth_medication_schedule`; this is the note the nurse renders on the medication card), `route TEXT NOT NULL` 5-value CHECK `ORAL / TOPICAL / INHALER / INJECTION / OTHER`, `prescribing_physician TEXT`, `is_self_administered BOOLEAN NOT NULL DEFAULT false` (when true the student carries the medication themselves — epinephrine pen, rescue inhaler — and the Step 6 nurse dashboard sorts these out of the daily admin checklist since the nurse only logs administered doses for staff-administered medications), `is_active BOOLEAN NOT NULL DEFAULT true`. INDEX on `(health_record_id, is_active)` for the active-medications hot path. The Step 6 `MedicationService` is the canonical writer.

2. **`hlth_medication_schedule`** — Per-medication daily schedule slot. `medication_id` NOT NULL FK to `hlth_medications(id)` ON DELETE CASCADE (a schedule slot has no meaning without its parent medication), `scheduled_time TIME NOT NULL` (no date — the slot recurs), `day_of_week SMALLINT` nullable with **CHECK `day_of_week IS NULL OR day_of_week BETWEEN 0 AND 6`** (NULL means every day, the typical case for daily medications; 0–6 follows the Cycle 5 `sch_periods` ISO Sunday-Saturday convention), `notes TEXT` nullable. INDEX on `(medication_id)`. The Step 6 `ScheduleService` renders these as a time-slot checklist on the nurse dashboard.

3. **`hlth_medication_administrations`** — Per-dose log. `medication_id` NOT NULL FK to `hlth_medications(id)` ON DELETE CASCADE, `schedule_entry_id UUID` nullable **with no DB-enforced FK** (deliberate soft ref — when a nurse retires a slot the historical administrations remain pinned to the medication via `medication_id`; the nullable column also reflects PRN/unscheduled doses that never had a slot), `administered_by UUID` REFERENCES `hr_employees(id)` ON DELETE SET NULL (audit trail survives a nurse leaving the school — the row remains for compliance review with `administered_by` NULL), `administered_at TIMESTAMPTZ` nullable, `dose_given TEXT` nullable, `notes TEXT` nullable, `parent_notified BOOLEAN NOT NULL DEFAULT false`, `was_missed BOOLEAN NOT NULL DEFAULT false`, `missed_reason TEXT` nullable 5-value CHECK `STUDENT_ABSENT / STUDENT_REFUSED / MEDICATION_UNAVAILABLE / PARENT_CANCELLED / OTHER` (or NULL). **Multi-column `hlth_medication_administrations_missed_chk`** is the keystone invariant: pins administration rows to one of two shapes — active dose requires `was_missed=false AND administered_at NOT NULL AND missed_reason NULL`; missed dose requires `was_missed=true AND administered_at NULL AND missed_reason NOT NULL`. Any other combination is rejected. INDEX on `(medication_id, administered_at DESC)` for the dose-history hot path. **Partial INDEX on `(schedule_entry_id, was_missed) WHERE was_missed = true`** for the missed-dose audit query — the canonical compliance report shape.

**Soft cross-schema refs per ADR-001 / ADR-020:** none new in this step.

**FK summary — 4 new intra-tenant DB-enforced FKs:**

| FK                                                                     | Action   |
| ---------------------------------------------------------------------- | -------- |
| `hlth_medications.health_record_id → hlth_student_health_records(id)`  | CASCADE  |
| `hlth_medication_schedule.medication_id → hlth_medications(id)`        | CASCADE  |
| `hlth_medication_administrations.medication_id → hlth_medications(id)` | CASCADE  |
| `hlth_medication_administrations.administered_by → hr_employees(id)`   | SET NULL |

The `schedule_entry_id` soft ref intentionally has no DB-enforced FK to `hlth_medication_schedule` — the design choice documented inline so future cycles know retiring a slot is safe.

0 cross-schema FKs.

**Tenant logical base table count after Step 2:** 143 → **146**. Cycle 10 running tally: 7 logical base tables (4 from Step 1 + 3 from Step 2). 8 intra-tenant FKs (4 + 4).

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction with savepoints, 16 assertions, all green):**

- T1 medication `route_chk` rejects `BOGUS`.
- T2 medication happy path with all 5 route values inserted in one block (Albuterol INHALER, Acetaminophen ORAL, Hydrocortisone TOPICAL, EpiPen INJECTION, Eye drops OTHER).
- T3 schedule `dow_chk` rejects `day_of_week=9`.
- T4 schedule happy path with NULL day_of_week (every day) AND specific day_of_week=3 (Wednesday extra slot) coexisting on the same medication.
- T5 schedule FK rejects bogus `medication_id`.
- T6 administration `missed_reason_chk` rejects `BOGUS`.
- T7 `missed_chk` rejects active dose with `administered_at` NULL (active doses must have a timestamp).
- T8 `missed_chk` rejects active dose with `missed_reason` set (active doses must have NULL missed_reason).
- T9 `missed_chk` rejects missed dose with `administered_at` set (missed doses must have NULL timestamp — the keystone invariant from the plan).
- T10 `missed_chk` rejects missed dose without `missed_reason` (missed doses must justify why).
- T11 active administration happy path (linked to schedule slot, administered yesterday, 1 puff, parent notified).
- T12 missed administration happy path with all 5 missed_reason values inserted in one block.
- T13 PRN administration with NULL `schedule_entry_id` accepted (unscheduled doses).
- T14 partial-INDEX query path returns exactly 5 missed rows for the slot.
- T15 schedule delete leaves administration rows intact via the soft-ref convention (the deliberately-not-FK design); the `schedule_entry_id` column retains its UUID after the parent slot row is gone, by design.
- T16 CASCADE on medication delete drops schedule + administrations cleanly (admin row count goes from 7 → 0).

All 4 FK delete actions confirmed via `pg_constraint.confdeltype` catalog readout: CASCADE 'c' / CASCADE 'c' / CASCADE 'c' / SET NULL 'n'. Idempotent re-provision verified — table count stable at 146.

**Out of scope this step (deferred to Step 6):** the request-path API. The schema ships now; the `MedicationService`, `ScheduleService`, and `AdministrationService` land in Step 6 along with the missed-dose audit endpoints, the nurse-dashboard medication checklist, and the `hlth.medication.administered` Kafka emit for parent notification. The HIPAA access log writes (VIEW_MEDICATIONS) are wired in via `HealthAccessLogService.recordAccess` from Step 5.

---

## Step 3 — IEP/504 + Nurse + Screening + Dietary Schema

**Status:** TODO.

(Steps 3–10 of Cycle 10 — IEP / nurse / screening / dietary schema, seed data, NestJS modules, UI, and CAT — remain to ship; see `docs/campusos-cycle10-implementation-plan.html`.)
