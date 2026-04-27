# CampusOS

Cloud-native, multi-tenant School Operating System. Replaces 8–15 disconnected school software systems with one platform.

## Project Status

Cycle 0 (Platform Foundation) is COMPLETE. **Cycle 1 (SIS Core + Attendance) is COMPLETE — all 11 steps done.** Schema, seed, SIS API, Attendance API + Kafka emits, web UI shell, Teacher Dashboard, Attendance Taking UI with confirm modal + batch submit, Parent Dashboard + child attendance calendar + absence-request form, AdminDashboard (school-wide overview + pending-absence queue), and a verified end-to-end vertical slice (`docs/cycle1-cat-script.md`). Cycle 2 (Classroom + Assignments + Grading) is the next cycle.
See `docs/campusos-cycle1-implementation-plan.html` for the detailed step-by-step plan, and `HANDOFF-CYCLE1.md` for current build state and known gaps.

## Architecture

- **840 tables** across 38 modules, governed by 76 ADRs (Architecture Decision Records)
- Schema-per-tenant multi-tenancy (PostgreSQL `search_path` switching)
- Modular monolith (NestJS) with planned extraction of 6 services
- Event-driven via Kafka
- 5-wave delivery plan

## Tech Stack

- **Backend:** NestJS 10 (TypeScript strict), Node.js 22 (CI + production image)
- **Frontend:** Next.js 14 (App Router, Tailwind CSS, React Query, Zustand)
- **Database:** PostgreSQL 16 (Prisma ORM, schema-per-tenant)
- **Cache:** Redis 7 (ioredis)
- **Events:** Apache Kafka (KafkaJS)
- **Auth:** External IdP via OIDC (Keycloak for dev). CampusOS never stores passwords.
- **Monorepo:** pnpm + Turborepo

## Project Structure

```
apps/api/                → NestJS backend (modular monolith)
apps/api/src/auth/       → AuthGuard (JWT), PermissionGuard, @Public, @RequirePermission
apps/api/src/tenant/     → TenantResolverMiddleware, TenantGuard, TenantPrismaService, AsyncLocalStorage
apps/api/src/iam/        → Roles, permissions, assignments, effective access cache
apps/api/src/platform/   → M0 Platform Core
apps/api/src/sis/        → M20 SIS Core (Cycle 1 Step 5): students, classes, families, guardians; /classes/my includes todayAttendance summary (Step 8)
apps/api/src/attendance/ → ATT-001..005 (Cycle 1 Step 6): attendance + absence requests + Kafka emits
apps/api/src/kafka/      → KafkaProducerService (best-effort emit)
apps/web/                → Next.js 14 frontend (App Router, Tailwind, React Query, Zustand)
apps/web/src/lib/        → api-client (Bearer + X-Tenant-Subdomain, single-flight 401→refresh), auth-store (Zustand), auth-context, query-client, shared TS types
apps/web/src/components/ui/        → Avatar, StatusBadge, LoadingSpinner, EmptyState, PageHeader, Modal, Toast (provider+useToast), DataTable, cn helper
apps/web/src/components/shell/     → AppLayout (responsive drawer), Sidebar (persona + permission-driven), TopBar (avatar menu, sign-out), inline SVG icons
apps/web/src/components/dashboard/ → TeacherDashboard (Step 8), ParentDashboard (Step 10), AdminDashboard (Step 11)
apps/web/src/hooks/      → React Query hooks: useMyClasses, useClasses, useClass, useClassAttendance, useBatchSubmitAttendance, useAbsenceRequests, useMyChildren, useStudent, useStudentAttendance, useSubmitAbsenceRequest
apps/web/src/app/        → Next.js routes: /login, /(app)/dashboard (persona-aware: sch-001:admin→Admin, STAFF→Teacher, GUARDIAN→Parent), /(app)/classes/[id]/attendance, /(app)/children/[id]/attendance, /(app)/children/[id]/absence-request
packages/database/       → Prisma schema, tenant SQL migrations, provisioning, seed scripts. `build` script chains `prisma generate` before tsc so CI/Docker builds are self-sufficient.
packages/shared/         → Shared TypeScript types and constants
```

## Key Design Contracts

