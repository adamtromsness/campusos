# CampusOS

Cloud-native, multi-tenant School Operating System. Replaces 8–15 disconnected school software systems with one platform.

> **Do NOT read `docs/reviews/cycle-reviews/`.** That directory holds 71 archived per-cycle review notes from Phase 1 and Phase 2 builds. They have been synthesised into `docs/reviews/campusos-phase2-completion-report.html` and are no longer active instructions. Reading them wastes context.

## Current State

**Phase 2 complete, hardening done, test coverage in progress (Tier 0 harness built, Tiers 1–7 pending).** The codebase has shipped through every planned cycle of Phase 1 (Cycles 0–32) and Phase 2 (P2-1..P2-29 .1 cycles + the four hardening cycles P2-H1..P2-H4). All cycles closed with a `cycleN-approved` tag after the post-cycle architectural review verdict; the final adversarial review against the post-Cycle-32 state landed as **PILOT-READY WITH CONDITIONS** and the conditions have all been addressed in commits since. The platform is repo-ready for pilot deployment.

**Codebase restructure complete.** `apps/api/src/` reorganised from 80+ cycle-by-cycle folders into 38 canonical modules under `apps/api/src/modules/m{XX}-{name}/` + cross-cutting infrastructure under `apps/api/src/shared/`. Documentation reorganised into `docs/{architecture,plans,reviews,policies,operations,design-hub}/`. Path aliases `@modules/*` and `@shared/*` are live in `tsconfig.json` and both vitest configs.

**Test coverage in progress — Wave 1, 2, 3 COMPLETE and all 11 surfaced production bugs fixed.** Tier 0 (integration test harness at `apps/api/test/integration/`) is built and operational. Tiers 1–7 (per-module unit + integration coverage targets per `docs/architecture/campusos-test-coverage-plan.html`) are the active engineering work, executing through the wave-by-wave plan in `docs/campusos-test-strategy-v3.html`. 2456 unit tests pass across 110 spec files (54 pre-existing skips, 0 failures), plus 987 DB-backed integration tests passing (0 skips — every Wave 1-3 `it.skip` retired). Combined unit + integration coverage: 96.5% m84-payments, 86.5% m83-finance, 97.3% m00-platform/iam, 100% m00-platform/auth — see `docs/reviews/handoffs/WAVE1-3-REVIEW.md` for full per-module breakdown. **Wave 1 done** + **Wave 2 done** + **Wave 3 done** (safety-critical, ≥90% target): wave3-immutable-contracts (16 tests, 3 new IMMUTABLE contracts) + iep-plans (29 tests — `iep.accommodation.updated` outbox-in-tx KEYSTONE) + referral-lifecycle (28 tests — full SUBMITTED→COMPLETED state machine + CrisisEscalationService.escalate outbox-in-tx KEYSTONE) + health-records (38 tests — `hlth.allergy_alert.changed` outbox-in-tx KEYSTONE + VIEW_RECORD audit-in-tx contract) + incident-lifecycle (49 tests — declare KEYSTONE inc_incidents + inc_declaration_outbox atomic + Kafka emit AFTER commit + resolve/cancel state machine with SELECT FOR UPDATE + TimelineService append-only contract) + counselling-sessions (42 tests — SessionService row-locked transitions + counsellor-owned row scope + SessionNoteService FERPA gate via `student_counseling_record:read` + IRREVERSIBLE lock with multi-column locked_chk) + wellbeing (32 tests — CheckinService.submit KEYSTONE response + alert + `svc.wellbeing.alert.created` outbox in same tx + SHI>FEELS_UNSAFE>WANTS_TO_TALK precedence + per-question-type shape validation + AlertService acknowledged_chk lockstep) + mtss (36 tests — MtssTierService partial UNIQUE keystone + caseload-ownership rule + row-scope visibility + svc.tier.changed emit + admin-only dashboard + team meetings UNIQUE). **Cumulative IMMUTABLE coverage: 9 tables verified DB-side**.

**Build state:**

