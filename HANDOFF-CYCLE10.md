# Cycle 10 Handoff — Health & Wellness

**Status:** Cycle 10 **IN PROGRESS** — Steps 1 + 2 + 3 + 4 of 10 done. All 15 hlth*\* tables in place + the ADR-030 read model + Maya's full demo data + HLT-001..005 IAM grants. Cycle 10 is the **second cycle of Wave 2 (Student Services)** and ships the M23 Health module — 14 of the 17 ERD tables (3 telehealth tables deferred). Plus the immutable HIPAA access log brings the total to 15 new tenant base tables. Cycle 10 is the **most access-restricted module in the system**: the `hlth*\*`tables are flagged in the ERD for a separate HIPAA-compliant KMS key. For the dev / demo phase the tables ship without field-level encryption but the access control layer is strict from day one — every read endpoint is gated by a dedicated`health_record:read`permission AND writes a row to`hlth_health_access_log` before the response body leaves the server.

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
| 3    | IEP/504 + Nurse + Screening + Dietary Schema                | **DONE** |
| 4    | Seed Data — Maya's Health Record + IEP + Sample Visits      | **DONE** |
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

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-04. Idempotent re-provision verified (zero new applies on the second run; tenant base table count stable at 154). Splitter-clean — Python audit script confirmed zero `;` outside legitimate statement terminators on the first attempt. Ninth migration in a row to clear the splitter trap (Cycles 4–10 unbroken). The largest schema migration of Cycle 10 — 8 tables in one file completing the full M23 Health surface.

**Migration:** `packages/database/prisma/tenant/migrations/034_hlth_iep_nurse_screening_dietary.sql`.

**Tables (8):**

1. **`hlth_iep_plans`** — One IEP or 504 plan per student. `school_id`, `student_id` NOT NULL FK to `sis_students(id)` ON DELETE CASCADE, `plan_type TEXT NOT NULL` 2-value CHECK `IEP / 504` (mutually exclusive in practice — a student gets one or the other), `status TEXT NOT NULL DEFAULT 'DRAFT'` 4-value CHECK `DRAFT / ACTIVE / REVIEW / EXPIRED`, `start_date DATE`, `review_date DATE`, `end_date DATE`, `case_manager_id UUID` FK to `hr_employees(id)` ON DELETE SET NULL (audit survives a counsellor leaving). **Partial UNIQUE INDEX on `(student_id) WHERE status <> 'EXPIRED'`** so expired plans accumulate as history while at most one active / draft / review plan exists per student. Mirrors the Cycle 9 `svc_behavior_plans` partial UNIQUE pattern. INDEX on `(school_id, status)`. The Step 7 `IepPlanService` is the canonical writer and emits `iep.accommodation.updated` on accommodation changes so the ADR-030 read model stays in sync.

2. **`hlth_iep_goals`** — Per-plan measurable goal. `iep_plan_id` NOT NULL FK CASCADE, `goal_text TEXT NOT NULL`, `measurement_criteria TEXT`, `baseline TEXT`, `target_value TEXT`, `current_value TEXT`, `goal_area TEXT`, `status TEXT NOT NULL DEFAULT 'ACTIVE'` 4-value CHECK `ACTIVE / MET / NOT_MET / DISCONTINUED`. INDEX on `(iep_plan_id, status)`. baseline / target_value / current_value are TEXT to accommodate quantitative ("90 percent accuracy") and qualitative ("independent transition between classes") measurement criteria.

3. **`hlth_iep_goal_progress`** — Per-goal progress entry (append-only audit history). `goal_id` NOT NULL FK CASCADE, `recorded_by` FK to `hr_employees(id)` ON DELETE SET NULL, `progress_value TEXT`, `observation_notes TEXT`, `recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()`. INDEX on `(goal_id, recorded_at DESC)` for the timeline query.

4. **`hlth_iep_services`** — Per-plan related service. `iep_plan_id` NOT NULL FK CASCADE, `service_type TEXT NOT NULL` (free-form covering speech therapy / OT / PT / counselling / other), `provider_name TEXT`, `frequency TEXT`, `minutes_per_session INT` with CHECK `IS NULL OR > 0` (zero or negative session length is nonsense), `delivery_method TEXT NOT NULL` 3-value CHECK `PULL_OUT / PUSH_IN / CONSULT`. INDEX on `(iep_plan_id)`. PULL_OUT means the student leaves the classroom; PUSH_IN means the provider joins the classroom; CONSULT means the provider supports the teacher rather than working with the student directly.

