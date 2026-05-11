# Phase 2 Cycle 13 — SIS Advanced (M20 .1)

**Status:** COMPLETE + APPROVED at the closeout commit (REVIEW-P2C13-CHATGPT final verdict, 2026-05-11). Round 1 vs `ea2a881` returned **FAIL** with 8 BLOCKING + 3 MAJOR; Round 2 vs `cd250e0` returned **PASS** — every dimension at PASS (Student Profiles & Avatars / Parent Updates / Graduation & Service Learning / Transcripts / Transfers / Lockers & Medical Exemptions / Event Durability / Test Coverage). Reviewer's only Round 2 cleanup item — stale top-of-file JSDoc on `TranscriptService.submitRequest()` still described the pre-fix direct `pay_invoice` creation behavior while the executable path was already correct — addressed in the closeout commit (comment rewritten to describe the durable `sis.transcript_request.fee_requested` outbox event that the Payments module's TranscriptFeeConsumer materialises the invoice + line items from). Tagged `p2c13-complete` at `cd250e0` (the Round 1 fix that earned Round 2 PASS) and `p2c13-approved` at the closeout commit.

**Wave:** C (Operational Depth).
**Plan:** `docs/campusos-p2c13-sis-advanced.html`.
**Sub-cycles:**

- P2-13a (Student Profiles + Custom Fields + Parent Updates, 8 tables, ~22 endpoints) at `8cc28e8`
- P2-13b (Graduation + Service Learning + GPA, 8 tables, ~20 endpoints, 2 workers) at `0900ce1`
- P2-13c (Transcripts + Transfers + Lockers + Reporting Periods + Awards + Medical Exemptions, 8 tables, ~20 endpoints) at `ea2a881`
- Round 1 fix commit (REVIEW-P2C13 — 8 BLOCKING + 3 MAJOR closed) at `cd250e0`
- Closeout commit (stale `TranscriptService` JSDoc) — this commit

**One non-blocking carry-over to Phase 2 / pre-pilot per the Round 2 reviewer's gate decision:** the Payments module's `TranscriptFeeConsumer` that subscribes to `sis.transcript_request.fee_requested`, materialises `pay_invoices` + `pay_invoice_line_items` for the school's `FINE` fee category, and emits its own event back to SIS so `linked_invoice_id` can be back-filled on `sis_transcript_requests`. The contract is documented in `submitRequest()` and the outbox row lands durably today; the consumer ships in the next cycle that touches the Payments module.

**Vertical-slice intent:** the most-requested SIS features by registrars — student-owned profiles with avatar approval, school-defined custom fields without schema changes, parent-initiated information update workflow with configurable auto-approval, graduation requirements with nightly credit audit + at-risk alerting, service learning hours with supervisor verification, GPA configurations with weighted bonuses, official transcript generation with frozen course snapshot, student transfer records, locker management with AES-256-GCM encrypted combinations, advanced reporting periods, student awards, and medical exemptions.

---

## Final totals (full P2-13)