- `pnpm --filter @campusos/api build` — 0 errors (`nest build`)
- `pnpm --filter @campusos/api test` — 1499 / 1499 passing (+ 54 skipped pre-existing). Mock-based unit specs across the 7 Wave 1-3 modules (m83, m84, m86, m00, m23, m87, m27) were deleted per Codex FIX 1 — the surface they covered now lives in DB-backed integration tests.
- `pnpm --filter @campusos/api test:integration` — 1013 / 1013 passing (0 skips). Includes the Codex review additions: cross-school isolation across m23 + m27 read paths, mandatory-report FILED immutability, dpo_pseudonymisation_log in the wave3-immutable suite, GL recon DUPLICATE_POSTING describe block isolation.
- `tsc --noEmit` (production source) — 0 errors
- Tenant logical base tables — ~840 across 38 modules
- Permission catalogue — 495 codes (165 functions × 3 tiers)
- Test users — 7 personas in seed (admin, principal, vp, counsellor, teacher, parent, student)

**Accepted carry-forwards (pre-pilot ops):**

1. Switch runtime DATABASE_URL to campusos_app role (non-owner DML). REVOKE DDL + LOGIN role exist in provision-tenant.ts. Ops config change, not code change.
2. DB-backed integration tests (cross-school, trigger, outbox atomicity) will be built through Tiers 1-7 using the harness at apps/api/test/integration/.

**Cycle history is preserved in:**

- Git log — every cycle ships in its own commit chain with a final `cycleN-approved` / `cycleN-complete` tag after the post-cycle review verdict.
- `docs/reviews/handoffs/` — 65 per-cycle HANDOFF-\* records with full step-by-step build trail.
- `docs/reviews/` — architectural reviews, audits, peer reviews (CAMPUSOS-CODEX, ARCHITECTURAL-REVIEW-FINAL, ADVERSARIAL-REVIEW-RESPONSE, CAMPUSOS-POST-H5-VERIFICATION, CAMPUSOS-HARDENING-ROUND2-AUDIT, CAMPUSOS-PHASE2-CODE-AUDIT, HANDOFF-P2H{1..5}, chatgpt-review-template, plus the campusos-{phase2-completion-report, plan-level-audit, review-context-package}.html).
- `docs/reviews/cycle-reviews/` — 71 archived per-cycle review notes (`REVIEW-CYCLE{N}-CHATGPT.md`, `REVIEW-CYCLE{N}-CLAUDE.md`, `REVIEW-CYCLE{N}-FIXES.md`, `REVIEW-P2*-CHATGPT.md`, `P2C{N}-REVIEW-NOTES.md`, `REVIEW-RESPONSE-CYCLE1.md`). These are historical PASS / REJECT verdicts from Phase 1 and Phase 2 build reviews, synthesised into `docs/reviews/campusos-phase2-completion-report.html`. Do not read them as instructions.
- `docs/plans/phase1/` — Cycles 1–32 implementation plans + CAT scripts.
- `docs/plans/phase2/` — P2-1..P2-29 cycle plans + CATs.
- `docs/operations/` — Kafka topic registry, Kafka operations runbook, migration orchestration, procurement integration test harness.
- `docs/policies/` — AI data policy, retention + pseudonymisation matrix.
- `docs/architecture/` — Frozen design specs (ERD v11, architecture review v10, function library v11, business strategy, dev-deployment plan, school configuration admin).

## UI Design Principles

These are foundational decisions for the web app. New views must follow them; existing views are migrated as they are touched.