5. **`hlth_iep_accommodations`** — Per-plan accommodation. `iep_plan_id` NOT NULL FK CASCADE, `accommodation_type TEXT NOT NULL` (free-form matching the ADR-030 read model — EXTENDED*TIME, ALTERNATIVE_ASSESSMENT, ASSISTIVE_TECH, READ_ALOUD, REDUCED_DISTRACTION, PREFERENTIAL_SEATING), `description TEXT`, `applies_to TEXT NOT NULL` 3-value CHECK `ALL_ASSESSMENTS / ALL_ASSIGNMENTS / SPECIFIC`, `specific_assignment_types TEXT[]` nullable, `effective_from DATE`, `effective_to DATE`. **Multi-column `applies_to_chk`** pins the SPECIFIC scope to a non-empty `specific_assignment_types` array AND pins the broad scopes (ALL_ASSESSMENTS, ALL_ASSIGNMENTS) to a NULL array — the broad scope cannot also enumerate specific types. **Multi-column `dates_chk`** enforces `effective_to >= effective_from` only when both are set. INDEX on `(iep_plan_id)`. The Step 7 `IepPlanService` emits `iep.accommodation.updated` on every INSERT / UPDATE / DELETE so the ADR-030 `IepAccommodationConsumer` upserts `sis_student_active_accommodations` for teachers to read without ever touching `hlth*\*`.

