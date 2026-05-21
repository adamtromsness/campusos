# CampusOS

Cloud-native, multi-tenant School Operating System. Replaces 8–15 disconnected school software systems with one platform.

> **Do NOT read `docs/reviews/cycle-reviews/`.** That directory holds 71 archived per-cycle review notes from Phase 1 and Phase 2 builds. They have been synthesised into `docs/reviews/campusos-phase2-completion-report.html` and are no longer active instructions. Reading them wastes context.

## Current State

**Phase 2 complete. Hardening done. Test strategy complete. Ready for Phase 3.**

- 37 runtime modules under `apps/api/src/modules/m{XX}-{name}/`
- ~840 tables across 38 logical ERD modules (M3 Calendar absorbed into M22 Scheduling)
- 7543 DB-backed integration tests passing, 2 justified skips
- 87.99% global statement coverage (all modules at target: financial ≥95%, safety ≥90%, all others ≥80%)
- 21 production bugs found and fixed by DB-backed tests
- 3 CodeQL findings resolved
- 0 unjustified test skips

**Build health:**

- `pnpm --filter @campusos/api build` — 0 errors
- `pnpm --filter @campusos/api test:integration` — 7543 passing, 0 failures
- `tsc --noEmit` — 0 production errors

**Accepted pre-pilot carry-forward:**
Switch runtime `DATABASE_URL` to `campusos_app` role (non-owner DML).
REVOKE DDL + LOGIN role exist in `provision-tenant.ts`. Ops config change.

**References:**

- Wave review docs: `docs/reviews/WAVE{N}-FINAL-VERIFICATION.md`
- Test strategy: `docs/campusos-test-strategy-v3.html`
- Phase 2 completion report: `docs/reviews/campusos-phase2-completion-report.html`
- Phase 3 roadmap: `docs/campusos-phase3-roadmap.html`

Cycle history: git tags, `docs/reviews/handoffs/`, `docs/plans/`.

## UI Design Principles

These are foundational decisions for the web app. New views must follow them; existing views are migrated as they are touched.

- **Less is more.** Remove information rather than add it. Persona-specific dashboards were deleted in favour of a clean launchpad.
- **Home is a launchpad, not a dashboard.** `/dashboard` is a centered page: logo, persona-aware greeting, search input, App tile grid. No stats, tables, or lists. Each App owns its detail views.
- **Apps are the primary navigation unit.** Sidebar mirrors the home grid — keep them in sync via `apps/web/src/components/shell/apps.tsx::getAppsForUser(user)`.
- **Persona-aware app grid.** Driven by IAM permissions + `personType`, not role names. Each tile has a `permission` predicate and optional `routePrefix`.
- **iOS-style unread badges.** Red circle, white number, capped "99+", via `apps/web/src/hooks/use-app-badges.ts`. Hooks accept an `enabled` arg so a STUDENT without `com-001:read` doesn't 403. Top-bar `NotificationBell` is the cross-app notifier, independent of per-app badges.
- **Logo is sans-serif.** Tailwind `font-sans` stack with `font-semibold tracking-tight`. Never `font-display` for the wordmark (article titles may use it).
- **App pages are minimal lists.** `/classes` and `/children` are flat card grids with one or two primary actions per row. Aggregates belong in their own apps.

## Architecture

- **~840 tables** across 38 logical modules (ERD v11), implemented as **37 runtime modules** in the API — see "Module-count drift" below.
- Schema-per-tenant multi-tenancy (PostgreSQL `search_path` switching)
- Modular monolith (NestJS) with planned extraction of 6 services
- Event-driven via Kafka (ADR-057 canonical envelope; `prefixedTopic()` for `KAFKA_TOPIC_ENV` prefix; outbox-backed durable emits for safety-critical events)
- Path aliases: `@modules/*` → `apps/api/src/modules/*`, `@shared/*` → `apps/api/src/shared/*`