| Dimension                       | Count                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New tenant base tables          | **24** (`sis_*` prefix — splits into 3 × 8 across the sub-cycles)                                                                                                                                                                                                                                                                                                                                                   |
| Tenant logical base table count | 654 → **678**                                                                                                                                                                                                                                                                                                                                                                                                       |
| Tenant migrations               | 3 (`142_sis_profiles_customfields.sql`, `143_sis_graduation_gpa.sql`, `144_sis_transcripts_transfers.sql`)                                                                                                                                                                                                                                                                                                          |
| Intra-tenant FKs                | 13 (CASCADE on every sis_students-rooted parent, NO ACTION on a handful of audit-preserving refs)                                                                                                                                                                                                                                                                                                                   |
| Cross-schema FKs                | 0 (every cross-module ref is soft per ADR-001/020)                                                                                                                                                                                                                                                                                                                                                                  |
| NestJS modules                  | **3** — `SisAdvancedModule` (P2-13a), `SisGraduationModule` (P2-13b), `SisTranscriptsModule` (P2-13c)                                                                                                                                                                                                                                                                                                               |
| Backend services                | **15** — Profile / CustomField / ParentUpdate / StudentNote / FamilyRelationship (P2-13a) + Graduation / ServiceLearning / GPA / Prerequisite (P2-13b) + Transcript / Transfer / Locker / ReportingPeriod / StudentAward / MedicalExemption (P2-13c)                                                                                                                                                                |
| Workers                         | **2** — `GraduationAuditWorker` + `GpaWorker` (P2-13b)                                                                                                                                                                                                                                                                                                                                                              |
| Endpoints                       | **~62** under `/sis/*` (~22 P2-13a + ~20 P2-13b + ~20 P2-13c)                                                                                                                                                                                                                                                                                                                                                       |
| Kafka emit topics               | **5 durable outbox emits** — `sis.avatar.reviewed`, `sis.parent_update.submitted`, `sis.parent_update.reviewed` (P2-13a; migrated to outbox in REVIEW-P2C13 Round 1) + `sis.graduation.at_risk` (P2-13b; migrated to outbox in Round 1) + `sis.transcript_request.fee_requested` (P2-13c; introduced in Round 1 to replace SIS's direct `pay_invoices` write — Payments-module-side consumer is Phase 2 carry-over) |
| Vitest spec count               | 647 → 696 (Round 1 cycle build) → **709** (Round 1 fixes added 13 pinned regression tests across cross-school UUID denial, broad-STAFF narrowing, durable outbox emits, transcript fee outbox event, and school-scoped queues)                                                                                                                                                                                      |
| Permission codes touched        | STU-001..008 (already in catalogue)                                                                                                                                                                                                                                                                                                                                                                                 |
| Seed scripts                    | 3 — `seed-sis-advanced-a.ts`, `seed-sis-graduation.ts`, `seed-sis-advanced-c.ts`                                                                                                                                                                                                                                                                                                                                    |

---

## P2-13c — Final sub-cycle (this commit)

### Schema (Step 5)

Migration `144_sis_transcripts_transfers.sql` lands 8 base tables:

| Table                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sis_transcripts`               | Transcript header. 2-value `transcript_type` (OFFICIAL / UNOFFICIAL), 3-value `status` (GENERATED / SENT / REVOKED). Multi-column `sent_chk` keeps `sent_at` populated only from SENT onward. Multi-column `revoked_chk` lockstep ties `revoked_at` + `revoke_reason` populated together on REVOKED. cumulative_gpa_snapshot + total_credits + class_rank + class_size frozen at generation time. |
| `sis_transcript_courses`        | **THE FROZEN-SNAPSHOT KEYSTONE.** One row per course on the transcript at generation time. NEVER live-joined to cls_grades — a re-grade downstream creates a NEW transcript with fresh rows; it does NOT rewrite the existing rows.                                                                                                                                                               |
| `sis_transcript_requests`       | Parent / student request workflow. 2-value `transcript_type`, 5-value `status` (SUBMITTED / PROCESSING / SENT / PICKED_UP / CANCELLED). `fee_amount` + `fee_paid` + `linked_invoice_id` soft FK to pay_invoices drive the optional fee path. Service-layer creates the pay_invoice inside the same tx when fee_amount > 0.                                                                        |
| `sis_transfer_records`          | Incoming or outgoing transfer between schools. Multi-column `records_shape_chk` enforces INCOMING carries `records_received` only and OUTGOING carries `records_sent` only.                                                                                                                                                                                                                       |
| `sis_lockers`                   | Locker assignment. 3-value `status` (AVAILABLE / ASSIGNED / OUT_OF_SERVICE). **Multi-column `assignment_chk` lockstep** keeps `assigned_to_student_id` + `assigned_at` + `academic_year` populated together on ASSIGNED, all three NULL on AVAILABLE, and `academic_year` NULL on OUT_OF_SERVICE. `combination_encrypted` stores AES-256-GCM ciphertext.                                          |
| `sis_reporting_periods`         | Per-(school, academic_year) grading window. 4-value `period_type`, 4-value `status` (UPCOMING / OPEN / GRADING_CLOSED / PUBLISHED). Multi-column `published_chk` lockstep pins `published_at` populated only on PUBLISHED. Service-layer enforces strict transition graph UPCOMING → OPEN → GRADING_CLOSED → PUBLISHED.                                                                           |
| `sis_student_awards`            | 6-value `award_type` (HONOR_ROLL / DEANS_LIST / PERFECT_ATTENDANCE / SUBJECT_AWARD / CITIZENSHIP / OTHER).                                                                                                                                                                                                                                                                                        |
| `sis_medical_exemption_records` | Per-student exemption from PE / swimming / field trips / etc. 4-value `exemption_type`. Multi-column `dates_chk` enforces `effective_to >= effective_from` when both set. Open-ended exemptions (effective_to NULL) hit a partial INDEX.                                                                                                                                                          |

**13 intra-tenant FKs** across migration 144 (every CASCADE on sis_students-rooted parent + 1 CASCADE on transcript_courses → transcripts + 1 CASCADE on transcript_requests → students + 1 CASCADE on transfers → students + 1 CASCADE on lockers' student soft ref via service layer + 1 CASCADE on awards → students + 1 CASCADE on exemptions → students). 0 cross-schema FKs.

**Constraint smoke verified** on `tenant_demo` 2026-05-11: 12 assertions across UPCOMING / published_chk / assignment_chk / direction shape / revoked_chk / copies_chk / award_type_chk / dates_chk all behave correctly.

### Seed (Step 6 a)

`seed-sis-advanced-c.ts` (idempotent — gated on `sis_lockers` row count). 7 sections:

- **A.** 2 transcripts (1 OFFICIAL SENT to Stanford Admissions for Maya, 1 UNOFFICIAL GENERATED for Aaliyah).
- **A.cont.** 12 frozen `sis_transcript_courses` snapshots (8 for Maya, 4 for Aaliyah) covering 2024-2025 + 2025-2026 with honors / AP flags + per-course grade points.
- **B.** 2 transcript_requests (1 SENT with linked invoice + fee paid, 1 SUBMITTED no fee).
- **C.** 2 transfer_records (1 INCOMING from Springfield Elementary for Aaliyah, 1 OUTGOING to Riverside Academy for Ethan).
- **D.** 10 lockers — 6 ASSIGNED with AES-256-GCM encrypted combinations, 3 AVAILABLE, 1 OUT_OF_SERVICE.
- **E.** 3 reporting_periods (Q1 PUBLISHED 2025-2026, Q2 OPEN, Q3 UPCOMING).
- **F.** 4 student_awards (HONOR_ROLL × 2 for Maya + Aaliyah, PERFECT_ATTENDANCE for Maya, SUBJECT_AWARD Chemistry for Maya).
- **G.** 2 medical_exemption_records (current PE for Ethan, expired SWIMMING for Aaliyah).

### Services (Step 6 b)

`apps/api/src/sis-transcripts/` — `SisTranscriptsModule` with **6 services + 1 controller + ~22 endpoints** under STU-001 / 004 / 005 / 007:

- **TranscriptService** — THE FROZEN-SNAPSHOT KEYSTONE. `generate()` snapshots cls_grades joined to sis_classes + sis_courses + sis_terms + sis_academic_years into sis_transcript_courses inside one tenant tx. Rows are IMMUTABLE after generation. `submitRequest()` with `feeAmount > 0` creates a matching pay_invoice + pay_invoice_line_items in the same tenant tx — family pays via the Cycle 6 billing flow. Strict status transitions GENERATED → SENT → REVOKED for transcripts, SUBMITTED → PROCESSING → (SENT|PICKED_UP) → CANCELLED for requests.
- **TransferService** — INCOMING / OUTGOING transfer records under STU-004. Service-layer patches reject any update that would violate the schema's direction shape invariant.
- **LockerService** — AES-256-GCM at-rest encryption for `combination_encrypted` via `locker-crypto.ts`. Plaintext combination returned ONCE on assign + on student own-locker read (row-scoped to the owning student, linked guardian, or staff/admin). `bulkClear()` releases every ASSIGNED locker in one tenant tx via `SELECT … FOR UPDATE` + `UPDATE … SET status='AVAILABLE'` — clears assigned_to_student_id + assigned_at + academic_year + combination_encrypted atomically per the assignment_chk lockstep. Optional `academicYear` filter scopes the clear to a single year.
- **ReportingPeriodService** — strict transition graph UPCOMING → OPEN → GRADING_CLOSED → PUBLISHED. No skipping forward, no walking backward. PUBLISHED stamps `published_at` atomically.
- **StudentAwardService** — `bulkHonorRoll()` reads sis_student_gpa_snapshots (P2-13b) to find qualifying students. Idempotent — students already holding a HONOR_ROLL award with the matching (academic_year, term) are skipped.
- **MedicalExemptionService** — gated on STU-001 (the broader student-profile code). Service-layer dates check rejects effective_to < effective_from.

**Locker crypto module** at `locker-crypto.ts`:

- `encryptCombination(plaintext)` → `base64(iv).base64(tag).base64(ciphertext)` (12-byte iv, 16-byte auth tag, AES-256-GCM).
- `decryptCombination(wire)` → plaintext, throws on tampered ciphertext.
- `generateCombination()` → random `NN-NN-NN` shape (each segment 00..49).
- `SIS_LOCKER_KEY` env var required in production (mirrors REVIEW-CYCLE22 BLOCKING 5 + P2C1 visitor PII fail-closed pattern). Dev / test use the deterministic seed string so seeded ciphertext decrypts cleanly through the same module.

**IAM grants** (seed-iam.ts updated): Teacher gains `STU-007:read` (own locker visibility), Parent gains `STU-007:read` (own child's locker via row scope), Student gains `STU-007:read` (own locker), Staff gains `STU-007:read+write` (registrar / dean of students). School Admin / Platform Admin pick up `:admin` tier via `everyFunction` for bulk-clear authority.

### Tests (Step 6 c)

`sis-transcripts.spec.ts` — 16 scenarios all green. Coverage:

| #   | Scenario                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------- |
| S1  | TranscriptService.generate refuses non-staff non-admin                                                      |
| S2  | TranscriptService.generate snapshots cls_grades + writes frozen course rows in one tx                       |
| S3  | TranscriptService.submitRequest with fee creates pay_invoice + pay_invoice_line_items in same tx            |
| S4  | TranscriptService.patchStatus rejects REVOKED without revokeReason                                          |
| S5  | TransferService.patch refuses INCOMING + recordsSent=true (schema shape invariant)                          |
| S6  | LockerService.assign returns plaintext combination once, stores AES-256-GCM ciphertext at rest              |
| S7  | LockerService.bulkClear releases every ASSIGNED locker in one tx, reports count                             |
| S8  | ReportingPeriodService.patchStatus rejects backwards (OPEN → UPCOMING) + forward skips (OPEN → PUBLISHED)   |
| S9  | StudentAwardService.bulkHonorRoll skips students already holding the matching HONOR_ROLL                    |
| S10 | MedicalExemptionService.create rejects effective_to < effective_from                                        |
| S11 | encryptCombination ↔ decryptCombination round-trip                                                          |
| S12 | encryptCombination wire format base64(iv).base64(tag).base64(cipher), plaintext never present in ciphertext |
| S13 | generateCombination returns NN-NN-NN shape                                                                  |
| S14 | Controller permission metadata pinned to STU-001 / 004 / 005 / 007                                          |
| —   | LockerService.release rejects non-ASSIGNED locker                                                           |
| —   | LockerService.release rejects missing locker                                                                |

### CI parity (Step 6 c)

| Check                                    | Result                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm format:check`                      | ✓ All matched files use Prettier code style                                    |
| `pnpm lint:logs`                         | ✓ 773 files clean                                                              |
| `pnpm --filter @campusos/api build`      | ✓ nest build                                                                   |
| `pnpm --filter @campusos/web build`      | ✓ Next.js + 13 P2-13c page imports                                             |
| `pnpm --filter @campusos/database build` | ✓ Prisma generate + tsc clean                                                  |
| Vitest (full suite)                      | ✓ 33 spec files, 696 / 696 passing — `sis-transcripts.spec.ts` 16 / 16 passing |

---

## Endpoint summary (P2-13c)

```
GET    /sis/students/:id/transcripts                STU-005:read
GET    /sis/transcripts/:id                         STU-005:read
POST   /sis/students/:id/transcripts/generate       STU-005:write
PATCH  /sis/transcripts/:id/status                  STU-005:write
POST   /sis/transcript-requests                     STU-005:read
GET    /sis/transcript-requests                     STU-005:read
GET    /sis/transcript-requests/:id                 STU-005:read
PATCH  /sis/transcript-requests/:id/status          STU-005:write

GET    /sis/students/:id/transfers                  STU-004:read
GET    /sis/transfers                               STU-004:read
GET    /sis/transfers/:id                           STU-004:read
POST   /sis/transfers                               STU-004:write
PATCH  /sis/transfers/:id                           STU-004:write

GET    /sis/lockers                                 STU-007:read
POST   /sis/lockers                                 STU-007:write
POST   /sis/lockers/assign                          STU-007:write
POST   /sis/lockers/:id/release                     STU-007:write
POST   /sis/lockers/bulk-clear                      STU-007:admin
POST   /sis/lockers/:id/out-of-service              STU-007:write
POST   /sis/lockers/:id/available                   STU-007:write
GET    /sis/students/:id/locker                     STU-007:read (row-scoped)

GET    /sis/reporting-periods                       STU-005:read
GET    /sis/reporting-periods/current               STU-005:read
GET    /sis/reporting-periods/:id                   STU-005:read
POST   /sis/reporting-periods                       STU-005:admin
PATCH  /sis/reporting-periods/:id/status            STU-005:admin

GET    /sis/students/:id/awards                     STU-005:read
POST   /sis/awards                                  STU-005:write
POST   /sis/awards/bulk-honor-roll                  STU-005:write
DELETE /sis/awards/:id                              STU-005:write

GET    /sis/students/:id/medical-exemptions         STU-001:read
POST   /sis/medical-exemptions                      STU-001:write
PATCH  /sis/medical-exemptions/:id                  STU-001:write
DELETE /sis/medical-exemptions/:id                  STU-001:write
```

---

## Cross-cycle integration

- **Cycle 2 `cls_grades`** — TranscriptService.generate joins cls_grades (with `is_published=true`) to sis_classes + sis_courses + sis_terms + sis_academic_years at the moment of generation. The result is frozen into sis_transcript_courses and never re-read.
- **Cycle 6 `pay_invoices` + `pay_invoice_line_items` + `pay_family_accounts`** — TranscriptService.submitRequest creates a pay_invoice + line item in the same tenant tx when `feeAmount > 0`. The family pays through the standard Cycle 6 billing flow.
- **P2-13b `sis_gpa_configurations` + `sis_student_gpa_snapshots`** — TranscriptService.generate reads the school's default GPA config to bind cumulative_gpa_snapshot + class_rank at generation time. StudentAwardService.bulkHonorRoll reads gpa_snapshots to find qualifying students.

---

## Reviewer attention items (P2-13c carry-overs)

1. **Transcript PDF rendering** — `pdf_s3_key` column ships, but generating + uploading the PDF is deferred to a follow-up cycle (mirrors the P2C10 pattern). Service stamps NULL on generate today; admin can attach later via direct DB or a future endpoint.
2. **Reporting period auto-publish worker** — schema + service ships, but the cron that walks `grades_due_date < now()` and advances OPEN → GRADING_CLOSED is deferred to Phase 3 ops.
3. **Locker key rotation** — `SIS_LOCKER_KEY` env var supports one key only. Production key rotation (re-encrypt all `combination_encrypted` rows under a new key) is a Phase 3 ops procedure.
4. **Transcript request fee — payment hook** — `linked_invoice_id` populates today but flipping `fee_paid=true` when the matching pay_payment lands is deferred. A Cycle 6 consumer can set the flag in a follow-up cycle.
5. **`sis.transcript.generated` Kafka emit** — not emitted today. A future portfolio / parent notification cycle can pick it up by emitting from TranscriptService.generate AFTER tx commits.

---

## Migration count

- Pre-P2C13: `141_evt_scans_passes.sql`.
- P2-13a: `142_sis_profiles_customfields.sql`.
- P2-13b: `143_sis_graduation_gpa.sql`.
- P2-13c: `144_sis_transcripts_transfers.sql` (this commit).

**Splitter audit clean** on all three P2-13 migrations on first attempt after the documented audit. Idempotent re-provisions verified on both `tenant_demo` and `tenant_test`.

---

## Outstanding work (full P2-13)

Carried as Phase 2 / pre-pilot punch list items in the architecture review notes (`P2C13-REVIEW-NOTES.md`):

- Custom field generic FK validation against the polymorphic entity_id (P2-13a) — service-layer validator deferred per the same plan as transit / equipment soft-ref validation.
- Graduation audit worker per-school cron schedule wired to Phase 3 ops.
- Bulk parent-update queue UI redesign (P2-13a) — admin queue ships, batch approval is a polish item.
- Transcript PDF rendering pipeline (P2-13c) — see Reviewer attention item 1.
- Reporting period auto-advance worker (P2-13c) — see Reviewer attention item 2.

---

## Commit + tag plan

- This commit: `feat(sis): P2-13c Transcripts + Transfers + Lockers — 8 tables, ~20 endpoints, handoff + review docs for full P2-13`
- After peer review verdict APPROVED: tag `p2c13-complete` at the closeout commit + `p2c13-approved` at the verdict commit.