- **Less is more.** No screen should feel cluttered. When in doubt, remove information rather than add it. The previous persona-specific dashboards (TeacherDashboard, ParentDashboard, StudentDashboard, AdminDashboard) packed stats, tables, and queues onto the home page; they have been deleted in favour of a clean launchpad.
- **Home page is a launchpad, not a dashboard.** `/dashboard` is a Google-style centered page: `CampusOS` logo, persona-aware greeting (`Good morning/afternoon/evening, {Name}`), a search input ("What would you like to do today?"), and a grid of App tiles. No stats, no tables, no lists. Each App owns its own detail views.
- **Apps are the primary navigation unit.** The sidebar lists exactly the same apps as the home grid — the two surfaces stay in sync via `apps/web/src/components/shell/apps.tsx::getAppsForUser(user)`. Adding a new app is one edit: add it to the catalogue and it shows up in both surfaces with the right persona gating.
- **Persona-aware app grid.** Driven by IAM permissions and `personType`, not by role names. Each tile has a `permission` predicate and an optional `routePrefix` so any nested route under the app keeps the tile highlighted.
- **iOS-style unread badges.** Red circle, white number, capped at "99+", in the top-right of an app tile and trailing-aligned on a sidebar row. Wired through `apps/web/src/hooks/use-app-badges.ts`. Hooks are gated on permissions via an optional `enabled` argument so a STUDENT without `com-001:read` doesn't 403 on `/threads`. The top-bar `NotificationBell` is the unified cross-app notifier and is independent of these per-app badges.
- **Logo is sans-serif.** The "CampusOS" wordmark uses the Tailwind `font-sans` stack (DM Sans / Inter / system) with `font-semibold` and `tracking-tight`. Never `font-display` (DM Serif Display) for the wordmark. `font-display` is still allowed for in-page article titles like an announcement detail headline; it must not be used for the brand mark.
- **App pages are minimal lists, not dashboards.** `/classes` and `/children` are flat grids of cards (one card per class / child) with one or two primary actions per row. Recent activity, queues, and aggregate stats belong in their own apps, not bolted onto a launchpad or a list page.

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
apps/api/src/modules/                        → 38 canonical domain modules
  ├── m00-platform/                          → Core platform: auth (service/controller/module) + iam + tenant (module/guard) + configuration + region + governance + profile + households + community + crm + ops + platform-admin + platform
  ├── m60-tickets/                           → Service tickets / helpdesk (M60)
  ├── m02-workflows/                         → Approval workflows (M2)
  ├── m03-tasks/                             → Task management + auto-task rule engine (M3)
  ├── m09-behaviour/                         → discipline/ + intervention-plans/ + positive/
  ├── m20-sis/                               → students/ + guardians/ + family/ + attendance/ + custom-fields/ + notes/ + graduation/ + transcripts/ + lockers/ + transfers/
  ├── m21-classroom/                         → classes/ + lessons/ + assignments/ + grading/ + ai-tutoring/ + hall-passes/ + peer-review/ + progress-notes/ + report-cards/
  ├── m22-scheduling/                        → Bell schedules + timetable (btree_gist EXCLUSIONs) + rooms + bookings + calendar + coverage
  ├── m23-health/                            → records/ + iep/ + immunisation/ + dietary/ + screenings/
  ├── m24-library/                           → Catalogue + circulation + holds + fines + reading programmes + reviews
  ├── m25-curriculum/                        → Curriculum maps + standards + delivery gap worker
  ├── m26-portfolio/                         → Portfolio + readiness pathways + college apps + resume
  ├── m27-student-services/                  → counselling/ + wellbeing/ + referrals/ + mtss/ + caseload/
  ├── m40-communications/                    → messaging/ + announcements/ + notifications/ + broadcasts/ + moderation/ + push/ + emergency-alerts/
  ├── m41-meetings/                          → meetings/ + recordings/ + templates/
  ├── m42-publications/                      → Publications (M42)
  ├── m61-transport/                         → Transportation (M61)
  ├── m62-it/                                → IT infrastructure (M62)
  ├── m63-food-service/                      → Food service (M63)
  ├── m64-clubs/                             → clubs/ + elections/ + field-trips/ + activities/
  ├── m65-facilities/                        → Facilities (M65)
  ├── m66-athletics/                         → Athletics (M66)
  ├── m67-store/                             → orders/ + products/ + promotions/ + loyalty/ + gift-cards/ + wishlists/ + inventory/ + categories/
  ├── m80-hr/                                → employees/ + leave/ + payroll/ + recruitment/ + training/ + certifications/ + appraisals/
  ├── m81-enrolment/                         → applications/ + offers/ + waitlist/ + tours/ + withdrawals/ + capacity/
  ├── m82-substitutes/                       → Substitute marketplace (M82)
  ├── m83-finance/                           → Finance & accounting (M83) — core + finance-advanced (departmental budgets, atomic budget transfers, manual journal entry batches)
  ├── m84-payments/                          → Payments & billing (M84)
  ├── m85-accreditation/                     → Accreditation (M85)
  ├── m86-procurement/                       → Procurement (M86) — core + procurement-advanced (vendor catalogues, contracts with amendments + expiry alerting, spending analytics)
  ├── m87-safety/                            → incidents/ + emergency/ + drills/ + reunification/
  ├── m90-visitors/                          → Visitor management (M90)
  ├── m100-engagement/                       → Parent engagement (M100)
  ├── m101-events/                           → Events & ticketing (M101)
  ├── m102-alumni/                           → Alumni (M102)
  ├── m103-groups/                           → groups/ + events/ + polls/ + resources/
  └── m110-analytics/                        → Analytics & reporting (M110)
