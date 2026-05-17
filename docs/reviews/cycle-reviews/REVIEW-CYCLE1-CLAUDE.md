# Cycle 1 Architecture Review — Claude

**Reviewer:** Claude (Architecture Review)
**Date:** April 27, 2026
**Scope:** Steps 1–11 (full cycle)
**Sources:** CLAUDE.md (Steps 1–9), HANDOFF-CYCLE1.md (Steps 1–6 detailed), ERD v11, Architecture Review v10, Function Library v11

## Summary: 14 PASS · 5 DEVIATION · 2 VIOLATION

---

## 1. Schema Compliance

**PASS** — The 18 tenant tables match the ERD's M20 SIS Core module. Academic structure (7 tables), student/family (8 tables), attendance (3 tables) are all present with correct column sets.

**PASS** — `sis_attendance_records` partitioning matches ADR-007 exactly: RANGE(school_year) → HASH(class_id, 8 buckets). Composite PK includes partition keys. BRIN index on date. 4 year partitions × 8 hash leaves = 32 leaf partitions.

**PASS** — Partial unique indexes implemented correctly: `sis_academic_years` one-current constraint, `sis_enrollments` active-enrollment uniqueness.

**DEVIATION (acceptable)** — TEXT+CHECK instead of PG ENUM types. Documented, justified by the SQL migration splitter limitation. Same domain enforcement, easier evolution.

**DEVIATION (acceptable)** — ERD shows M20 SIS Core as 30 tables; Cycle 1 implements 18. The remaining 12 (discipline tables, transfer records, course proposals, active accommodations, etc.) are deferred appropriately — they depend on modules not yet built (Health, Counselling).

---

## 2. ADR Compliance

**PASS** — ADR-001 (tenant isolation): All 12 cross-schema FK constraints removed. Soft UUID refs with app-layer validation. Confirmed in the handoff's architecture review response section.

**PASS** — ADR-002 (UUIDv7): All PKs generated via `generateId()` in the application layer.

**PASS** — ADR-007 (attendance partitioning): Correctly implemented as documented above.

**PASS** — ADR-031 (frozen gate): Inherited from Cycle 0 TenantGuard, still operational.

**PASS** — ADR-055 (identity): `sis_students → platform_students.person_id → iam_person.id` projection chain correct. `sis_staff` and `sis_guardians` reference `iam_person` directly. `POST /students` creates all three records atomically via `executeInTenantTransaction`.

**PASS** — ADR-036 (IAM): Guard chain Auth → Tenant → Permission all in AppModule. PermissionGuard fails closed. Two-level scope chain [school, platform] unblocks Platform Admins.

---

## 3. Permission Guards

**PASS** — All 18 API endpoints have `@RequirePermission` with correct function codes. Permission tiers align with the Function Library: read for viewing, write for marking/submitting, admin for reviewing absence requests.

**DEVIATION (acceptable)** — 444 permission codes vs the Function Library's 148 functions × 3 tiers = 444. The handoff documents that the catalogue was reconciled (5 stale removed, 11 new added) to reach 148 functions exactly. Permission reconciliation in `seed-iam.ts` is self-healing.

---

## 4. Tenant Isolation

**PASS** — All SIS services use `TenantPrismaService.executeInTenantContext()` for reads and `executeInTenantTransaction()` for multi-table writes. Cross-schema joins use explicit `platform.iam_person` qualification.

**PASS** — No DB-enforced FK constraints between tenant and platform schemas. Soft refs only.

---

## 5. Identity Model

**PASS** — The transitive identity path `sis_students → platform_students → iam_person` matches the ERD. `PATCH /students` correctly cannot modify `firstName`/`lastName` (identity is immutable from the tenant layer).

**DEVIATION (acceptable)** — ADR-055 prose describes `sis_students` as a "projection of iam_person" but the actual path goes through `platform_students`. The handoff correctly flags this as a documentation clarification backlog item, not a code issue.

---

## 6. Event Contracts

**PASS** — Kafka events follow the `{domain}.{entity}.{verb}` naming convention: `att.attendance.marked`, `att.attendance.confirmed`, `att.student.marked_tardy`, `att.student.marked_absent`, `att.absence.requested`, `att.absence.reviewed`. All six expected events are emitted.

**PASS** — Best-effort fire-and-forget pattern with logged warnings on broker unavailability. Correct for Cycle 1 where no consumers exist yet.

---

## 7. UI Layer (Steps 7–11)

**PASS** — CLAUDE.md documents: AuthProvider with JWT/refresh, ApiClient with Bearer + X-Tenant-Subdomain, persona-aware routing (teacher vs parent dashboard), permission-driven sidebar, and the correct React Query hooks wired to the API endpoints.

**DEVIATION (acceptable)** — HANDOFF-CYCLE1.md was stale for Steps 7–11 at time of review. The CLAUDE.md Project Status and Project Structure sections reflect the UI work. The operating rules added to CLAUDE.md should prevent this going forward.

---

## 8. Violations

### VIOLATION 1 — `PermissionGuard.resolveScopeChain` has no caching

Every API request triggers a Postgres query to look up the school's IAM scope. With the UI making multiple rapid API calls per page load (teacher dashboard fetches `/classes/my` plus attendance summaries per class), this adds unnecessary latency.

**Required fix:** Add Redis caching for the scope lookup with a 60-second TTL. The scope-to-school mapping changes extremely rarely (only when scopes are created or deleted).

### VIOLATION 2 — `build-cache.ts` is not wired into the seed pipeline

A fresh clone that runs the seed pipeline will have an empty effective access cache unless the developer knows to manually run `build-cache.ts`. The README lists it, but it should be automatic.

**Required fix:** Wire `build-cache.ts` as the final step of `seed-iam.ts`, or create a `pnpm db:seed:all` script that runs the complete pipeline.

---

## 9. Questions for the Architect

1. **ERD shows `parent_explained_at TIMESTAMPTZ` on `sis_attendance_records`.** Was this column included in the migration? The HANDOFF lists `parent_explanation` but doesn't mention the timestamp companion field.

2. **ERD mentions `sis_course_proposals` as part of M20 SIS Core.** Should it be tracked for Cycle 2 or a later cycle?

3. **The `sis_student_active_accommodations` read model** is documented in the ERD under M20 SIS Core. When the Health module is built (Wave 2), will this table be added to the SIS tenant migration or handled by the Health module?
