# Cycle 1 Architecture Review — ChatGPT (Adversarial)

**Reviewer:** ChatGPT
**Date:** April 27, 2026
**Scope:** Full Cycle 1
**Verdict:** Reject pending fixes

## Summary: 8 PASS · 4 DEVIATION · 6 VIOLATION

---

## Critical Violations

### VIOLATION 1 — Tenant isolation is not connection-safe (PRIORITY 1 — CRITICAL)

`TenantPrismaService.executeInTenantContext()` sets `search_path` using a shared Prisma client, then executes the callback on that same client outside a transaction. With Prisma pooling, `SET search_path` is not guaranteed to bind to the same connection used by the subsequent query, and concurrent requests can bleed schema state.

**ADR violated:** ADR-001 (schema-per-tenant isolation)

**Required fix:** Make every tenant-scoped operation run inside an interactive transaction with `SET LOCAL search_path`, or use a tenant-scoped connection/session abstraction. `executeInTenantTransaction()` is closer to correct; `executeInTenantContext()` should be rewritten to use the same pattern.

**Triage (Claude):** VALID. This is the most serious finding. Could cause actual cross-tenant data leakage under concurrent load. Fix immediately.

---

### VIOLATION 2 — Parent/student users can read too much student data (PRIORITY 2)

Parent and Student roles have `stu-001:read`. But `GET /students`, `GET /students/:id`, and `GET /students/:id/guardians` are protected only by `stu-001:read` with no relationship-based row filter. `StudentService.list()` returns tenant-wide students.

**Required fix:** Add row-level authorization:

- Parents: only linked children (via sis_student_guardians)
- Students: only self
- Teachers: only students in assigned classes
- Admins: school-wide scope

**Triage (Claude):** VALID. Real PII exposure risk. Fix before Cycle 2.

---

### VIOLATION 3 — Attendance writes are not assignment-scoped (PRIORITY 2)

Teachers have `att-001:write` at SCHOOL scope. The mark and batch attendance endpoints require `att-001:write` but do not verify the caller is assigned to the class before writing.

**Required fix:** Before marking attendance, enforce:

- School admin scope bypasses, or
- `sis_class_teachers` mapping for the caller and that class, or
- Future class-level IAM scope

**Triage (Claude):** VALID. Any teacher can mark attendance for any class. Fix alongside Violation 2.

---

### VIOLATION 4 — Admin detection can bleed across scopes (PRIORITY 3)

`callerIsAdmin()` uses `hasAnyPermissionAcrossScopes()` which checks all cached scopes, not the current tenant's scope chain. A user with `att-004:admin` in one school could be treated as admin in another school.

**Required fix:** Replace `hasAnyPermissionAcrossScopes()` with a current-scope-chain admin check.

**Triage (Claude):** PARTIALLY VALID. Theoretical risk — no multi-school users exist yet. But architecturally incorrect. Easy fix, do it alongside others.

---

### VIOLATION 5 — Kafka events do not follow ADR-057 envelope (PRIORITY 4)

ADR-057 requires a canonical envelope with `event_id`, `event_type`, `event_version`, `occurred_at`, `published_at`, `tenant_id`, `source_module`, `correlation_id`, and `payload`. It also specifies `{env}.{domain}.{entity}.{verb}` topic naming. Current Kafka producer sends raw JSON payloads.

**Required fix:** Centralize event envelope creation in `KafkaProducerService.emit()` and add env prefixing.

**Triage (Claude):** VALID but LOW PRIORITY. No consumers exist yet (Cycle 3 builds them). Add a TODO and implement the envelope when the first consumer lands. Don't delay Cycle 1 closure for this.

---

### VIOLATION 6 — GuardTestController still in production (TRIVIAL)

`GuardTestController` is registered in `AppModule`. The controller itself says "Remove this controller before production."

**Required fix:** Remove from production builds or gate behind dev-only module flag.

**Triage (Claude):** VALID. Trivial fix.

---

## Deviations Accepted

1. `TEXT + CHECK` instead of native PG ENUM — acceptable for tenant migrations
2. `class-validator` DTOs instead of shared Zod schemas — acceptable short term
3. Two-level scope traversal `[school, platform]` — acceptable for Cycle 1, must be expanded
4. Best-effort Kafka emit — acceptable only until consumers exist

---

## Passes

1. Attendance partitioning matches ADR-007: RANGE by `school_year` with HASH by `class_id`
2. Identity model via `sis_students → platform_students → iam_person` is correct
3. `POST /students` is transactional across platform and tenant inserts
4. Auth endpoints correctly marked `@Public()` where appropriate
5. Health endpoint is public
6. PermissionGuard fails closed when `request.user` is missing
7. IAM hot-path checks use `iamEffectiveAccessCache`, not role-permission joins
8. Frozen tenant write-gate exists in `TenantGuard`

---

## Fix Priority Order

| Priority | Violation                     | Risk                      | Effort            |
| -------- | ----------------------------- | ------------------------- | ----------------- |
| 1        | search_path connection safety | Cross-tenant data leakage | Medium            |
| 2        | Row-level student data auth   | PII exposure              | Medium            |
| 2        | Attendance assignment scoping | Unauthorized writes       | Small             |
| 3        | Cross-scope admin detection   | Theoretical escalation    | Small             |
| 4        | Kafka ADR-057 envelope        | Contract non-compliance   | TODO only for now |
| 5        | GuardTestController removal   | Dev artifact in prod      | Trivial           |