- **Identity (ADR-055):** `iam_person` is the canonical FK for human identity. `platform_users` is ONLY for auth/audit columns. Domain projections (`sis_staff`, `sis_guardians`) carry direct `person_id` refs to `iam_person`. `sis_students` is a transitive projection — its identity path is `sis_students → platform_students.person_id → iam_person.id` (`platform_students` exists for cross-school student portability).
- **Soft cross-schema refs (ADR-001/020/028):** Tenant tables MUST NOT have DB-enforced FK constraints to `platform.*` tables. UUID columns + app-layer Prisma validation only. Cross-schema joins on the read path are fine; FK constraints are not. Health monitoring of soft refs is a future concern (`platform_reference_health`).
- **Permissions:** 444 permission codes (148 functions × 3 tiers: read/write/admin). Check codes, never role names. Use `@RequirePermission('att-001:write')`. Catalogue is reconciled from `packages/database/data/permissions.json` by `seed-iam.ts` — adds new codes, removes stale ones.
- **Tenancy (ADR-001):** Every tenant query uses `search_path = tenant_<id>, platform, public`. Platform tables are shared. Tenant tables are isolated. Schema-per-tenant — never store tenant_id columns on tenant-scoped tables.
- **UUIDs (ADR-002):** All PKs are UUIDv7, generated in the application layer via `generateId()` from `@campusos/database`.
- **Attendance partitioning (ADR-007):** `sis_attendance_records` is composite-partitioned `RANGE(school_year) → HASH(class_id) MODULUS 8`. Composite PK `(id, school_year, class_id)`. Queries should include `class_id` and `date` (or `school_year`) in the predicate to enable partition pruning. Year partitions cover 2024-08 through 2028-08; rotation is a future M0 job.
- **Frozen state (ADR-031):** `is_frozen=true` blocks all writes. Reads still work.
- **Guard order (Auth → Tenant → Permission):** All three guards are registered as `APP_GUARD` in `AppModule` to make order deterministic. `PermissionGuard` fails closed if `request.user` is missing.
- **Scope inheritance (ADR-036, partial):** `PermissionGuard.resolveScopeChain` checks SCHOOL scope first, then PLATFORM scope. Lets Platform Admins act against any tenant without per-school role assignments. Full district/department/class traversal is future work.
- **No implicit access:** Guardian access derived from `iam_relationship_access_rule`, never assumed.

## Guard Chain (every request)

TenantResolverMiddleware → AuthGuard (JWT) → TenantGuard (frozen check) → PermissionGuard (@RequirePermission)

## Commands

```bash
# Start local services
docker compose up -d

# Start API (dev mode, port 4000, watch)
pnpm --filter @campusos/api dev

# Start web (dev mode, port 3000)
pnpm --filter @campusos/web dev

# Run tests
pnpm test

# Database migrations (platform schema, Prisma)
pnpm --filter @campusos/database migrate

# Tenant schema migrations
# Add SQL file to packages/database/prisma/tenant/migrations/ (numbered: 005_*.sql, 006_*.sql, ...)
# Then re-provision:
pnpm --filter @campusos/database provision --subdomain=demo
pnpm --filter @campusos/database provision --subdomain=test

# Seed pipeline (run in order)
pnpm --filter @campusos/database seed                       # platform: org, school, 5 test users, Chen family, provisions tenant_demo
pnpm --filter @campusos/database exec tsx src/seed-iam.ts   # 444 permissions, 6 roles, role-permission mappings, role assignments
pnpm --filter @campusos/database seed:sis                   # 15 students, 10 guardians, 8 families, 41 enrollments + attendance
pnpm --filter @campusos/database exec tsx src/build-cache.ts  # rebuild iam_effective_access_cache (run after any role/permission change)

# Rebuild from corrupted state (drops and re-provisions tenant schemas)
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "DROP SCHEMA IF EXISTS tenant_demo CASCADE; DROP SCHEMA IF EXISTS tenant_test CASCADE;"
pnpm --filter @campusos/database provision --subdomain=demo
pnpm --filter @campusos/database provision --subdomain=test
pnpm --filter @campusos/database seed:sis        # idempotent: lookup-or-create on platform identities
pnpm --filter @campusos/database exec tsx src/build-cache.ts

# Prisma studio (visual DB browser, platform schema only)
pnpm --filter @campusos/database studio
```

## Database

- **Platform schema** (~27 tables): organisations, schools, iam_person, platform_users, platform_students, platform_families, roles, permissions (**444 codes**), iam_scope, iam_role_assignment, iam_effective_access_cache, and more. Managed by Prisma at `packages/database/prisma/platform/schema.prisma`.
- **Tenant schema** (23 base tables after Cycle 1): 5 from Cycle 0 foundation (school_config, school_feature_flags, grading_scales, custom_field_definitions, custom_field_values) + 18 SIS tables from Cycle 1 (sis_academic_years, sis_terms, sis_departments, sis_courses, sis_classes, sis_class_teachers, sis_enrollments, sis_families, sis_students, sis_staff, sis_guardians, sis_student_guardians, sis_family_members, sis_emergency_contacts, sis_student_notes, sis_absence_requests, sis_attendance_records, sis_attendance_evidence). Plus 36 partition objects under sis_attendance_records (4 year partitions × 8 hash leaves + 4 year parents).
- Tenant migrations are SQL files in `packages/database/prisma/tenant/migrations/`, split by semicolons, each statement executed individually by `provision-tenant.ts`. **Caveat:** statements that start with `--` after trim are filtered out — keep header comments minimal or use `/* … */`.
- Tenant SQL must be idempotent: use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `DROP CONSTRAINT IF EXISTS … ; ADD CONSTRAINT …` for FK changes (Postgres has no `ADD CONSTRAINT IF NOT EXISTS`).
- Enum-like columns use `TEXT + CHECK IN (…)` rather than PG `ENUM` types — `CREATE TYPE` isn't idempotent under the SQL splitter.