apps/api/src/shared/                         → Cross-cutting infrastructure
  ├── auth/                                  → Guards (Auth, Permission, StudentOwned) + decorators (Public, RequirePermission, StudentOwned, PlatformScoped) + their *.spec files
  ├── tenant/                                → Tenant context (AsyncLocalStorage), middleware, Prisma wrappers (`executeInTenantContext`, `executeInTenantTransaction`), index re-exports
  ├── kafka/                                 → KafkaProducerService (ADR-057 envelope) + KafkaConsumerService + IdempotencyService + OutboxService + `envelope-consumer` (unwrapEnvelope + processWithIdempotency — ADR-057 helpers used by every Kafka consumer) + `prefixedTopic`
  ├── cache/                                 → RedisModule + RedisService (best-effort ioredis wrapper used by IAM cache, notification pipeline, ledger balance, AI quota, unread counts, ledger / publication / loyalty caches)
  ├── dlq/                                   → Dead letter queue admin (DlqController, DlqService, replay/discard atomic claim flow)
  ├── observability/                         → OpenTelemetry bootstrap, structured logger, Prometheus metrics, circuit breaker, reference-health scanner, worker jitter, trace context, request-log middleware
  ├── common/                                → Shared utilities (reserved)
  └── __tests__/                             → Cross-cutting regression suites (P2-H4 IMMUTABLE contracts, atomic operations, school-scope leak regression, P2-H5 role contract + immutable-role-contract)
