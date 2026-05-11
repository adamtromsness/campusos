# P2-13 SIS Advanced — Peer Review Notes

**Purpose:** scaffold the architectural review of Phase 2 Cycle 13. The peer reviewer should walk every section, verify the claim against the code in `main` at this commit, and record VERIFIED / DEVIATION / VIOLATION per finding. The closeout commit lands every BLOCKING + actionable MAJOR before the cycle gets tagged `p2c13-approved`.

## How the cycle splits

| Sub-cycle | Commit        | Scope                                                                                                                                                                                            |
| --------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P2-13a    | `8cc28e8`     | 8 tables (`142_sis_profiles_customfields.sql`), seed, 5 services (Profile / CustomField / ParentUpdate / StudentNote / FamilyRelationship), ~22 endpoints, 3 Kafka emits.                        |
| P2-13b    | `0900ce1`     | 8 tables (`143_sis_graduation_gpa.sql`), seed, 4 services + 2 workers (Graduation + GraduationAuditWorker + GPA + GPAWorker + ServiceLearning + Prerequisite), ~20 endpoints, 1 Kafka emit.      |
| P2-13c    | _this commit_ | 8 tables (`144_sis_transcripts_transfers.sql`), seed, 6 services (Transcript / Transfer / Locker / ReportingPeriod / StudentAward / MedicalExemption), ~22 endpoints, AES-256-GCM locker crypto. |

---

## 1. Custom fields design — typed values + entity polymorphism

**Claim (P2-13a):** schools define their own SIS fields via `sis_custom_field_definitions` without schema changes. Each definition carries a 6-value `field_type` CHECK (TEXT / NUMBER / DATE / BOOLEAN / ENUM / MULTI*SELECT) and an `enum_options TEXT[]` array enforced via `sis_custom_field_defs_enum_chk` for ENUM / MULTI_SELECT types. Values land in `sis_custom_field_values` with one `value*\*`column populated per row based on the matching`definition.field_type`. The entity_id is a soft polymorphic ref interpreted per `definition.entity_type` (STUDENT → sis_students, STAFF → hr_employees, GUARDIAN → sis_guardians, CLASS → sis_classes).

**Service layer enforcement:**

- `CustomFieldService.createDefinition` validates `enum_options` non-empty on ENUM / MULTI_SELECT before INSERT.
- `CustomFieldService.upsertValues` validates every (definition, value) pair against the definition's `field_type` before writing — TEXT must populate `value_text`, NUMBER must populate `value_number`, etc. Mismatched value columns reject with 400.

**Schema invariant (defence-in-depth):**

- UNIQUE(school_id, entity_type, field_name) on definitions — no two definitions can share an entity_type + name within a school.
- UNIQUE(definition_id, entity_id) on values — exactly one value per (definition, entity).

**Verify in code:**

- `apps/api/src/sis-advanced/custom-field.service.ts` — DTO + service.
- `packages/database/prisma/tenant/migrations/142_sis_profiles_customfields.sql` lines 80-110.

---

## 2. Graduation audit worker approach

**Claim (P2-13b):** `GraduationAuditWorker` walks every ACTIVE student in the school and, per active requirement, computes MET / IN_PROGRESS / NOT_MET against published cls_grades + sis_service_learning_hours + sis_student_gpa_snapshots. Materialises into `sis_student_graduation_audits` keyed on UNIQUE(student_id, requirement_id) so re-runs UPSERT cleanly. Emits `sis.graduation.at_risk` per senior with NOT_MET requirements after the run, with a deterministic event_id keyed on `(studentId, runId)` so retries dedup downstream.

**Service-layer audit shape:**

- 6 requirement types — CREDIT_TOTAL, SUBJECT_CREDIT, SPECIFIC_COURSE, SERVICE_HOURS, ASSESSMENT, MINIMUM_GPA.
- Per requirement, GraduationAuditWorker reads the qualifying-columns CHECK (`shape_chk` on `sis_graduation_requirements`) to find which audit shape applies and computes credits_earned / credits_remaining for credit-based requirements, or simple MET / NOT_MET for the boolean variants.