6. **`hlth_nurse_visits`** — Live nurse office row. `school_id`, **`visited_person_id UUID NOT NULL` (soft polymorphic ref) + `visited_person_type TEXT NOT NULL DEFAULT 'STUDENT'`** 2-value CHECK `STUDENT / STAFF` (the soft polymorphic ref resolves via the type — STUDENT references `sis_students(id)`, STAFF references `hr_employees(id)`; no DB-enforced FK because the target table differs by row; the Step 7 `NurseVisitService` is the canonical validator), `nurse_id` FK to `hr_employees(id)` ON DELETE SET NULL, `visit_date TIMESTAMPTZ NOT NULL DEFAULT now()`, `status TEXT NOT NULL DEFAULT 'COMPLETED'` 2-value CHECK `IN_PROGRESS / COMPLETED`, `signed_in_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `signed_out_at TIMESTAMPTZ`, `reason TEXT`, `treatment_given TEXT`, `parent_notified BOOLEAN`, `sent_home BOOLEAN NOT NULL DEFAULT false`, `sent_home_at TIMESTAMPTZ`, `follow_up_required`, `follow_up_notes`, `follow_up_date DATE`. **Multi-column `signed_chk`** pins IN_PROGRESS to `signed_out_at NULL` AND COMPLETED to `signed_out_at NOT NULL`. **Multi-column `sent_home_chk`** pins `sent_home=true` to a non-NULL `sent_home_at` AND `sent_home=false` to a NULL `sent_home_at`. **Partial INDEX on `(school_id, status) WHERE status = 'IN_PROGRESS'`** backs the live nurse office roster query that the Step 8 dashboard polls. Plus INDEX on `(school_id, visit_date DESC)` and `(visited_person_id, visit_date DESC)`.

7. **`hlth_screenings`** — Per-student screening result. `school_id`, `student_id` NOT NULL FK CASCADE, `screening_type TEXT NOT NULL` (free-form — VISION, HEARING, SCOLIOSIS, BMI, DENTAL, CUSTOM), `screening_date DATE NOT NULL`, `screened_by` FK to `hr_employees(id)` ON DELETE SET NULL, `result TEXT` nullable 4-value CHECK `PASS / REFER / RESCREEN / ABSENT` (or NULL while the screening is in progress), `result_notes`, `follow_up_required BOOLEAN`, `follow_up_completed BOOLEAN DEFAULT false`, `referral_notes`. INDEX on `(student_id, screening_date DESC)` for the per-student screening history. **Partial INDEX on `(school_id, follow_up_completed) WHERE follow_up_required = true AND follow_up_completed = false`** backs the admin follow-up queue that the Step 9 screening log renders.

8. **`hlth_dietary_profiles`** — One profile per student. `school_id`, `student_id` NOT NULL FK CASCADE, `dietary_restrictions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]` (free-form array — VEGETARIAN, VEGAN, HALAL, KOSHER, GLUTEN_FREE, DAIRY_FREE plus school-specific tags), `allergens JSONB NOT NULL DEFAULT '[]'::jsonb` (structured `[{allergen, severity, reaction}]` rows), `special_meal_instructions TEXT`, `pos_allergen_alert BOOLEAN NOT NULL DEFAULT false` (when true the future POS / cafeteria integration shows a hard-stop alert at checkout), `updated_by UUID` (soft ref to `platform.platform_users(id)` per ADR-001). **UNIQUE INDEX on `(student_id)`** so the Step 7 `DietaryProfileService` can upsert. **Partial INDEX on `(school_id) WHERE pos_allergen_alert = true`** backs the `GET /health/allergen-alerts` endpoint that the future POS / cafeteria integration polls.

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `hlth_iep_plans.school_id → platform.schools(id)`
- `hlth_nurse_visits.school_id → platform.schools(id)`
- `hlth_screenings.school_id → platform.schools(id)`
- `hlth_dietary_profiles.school_id → platform.schools(id)`
- `hlth_dietary_profiles.updated_by → platform.platform_users(id)` (soft per ADR-001)
- `hlth_nurse_visits.visited_person_id` is **soft polymorphic** per the `visited_person_type` column — STUDENT references `sis_students(id)`, STAFF references `hr_employees(id)`; the Step 7 `NurseVisitService` is the canonical validator before insert.

**FK summary — 11 new intra-tenant DB-enforced FKs:**

| FK                                                         | Action   |
| ---------------------------------------------------------- | -------- |
| `hlth_iep_plans.student_id → sis_students(id)`             | CASCADE  |
| `hlth_iep_plans.case_manager_id → hr_employees(id)`        | SET NULL |
| `hlth_iep_goals.iep_plan_id → hlth_iep_plans(id)`          | CASCADE  |
| `hlth_iep_goal_progress.goal_id → hlth_iep_goals(id)`      | CASCADE  |
| `hlth_iep_goal_progress.recorded_by → hr_employees(id)`    | SET NULL |
| `hlth_iep_services.iep_plan_id → hlth_iep_plans(id)`       | CASCADE  |
| `hlth_iep_accommodations.iep_plan_id → hlth_iep_plans(id)` | CASCADE  |
| `hlth_nurse_visits.nurse_id → hr_employees(id)`            | SET NULL |
| `hlth_screenings.student_id → sis_students(id)`            | CASCADE  |
| `hlth_screenings.screened_by → hr_employees(id)`           | SET NULL |
| `hlth_dietary_profiles.student_id → sis_students(id)`      | CASCADE  |

0 cross-schema FKs.

**Tenant logical base table count after Step 3:** 146 → **154**. **Cycle 10 schema phase complete.** All 15 hlth*\* tables in place: 4 from Step 1 (records + conditions + immunisations + access log) + 3 from Step 2 (medications + schedule + administrations) + 8 from Step 3. Cycle 10 running tally: \*\*15 logical hlth*\* tables, 19 intra-tenant FKs (4 + 4 + 11), 0 cross-schema FKs\*\*.

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction with savepoints, 36 assertions, all green):**

- T1–T2 IEP plan_type_chk + status_chk reject `BOGUS`.
- T3 504 ACTIVE plan happy path (Maya, Hayes case manager, dates set).
- **T4 partial UNIQUE keystone — rejects 2nd non-EXPIRED plan for same student.**
- **T5 partial UNIQUE allows EXPIRED + ACTIVE coexistence (history preserved).**
- T6 goal status_chk rejects `BOGUS`.
- T7 goal happy path (Extended Time compliance, baseline 60% target 90%).
- T8 goal_progress happy path (Hayes records 75% with notes).
- T9 service delivery_chk rejects `BOGUS`.
- T10 minutes_chk rejects 0.
- T11 service happy path with all 3 delivery methods (PULL_OUT, PUSH_IN, CONSULT).
- T12 accommodation applies_to_chk rejects `BOGUS`.
- **T13 specific_chk rejects ALL_ASSESSMENTS with array set (broad scope cannot enumerate types).**
- **T14 specific_chk rejects SPECIFIC without array.**
- **T15 specific_chk rejects SPECIFIC with empty array.**
- T16 dates_chk rejects effective_to before effective_from.
- T17 accommodation happy path with all 3 applies_to values + SPECIFIC with `ARRAY['ESSAY', 'EXAM']`.
- T18 nurse_visit visited_type_chk rejects `BOGUS`.
- T19 nurse_visit status_chk rejects `BOGUS`.
- **T20 signed_chk rejects IN_PROGRESS with signed_out_at set.**
- **T21 signed_chk rejects COMPLETED without signed_out_at.**
- **T22 sent_home_chk rejects sent_home=true without timestamp.**
- **T23 sent_home_chk rejects sent_home=false with timestamp.**
- T24 IN_PROGRESS happy path (Maya wheezing).
- T25 COMPLETED with sent_home happy path (Maya goes home).
- T26 STAFF visit happy path (a teacher with a headache exercises the soft polymorphic ref).
- T27 partial-INDEX live roster query returns 1 active visit.
- T28 screening result_chk rejects `BOGUS`.
- T29 screening happy path with all 4 result values (PASS, REFER, RESCREEN, ABSENT).
- T30 NULL result accepted (in-progress / pending).
- T31 partial-INDEX follow-up query returns 1 (Maya VISION REFER).
- T32 dietary profile happy path with `pos_allergen_alert=true` and structured allergens JSONB.
- T33 UNIQUE student_id rejects duplicate dietary profile.
- T34 partial-INDEX allergen-alert query returns 1.
- T35 plan delete CASCADEs through all 4 child tables (goals + goal_progress + accommodations + services drop together).
- T36 FK rejects bogus iep_plan_id.

All 11 FK delete actions confirmed via `pg_constraint.confdeltype` catalog readout: 6 CASCADE 'c' + 5 SET NULL 'n'. **All 8 multi-column lockstep CHECKs fire on every mismatch direction** — `applies_to_chk` × 3 (T13/T14/T15), `signed_chk` × 2 (T20/T21), `sent_home_chk` × 2 (T22/T23), `dates_chk` × 1 (T16). Idempotent re-provision verified — table count stable at 154.

**Out of scope this step (deferred to Step 7):** the request-path APIs. The schema ships now; `IepPlanService`, `NurseVisitService`, `ScreeningService`, `DietaryProfileService`, and the `IepAccommodationConsumer` Kafka consumer (the keystone ADR-030 read-model bridge) all land in Step 7. The HIPAA access log writes (VIEW_IEP / VIEW_VISITS / VIEW_SCREENING / VIEW_DIETARY) are wired in via `HealthAccessLogService.recordAccess` from Step 5.

---

## Step 4 — Seed Data — Maya's Health Record + IEP + Sample Visits

**Status:** DONE. Idempotent seed lands cleanly on `tenant_demo` 2026-05-04. Re-run gates on whether Maya already has a health record and skips with `Maya's health record already exists — skipping`. Test tenant `tenant_test` stays empty by convention.

