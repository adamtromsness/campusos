# Cycle 1 Review Fix Instructions

Both architecture reviewers (Claude and ChatGPT) have completed their reviews.
Their full findings are in REVIEW-CYCLE1-CLAUDE.md and REVIEW-CYCLE1-CHATGPT.md.

Fix the following violations in priority order. After all fixes, update
HANDOFF-CYCLE1.md and CLAUDE.md, then commit with message:
"fix: address architecture review violations (REVIEW-CYCLE1)"

---

## Fix 1 — CRITICAL: Tenant search_path connection safety

Rewrite `TenantPrismaService.executeInTenantContext()` to use `SET LOCAL search_path`
inside an interactive transaction, same pattern as `executeInTenantTransaction()`.

Current `executeInTenantContext()` sets `search_path` on a shared client outside a
transaction. With Prisma connection pooling, `SET search_path` is not guaranteed to
bind to the same connection used by the subsequent query. Concurrent requests can
bleed schema state — this is a cross-tenant data leakage risk.

`SET LOCAL` is transaction-scoped and automatically reverts when the transaction ends.
All existing callers of `executeInTenantContext` should work unchanged.

---

## Fix 2 — Row-level authorization for student data

Add relationship-based row filtering to StudentService:

- **Parents:** `GET /students` returns only linked children (join sis_student_guardians
  where guardian.person_id = caller's personId). `GET /students/:id` returns 403 if
  the caller is not a linked guardian.
- **Students:** `GET /students` returns only self. `GET /students/:id` returns 403
  if the student ID doesn't match the caller.
- **Teachers:** `GET /students` returns only students enrolled in the teacher's
  assigned classes (join sis_class_teachers + sis_enrollments).
- **Admins (School Admin, Platform Admin):** No filter — school-wide access.

Apply the same filtering to `GET /students/:id/guardians`.

Determine the caller's role by checking their personType from the JWT payload
or by querying sis_staff/sis_guardians/sis_students for the caller's personId.

---

## Fix 3 — Attendance writes must verify class assignment

Before marking attendance (PATCH /attendance/:id and POST /classes/:id/attendance/:date/batch),
verify the caller is assigned to that class via sis_class_teachers.

- Query: does sis_class_teachers have a row where teacher_employee_id matches the
  caller's staff record (sis_staff.person_id = caller's personId)?
- School Admins and Platform Admins bypass this check.
- If the caller is not assigned, return 403 with message "You are not assigned to this class."

---

## Fix 4 — Replace hasAnyPermissionAcrossScopes with scope-chain check

`callerIsAdmin()` in the absence request service uses `hasAnyPermissionAcrossScopes()`
which checks ALL cached scopes, not just the current tenant's scope chain.

Replace with a check against the current tenant's scope chain only (the same
[school, platform] chain that PermissionGuard.resolveScopeChain returns).

---

## Fix 5 — Remove GuardTestController from production

Either:

- Remove `GuardTestController` from `AppModule` imports entirely, or
- Gate it: only register when `process.env.NODE_ENV !== 'production'`

---

## Fix 6 — Kafka ADR-057 envelope (TODO only)

Add a TODO comment block at the top of `KafkaProducerService.emit()` noting:

```
// TODO (Cycle 3): Implement ADR-057 canonical event envelope.
// Required fields: event_id, event_type, event_version, occurred_at,
// published_at, tenant_id, source_module, correlation_id, payload.
// Topic naming: {env}.{domain}.{entity}.{verb}
// See: docs/campusos-erd-v11.html → ADR-057
```

Do not change the emit behavior now — no consumers exist yet.

---

## Fix 7 — Redis caching for PermissionGuard scope lookup (from Claude review)

Add Redis caching to `PermissionGuard.resolveScopeChain()` with a 60-second TTL.
Key: `scope-chain:{schoolId}`. Invalidate on scope creation/deletion.
The scope-to-school mapping changes extremely rarely.

---

## Fix 8 — Wire build-cache.ts into seed pipeline (from Claude review)

Either:

- Add cache rebuild as the final step of `seed-iam.ts`, or
- Create a `pnpm db:seed:all` script in packages/database/package.json that runs:
  seed → seed-iam → seed:sis → build-cache in order

A developer running the full seed pipeline should get a working system without
knowing about internal implementation details.

---

## After all fixes

1. Update HANDOFF-CYCLE1.md — add a "Review fixes" section documenting what changed
2. Update CLAUDE.md — reflect any new conventions (e.g., always use SET LOCAL, row-level auth pattern)
3. Commit and push
