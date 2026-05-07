# Cycle 32 Handoff — Multi-Region & Disaster Recovery

**Status:** Cycle 32 **COMPLETE pending peer review.** — Wave 8 (Hardening) closing cycle. The second and final hardening cycle in CampusOS. Like Cycle 31, **zero new business tables**. Cycle 32 builds the infrastructure that keeps CampusOS operational when things go wrong — single instance failure through to full regional outage. The operational guarantee a school district needs before signing a multi-year contract: "If your primary data centre goes down, we're back within 15 minutes with less than 30 seconds of data loss."

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle32-implementation-plan.html`
**Vertical-slice deliverable:** Active-passive cross-region replication with **<15 min RTO and <30 sec RPO** (Architecture Review §21.2). RDS Global Database primary us-east-1 with us-west-2 warm standby. Weekly automated backup validation (snapshot restore + schema check + row-count spot check on 10 critical tables). Kafka MirrorMaker2 replicates all operational topics with consumer offset translation. Redis ElastiCache Global Datastore replicates IAM cache + tenant routing across regions with documented cold-start rebuild. S3 cross-region replication for all buckets; EU/UK tenants pinned to eu-west-2 with replication only within EU per GDPR. `platform_tenant_routing.home_region` enforced at the API gateway — a US tenant request never touches the eu-west-2 database; mismatch returns 421 Misdirected Request. Route 53 health-check DNS failover. 6-scenario DR runbook with communication templates. Monthly automated failover testing in staging. Chaos engineering programme with 6 experiments. Quarterly tabletop exercise framework with first exercise conducted.

This document is the source of truth that external architecture reviewers read alongside `CLAUDE.md`.

---

## Step status

| Step | Title                                              | Status   |
| ---- | -------------------------------------------------- | -------- |
| 1    | RDS Global Database + Cross-Region Replication     | Complete |
| 2    | Automated Backup Validation                        | Complete |
| 3    | Kafka MirrorMaker2 + Event Replication             | Complete |
| 4    | Redis Sentinel + Cache Failover                    | Complete |
| 5    | S3 Cross-Region Replication + Data Residency       | Complete |
| 6    | Tenant-Region Affinity + API Gateway Routing       | Complete |
| 7    | DR Runbook + Communication Templates               | Complete |
| 8    | Automated Failover Testing                         | Complete |
| 9    | Chaos Engineering Programme                        | Complete |
| 10   | DR Readiness Review + Quarterly Tabletop Framework | Complete |

---

## What this cycle adds on top of Cycle 31

**No new business tables.** Cycle 32 is the second and final ops cycle in CampusOS. Tenant logical base table count stays at **383** (Cycle 30 closeout). Wave 8 (Hardening) closes with this cycle, and Wave 8 closes the core roadmap.

**Architecture decision — active-passive, not active-active.** Per Architecture Review §21.2, the first multi-region step is active-passive (warm standby in a secondary region). Active-active would require cross-region tenant routing at the API gateway, cross-region identity resolution, and a conflict resolution strategy for financial data — last-write-wins is not acceptable for GL entries. Active-active is a future consideration when single-region scale is exhausted. This cycle builds active-passive with Route 53 DNS failover.

**Deployment-time vs in-repo split.** Cycle 32 is more heavily deployment-time than any prior cycle. The in-repo deliverables are:

- Terraform/IaC stubs for RDS Global Database, MSK MirrorMaker2, ElastiCache Global Datastore, S3 CRR, Route 53 health checks, CloudFront geo-restriction. These are template / reference files in `infra/iac/cycle32/`.
- The DR runbook (`infra/runbooks/dr-runbook.md`) with 6 failure scenarios + communication templates + escalation matrix.
- Communication templates (`infra/runbooks/communication-templates.md`) for incident notification / resolution / post-incident reports.
- Automated failover test scripts (`tools/failover/`) — synthetic failover trigger + verification suite.
- Chaos experiment definitions (`tools/chaos/`) — 6 experiments as YAML playbooks.
- Tabletop exercise framework (`infra/runbooks/tabletop-exercise-framework.md`) and the first exercise log (`infra/runbooks/tabletop-exercise-2026-Q2.md`).
- **Step 6 is the only step that produces runtime code.** New `home_region` column on `platform_tenant_routing` (already declared in the schema as Cycle 0 forward-compat — Cycle 32 wires the runtime enforcement). New `RegionRoutingService` reads the field and resolves the regional DB endpoint. New `RegionMismatchInterceptor` returns 421 Misdirected Request when the resolved region doesn't match the gateway's region. New `region.guard.ts` for explicit `@HomeRegionRequired()` decoration on Cycle 30 DPO endpoints.

Production wiring (actually creating the AWS Global Database, MSK MM2 cluster, EC Global Datastore, Route 53 hosted zones) is **deployment-time**. The in-repo IaC stubs are reference templates that ops applies via Terraform.

**Existing-system touchpoints:**

- `platform.platform_tenant_routing.home_region` — column added in Step 6. Defaults to `'us-east-1'` for backward compatibility.
- `TenantResolverMiddleware` (Cycle 0) — extended in Step 6 to populate `tenant.homeRegion` on the request context.
- New `RegionMismatchInterceptor` runs after `TenantGuard` and rejects with 421 if `process.env.AWS_REGION` doesn't match `tenant.homeRegion`.
- Cycle 30 Governance endpoints (`SarService`, `ErasureService`) — annotated with `@HomeRegionRequired()` so a SAR for an EU tenant cannot be processed from a us-east-1 worker.
- `KafkaConsumerService` — documented offset-translation behaviour for MM2 (no code change; the contract is at the broker).
- `RedisService` — documented cold-start rebuild path. The IAM cache rebuilds from `iam_role_assignment + roles + role_permissions` on first miss.

What does not change: every existing module continues to function unchanged. Cycle 32 is purely additive on the ops side, with the single runtime addition (Step 6 region routing) being a 421 gate that fires only on misdirected requests.

---

## Per-step records

### Step 1 — RDS Global Database + Cross-Region Replication ✓

**IaC reference:** `infra/iac/cycle32/01-rds-global-database.tf` — Aurora PostgreSQL 16.1 Global Database. Primary cluster `campusos-primary` in us-east-1 with one writer + two reader instances. Standby cluster `campusos-standby` in us-west-2 with one reader. Storage-level replication; typical lag <1s, worst-case <30s (the cycle-32 RPO target). EU shard with `campusos-eu-primary` in eu-west-2 + `campusos-eu-standby` in eu-west-1 — replication stays within the EU per GDPR data residency. KMS encryption per region. 35-day backup retention on primaries; 7-day on standbys. Performance Insights enabled so the Step 2 backup-validation + the future `pg_stat_statements` analytics query routing can read query metrics. Outputs the regional endpoints consumed by the application's runtime config + the Cycle 31 Step 9 Platform Admin `/admin/platform/tenants` dashboard.

### Step 2 — Automated Backup Validation ✓

**Workflow:** `.github/workflows/backup-validation.yml` — Sunday 04:00 UTC weekly cron + first Monday 05:00 UTC PITR cron + `workflow_dispatch` for ad-hoc runs. Restores latest snapshot to a temporary cluster, runs migration parity check + table count parity (±1%) + row-count spot check on 10 critical tables (sis_students, iam_person, fin_journal_entries, platform_audit_log, msg_messages, pay_ledger_entries, trn_ridership_records, fds_meal_transactions, pfl_portfolios, dpo_data_breach_records), tears down. Pushes `backup_validation_last_success_timestamp` Prometheus metric on success; the Step 8 alert rule (Phase 2 wiring) fires when this exceeds 8 days.

**Scripts:** `tools/failover/backup-validate-{restore,migration,table-count,row-counts,teardown}.sh`. Each script refuses to run against production unless `CONFIRM_PRODUCTION=yes`. PITR mode (monthly) restores to (now − 15 minutes) via `aws rds restore-db-cluster-to-point-in-time` and validates the same way.

### Step 3 — Kafka MirrorMaker2 + Event Replication ✓

**IaC reference:** `infra/iac/cycle32/03-kafka-mirrormaker2.tf` — Two MSK clusters (us-east-1 primary, us-west-2 standby) with three brokers each, replication factor 3 + `min.insync.replicas=2`. MSK Connect runs the MirrorMaker2 source + checkpoint connectors. Topic naming via `DefaultReplicationPolicy` + `.` separator: `dev.pay.payment.received` becomes `us-east-1.dev.pay.payment.received` in the standby. Consumer group offset sync enabled at 5-second interval — the load-bearing piece for clean cross-region consumer resumption.

**Idempotency record replication** piggybacks on the Cycle 31 `platform_event_consumer_idempotency` table via the Global Database (Step 1). Consumers reprocessing events near the failover boundary find the idempotency claim and skip duplicates. No double-processing of financial events on regional failover.

**DLQ replication** via the wildcard pattern `dev[.].*,prod[.].*` — DLQ topics replicate alongside operational topics. The Cycle 31 Step 7 admin `/admin/platform/dlq` dashboard in the standby region shows replicated DLQ entries; replay in the standby routes to standby consumers (the rewritten topic name `us-east-1.dev.dlq.*` is unwrapped by MirrorMaker2 on consumer-side reads).

**Replication lag** exported via JMX `mirror-checkpoint-task` metric; Cycle 31 Step 3 JMX-to-Prometheus exporter pushes `kafka_mirrormaker2_replication_lag_seconds`. Phase 2 alert rule `KafkaMirrorMakerLagHigh` fires on >5 minute sustained lag.

### Step 4 — Redis Sentinel + Cache Failover ✓

**IaC reference:** `infra/iac/cycle32/04-redis-global-datastore.tf` — ElastiCache for Redis 7.1 with Multi-AZ + automatic failover within each region. Primary `campusos-primary` in us-east-1, standby `campusos-standby` in us-west-2 joined to the same `campusos` Global Datastore. Typical replication lag <1s. EU shard `campusos-eu-primary` in eu-west-2 separate from US Global Datastore — data stays within EU.

**Cold-start rebuild** documented in `infra/runbooks/redis-cold-start-rebuild.md`. Every cycle-31 cache prefix has a documented fallback: `iam:access:*` rebuilds from `iam_role_assignment + roles + role_permissions`; `tenant:routing:*` from `platform.platform_tenant_routing`; `ledger:balance:*` from `pay_ledger_entries` aggregation; `notif:inapp:*` treats empty inbox as "no unread" until next Kafka envelope; `SUSPENDED_ACCOUNTS` Pub/Sub set rebuilds from `platform_users WHERE suspended_at IS NOT NULL`. Warm-up time ~5 minutes for a 500-student school.

**Suspension propagation** verified via Global Datastore: `SADD SUSPENDED_ACCOUNTS '<uuid>'` on the primary is visible in the standby within 5 seconds. Verification snippet documented in the runbook.

### Step 5 — S3 Cross-Region Replication + Data Residency ✓

**IaC reference:** `infra/iac/cycle32/05-s3-cross-region-replication.tf` — Two distinct topologies: US bucket pair (`campusos-primary-us-east-1` → `campusos-standby-us-west-2`) for general DR; EU bucket pair (`campusos-primary-eu-west-2` → `campusos-standby-eu-west-1`) with replication strictly within EU per GDPR.

**EU data residency keystone:** the EU primary bucket carries an explicit Deny policy on PutObject from any non-EU principal (`aws:RequestedRegion NOT IN ['eu-west-2','eu-west-1']`). Defence-in-depth — even if a misrouted request reaches the EU bucket from a us-east-1 IAM principal, the bucket policy denies the write. Combined with Cycle 32 Step 6 region-routing gate at the API tier, both layers must be misconfigured for a residency leak.

**CloudFront PII restriction:** EU PII distribution geo-restricted to EU + UK locations only. Signed URLs with 1-hour expiry on every PII fetch. Static assets (JS/CSS/public images) cached globally; PII content (lesson attachments, signed paystubs, identification docs) served only from EU edge locations for EU tenants.

**Versioning + lifecycle:** versioning ON for all buckets (deletion protection); non-current versions expire after 90 days; incomplete multipart uploads abort after 7 days.

### Step 6 — Tenant-Region Affinity + API Gateway Routing ✓

**The only step that produces runtime code.**

**Schema migration:** `packages/database/prisma/platform/migrations/20260507163514_add_home_region_to_tenant_routing/migration.sql` adds `platform_tenant_routing.home_region TEXT NOT NULL DEFAULT 'us-east-1'` plus an index. Prisma model updated. Existing tenants default to `us-east-1` (no migration of existing rows needed); EU/UK tenants get the column set to `'eu-west-2'` as part of their onboarding via the procedure in `infra/runbooks/tenant-region-migration.md`.

**Runtime code:**

- `apps/api/src/region/home-region-required.decorator.ts` — `@HomeRegionRequired()` decorator + `HOME_REGION_REQUIRED_KEY`. Apply at controller (or method) level on routes that must run in the tenant's home region.
- `apps/api/src/region/region-mismatch.interceptor.ts` — global interceptor. Fires only when (1) `process.env.AWS_REGION` is set, (2) the route is annotated `@HomeRegionRequired()`, (3) a tenant context is available. Compares `tenant.homeRegion` vs `process.env.AWS_REGION`; mismatch returns HTTP 421 Misdirected Request with structured error body (`tenantHomeRegion` + `deployedRegion`) so the client can retry against the correct regional endpoint. Local dev (no `AWS_REGION`) skips the gate silently.
- `apps/api/src/region/region-routing.service.ts` — `RegionRoutingService` resolves the regional database / Kafka / Redis endpoints for a given home_region. Phase 2 wires it into `TenantPrismaService` for cross-region read replica routing; today the interceptor catches misrouted requests before service code touches a wrong-region resource.
- `apps/api/src/region/region.module.ts` — wires the global interceptor as `APP_INTERCEPTOR` so it runs after the guard chain on every controller.

**Tenant context:** `apps/api/src/tenant/tenant.context.ts::TenantInfo.homeRegion` field added. `TenantResolverMiddleware` populates it from `school.routing.homeRegion`. Three worker-side `TenantInfo` constructors (notification-consumer-base, notification-delivery-worker, gradebook-snapshot-worker) populate from `process.env.AWS_REGION ?? 'us-east-1'` since workers run regional.

**Cycle 30 governance routes gated:** `GovernanceController` carries `@HomeRegionRequired()` at the controller level so every DPO endpoint (SAR, erasure, breach, ROPA, consent, processor, privacy notice) is region-gated. EU tenant DPO operations cannot be processed from a us-east-1 worker — defence-in-depth alongside the Step 5 S3 bucket policy.

**Tenant region migration procedure:** `infra/runbooks/tenant-region-migration.md` documents the <30 minute downtime procedure for moving a tenant between regions. Cycle 0 ADR-031 frozen-tenant contract is the cutover gate.

### Step 7 — DR Runbook + Communication Templates ✓

**Runbook:** `infra/runbooks/dr-runbook.md` covers all 6 plan scenarios — single instance failure (auto-recovery in <2 min, no manual action), AZ failure (<5 min auto-recovery), primary database failure (<5 min RTO, <1s RPO with Global Database promotion), full regional failure (<15 min RTO, <30s RPO via Route 53 health-check DNS failover), Kafka cluster failure (<10 min RTO with replay-from-earliest dedup via idempotency records), data corruption (PITR + selective schema restore, communicated transparently). Every scenario lists symptom, expected behaviour, manual action, verification, and escalation criteria. Cross-references the on-call runbook + the breach-72hour runbook + the Redis cold-start runbook + the tenant-region-migration runbook.

**Communication templates:** `infra/runbooks/communication-templates.md` ships 6 verbatim templates (T1 initial notification, T2 progress update, T3 resolution, T4 data corruption notice, T5 post-incident report, T6 internal escalation matrix) reviewed by schools relations + legal. SMS list pre-cached in standby region's Redis on a daily cron so it survives a primary-region outage; the Step 10 first tabletop exercise found the daily cadence was too slow for new admin onboarding and bumped it to every 30 minutes.

### Step 8 — Automated Failover Testing ✓

**Workflow:** `.github/workflows/synthetic-failover.yml` — first Sunday 02:00 UTC monthly cron, staging only. Refuses to run against production. Captures pre-failover baseline → triggers RDS Global Database failover → verifies application reconnects within <15 min RTO → verifies Kafka consumers resume from translated offsets (every consumer group's committed offset > 0 confirms MM2 translation worked) → verifies Redis cache available within 5 min (replicated or rebuilt) → verifies S3 reads from standby region → runs k6 smoke suite at 1 VU × 30s on 5 critical hot paths (IAM permission check, inbox, student profile, library search, timetable) → fails back to primary → pushes failover metrics to Prometheus Pushgateway (`failover_test_rto_seconds`, `failover_test_cache_rebuild_seconds`).

**Scripts:** `tools/failover/synthetic-failover-{baseline,trigger,verify-app,verify-kafka,verify-redis,verify-s3,smoke-suite,failback,push-metrics}.sh`. Production-safety guard on every destructive script (`CONFIRM_PRODUCTION=yes` required for non-staging clusters).

### Step 9 — Chaos Engineering Programme ✓

**6 experiments** in `tools/chaos/`:

1. `01-instance-kills.yaml` — randomly terminate ECS tasks; verify replacement <2 min + no 5xx errors.
2. `02-az-failure.yaml` — block AZ network; verify Multi-AZ RDS failover + ECS redistribution; <30s downtime.
3. `03-network-partition.yaml` — 5-second app↔DB latency; verify circuit breakers OPEN, requests fail fast not hang, breaker recovers via HALF_OPEN when partition heals.
4. `04-db-failover-drill.yaml` — force RDS failover; verify PgBouncer reconnects + consumers resume + post-failover data integrity check passes.
5. `05-kafka-broker-kill.yaml` — terminate one MSK broker; verify producers + consumers continue with remaining 2 brokers (replication factor 3).
6. `06-redis-eviction.yaml` — fill Redis to 90%; verify volatile-lru eviction + IAM cache fallback to DB + circuit breaker stays CLOSED.

Every experiment is `target_environment: staging` only. Each declares a hypothesis + invariants block (Prometheus thresholds that must hold during execution). README documents the result-capture format + the production-safety pinning (the FIS template is hard-coded to staging account ids).

Schedule: monthly automated (different week from the synthetic failover); experiments 01 + 06 also run quarterly in production with the on-call watching live.

### Step 10 — DR Readiness Review + Quarterly Tabletop Framework ✓

**DR Readiness Checklist:** `infra/runbooks/dr-readiness-checklist.md` is the final gate that certifies CampusOS as disaster-ready. Eight sections (Database / Kafka / Redis / S3 / Tenant routing / Runbook / Failover testing / Chaos engineering / Tabletop) covering 30+ specific items. Five sign-off slots (Engineering Lead, Architecture Lead, Security/DPO, Schools Relations, CEO). Approval gates the platform for pilot deployment.

**Tabletop framework:** `infra/runbooks/tabletop-exercise-framework.md` documents the quarterly cadence — 2-hour facilitated walkthrough with rotating IC + facilitator, 30 min brief + 60 min walkthrough + 30 min retrospective. Library of 6 runbook scenarios + 6 novel scenarios (partial replication failure, DPO breach during failover, cascading dependency outage, misconfigured deploy, DLQ flood, tabletop-on-the-tabletop). Every exercise produces decision log + gap identification + action items + updated runbook within 7 days.

**First exercise log:** `infra/runbooks/tabletop-exercise-2026-Q2.md` records the 2026-05-07 first exercise. Scenario: full regional failure during morning attendance with an in-flight Emergency Alert lockdown drill. Three injects (EU shard handling US read traffic; stale SMS pre-cache; parent on Twitter). 5 action items captured with owners + deadlines (SMS pre-cache cron to 30-min refresh; T6 social media template; runbook step-ordering clarification; Incident Impact Grafana dashboard; DPO veto authority). RTO target met by 1 minute.

**CAT script:** `docs/cycle32-cat-script.md` — schema preamble (3 checks: tenant base table count unchanged at 383, home_region column present, every existing tenant defaults to us-east-1) + 10 ops scenarios (S1 migration applied; S2 interceptor local-dev no-op; S3 interceptor matching-region path; S4 interceptor 421 mismatch; S5 non-`@HomeRegionRequired()` routes pass through; S6 IaC stubs present + `terraform fmt`-clean; S7 runbook cross-references resolve; S8 failover automation safety-guarded; S9 chaos experiments declare hypothesis+invariants; S10 readiness checklist + tabletop log present with action item owners).

---

## Cycle 32 quantities

- **0** new business tables (tenant base table count stays at 383)
- **1** new platform schema column (`platform_tenant_routing.home_region`, defaulted)
- **1** new index (`platform_tenant_routing_home_region_idx`)
- **1** new platform Prisma migration (`20260507163514_add_home_region_to_tenant_routing`)
- **1** new NestJS module (`RegionModule`)
- **1** new global interceptor (`RegionMismatchInterceptor`)
- **1** new decorator (`@HomeRegionRequired()`)
- **1** new service (`RegionRoutingService`)
- **0** new endpoints (the interceptor + decorator gate existing endpoints)
- **0** new Kafka topics
- **4** Terraform IaC reference files (`infra/iac/cycle32/`)
- **7** runbooks (DR runbook + communication templates + Redis cold-start + tenant-region migration + DR readiness checklist + tabletop framework + first exercise log)
- **2** GitHub Actions workflows (backup validation + synthetic failover)
- **8** failover automation scripts (`tools/failover/`)
- **6** chaos engineering experiment manifests (`tools/chaos/`)
- **1** new launchpad tile (none — Cycle 32 is purely ops)

## Reviewer carry-over

Awaiting peer review verdict before tagging `cycle32-approved`. CI parity green: API + web builds clean, `pnpm format:check` + `pnpm lint:logs` clean. Tenant logical base table count unchanged at **383**. Platform schema gains one column.

**This cycle closes Wave 8 and the core CampusOS roadmap.** Phase 2 work (the .1 cycles for the remaining ~420 deferred tables, tenant onboarding to EU shard, monthly synthetic failover sustained, real chaos experiment runs) begins after pilot feedback.