**Cron schedule:** deferred to Phase 3 ops. The worker exposes `runForSchool(schoolId)` which can be triggered by an admin endpoint today and a cron worker pre-pilot.

**Verify in code:**

- `apps/api/src/sis-graduation/graduation-audit.worker.ts` — full worker.
- `apps/api/src/sis-graduation/graduation.service.ts` — admin-trigger endpoint.

---

## 3. GPA calculation with weighted bonuses

**Claim (P2-13b):** `sis_gpa_configurations` carries a JSONB `grade_point_mapping` (e.g. `{"A+":4.0, "A":4.0, "A-":3.7, ...}`) plus `honors_weight_bonus NUMERIC(2,1) DEFAULT 0.5` and `ap_weight_bonus NUMERIC(2,1) DEFAULT 1.0`. The 3-value `calculation_method` CHECK is UNWEIGHTED / WEIGHTED / SUBJECT_AREA. WEIGHTED applies the honors / AP bonus on top of the mapped point value at GPAWorker computation time. Class rank within (school, grade_level) computed in the same pass.

**Schema invariant:**

- Partial UNIQUE on `(school_id) WHERE is_default = true` so each school has exactly one default config.
- `bonus_chk CHECK (honors_weight_bonus >= 0 AND ap_weight_bonus >= 0)`.

**Materialisation cadence:** end-of-term GPAWorker run. UNIQUE on `(student_id, gpa_config_id, COALESCE(academic_year_id, sentinel), COALESCE(term_id, sentinel))` so NULL-year + NULL-term cumulative-only snapshots coexist with named-term rows.

**Verify in code:**

- `apps/api/src/sis-graduation/gpa.worker.ts` lines 110-180 (weighting math).

---

## 4. Transcript snapshot pattern — THE FROZEN-SNAPSHOT KEYSTONE

**Claim (P2-13c):** `sis_transcript_courses` are written ONCE at `TranscriptService.generate()` by snapshotting cls_grades joined to sis_classes + sis_courses + sis_terms + sis_academic_years. The rows are NEVER live-joined to cls_grades. A re-grade downstream creates a NEW transcript with fresh frozen rows; it does NOT rewrite the existing rows. ADR-010 immutability for the legal student record.

**The wire:**

```ts
// transcript.service.ts — generate()
const courseRows = await tx.$queryRawUnsafe<...>(
  'SELECT c.id::text AS class_id, ' +
  "COALESCE(ay.name, '') AS academic_year, " +
  "COALESCE(tm.name, '') AS term, " +
  'co.name AS course_name, ' +
  'co.code AS course_code, ' +
  'co.credit_hours::text AS credits, ' +
  'g.letter_grade AS grade, ' +
  "(SELECT gse.grade_points::text FROM sis_grade_scale_entries gse " +
  "  WHERE gse.school_id = $2::uuid AND gse.letter_grade = g.letter_grade " +
  "  ORDER BY gse.sort_order LIMIT 1) AS grade_points, " +
  'COALESCE(co.is_honors, false) AS is_honors, ' +
  'COALESCE(co.is_ap, false) AS is_ap ' +
  'FROM cls_grades g ' +
  'JOIN sis_classes c ON c.id = g.class_id ' +
  'JOIN sis_courses co ON co.id = c.course_id ' +
  'LEFT JOIN sis_terms tm ON tm.id = c.term_id ' +
  'LEFT JOIN sis_academic_years ay ON ay.id = c.academic_year_id ' +
  'WHERE g.student_id = $1::uuid AND g.is_published = true ' +
  'ORDER BY ay.start_date NULLS LAST, tm.start_date NULLS LAST, co.name',
  studentId, tenant.schoolId,
);

// Per-row INSERT into sis_transcript_courses inside the same tx.
for (const c of courseRows) {
  await tx.$executeRawUnsafe(
    'INSERT INTO sis_transcript_courses (id, transcript_id, academic_year, term, ' +
      'course_name, course_code, credits, grade, grade_points, is_honors, is_ap, ' +
      'source_class_id, sort_order) VALUES (...)'
  );
}
```