**Prerequisite migration:** `packages/database/prisma/tenant/migrations/035_sis_student_active_accommodations.sql`. The ADR-030 read model has been referenced in CLAUDE.md and prior cycle handoffs since Cycle 1 as the surface teachers read for active accommodations without ever touching `hlth_*` tables, but the table was never built. Step 4 ships it as a prerequisite for the Step 7 IepAccommodationConsumer Kafka consumer + the seed plants 2 demo rows so the read model has a baseline shape. **1 logical base table** (3-value `plan_type` CHECK IEP/504, 3-value `applies_to` CHECK matching `hlth_iep_accommodations`, multi-column `specific_chk` mirroring the source so the read model never holds a shape the source could not produce, multi-column `dates_chk`, `student_id` FK CASCADE, **partial UNIQUE INDEX on `source_iep_accommodation_id WHERE source_iep_accommodation_id IS NOT NULL`** so the Step 7 consumer keys upserts deterministically while seed rows can coexist). 1 new intra-tenant FK, 0 cross-schema FKs. Tenant logical base table count: 154 → **155**. Splitter trap caught two `;` characters in the comment header on the first audit; rewritten with periods on the second pass — matches the same trap pattern caught in Cycles 4–8.

**Seed script:** `packages/database/src/seed-health.ts` (wired as `seed:health` in `packages/database/package.json`).

