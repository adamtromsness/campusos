# CampusOS

**The School Operating System** — a cloud-native, multi-tenant platform that unifies every operational domain of a K–12 school into a single system.

## Status

- **Cycle 0 (Platform Foundation):** Complete — auth, tenancy, IAM, guard chain.
- **Cycle 1 (SIS Core + Attendance):** Steps 1–6 of 11 done — schema, seed, SIS module, Attendance module with Kafka emits, vertical slice verified end-to-end. UI work (Steps 7–11) remains. See `HANDOFF-CYCLE1.md` for current state.

## Architecture

- **840 tables** across **38 modules**, governed by **76 ADRs**
- Modular monolith (NestJS) with 6 extracted services
- Schema-per-tenant multi-tenancy (PostgreSQL)
- Event-driven via Kafka
- 5-wave delivery plan

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | NestJS 10 (TypeScript, strict mode) |
| Frontend | Next.js 14 (App Router, Tailwind CSS) |
| Database | PostgreSQL 16 (Prisma ORM) |
| Cache | Redis 7 (ioredis) |
| Events | Apache Kafka (KafkaJS) |
| Auth | External IdP via OIDC/SAML (Keycloak for dev) |
| Monorepo | pnpm + Turborepo |
| Testing | Vitest, Supertest, Pact, Playwright |
| CI/CD | GitHub Actions |
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

```
Claude writes code → CI/CD tests → ChatGPT reviews → Human accepts
     (DEV)            (SIT)           (SIT)            (CAT)
```

## Design Documents

See the [Design Hub](./docs/) for the complete specification:

- **ERD v11** — 840 tables, 38 modules, 76 ADRs
- **Architecture Review** — 30 sections, modular monolith + 6 services
- **Function Library** — 148 functions, 28 groups, 3 access tiers
- **Dev & Deployment Plan** — 29 sections, 4 environments, 8 build cycles
- **Business Strategy** — 15 sections, pricing, GTM, community exchange

## License

Proprietary. All rights reserved.