**There is no UPDATE path on `sis_transcript_courses`** — the service exposes only INSERT-at-generate-time. A future grade change in cls_grades cannot reach back into the existing transcript rows. The next transcript generation will pick up the fresh grade because it re-reads cls_grades at that moment.

**Test coverage:** `sis-transcripts.spec.ts` S2 verifies `transcriptInserts === 1` AND `courseInserts >= 1` AND `gradesQueried === 1` (cls_grades read exactly once at generate time, not on the post-fetch reload).

**Verify in code:**

- `apps/api/src/sis-transcripts/transcript.service.ts` — `generate()` method.
- `apps/api/src/sis-transcripts/sis-transcripts.spec.ts` — S2.
- `packages/database/prisma/tenant/migrations/144_sis_transcripts_transfers.sql` — no UPDATE on `sis_transcript_courses` anywhere; schema is INSERT-only by service contract.

---

## 5. Locker combination encryption

**Claim (P2-13c):** `sis_lockers.combination_encrypted` stores AES-256-GCM ciphertext of the locker combination. Wire format mirrors P2C1 visitor PII + Cycle 22 IT vault: `base64(iv).base64(authTag).base64(ciphertext)` (12-byte iv, 16-byte auth tag). Plaintext is generated by `LockerService.assign()` and returned ONCE in the response — never stored in plaintext anywhere in the system.

**Key derivation:**

```ts
// locker-crypto.ts
const NODE_ENV = process.env.NODE_ENV || 'development';
if (NODE_ENV === 'production' && !process.env.SIS_LOCKER_KEY) {
  throw new Error('SIS_LOCKER_KEY is required in production — ...');
}
const KEY_MATERIAL = process.env.SIS_LOCKER_KEY || 'campusos-demo-locker-combination-key-2026';
function deriveKey() {
  return scryptSync(KEY_MATERIAL, KEY_SALT, 32);
}
```

Production-fail-closed mirrors REVIEW-CYCLE22 BLOCKING 5 and P2C1 visitor PII.

**Combination distribution:**

- `assign()` generates a fresh `NN-NN-NN` combination (or accepts a supplied plaintext), encrypts via AES-256-GCM, writes the ciphertext to `combination_encrypted`, returns the plaintext exactly once on the response.
- Subsequent reads via `GET /sis/students/:id/locker` decrypt on demand — row-scoped to the owning student, linked guardian, or staff / admin. List view (`GET /sis/lockers`) returns `hasCombination: boolean` flag only — never the combination itself.
- Year-end `bulkClear()` clears `combination_encrypted` atomically alongside assigned_to_student_id + assigned_at + academic_year per the `sis_lockers_assignment_chk` lockstep.

**Test coverage:** `sis-transcripts.spec.ts`:

- S6 verifies assign() produces a 3-segment base64 wire, the plaintext does NOT appear in the ciphertext column, and round-trip decryption recovers the plaintext.
- S11 + S12 directly exercise the crypto module — round-trip + wire format.
- S13 verifies `generateCombination()` produces NN-NN-NN shape.

**Verify in code:**

- `apps/api/src/sis-transcripts/locker-crypto.ts`.
- `apps/api/src/sis-transcripts/locker.service.ts` — `assign()`, `bulkClear()`, `getStudentLocker()`.
- Live verification in seed: `seed-sis-advanced-c.ts` writes 6 encrypted combinations on seed; manual psql confirms each `combination_encrypted` is a 3-segment base64 string with the plaintext nowhere to be found.

---

## 6. Parent update auto-approval logic

**Claim (P2-13a):** `sis_auto_approval_rules` configures per-(school, target_type, field_name) auto-approval flags. `ParentUpdateService.submitRequest` walks every field in `proposed_changes` JSONB and:

- If every field has an active `auto_approve=true` rule → status lands AUTO_APPROVED + applied_at populates inside the same tenant tx as the INSERT.
- If any field lacks a true rule OR target_type is high-risk (EMERGENCY_CONTACT) → status lands PENDING for admin review.

**Schema invariants:**

- Multi-column `reviewed_chk` lockstep on `sis_parent_info_update_requests` keeps reviewed_by + reviewed_at populated together for APPROVED / REJECTED (manual review path), accepts PENDING with both NULL, and accepts AUTO_APPROVED unconstrained on reviewer columns.
- Multi-column `applied_chk` keeps applied_at populated only when status is APPROVED or AUTO_APPROVED.

**Service-layer apply path:** on APPROVED or AUTO_APPROVED status, the proposed_changes JSONB is applied to the target table (sis_students / sis_guardians / sis_emergency_contacts) inside the same tenant tx as the status flip. `applied_at` stamps atomically.

**Verify in code:**

- `apps/api/src/sis-advanced/parent-update.service.ts` — `submitRequest()` + `reviewRequest()`.

---

## 7. Cross-cycle integration

| Source                                           | Target                                                                                             | Sub-cycle | Soft / DB-enforced                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------- | ------------------------------------ |
| `sis_custom_field_values.entity_id`              | sis_students / hr_employees / sis_guardians / sis_classes (polymorphic via definition.entity_type) | P2-13a    | Soft (ADR-001)                       |
| `sis_parent_info_update_requests.submitted_by`   | platform.iam_person                                                                                | P2-13a    | Soft (ADR-001)                       |
| `sis_graduation_requirements.specific_course_id` | sis_courses (when requirement_type=SPECIFIC_COURSE)                                                | P2-13b    | Soft (ADR-001)                       |
| `sis_service_learning_hours.reviewed_by`         | platform.iam_person                                                                                | P2-13b    | Soft (ADR-001)                       |
| `sis_student_gpa_snapshots.gpa_config_id`        | sis_gpa_configurations                                                                             | P2-13b    | DB-enforced CASCADE on config delete |
| `sis_transcripts.gpa_config_id`                  | sis_gpa_configurations                                                                             | P2-13c    | Soft (ADR-001)                       |
| `sis_transcripts.generated_by`                   | platform.iam_person                                                                                | P2-13c    | Soft (ADR-001)                       |
| `sis_transcript_courses.source_class_id`         | sis_classes                                                                                        | P2-13c    | Soft (display-only)                  |
| `sis_transcript_requests.linked_invoice_id`      | pay_invoices (Cycle 6)                                                                             | P2-13c    | Soft (ADR-001)                       |
| `sis_lockers.assigned_to_student_id`             | sis_students                                                                                       | P2-13c    | Soft (ADR-001)                       |
| `sis_reporting_periods.academic_year_id`         | sis_academic_years                                                                                 | P2-13c    | Soft (ADR-001)                       |
| `sis_transcripts.student_id`                     | sis_students                                                                                       | P2-13c    | DB-enforced CASCADE                  |
| `sis_transfer_records.student_id`                | sis_students                                                                                       | P2-13c    | DB-enforced CASCADE                  |
| `sis_student_awards.student_id`                  | sis_students                                                                                       | P2-13c    | DB-enforced CASCADE                  |
| `sis_medical_exemption_records.student_id`       | sis_students                                                                                       | P2-13c    | DB-enforced CASCADE                  |

**TranscriptService → Cycle 6 billing keystone:** when `feeAmount > 0` on a transcript request, the service creates a pay_invoice (DRAFT status) + pay_invoice_line_items in the same tenant tx as the request INSERT. The family pays through the normal Cycle 6 family-billing flow. `linked_invoice_id` stamps on the request so admin can reconcile.

**StudentAwardService → P2-13b GPA snapshots keystone:** `bulkHonorRoll()` reads `sis_student_gpa_snapshots` with `cumulative_gpa >= $threshold` to find qualifying students. Idempotent — students already holding a HONOR_ROLL award with the matching (academic_year, term) skip.

