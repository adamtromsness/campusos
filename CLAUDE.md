# CampusOS

Cloud-native, multi-tenant School Operating System. Replaces 8–15 disconnected school software systems with one platform.

## Project Status

Cycle 0 (Platform Foundation) is COMPLETE. Currently building Cycle 1 (SIS Core + Attendance).
See `docs/campusos-cycle1-implementation-plan.html` for the detailed step-by-step plan.

## Architecture

- **840 tables** across 38 modules, governed by 76 ADRs (Architecture Decision Records)
- Schema-per-tenant multi-tenancy (PostgreSQL `search_path` switching)
- Modular monolith (NestJS) with planned extraction of 6 services
- Event-driven via Kafka
- 5-wave delivery plan

## Tech Stack

- **Backend:** NestJS 10 (TypeScript strict), Node.js 20
- **Frontend:** Next.js 14 (App Router, Tailwind CSS, React Query, Zustand)
- **Database:** PostgreSQL 16 (Prisma ORM, schema-per-tenant)
- **Cache:** Redis 7 (ioredis)
- **Events:** Apache Kafka (KafkaJS)
- **Auth:** External IdP via OIDC (Keycloak for dev). CampusOS never stores passwords.
- **Monorepo:** pnpm + Turborepo

## Project Structure

```
apps/api/          → NestJS backend (modular monolith)
apps/api/src/auth/ → AuthGuard (global), JWT, @Public decorator
apps/api/src/tenant/ → TenantResolverMiddleware, TenantGuard, AsyncLocalStorage
apps/api/src/iam/  → Roles, permissions, assignments, effective access cache
apps/api/src/platform/ → M0 Platform Core
apps/web/          → Next.js frontend
packages/database/ → Prisma schema, migrations, tenant provisioning, seed
packages/shared/   → Shared TypeScript types and constants
```

## Key Design Contracts

- **Identity (ADR-055):** `iam_person` is the canonical FK for human identity. `platform_users` is ONLY for auth/audit columns (created_by, actor_id).
- **Permissions:** 426 permission codes (148 functions × 3 tiers: read/write/admin). Check codes, never role names. Use `@RequirePermission('att-001:write')`.
- **Tenancy (ADR-001):** Every tenant query uses `search_path = tenant_<id>, platform, public`. Platform tables are shared. Tenant tables are isolated.
- **UUIDs (ADR-002):** All PKs are UUIDv7, generated in the application layer via `generateId()`.
- **Frozen state (ADR-031):** `is_frozen=true` blocks all writes. Reads still work.
- **No implicit access:** Guardian access derived from `iam_relationship_access_rule`, never assumed.

## Guard Chain (every request)

TenantResolverMiddleware → AuthGuard (JWT) → TenantGuard (frozen check) → PermissionGuard (@RequirePermission)

## Commands

```bash
# Start local services
docker compose up -d

# Start API (dev mode)
cd apps/api && npx nest start --watch

# Start web (dev mode)  
cd apps/web && npx next dev

# Run tests
pnpm test

# Database migrations (platform schema)
cd packages/database
DATABASE_URL="postgresql://campusos:campusos_dev@localhost:5432/campusos_dev?schema=platform" npx prisma migrate dev --schema=prisma/platform/schema.prisma --name <name>

# Tenant schema migrations
# Add SQL file to packages/database/prisma/tenant/migrations/
# Then re-provision: npx tsx src/provision-tenant.ts --subdomain=demo

# Seed data
npx tsx src/seed.ts

# Build effective access cache
npx tsx src/build-cache.ts

# Prisma studio (visual DB browser)
DATABASE_URL="postgresql://campusos:campusos_dev@localhost:5432/campusos_dev?schema=platform" npx prisma studio --schema=prisma/platform/schema.prisma
```

## Database

- **Platform schema** (26 tables): organisations, schools, iam_person, platform_users, platform_students, platform_families, roles, permissions (426 codes), iam_scope, iam_role_assignment, iam_effective_access_cache, and more.
- **Tenant schema** (~5 tables, expanding): school_config, school_feature_flags, grading_scales, custom_field_definitions, custom_field_values. Cycle 1 adds ~18 SIS tables.
- Tenant migrations are SQL files in `packages/database/prisma/tenant/migrations/`, split by semicolons, each statement executed individually via `executePlatformSQL()`.

## Test Users (seeded, Keycloak)

| Email | Role | Password |
|-------|------|----------|
| admin@demo.campusos.dev | Platform Admin (all 426 permissions) | admin123 |
| principal@demo.campusos.dev | School Admin | admin123 |
| teacher@demo.campusos.dev | Teacher (James Rivera) | teacher123 |
| student@demo.campusos.dev | Student (Maya Chen) | student123 |
| parent@demo.campusos.dev | Parent (David Chen, Maya's father) | parent123 |

Dev login: `POST /api/v1/auth/dev-login` with `{"email":"..."}` and `X-Tenant-Subdomain: demo` header.

## Design Documents (authoritative references)

Read these when you need table definitions, column details, ADR specifics, or permission descriptions:

- `docs/campusos-erd-v11.html` — Complete schema: all 840 tables with full column definitions, indexes, constraints, Kafka events, ADR cross-references
- `docs/campusos-architecture-review-v10.html` — 30 sections: system architecture, multi-tenancy, IAM, events, scalability, security
- `docs/campusos-function-library-v11.html` — 148 functions, 28 groups, 3 access tiers each
- `docs/campusos-dev-deployment-plan.html` — Build pipeline, environments, Wave 1 sequence
- `docs/campusos-business-strategy.html` — Pricing, team, GTM, community exchange
- `docs/campusos-cycle1-implementation-plan.html` — Current cycle: 11 steps for SIS + Attendance

## Conventions

- Tenant-scoped tables use SQL migrations in `packages/database/prisma/tenant/migrations/`
- Platform tables use Prisma schema in `packages/database/prisma/platform/schema.prisma`
- NestJS modules follow the pattern: module.ts, service.ts, controller.ts in `apps/api/src/<domain>/`
- Every API endpoint needs `@RequirePermission()` unless marked `@Public()`
- Use `TenantPrismaService.executeInTenantContext()` for tenant-scoped queries
- Kafka events follow `{domain}.{entity}.{verb}` naming (e.g. `att.student.marked_tardy`)
- No DROP TABLE, no DROP COLUMN in migrations. Additive only.