**Module-count drift (38 logical vs 37 runtime).** ERD v11 catalogues **38** logical modules including `M3 Calendar` (7 tables, `cal_` prefix per the original v11 prefix map). The API registers **37** runtime modules because M3 was implemented as part of M22 Academic Scheduling — every calendar table ships under the `sch_` prefix (`sch_calendar_events`, `sch_calendar_day_overrides` in `packages/database/prisma/tenant/migrations/017_sch_calendar_and_coverage.sql`) and the request-side surface lives at `apps/api/src/modules/m22-scheduling/calendar.{controller,service}.ts`. Calendar events are a scheduling concern (they share rooms, periods, bell schedules, and coverage workflow with the rest of M22), so a separate canonical module would have duplicated that machinery without owning any independent data domain. No code or migration ever creates a `cal_*` table.

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
apps/api/                                    → NestJS backend (modular monolith)
apps/api/src/main.ts                         → Entry point (OpenTelemetry bootstrap → NestFactory)
apps/api/src/app.module.ts                   → Root module wiring all 38 domain modules
apps/api/src/guard-test.controller.ts        → Guard chain integration test surface
apps/api/src/modules/m{XX}-{name}/           → 37 canonical domain modules. Sub-folders inside the larger modules (m00-platform, m09-behaviour, m20-sis, m21-classroom, m23-health, m27-student-services, m40-communications, m41-meetings, m64-clubs, m67-store, m80-hr, m81-enrolment, m87-safety, m103-groups) contain leaf NestJS modules; others are flat. m83-finance and m86-procurement each fold a `*-advanced.module.ts` sibling into the root module.
apps/api/src/shared/                         → Cross-cutting infrastructure
  ├── auth/                                  → AuthGuard / PermissionGuard / StudentOwned + decorators (Public, RequirePermission, StudentOwned, PlatformScoped)
  ├── tenant/                                → Tenant context (AsyncLocalStorage), middleware, Prisma wrappers (`executeInTenantContext`, `executeInTenantTransaction`)
  ├── kafka/                                 → KafkaProducerService (ADR-057 envelope), KafkaConsumerService, IdempotencyService, OutboxService, `envelope-consumer` helpers, `prefixedTopic`
  ├── cache/                                 → RedisModule + RedisService (ioredis wrapper used by IAM cache, notifications, ledger balance, AI quota, unread counts)
  ├── dlq/                                   → DLQ admin (DlqController/Service, atomic replay/discard)
  ├── observability/                         → OpenTelemetry bootstrap, structured logger, Prometheus metrics, circuit breaker, reference-health scanner, worker jitter, request-log middleware
  └── common/                                → Shared utilities (reserved)