**What gets seeded (8 sections + permissions):**

A. **Maya's `hlth_student_health_records`** — A+ blood type; structured JSONB allergies (Peanuts SEVERE Anaphylaxis "Carries an EpiPen at all times" + Dust mites MILD Sneezing); emergency_medical_notes referencing the asthma plan; physician Dr. Sarah Lee + +1-217-555-9000.

B. **2 `hlth_medical_conditions`** — Asthma MODERATE ACTIVE diagnosed 2020-05-15 with full management_plan ("PRN albuterol inhaler. Avoid known triggers..."); Seasonal allergies MILD ACTIVE diagnosed 2022-03-10 with management_plan.

C. **3 `hlth_immunisations`** — DTaP CURRENT administered 2024-09-15 by Springfield Pediatrics; Influenza OVERDUE due 2025-10-15 (drives the OVERDUE compliance dashboard); MMR CURRENT administered 2023-08-20.

D. **1 `hlth_medications` + 1 `hlth_medication_schedule` + 2 `hlth_medication_administrations`** — Albuterol Inhaler 90mcg, INHALER, 2 puffs PRN plus scheduled 08:00 daily, prescribed by Dr. Lee, `is_self_administered=true`. Schedule slot at 08:00 with `day_of_week=NULL` (every day). Administration 1: yesterday 08:05, administered by Sarah Mitchell, 1 puff, parent_notified=true (`was_missed=false`, timestamp populated — active dose shape). **Administration 2: today's slot missed because Maya was absent — `was_missed=true`, `administered_at=NULL`, `missed_reason='STUDENT_ABSENT'`** (exercises the missed_chk invariant).

E. **2 `hlth_nurse_visits`** — V1: Maya yesterday 10:30, COMPLETED at 10:50 (20 minutes), reason "Wheezing episode after gym class", treatment "Administered albuterol inhaler 2 puffs. Resting period observed for 15 minutes. Symptoms resolved.", parent_notified=true, sent_home=false. V2: Ethan Rodriguez last week 13:15, COMPLETED at 13:35, reason "Headache complaint", treatment "Rest and water", parent_notified=false, sent_home=false.

F. **1 `hlth_iep_plans` + 2 `hlth_iep_goals` + 1 `hlth_iep_goal_progress` + 1 `hlth_iep_services` + 2 `hlth_iep_accommodations`** — Maya, plan_type=504, status=ACTIVE, start_date=2025-08-15, review_date=today+60d, case_manager_id=Marcus Hayes (counsellor). Goal 1: "Demonstrate compliance with extended time accommodation across all assessments" baseline 60% target 90% current 75% Academic ACTIVE. Goal 2: "Reduced-distraction setting effectively across all assessments" qualitative baseline + target Behavioural ACTIVE. 1 progress entry on Goal 1 by Hayes a week ago: "Steady improvement... 3 of 4 recent assessments within the extended window without distress". Service: Speech therapy by Sarah Reynolds (district SLP), 30 min, 2x weekly, PULL_OUT. **Accommodation 1: EXTENDED_TIME ALL_ASSESSMENTS effective 2025-08-15** ("Maya receives 1.5x time on all assessments and quizzes"). **Accommodation 2: REDUCED_DISTRACTION ALL_ASSESSMENTS effective 2025-08-15** ("Maya completes assessments in a quiet alternate location separate from the main classroom").

G. **1 `hlth_screenings`** — Maya VISION 2026-04-01 by Hayes, result=REFER, "Distance vision below threshold in left eye. Right eye within normal range.", `follow_up_required=true`, `follow_up_completed=false`, referral_notes "Schedule ophthalmologist appointment for further evaluation." This row populates the partial INDEX `WHERE follow_up_required=true AND follow_up_completed=false` so the Step 9 admin follow-up queue has a baseline entry.

H. **1 `hlth_dietary_profiles`** — Maya, `dietary_restrictions=ARRAY[]` (no special dietary preferences beyond the allergen), allergens JSONB `[{allergen:'Peanuts', severity:'SEVERE', reaction:'Anaphylaxis'}]`, special_meal_instructions "Strict no-peanuts protocol. Verify ingredient lists at every service.", **`pos_allergen_alert=true`** so the future POS / cafeteria integration shows a hard-stop alert at checkout (drives the partial INDEX hot path).

