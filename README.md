# CampusOS

**The School Operating System** — a cloud-native, multi-tenant platform that unifies every operational domain of a K–12 school into a single system.

## Status

**Phase 1 (Build the Core) — COMPLETE.** All four foundation cycles shipped, reviewed, and approved.

- **Cycle 0 (Platform Foundation):** Complete — auth, tenancy, IAM, guard chain.
- **Cycle 1 (SIS Core + Attendance):** Complete — 11/11 steps. Schema, seed, SIS API, Attendance API + Kafka emits, web shell, Teacher/Parent/Admin dashboards, attendance taking + absence requests, end-to-end vertical slice. Post-cycle review fixes applied (tenant isolation, row-level auth, manager scope). See `HANDOFF-CYCLE1.md`.
- **Cycle 2 (Classroom + Assignments + Grading):** Complete — 10/10 steps. Assignments + categories + submissions + grading + gradebook snapshots (first Kafka consumer with claim-after-success idempotency), teacher grading UI, student/parent grade views, CAT verified end-to-end. Post-cycle review APPROVED at `d876e86`. See `HANDOFF-CYCLE2.md`.
- **Cycle 3 (Communications):** Complete — 11/11 steps. Messaging + content moderation, notifications pipeline (5 Kafka consumers + delivery worker + Redis idempotency), announcements + audience fan-out worker, NotificationBell + `/notifications` history, full messaging + announcements UIs, 7-scenario CAT verified end-to-end. Post-cycle review APPROVED at `592d366` after Round 2 (Kafka consumer DLQ retry, delivery worker PROCESSING state, announcement manager scope fixes applied). See `HANDOFF-CYCLE3.md` and `REVIEW-CYCLE3-CHATGPT.md`.

**Phase 2 (Test & Refine) — IN PROGRESS.** Walking every workflow as each persona, refining UI/navigation, building the UI design guide (`docs/ui-design-guide.md`), and tightening edge cases before expanding into Cycles 4–8 (HR, Enrollment, Tasks, Calendar, Helpdesk).

## Architecture

- **840 tables** across **38 modules**, governed by **76 ADRs**
- Modular monolith (NestJS) with 6 extracted services
- Schema-per-tenant multi-tenancy (PostgreSQL)
- Event-driven via Kafka
- 5-wave delivery plan

## Tech Stack

| Layer          | Technology                                     |
| -------------- | ---------------------------------------------- |
| Backend        | NestJS 10 (TypeScript, strict mode)            |
| Frontend       | Next.js 14 (App Router, Tailwind CSS)          |
| Database       | PostgreSQL 16 (Prisma ORM)                     |
| Cache          | Redis 7 (ioredis)                              |
| Events         | Apache Kafka (KafkaJS)                         |
| Auth           | External IdP via OIDC/SAML (Keycloak for dev)  |
| Monorepo       | pnpm + Turborepo                               |
| Testing        | Vitest, Supertest, Pact, Playwright            |
| CI/CD          | GitHub Actions                                 |
| Infrastructure | AWS (ECS, RDS, MSK, ElastiCache) via Terraform |

## Project Structure

```
campusos/
├── apps/
│   ├── api/              # NestJS backend (modular monolith)
│   └── web/              # Next.js frontend
├── packages/
│   ├── database/         # Prisma schema, migrations, seed
│   ├── shared/           # Shared types, Zod schemas, constants
│   ├── eslint-config/    # Shared ESLint rules
│   └── tsconfig/         # Shared TypeScript configs
├── infrastructure/       # Terraform (added in Step 10)
├── turbo.json            # Turborepo pipeline
├── pnpm-workspace.yaml   # Workspace definition
└── .env.example          # Environment template
```

## Getting Started

```bash
# Prerequisites: Node.js 20, pnpm 9+, Docker

# Install dependencies
pnpm install

# Copy environment variables
cp .env.example .env.local

# Start local services (PostgreSQL, Kafka, Redis, Keycloak)
docker compose up -d

# Run database migrations
pnpm db:migrate

# Start development servers
pnpm dev
```

- **API:** http://localhost:4000
- **Swagger:** http://localhost:4000/api/docs
- **Web:** http://localhost:3000
- **Keycloak:** http://localhost:8080

## Development Pipeline

Phase 1 followed a build → review → fix → approve loop per cycle:

```
Claude writes code → CI/CD tests → ChatGPT reviews → fixes applied → Human accepts
     (DEV)            (SIT)           (SIT)            (DEV)           (CAT)
```

Each cycle ships a vertical-slice CAT script (`docs/cycle{N}-cat-script.md`) that reproduces the end-to-end flow against `tenant_demo`. Phase 2 is now exercising those flows persona-by-persona to surface UX gaps and edge cases before Phase 3 (Cycles 4–8) expands the system.

## Design Documents

See the [Design Hub](./docs/) for the complete specification:

- **ERD v11** — 840 tables, 38 modules, 76 ADRs
- **Architecture Review** — 30 sections, modular monolith + 6 services
- **Function Library** — 148 functions, 28 groups, 3 access tiers
- **Dev & Deployment Plan** — 29 sections, 4 environments, 8 build cycles
- **Business Strategy** — 15 sections, pricing, GTM, community exchange

## License

Proprietary. All rights reserved.