apps/web/                                    → Next.js 14 frontend (App Router, Tailwind, React Query, Zustand)
apps/web/src/app/                            → Routes (App Router groups: /(app)/* for authed; /login, /apply/tours/public, /shop/[storeId], /portfolio-share/[token], /enrolment/tours/public, /find-schools for unauthed)
apps/web/src/components/                     → ui/ (DataTable, Modal, Toast, PageHeader, EmptyState, etc.), shell/ (AppLayout, Sidebar, TopBar, apps.tsx launchpad catalogue, NotificationBell, icons), classroom/, scheduling/, profile/
apps/web/src/hooks/                          → React Query hooks per domain (use-classroom, use-hr, use-scheduling, use-billing, use-enrollment, use-discipline, etc.)
apps/web/src/lib/                            → api-client (Bearer + X-Tenant-Subdomain + single-flight 401→refresh), auth-store (Zustand), auth-context, query-client, shared TS types, *-format helpers per domain
packages/database/                           → Prisma schema (platform/schema.prisma), tenant SQL migrations (prisma/tenant/migrations/*.sql), provisioning, seed scripts
packages/shared/                             → Shared TypeScript types and constants
docs/                                        → Documentation (see "Design Documents" below)
  ├── architecture/                          → Frozen design specs (ERD v11, architecture review v10, function library v11, business strategy, dev-deployment plan, school configuration admin)
  ├── plans/{phase1,phase2,hardening}/       → Cycle implementation plans + CAT scripts
  ├── reviews/                               → Architectural reviews, audits, peer reviews
  ├── reviews/handoffs/                      → 65 per-cycle HANDOFF-* records
  ├── operations/                            → Runbooks (Kafka, migration orchestration, procurement integration)
  ├── policies/                              → Compliance docs (AI data policy, retention + pseudonymisation matrix)
  ├── design-hub/index.html                  → Design hub home page
  └── (root)                                 → restructure-plan, test-coverage-plan, phase3-roadmap, hardening-cycles
```

Path aliases (set in `apps/api/tsconfig.json` and both vitest configs):

- `@modules/*` → `apps/api/src/modules/*`
- `@shared/*` → `apps/api/src/shared/*`
- `@/*` → `apps/api/src/*` (legacy escape hatch)

Nest CLI's webpack-loader resolves aliases at compile time, so `dist/` ships pure relative require paths — no runtime tsconfig-paths needed.

**Canonical-aggregator pattern.** `app.module.ts` imports exactly **one module per canonical M-numbered directory** (37 total). Directories that contain multiple leaf NestJS modules (m00-platform, m09-behaviour, m20-sis, m21-classroom, m23-health, m27-student-services, m40-communications, m41-meetings, m64-clubs, m67-store, m80-hr, m81-enrolment, m87-safety, m103-groups) expose a top-level `m{XX}-{name}.module.ts` aggregator (class `M{XX}{Name}Module`) that imports + re-exports every leaf module under that directory. App.module.ts never imports leaf modules directly. The M-prefixed class name avoids TypeScript collisions with same-named leaf classes (e.g. `M20SisModule` aggregator vs `SisModule` leaf at `m20-sis/students/sis.module.ts`). Modules that were already flat at root (m02, m03, m22, m24-26, m42, m60-66 except m64, m82-86, m90, m100-102, m110) keep their existing single root module file. m83-finance and m86-procurement fold their `*-advanced.module.ts` siblings into their existing root module (FinanceModule imports FinanceAdvancedModule internally; same pattern for ProcurementModule) so they still register as one canonical module each.

**Barrel exports.** Every canonical module exposes an `index.ts` at its root that re-exports the module's public API — the aggregator class + the few services / types other modules consume. The shared subsystems (`shared/auth`, `shared/tenant`, `shared/kafka`, `shared/cache`) likewise expose `index.ts` barrels. Cross-module imports go through the barrel (`import { ActorContextService, ResolvedActor } from '@modules/m00-platform'`); within-module imports stay relative (`from './student.service'`). The convention is enforced informally — most-imported boundaries (m00-platform IAM, @shared/tenant, @shared/auth, @shared/kafka) drive the bulk of cross-module references and account for >2,400 import lines that all go through barrels. A handful of edge cases — within-module `@modules/m00-platform/iam/*` references inside m00-platform itself, two `@shared/kafka/*` references inside shared/kafka — stay direct because routing through the barrel would create a self-import.

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

### Convenience scripts (root `package.json`)

```bash
pnpm dev               # both api + web concurrently via Turborepo
pnpm dev:api           # NestJS api, watch mode (port 4000)
pnpm dev:web           # Next.js web, dev mode (port 3000)

pnpm db:migrate        # apply platform migrations + provision tenant_demo (idempotent — migrate:deploy non-interactive)
pnpm db:seed           # full demo data — runs the multi-step seed:all chain (each step idempotent; ~26 seconds end-to-end)
pnpm db:reset          # drop platform + every tenant_* schema, then migrate + seed in one command. Refuses to run against any DATABASE_URL that isn't localhost with a _dev/_test suffix.
pnpm db:studio         # Prisma Studio (visual platform-schema browser)

pnpm format            # Prettier auto-fix
pnpm format:check      # Prettier verify (CI gate)
pnpm lint:logs         # log-schema lint (CI gate — no console.log, no email PII in logs)
pnpm test              # turbo test (vitest under the hood)
pnpm build             # turbo build across all packages
```

### Per-package scripts

```bash
# API (apps/api)
pnpm --filter @campusos/api dev          # nest start --watch
pnpm --filter @campusos/api build        # nest build
pnpm --filter @campusos/api test         # vitest run
pnpm --filter @campusos/api test:integration   # DB-backed integration tests (requires Postgres)
pnpm --filter @campusos/api test:all           # unit + integration combined
pnpm --filter @campusos/api exec tsc --noEmit   # strict typecheck

# Database (packages/database)
pnpm --filter @campusos/database migrate:deploy        # platform only
pnpm --filter @campusos/database provision --subdomain=demo
pnpm --filter @campusos/database seed:all              # full seed chain (~36 steps)
pnpm --filter @campusos/database seed                  # platform only
pnpm --filter @campusos/database seed:iam              # IAM only (permissions, roles, role-permission mappings)
pnpm --filter @campusos/database cache:build           # rebuild iam_effective_access_cache
```

### Tenant schema migrations

Add an SQL file to `packages/database/prisma/tenant/migrations/` (numbered `NNN_*.sql`), then re-provision:

```bash
pnpm --filter @campusos/database provision --subdomain=demo
pnpm --filter @campusos/database provision --subdomain=test
pnpm --filter @campusos/database seed:all
pnpm --filter @campusos/database exec tsx src/build-cache.ts
```

### Rebuild from corrupted state

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "DROP SCHEMA IF EXISTS tenant_demo CASCADE; DROP SCHEMA IF EXISTS tenant_test CASCADE;"
pnpm --filter @campusos/database provision --subdomain=demo
pnpm --filter @campusos/database provision --subdomain=test
pnpm --filter @campusos/database seed:all
pnpm --filter @campusos/database exec tsx src/build-cache.ts
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

**Frozen design specs** (`docs/architecture/`):

- `campusos-erd-v11.html` — Complete schema: ~840 tables with full column definitions, constraints, indexes, partitioning, Kafka events, ADR cross-references
- `campusos-architecture-review-v10.html` — 30 sections covering system architecture, multi-tenancy, IAM, events, scalability, security
- `campusos-function-library-v11.html` — 165 functions × 3 tiers (read / write / admin) = 495 permission codes
- `campusos-business-strategy.html` — Pricing, team, GTM, community exchange
- `campusos-dev-deployment-plan.html` — Build pipeline, environments, infrastructure
- `campusos-school-configuration-admin.html` — Three organisational structures (Facility, Academic, Position) + 8-step setup wizard

**Cycle plans** (`docs/plans/phase1/` and `docs/plans/phase2/`):

- `phase1/campusos-cycle{N}-implementation-plan.html` — Per-cycle implementation plan (N = 1..32, incl. 6.1 and 11.1)
- `phase1/cycle{N}-cat-script.md` — Per-cycle Customer Acceptance Test script
- `phase2/campusos-p2c{N}-*.html` — P2 cycle plans
- `phase2/p2c{1,2,3,6}-cat-script.md` — P2 CATs
- `phase2/campusos-phase2-{backlog,build-plan,testing-checklist}.html` — Phase 2 supporting plans

**Reviews** (`docs/reviews/` and `docs/reviews/handoffs/`):

- `handoffs/HANDOFF-CYCLE{N}.md` — Per-cycle handoff: step-by-step build trail, deviations, decisions
- `handoffs/HANDOFF-P2C{N}.md` — P2 cycle handoffs
- `handoffs/HANDOFF-P2H{1..5}.md` — Hardening cycle handoffs
- `ARCHITECTURAL-REVIEW-FINAL{,-V2}.md`, `ADVERSARIAL-REVIEW-RESPONSE.md` — Final pre-pilot reviews
- `CAMPUSOS-CODEX-PEER-REVIEW.md`, `CAMPUSOS-CODEX-ROUND2-REVIEW.md`, `CAMPUSOS-POST-H5-VERIFICATION.md`, `CAMPUSOS-HARDENING-ROUND2-AUDIT.md`, `CAMPUSOS-PHASE2-CODE-AUDIT.md`
- `campusos-phase2-completion-report.html`, `campusos-plan-level-audit.html`, `campusos-review-context-package.html`, `chatgpt-review-template.md`

**Operations** (`docs/operations/`):

- `kafka-operations-runbook.md` — Consumer retry policy, DLQ shape, replay procedure, financial/safety event escalation SLAs
- `kafka-topic-registry.md` — Canonical inventory of every Kafka topic (~110 topics across 38 modules)
- `migration-orchestration.md` — Tenant migration authoring rules (splitter caveats, idempotency, expand/contract pattern, rollout sequencing, T-72h / T-24h / T-0 / T+1h communication template)
- `procurement-integration-test-harness.md` — Integration test harness setup for the M86 procurement module

**Policies** (`docs/policies/`):

- `ai-data-policy.md` — Hard categorical exclusions (health, behaviour, counselling, wellbeing, mandatory reports, banned persons, HR, financial, DPO data, verification docs are NEVER sent to AI providers even with consent); PII minimisation pseudonym-map pipeline; zero-retention + training opt-out + EU/US region pinning; opt-out effect (hard-delete + provider-side deletion request); 90-day pseudonymisation of inference logs
- `retention-pseudonymisation-matrix.md` — Per-record-class retention durations + lawful basis + pseudonymisation actions across 36 record classes (operational / academic / health-safety / financial / counselling-safeguarding / HR-workforce / audit-logs / identity-governance)

**Other** (`docs/`):

- `campusos-test-coverage-plan.html` — Test strategy across all 38 modules; per-tier coverage targets (Tier 1 Financial ≥95%, Tier 2 Auth+IAM ≥95%, Tier 5 Core Domain ≥80%, Tier 6 Operational ≥80%)
- `campusos-phase3-roadmap.html` — Phase 3 themes (chart of accounts management, AP three-way matching, grant accounting, financial statements, AI-driven analytics, full Stripe wiring)
- `campusos-hardening-cycles.html` — Hardening sprint plan (P2-H1 through P2-H6)
- `campusos-restructure-plan.html` — This restructure's source-of-truth plan
- `design-hub/index.html` — Design hub home page

## Conventions

- Tenant-scoped tables use SQL migrations in `packages/database/prisma/tenant/migrations/`.
- Platform tables use Prisma schema in `packages/database/prisma/platform/schema.prisma`.
- NestJS modules follow the pattern: `module.ts`, `service.ts`, `controller.ts`, `dto/` co-located inside the canonical module under `apps/api/src/modules/m{XX}-{name}/{sub-module}/`. Spec files (`*.spec.ts`) sit next to the file under test.
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