I. **2 `sis_student_active_accommodations` rows** — direct seed write demonstrating the ADR-030 read model shape. Both rows reference Maya's source IEP accommodation rows from section F via `source_iep_accommodation_id` (Step 7 consumer keys upserts here via the partial UNIQUE INDEX). EXTENDED_TIME ALL_ASSESSMENTS plan_type=504 effective 2025-08-15 + REDUCED_DISTRACTION ALL_ASSESSMENTS plan_type=504 effective 2025-08-15. The Step 7 IepAccommodationConsumer will maintain these going forward via Kafka events.

**Live counts on `tenant_demo` after seed:**

| Resource                            | Count                                   |
| ----------------------------------- | --------------------------------------- |
| `hlth_student_health_records`       | 1                                       |
| `hlth_medical_conditions`           | 2                                       |
| `hlth_immunisations`                | 3 (1 OVERDUE)                           |
| `hlth_medications`                  | 1                                       |
| `hlth_medication_schedule`          | 1                                       |
| `hlth_medication_administrations`   | 2 (1 missed STUDENT_ABSENT)             |
| `hlth_nurse_visits`                 | 2 (Maya + Ethan, both COMPLETED)        |
| `hlth_iep_plans` ACTIVE             | 1 (504, Hayes case manager)             |
| `hlth_iep_goals`                    | 2                                       |
| `hlth_iep_goal_progress`            | 1                                       |
| `hlth_iep_services`                 | 1 (Speech, 30min 2x weekly PULL_OUT)    |
| `hlth_iep_accommodations`           | 2 (EXTENDED_TIME + REDUCED_DISTRACTION) |
| `hlth_screenings`                   | 1 (Maya VISION REFER pending follow-up) |
| `hlth_dietary_profiles` POS alert   | 1                                       |
| `sis_student_active_accommodations` | 2 (ADR-030 read model demo)             |

**`seed-iam.ts` updated:** Teacher gains `HLT-001:read` (41 → 42 perms — health alerts only; the future Step 5 service strips PII for non-managers and returns accommodation-level info). Parent gains `HLT-001:read` (21 → 22 — own child's summary, row-scoped at the future Step 5 service GUARDIAN branch via `sis_student_guardians`). Staff gains all 5 HLT codes read+write (24 → 34 — covers nurse / counsellor / VP). School Admin and Platform Admin already hold all `HLT-*:admin` tiers via `everyFunction: ['read','write','admin']`. Catalogue total stays at **447 codes** — HLT-001 through HLT-005 were already in `permissions.json` from earlier cycles awaiting use; no catalogue edit required. Cache rebuild reports 7 account-scope pairs — admin/principal 447 (unchanged), teacher 42 (was 41), parent 22 (was 21), student 19 (unchanged), VP/counsellor 34 (was 24).

**Idempotency:** the seed gates on whether Maya already has a `hlth_student_health_records` row and skips on re-run. Test tenant `tenant_test` stays empty by convention. The `seed-iam.ts` re-run reports `0 newly added` for Teacher / Parent / Staff after the first run.

**Out of scope this step (deferred to Steps 5–7):** the request-path APIs that read these tables. Step 5 ships `HealthRecordService` + `ConditionService` + `ImmunisationService` + `HealthAccessLogService` (the canonical writer for the HIPAA audit log). Step 6 ships `MedicationService` + `ScheduleService` + `AdministrationService` (with the missed-dose audit and `hlth.medication.administered` Kafka emit). Step 7 ships `IepPlanService` + `NurseVisitService` + `ScreeningService` + `DietaryProfileService` + the **`IepAccommodationConsumer`** (the keystone ADR-030 read-model bridge) that subscribes to `iep.accommodation.updated` and upserts `sis_student_active_accommodations` keyed on `source_iep_accommodation_id`.

---

## Step 5 — Health Records NestJS Module — Records + Conditions + Imms

**Status:** TODO.

(Steps 5–10 of Cycle 10 — NestJS modules, IepAccommodationConsumer, UI, and CAT — remain to ship; see `docs/campusos-cycle10-implementation-plan.html`.)