apps/api/test/                               → integration/ (DB-backed) + unit/ (mocks) — see Conventions
apps/web/                                    → Next.js 14 frontend (App Router, Tailwind, React Query, Zustand)
  src/app/                                   → Routes ((app)/* authed; /login, /apply/tours/public, /shop/[storeId], /portfolio-share/[token], /enrolment/tours/public, /find-schools unauthed)
  src/components/                            → ui/, shell/ (AppLayout, Sidebar, TopBar, apps.tsx launchpad, NotificationBell), classroom/, scheduling/, profile/
  src/hooks/                                 → React Query hooks per domain
  src/lib/                                   → api-client (Bearer + X-Tenant-Subdomain + single-flight 401→refresh), auth-store (Zustand), query-client, shared TS types
packages/database/                           → Prisma platform schema, tenant SQL migrations (prisma/tenant/migrations/*.sql), provisioning, seed scripts
packages/shared/                             → Shared TS types + constants
docs/                                        → architecture/ (frozen specs), plans/ (cycle plans), reviews/ (audits + handoffs/), operations/ (runbooks), policies/ (compliance), design-hub/
```

Path aliases (set in `apps/api/tsconfig.json` and both vitest configs):

- `@modules/*` → `apps/api/src/modules/*`
- `@shared/*` → `apps/api/src/shared/*`
- `@/*` → `apps/api/src/*` (legacy escape hatch)

Nest CLI's webpack-loader resolves aliases at compile time, so `dist/` ships pure relative require paths — no runtime tsconfig-paths needed.

**Canonical-aggregator pattern.** `app.module.ts` imports exactly one module per canonical M-numbered directory (37 total). Directories with multiple leaf NestJS modules expose a top-level `m{XX}-{name}.module.ts` aggregator (class `M{XX}{Name}Module`) that imports + re-exports its leaves; the M-prefix avoids name collisions with same-named leaf classes. `app.module.ts` never imports leaf modules directly.

**Barrel exports.** Every canonical module and the shared subsystems (`shared/auth`, `shared/tenant`, `shared/kafka`, `shared/cache`) expose an `index.ts` re-exporting the public API. Cross-module imports go through the barrel (`import { ResolvedActor } from '@modules/m00-platform'`); within-module imports stay relative (`from './student.service'`).

## Key Design Contracts

- **Identity (ADR-055):** `iam_person` is the canonical FK for human identity. `platform_users` is ONLY for auth/audit columns. Domain projections (`sis_staff`, `sis_guardians`) carry direct `person_id` refs to `iam_person`. `sis_students` is a transitive projection — its identity path is `sis_students → platform_students.person_id → iam_person.id` (`platform_students` exists for cross-school student portability).
- **Soft cross-schema refs (ADR-001/020/028):** Tenant tables MUST NOT have DB-enforced FK constraints to `platform.*` tables. UUID columns + app-layer Prisma validation only. Cross-schema joins on the read path are fine; FK constraints are not. Soft-FK orphan detection is the job of `platform_reference_health` + the `ReferenceHealthScannerWorker` (under `shared/observability/`).
- **Permissions:** 495 permission codes (165 functions × 3 tiers: read / write / admin). Check codes, never role names. Use `@RequirePermission('att-001:write')`. Catalogue is reconciled from `packages/database/data/permissions.json` by `seed-iam.ts` — adds new codes, removes stale ones. **One catalogue entry deviates from the `XXX-NNN` convention by design**: `student_counseling_record` is the FERPA-gate code; controllers reference it verbatim as `@RequirePermission('student_counseling_record:read')` and only Staff + School Admin + Platform Admin hold `:read`.
- **Tenancy (ADR-001):** Every tenant query uses `search_path = tenant_<id>, platform, public`. Platform tables are shared. Tenant tables are isolated. Schema-per-tenant — never store tenant_id columns on tenant-scoped tables.
- **UUIDs (ADR-002):** All PKs are UUIDv7, generated in the application layer via `generateId()` from `@campusos/database`.
- **Attendance partitioning (ADR-007):** `sis_attendance_records` is composite-partitioned `RANGE(school_year) → HASH(class_id) MODULUS 8`. Composite PK `(id, school_year, class_id)`. Queries should include `class_id` and `date` (or `school_year`) in the predicate to enable partition pruning.
- **Frozen state (ADR-031):** `is_frozen=true` blocks all writes. Reads still work.
- **Guard order (Auth → Tenant → Permission):** All three guards are registered as `APP_GUARD` in `AppModule` to make order deterministic. `PermissionGuard` fails closed if `request.user` is missing.
- **Scope inheritance (ADR-036, partial):** `PermissionCheckService.resolveScopeChain` checks SCHOOL scope first, then PLATFORM scope. Used by both `PermissionGuard` (endpoint gates) and `hasAnyPermissionInTenant` (admin-status checks). Lets Platform Admins act against any tenant without per-school role assignments. Full district/department/class traversal is future work.
- **Tenant isolation under pooling:** `executeInTenantContext` and `executeInTenantTransaction` both wrap their callback in a Prisma `$transaction` that runs `SET LOCAL search_path TO "tenant_X", platform, public`. SET LOCAL is mandatory — a session-level SET on a pooled client can leak between concurrent requests and serve another tenant's data.
- **Row-level authorisation:** Endpoint permission gates (`@RequirePermission`) are necessary but not sufficient. Multi-persona reads (e.g. `stu-001:read` is held by parents, students, teachers, and admins) MUST also apply a row filter via `ActorContextService.resolveActor(...)` + a per-personType visibility predicate. Pattern lives in `apps/api/src/modules/m20-sis/sis/student.service.ts::visibilityClause`. Writes that are bound to a class (e.g. attendance) MUST verify caller membership in the relevant link table (`sis_class_teachers`) before mutating; admins bypass.
- **Admin checks are tenant-scoped, not cross-scope.** Use `permissionCheckService.hasAnyPermissionInTenant(accountId, schoolId, codes)` or read `actor.isSchoolAdmin` from `ActorContextService.resolveActor(...)`. NEVER scan `iam_effective_access_cache` across all scopes — that leaks admin status from school A into a request scoped to school B.
- **No implicit access:** Guardian access derived from `iam_relationship_access_rule` (and per-domain join tables like `sis_student_guardians`), never assumed.
- **Manager-only roster reads:** Endpoints that return roster-wide grade or assessment data (e.g. `GET /classes/:classId/gradebook`) MUST gate on a _manager_ permission tier (`tch-003:write`, not `tch-003:read`) AND a row-scope manager check. `*:read` codes are typically held by students and parents, so they cannot be the gate for cross-roster views.
- **Kafka consumer idempotency must be claim-after-success.** Workers MUST NOT claim `platform_event_consumer_idempotency` on message arrival, because a recompute failure after the claim is at-most-once and silently drops the work. The pattern is: read-only `IdempotencyService.isClaimed(group, eventId)` on arrival → process → on success, `claim(group, eventId)`. Recompute paths must be idempotent (UPSERT) so duplicate redelivery after an unclaimed failure is harmless.
- **Staff identity:** `sis_class_teachers.teacher_employee_id`, `cls_grades.teacher_id`, `cls_lessons.teacher_id`, and `cls_student_progress_notes.author_id` reference `hr_employees(id)` (soft FK per ADR-055 / ADR-001/020). Resolve the calling employee via `actor.employeeId` from `ActorContextService.resolveActor(...)` — null-safe; non-staff personas and the synthetic Platform Admin (which has no `hr_employees` row) get `null` and the row-scope check should short-circuit.
- **Platform-scoped admin endpoints must verify tenant affiliation.** Admin endpoints that read/write platform-schema tables (`iam_person`, `platform_families`) must verify the target entity has a projection in the current tenant before allowing access. Use `assertTargetInCurrentTenant(personId)` and `householdAffiliatedWithCurrentTenant(familyId)`. Return 404 (not 403) on failure to avoid leaking the existence of cross-tenant data. The IAM permission gate alone is insufficient — `usr-001:admin` (and `sch-001:admin`) inherit through the platform scope chain.
- **State-machine transitions must lock the row inside the transaction.** Any endpoint that reads a status, validates it, then updates it MUST use `SELECT ... FOR UPDATE` inside `executeInTenantTransaction`. Reading status outside the transaction and updating inside it is a concurrency bug — two simultaneous requests can both pass the check and both apply mutations.
- **Cross-table lock ordering must be consistent.** When a service touches more than one row (e.g. an invoice + a payment), every code path must acquire the locks in the same order to avoid deadlock. Standing convention: **invoice first, then payment** across `PaymentService.pay` and `RefundService.issue`.
- **Concurrency hot-spots use `pg_advisory_xact_lock`.** Where a schema UNIQUE / EXCLUSION can't catch a race because the new row depends on aggregating existing rows (e.g. `pay_family_accounts.account_number = MAX+1`, `enr_capacity_summary.recompute`, room booking conflict checks), services take a per-key advisory tx lock at the top of the relevant tx. Key shape is always `hashtext('<resource>:' || <id>)` so locks across resources cannot collide.
- **ADR-057 canonical event envelope.** Every emit goes through `KafkaProducerService.emit(EmitOptions)`. The body on the wire is an `EventEnvelope` JSON object with `event_id` (UUIDv7), `event_type` (un-prefixed topic), `event_version` (default 1), `occurred_at`, `published_at`, `tenant_id`, `source_module`, `correlation_id`, `payload`. Consumers read `event_id` + `tenant_id` straight off the envelope.
- **Outbox for safety-critical emits.** Financial/governance/safety events use `OutboxService.enqueueInTx(tx, ...)` inside the triggering tenant tx; `OutboxPublisherWorker` drains `platform_outbox` to Kafka asynchronously. A broker outage leaves the outbox row pending; the worker retries on the next poll until `MAX_OUTBOX_ATTEMPTS`.

## Guard Chain (every request)

`TenantResolverMiddleware → AuthGuard (JWT) → TenantGuard (frozen check) → PermissionGuard (@RequirePermission)`

## Commands

### Zero-to-running

```bash
docker compose up -d   # Postgres + Redis + Kafka + Keycloak
pnpm dev:api           # NestJS backend on :4000 (watch mode)
pnpm dev:web           # Next.js frontend on :3000
```

If you've never seeded the DB, run `pnpm db:reset` once before `pnpm dev:api` — that drops + recreates + migrates + seeds the full demo state in ~30 seconds.

### Root scripts

```bash
pnpm dev               # api + web concurrently
pnpm dev:api           # NestJS, watch, :4000
pnpm dev:web           # Next.js, :3000
pnpm db:migrate        # platform migrations + provision tenant_demo (idempotent)
pnpm db:seed           # full demo data (seed:all chain, ~26s)
pnpm db:reset          # drop + migrate + seed (refuses non-localhost _dev/_test DBs)
pnpm db:studio         # Prisma Studio
pnpm format            # Prettier auto-fix
pnpm format:check      # Prettier CI gate
pnpm lint:logs         # log-schema lint (no console.log, no email PII)
pnpm test              # turbo test
pnpm build             # turbo build
```

### Per-package

```bash
pnpm --filter @campusos/api {dev,build,test,test:integration,test:all}
pnpm --filter @campusos/api exec tsc --noEmit
pnpm --filter @campusos/database {migrate:deploy,provision --subdomain=demo,seed:all,seed,seed:iam,cache:build}
```

### Tenant schema migrations

Add an SQL file to `packages/database/prisma/tenant/migrations/` (numbered `NNN_*.sql`), then:

```bash
pnpm --filter @campusos/database provision --subdomain=demo
pnpm --filter @campusos/database provision --subdomain=test
pnpm --filter @campusos/database seed:all
pnpm --filter @campusos/database exec tsx src/build-cache.ts
```

### Rebuild from corrupted state

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "DROP SCHEMA IF EXISTS tenant_demo CASCADE; DROP SCHEMA IF EXISTS tenant_test CASCADE;"
# then run the tenant-schema-migrations block above
```

## Database

- **Platform schema** (~29 tables): organisations, schools, iam_person, platform_users, platform_students, platform_families, roles, permissions, iam_scope, iam_role_assignment, iam_effective_access_cache, platform_push_tokens, platform_dlq_messages, platform_outbox, platform_tenant_routing, platform_event_consumer_idempotency, platform_audit_log, platform_reference_health, signature/breach/SAR governance tables. Managed by Prisma at `packages/database/prisma/platform/schema.prisma`.
- **Tenant schema** (~840 logical base tables across 38 modules). Migrations live in `packages/database/prisma/tenant/migrations/*.sql`, split by semicolons by `provision-tenant.ts`. Statements starting with `--` after trim are filtered out — keep header comments minimal or use `/* … */`. Never put a `;` inside a string literal or block comment.
- Tenant SQL must be idempotent: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS … ; ADD CONSTRAINT …` for FK changes.
- Enum-like columns use `TEXT + CHECK IN (…)` rather than PG `ENUM` types (P2-H4 ADV-06 ratification). CHECK constraints are easier to extend than PG ENUMs (`ALTER TYPE … ADD VALUE` is committed eagerly and cannot be rolled back; removing values is impossible). Do not convert TEXT+CHECK enums to PG ENUMs.
- Partitioned tables include `sis_attendance_records` (RANGE → HASH MODULUS 8), `msg_messages` / `msg_notification_log` / `msg_moderation_log` (monthly RANGE), `pay_ledger_entries` / `tsk_tasks` / `tkt_tickets` (annual or monthly RANGE), `msg_threads` (HASH 64 buckets), `evt_ticket_scans` (monthly RANGE). Composite PKs include the partition column.

## Test Users (seeded, Keycloak)

| Email                        | Role                                 | Password      |
| ---------------------------- | ------------------------------------ | ------------- |
| admin@demo.campusos.dev      | Platform Admin (all 495 permissions) | admin123      |
| principal@demo.campusos.dev  | School Admin (Sarah Mitchell)        | admin123      |
| teacher@demo.campusos.dev    | Teacher (James Rivera)               | teacher123    |
| student@demo.campusos.dev    | Student (Maya Chen)                  | student123    |
| parent@demo.campusos.dev     | Parent (David Chen, Maya's father)   | parent123     |
| vp@demo.campusos.dev         | Vice Principal (Linda Park)          | vp123         |
| counsellor@demo.campusos.dev | Counsellor (Marcus Hayes)            | counsellor123 |

The `admin@` Platform Admin persona is intentionally NOT bridged to `hr_employees` — it represents a system administrator, not a school employee. The other four staff (Mitchell via `principal@`, Rivera, Park, Hayes) each have an `hr_employees` row.

Dev login: `POST /api/v1/auth/dev-login` with `{"email":"..."}` and `X-Tenant-Subdomain: demo` header.

## Design Documents (authoritative references)

**Frozen specs** (`docs/architecture/`):

- `campusos-erd-v11.html` — ~840 tables with columns, constraints, indexes, partitioning, Kafka events, ADR refs
- `campusos-architecture-review-v10.html` — system architecture, multi-tenancy, IAM, events, scalability, security
- `campusos-function-library-v11.html` — 165 functions × 3 tiers = 495 permission codes
- `campusos-business-strategy.html`, `campusos-dev-deployment-plan.html`, `campusos-school-configuration-admin.html`

**Cycle plans** (`docs/plans/phase1/`, `docs/plans/phase2/`): per-cycle implementation plans + CAT scripts.

**Reviews** (`docs/reviews/`): handoffs/, architectural reviews, codex/adversarial/peer reviews, phase2-completion-report.

**Operations** (`docs/operations/`):

- `kafka-operations-runbook.md` — consumer retry policy, DLQ shape, replay, escalation SLAs
- `kafka-topic-registry.md` — every Kafka topic (~110 across 38 modules)
- `migration-orchestration.md` — tenant migration authoring (splitter, idempotency, expand/contract, rollout sequencing)
- `procurement-integration-test-harness.md`

**Policies** (`docs/policies/`):

- `ai-data-policy.md` — categorical exclusions (health, behaviour, counselling, wellbeing, mandatory reports, banned persons, HR, financial, DPO, verification docs never sent to AI even with consent); PII pseudonym-map; zero-retention + training opt-out + EU/US region pinning; 90-day pseudonymisation of inference logs
- `retention-pseudonymisation-matrix.md` — per-record-class retention + lawful basis + pseudonymisation across 36 record classes

**Other** (`docs/`):

- `campusos-test-coverage-plan.html` — per-tier targets (Financial ≥95%, Auth+IAM ≥95%, Core ≥80%, Operational ≥80%)
- `campusos-phase3-roadmap.html`, `campusos-hardening-cycles.html`, `campusos-restructure-plan.html`, `design-hub/index.html`

## Conventions

- Tenant-scoped tables use SQL migrations in `packages/database/prisma/tenant/migrations/`.
- Platform tables use Prisma schema in `packages/database/prisma/platform/schema.prisma`.
- NestJS modules follow the pattern: `module.ts`, `service.ts`, `controller.ts`, `dto/` co-located inside the canonical module under `apps/api/src/modules/m{XX}-{name}/{sub-module}/`. Test specs live under `apps/api/test/` — integration specs under `test/integration/`, unit specs under `test/unit/` (mirrors the `src/` layout: `test/unit/shared/auth/permission.guard.spec.ts` tests `src/shared/auth/permission.guard.ts`). Specs reference the source-under-test through the `@shared/*` / `@modules/*` aliases. The source tree itself stays spec-free.
- Every API endpoint needs `@RequirePermission()` unless marked `@Public()`. New global guards must be registered in `AppModule` (not in submodules) so guard ordering stays deterministic.
- Use `TenantPrismaService.executeInTenantContext(fn)` for **single-statement** tenant queries (read or single-table write). Internally runs inside a `$transaction` with `SET LOCAL search_path` to keep tenant scope pinned to one connection — never use a session-level SET on a pooled client.
- Use `TenantPrismaService.executeInTenantTransaction(fn)` for **multi-statement** writes that must be atomic (e.g. cross-schema inserts that span platform + tenant tables, like `POST /students`).
- Tenant tables aren't in the Prisma schema — query via `client.$queryRawUnsafe<RowType[]>(sql, ...args)` / `client.$executeRawUnsafe(sql, ...args)`. Always cast UUID args explicitly: `$1::uuid`. Same for `$1::date`. Prisma sends raw query parameters as TEXT and Postgres won't auto-coerce.
- Schema-qualify cross-schema reads (`platform.iam_person`) to be explicit.
- DTOs use `class-validator` + `class-transformer` (global ValidationPipe in `main.ts` with `forbidNonWhitelisted: true`).
- Kafka events follow `{domain}.{entity}.{verb}` naming (e.g. `att.student.marked_tardy`). Wire topics get an env prefix via `prefixedTopic()` controlled by `KAFKA_TOPIC_ENV` (default `dev`). Producers + consumers MUST use `prefixedTopic()`.
- No `DROP TABLE`, no `DROP COLUMN` in migrations. Additive only. (Pre-deployment edits to fix architectural errors are categorically different — re-provision the tenant.)
- Snake_case in SQL, camelCase in TypeScript. Map at the service layer with a `rowToDto` helper.
- **Web auth gating uses `personType` + permission codes from `/auth/me`** for menu visibility and persona routing only. Backend `PermissionGuard` is the authoritative access check on every request.
- **Web fetch wrapper (`apps/web/src/lib/api-client.ts`)** sends `X-Tenant-Subdomain: demo` (override via `NEXT_PUBLIC_TENANT_SUBDOMAIN`) and Bearer token. On 401 it single-flights `/auth/refresh` and retries once; on terminal 401 it calls the registered `onUnauthenticated` handler which clears state and routes to `/login`.
- **Imports.** Cross-module imports use `@modules/m{XX}-{name}/…` or `@shared/…` aliases. Within-module imports (sibling files inside the same canonical module) stay relative (`./foo.service`). Test files use the same aliases for source-under-test references.
- **`shared/` boundary.** `apps/api/src/shared/` may contain infrastructure primitives, framework adapters, guards, decorators, cache/event abstractions, and test harness utilities — code that's truly cross-cutting and module-agnostic. It MUST NOT contain domain workflow logic, table-specific business rules, or module-owned DTOs (those belong inside the owning canonical module). Root bootstrapping infrastructure that ships in `shared/` even though it's only wired in one place (e.g. `shared/observability/otel-bootstrap.ts`, `shared/observability/structured-logger.ts`, `shared/dlq/dlq.module.ts`, `shared/tenant/tenant-resolver.middleware.ts`) is **exempt from the informal "used by 3+ modules" placement rule** — they're framework-level entry points the AppModule wires once, and moving them into a single canonical module would make every other module appear to depend on that one's surface for no reason.

## Claude Code Operating Rules

After completing each step and before each commit:

1. Update this CLAUDE.md to reflect current status, new conventions, new commands, and any schema changes.
2. Update the active HANDOFF document under `docs/reviews/handoffs/` with any new tables, endpoints, seed data changes, deviations from the ERD, bug fixes, or architecture decisions. Update the step status table. Document what was built in the same level of detail as prior completed steps.
3. Include both files in every commit.

These two files are the source of truth that external architecture reviewers read. If they are stale, reviewers cannot do their job. A step is NOT complete until both files are current. Treat updating these files as part of the definition of done, not as a follow-up task.

When starting a new cycle, create the new `docs/reviews/handoffs/HANDOFF-CYCLE{N}.md` from the template structure used in existing handoff files before beginning Step 1.