## Test Users (seeded, Keycloak)

| Email                       | Role                                 | Password   |
| --------------------------- | ------------------------------------ | ---------- |
| admin@demo.campusos.dev     | Platform Admin (all 444 permissions) | admin123   |
| principal@demo.campusos.dev | School Admin                         | admin123   |
| teacher@demo.campusos.dev   | Teacher (James Rivera)               | teacher123 |
| student@demo.campusos.dev   | Student (Maya Chen)                  | student123 |
| parent@demo.campusos.dev    | Parent (David Chen, Maya's father)   | parent123  |

Dev login: `POST /api/v1/auth/dev-login` with `{"email":"..."}` and `X-Tenant-Subdomain: demo` header.

## Design Documents (authoritative references)

Read these when you need table definitions, column details, ADR specifics, or permission descriptions:

- `docs/campusos-erd-v11.html` — Complete schema: all 840 tables with full column definitions, indexes, constraints, Kafka events, ADR cross-references
- `docs/campusos-architecture-review-v10.html` — 30 sections: system architecture, multi-tenancy, IAM, events, scalability, security
- `docs/campusos-function-library-v11.html` — 148 functions, 28 groups, 3 access tiers each
- `docs/campusos-dev-deployment-plan.html` — Build pipeline, environments, Wave 1 sequence
- `docs/campusos-business-strategy.html` — Pricing, team, GTM, community exchange
- `docs/campusos-cycle1-implementation-plan.html` — Cycle 1 plan: 11 steps for SIS + Attendance
- `docs/cycle1-cat-script.md` — Cycle 1 Customer Acceptance Test script (the Step 11 deliverable; reproducible end-to-end walkthrough)

## Conventions

- Tenant-scoped tables use SQL migrations in `packages/database/prisma/tenant/migrations/`
- Platform tables use Prisma schema in `packages/database/prisma/platform/schema.prisma`
- NestJS modules follow the pattern: module.ts, service.ts, controller.ts, dto/ in `apps/api/src/<domain>/`
- Every API endpoint needs `@RequirePermission()` unless marked `@Public()`. New global guards must be registered in `AppModule` (not in submodules) so guard ordering stays deterministic
- Use `TenantPrismaService.executeInTenantContext(fn)` for **single-statement** tenant queries (read or single-table write)
- Use `TenantPrismaService.executeInTenantTransaction(fn)` for **multi-statement** writes that must be atomic (e.g. cross-schema inserts that span platform + tenant tables, like `POST /students`)
- Tenant tables aren't in the Prisma schema — query via `client.$queryRawUnsafe<RowType[]>(sql, ...args)` / `client.$executeRawUnsafe(sql, ...args)`. Always cast UUID args explicitly: `$1::uuid`. Same for `$1::date`. Prisma sends raw query parameters as TEXT and Postgres won't auto-coerce
- Schema-qualify cross-schema reads (`platform.iam_person`) to be explicit
- DTOs use `class-validator` + `class-transformer` (global ValidationPipe in `main.ts`). The `packages/shared` Zod option is unused so far
- Kafka events follow `{domain}.{entity}.{verb}` naming (e.g. `att.student.marked_tardy`)
- No DROP TABLE, no DROP COLUMN in migrations. Additive only. (Pre-deployment edits to fix architectural errors are categorically different — re-provision the tenant.)
- Snake_case in SQL, camelCase in TypeScript. Map at the service layer with a `rowToDto` helper
- **Web auth gating uses `personType` + permission codes from `/auth/me`** for menu visibility and persona routing only. Backend `PermissionGuard` is the authoritative access check on every request.
- **Web fetch wrapper (`apps/web/src/lib/api-client.ts`)** sends `X-Tenant-Subdomain: demo` (override via `NEXT_PUBLIC_TENANT_SUBDOMAIN`) and Bearer token. On 401 it single-flights `/auth/refresh` and retries once; on terminal 401 it calls the registered `onUnauthenticated` handler which clears state and routes to `/login`.

## Claude Code Operating Rules

After completing each step and before each commit:

1. Update this CLAUDE.md to reflect current status, new conventions, new commands, and any schema changes. The "Project Status" section must always state exactly which steps are done and which remain.
2. Update the active HANDOFF document (currently HANDOFF-CYCLE1.md) with any new tables, endpoints, seed data changes, deviations from the ERD, bug fixes, or architecture decisions. Update the step status table. Document what was built in the same level of detail as the existing completed steps.
3. Include both files in every commit.

These two files are the source of truth that external architecture reviewers read. If they are stale, reviewers cannot do their job. A step is NOT complete until both files are current. Treat updating these files as part of the definition of done, not as a follow-up task.

When starting a new cycle, create the new HANDOFF-CYCLE{N}.md from the template structure used in HANDOFF-CYCLE1.md before beginning Step 1.