---

## 8. Test coverage

- P2-13a: 22 scenarios in `sis-advanced.spec.ts`.
- P2-13b: 17 scenarios in `sis-graduation.spec.ts`.
- P2-13c: 16 scenarios in `sis-transcripts.spec.ts`.

Full suite: **696 / 696 passing across 33 spec files.**

---

## 9. CI parity

```
pnpm format:check    → ✓ All matched files use Prettier code style
pnpm lint:logs       → ✓ 773 files clean
pnpm --filter @campusos/api build  → ✓ nest build (no TS errors)
pnpm --filter @campusos/web build  → ✓ Next.js production build
pnpm --filter @campusos/database build → ✓ Prisma generate + tsc
vitest run                       → ✓ 696 / 696
```

---

## 10. Reviewer attention items (carry to Phase 2 / pre-pilot punch list if applicable)

1. **Custom field generic FK validation against polymorphic entity_id** (P2-13a) — `upsertValues` validates the value column matches the field_type but does not validate that the entity_id actually exists in the target table. Pre-pilot fix: per-definition lookup helper that resolves the right tenant table from `definition.entity_type` and refuses missing target rows.
2. **Graduation audit worker per-school cron schedule** — the worker exposes `runForSchool(schoolId)` but the production cron is Phase 3 ops. A school-admin-triggered manual run endpoint ships today.
3. **Bulk parent-update queue UI redesign** (P2-13a) — admin queue ships with per-row Approve / Reject; batch approval is a polish item.
4. **Transcript PDF rendering pipeline** (P2-13c) — `pdf_s3_key` column ships but generating + uploading the PDF is deferred. Service stamps NULL on generate today.
5. **Reporting period auto-advance worker** (P2-13c) — schema + service ships, but the cron that walks `grades_due_date < now()` and advances OPEN → GRADING_CLOSED is deferred to Phase 3 ops.
6. **Locker key rotation** (P2-13c) — `SIS_LOCKER_KEY` env var supports one key only. Production key rotation (re-encrypt all `combination_encrypted` rows under a new key) is a Phase 3 ops procedure.
7. **Transcript fee payment hook** (P2-13c) — `linked_invoice_id` populates today but flipping `fee_paid=true` when the matching pay_payment lands is deferred. A Cycle 6 consumer can set the flag in a follow-up.
8. **`sis.transcript.generated` Kafka emit** — not emitted today. A future portfolio / parent notification cycle can pick it up by emitting from TranscriptService.generate AFTER tx commits.
9. **`sis_lockers.assigned_to_student_id` is a soft FK** — sis_students delete does not cascade to release the locker. Pre-pilot decision: either tighten to a DB-enforced FK with ON DELETE SET NULL + assignment_chk relaxation, or rely on the admissions flow to release lockers before withdrawing a student.

---

## 11. Migration count + provisioning

- Pre-P2C13: `141_evt_scans_passes.sql`.
- P2-13a: `142_sis_profiles_customfields.sql`.
- P2-13b: `143_sis_graduation_gpa.sql`.
- P2-13c: `144_sis_transcripts_transfers.sql`.

**Splitter audit clean** on all 3 P2-13 migrations on first attempt after the documented audit. Idempotent re-provisions verified on both `tenant_demo` and `tenant_test`. Both tenants now hold 141 applied migrations.

**Cycle 4-onwards splitter-clean streak:** continues — 141 migrations in a row clear the audit before first provision. The `;`-in-block-comment trap from earlier cycles is now caught uniformly via the documented Python audit before every provision attempt.

---

## 12. Commit + tag plan

- Sub-cycle a: `8cc28e8` — tagged after CI green.
- Sub-cycle b: `0900ce1` — tagged after CI green.
- Sub-cycle c: _this commit_ — peer review pending.
- After verdict APPROVED: tag `p2c13-complete` at the closeout commit + `p2c13-approved` at the verdict commit.
