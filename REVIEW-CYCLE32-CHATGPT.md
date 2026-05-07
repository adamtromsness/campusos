# REVIEW-CYCLE32-CHATGPT

**Cycle:** 32 — Multi-Region & Disaster Recovery (Wave 8 closing). The
final cycle of the core CampusOS roadmap. Like Cycle 31, **zero new
business tables**. Active-passive cross-region replication with <15
min RTO, <30 sec RPO; RDS Global Database, Kafka MirrorMaker2,
ElastiCache Global Datastore, S3 CRR with EU data residency, tenant
home-region enforcement, DR runbook, automated failover testing,
chaos engineering programme, quarterly tabletop framework.

**Round 1 commit:** `cycle32-complete` at `3d4cbce` on `main`.
**Round 1 verdict:** **Reject pending fixes** — 5 BLOCKING + 3 MAJOR. All 5 BLOCKING + 3 MAJOR addressed in the closeout fix commit.
**Live verification reference:** `tenant_demo` 2026-05-07.

---

## Reviewer brief

Cycle 32 is more heavily deployment-time than any prior cycle. The
in-repo deliverables fall into three buckets:

1. **Runtime code (Step 6 only).** New `home_region` column on
   `platform_tenant_routing` (defaulted to `us-east-1`). New
   `RegionModule` with `@HomeRegionRequired()` decorator,
   `RegionMismatchInterceptor` (HTTP 421 on mismatch), and
   `RegionRoutingService`. Cycle 30 `GovernanceController` annotated
   so every DPO endpoint is region-bound. `TenantInfo.homeRegion`
   field added; three worker-side `TenantInfo` constructors updated.
2. **IaC reference stubs.** Four Terraform files in
   `infra/iac/cycle32/` for RDS Global Database (Step 1), Kafka
   MirrorMaker2 (Step 3), ElastiCache Global Datastore (Step 4), and
   S3 cross-region replication + EU bucket policy (Step 5).
3. **Runbooks + automation + chaos manifests.** DR runbook (6
   scenarios), communication templates (6 verbatim), Redis cold-start
   rebuild, tenant-region migration procedure, DR readiness
   checklist, tabletop framework + first exercise log, GitHub
   Actions workflows for backup validation + synthetic failover with
   8 helper scripts, and 6 chaos experiment YAML manifests.

**Key contracts to verify:**

1. **`home_region` migration applied** with default `'us-east-1'` so
   existing tenants stay on the primary US cluster.
2. **`@HomeRegionRequired()` interceptor** is a no-op when
   `process.env.AWS_REGION` is unset (local dev / test).
3. **HTTP 421 path** fires when `AWS_REGION !== tenant.homeRegion`
   on annotated routes; non-annotated routes pass through unchanged.
4. **Cycle 30 `GovernanceController`** carries the decorator at the
   class level so every DPO endpoint inherits the gate.
5. **EU data residency defence-in-depth.** Step 5 EU bucket policy
   (`Deny PutObject` from non-EU principals) + Step 6 region routing
   gate. Both layers must be misconfigured for a residency leak.
6. **Idempotency replication.** Cycle 31 `platform_event_consumer_idempotency`
   replicates via Global Database, so consumers reprocessing events
   near a failover boundary find the idempotency claim and skip
   duplicates. No double-processing of financial events.
7. **Production safety.** Every destructive failover script in
   `tools/failover/` carries a `CONFIRM_PRODUCTION=yes` guard. The
   synthetic-failover GitHub Actions workflow refuses production.
8. **Chaos experiments staging-only.** Every YAML carries
   `target_environment: staging`.

---

## Verification surface

### S1 — Schema migration

```
docker exec campusos-postgres psql -U campusos -d campusos_dev -tA \
  -c "SELECT column_name, column_default, is_nullable
        FROM information_schema.columns
       WHERE table_schema='platform'
         AND table_name='platform_tenant_routing'
         AND column_name='home_region'"
# Expect: home_region | 'us-east-1'::text | NO
```

### S2 — Interceptor: local dev no-op (AWS_REGION unset)

```
unset AWS_REGION
curl -i -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        http://localhost:4000/api/v1/governance/dashboard
# Expect: 200
```

### S3 — Interceptor: matching region

```
AWS_REGION=us-east-1 ./run-api.sh &
curl -i -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        http://localhost:4000/api/v1/governance/dashboard
# Expect: 200 (tenant_demo home_region defaults to us-east-1)
```

### S4 — Interceptor: 421 mismatch

```
AWS_REGION=eu-west-2 ./run-api.sh &
curl -i -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        http://localhost:4000/api/v1/governance/dashboard
# Expect: HTTP 421 with body { tenantHomeRegion:"us-east-1", deployedRegion:"eu-west-2" }
```

### S5 — Non-annotated routes pass through

```
AWS_REGION=eu-west-2 \
  curl -i -H "Authorization: Bearer $TEACHER_TOKEN" \
       -H "X-Tenant-Subdomain: demo" \
       http://localhost:4000/api/v1/classes/my
# Expect: 200 (not @HomeRegionRequired())
```

### S6 — IaC stubs present

```
ls infra/iac/cycle32/
# Expect: 01-rds-global-database.tf, 03-kafka-mirrormaker2.tf,
#         04-redis-global-datastore.tf, 05-s3-cross-region-replication.tf
```

### S7 — Runbook cross-references resolve

```
for f in $(grep -hoP '`infra/runbooks/[a-z0-9-]+\.md`' infra/runbooks/*.md \
            | tr -d '`' | sort -u); do
  test -f "$f" && echo "OK $f" || echo "MISSING $f"
done
# Expect: every line "OK"
```

### S8 — Failover automation safety

```
grep -l 'CONFIRM_PRODUCTION' tools/failover/*.sh | wc -l
# Expect: at least 2 (trigger + failback)
```

### S9 — Chaos experiments well-formed

```
for f in tools/chaos/0[1-6]-*.yaml; do
  grep -q '^  hypothesis:' "$f" && grep -q '^  invariants:' "$f" \
    && echo "OK $f" || echo "MISSING $f"
done
# Expect: every line "OK"

grep -l 'target_environment: staging' tools/chaos/*.yaml | wc -l
# Expect: 6
```

### S10 — Tabletop log + DR readiness checklist

```
test -f infra/runbooks/dr-readiness-checklist.md && echo OK
test -f infra/runbooks/tabletop-exercise-2026-Q2.md && echo OK
grep -c 'Owner: ' infra/runbooks/tabletop-exercise-2026-Q2.md
# Expect: at least 5
```

### Build gate

```
pnpm --filter @campusos/api build && pnpm --filter @campusos/web build
# Expect: both clean

pnpm format:check && pnpm lint:logs
# Expect: both clean (lint:logs reports 507 files clean)
```

---

## Triage table — Round 1

| #   | Severity | Item                                                                  | Verdict | Fix commit / Disposition                                                                   |
| --- | -------- | --------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| 1   | BLOCKING | Handoff claims API-gateway enforcement; impl is app-layer interceptor | VALID   | Handoff + CLAUDE.md rewritten to describe app-layer gate; gateway routing is IaC + Phase 2 |
| 2   | BLOCKING | Synthetic failover production guard substring-matches "prod"          | VALID   | Hardened to explicit `TARGET_ENV` check + optional `STAGING_AWS_ACCOUNT_IDS` allowlist     |
| 3   | BLOCKING | Workflow accepts `dev` but trigger script defaults to staging IDs     | VALID   | `dev` removed from workflow input; `TARGET_ENV` exported to scripts                        |
| 4   | BLOCKING | CAT lacks live 421 verification output                                | VALID   | Live verification block appended with captured output for matching/mismatch/passthrough    |
| 5   | BLOCKING | Handoff sometimes reads as if infra is deployed                       | VALID   | Explicit "In-repo / Deployment-time / Operational certification" 3-bucket section added    |
| 6   | MAJOR    | `RegionRoutingService` not yet wired into TenantPrismaService         | DOC     | Handoff scope claim narrowed: "passive lookup; service-layer dynamic routing is Phase 2"   |
| 7   | MAJOR    | Tenant-region migration runbook lacks platform-row visibility step    | VALID   | Step 10a added with explicit cross-region count parity SQL queries                         |
| 8   | MAJOR    | Backup-validation Pushgateway heredoc renders truncated               | VALID   | Extracted to `tools/failover/backup-validate-push-metric.sh`                               |

## Round 1 fix verification trail

**BLOCKING 1 — handoff API-gateway claim corrected.** `HANDOFF-CYCLE32.md` line 7 + line 110 + line 177 rewritten to describe the gate as application-layer (Nest interceptor on `@HomeRegionRequired()` routes) rather than gateway. CLAUDE.md Cycle 32 status section updated similarly. Gateway-level routing (Route 53 latency-based + per-region API Gateway endpoints) explicitly called out as deployment-time IaC reference. The app-layer interceptor stays as defence-in-depth.

**BLOCKING 2 — production guard hardened.** `tools/failover/synthetic-failover-trigger.sh` and `synthetic-failover-failback.sh` now require explicit `TARGET_ENV` (defaults to `staging`); `production` / `prod` requires `CONFIRM_PRODUCTION=yes`; new optional `STAGING_AWS_ACCOUNT_IDS` allowlist trip-wires any `AWS_ACCOUNT_ID` that doesn't match without `CONFIRM_PRODUCTION=yes`. Cluster IDs default to `campusos-{global,primary,standby}-${TARGET_ENV}` so the workflow + script agree on environment.

**BLOCKING 3 — workflow `dev` option removed.** `.github/workflows/synthetic-failover.yml` `target_environment` input is now a `choice` enum with only `staging`. The workflow exports `TARGET_ENV` + `STAGING_AWS_ACCOUNT_IDS` as env to both the trigger and failback steps. Workflow guard tightened: any `target_environment != staging` exits 1.

**BLOCKING 4 — live CAT verification.** `docs/cycle32-cat-script.md` now carries a "Live verification record (2026-05-07)" section with captured `curl` output for all four scenarios:

- `AWS_REGION=us-east-1` + `home_region=us-east-1` → governance dashboard 200 with rollup body.
- Same matching region + non-`@HomeRegionRequired()` `/classes/my` → 200.
- `AWS_REGION=us-west-2` + `home_region=us-east-1` → 421 with structured `{statusCode, error: "MISDIRECTED_REQUEST", tenantHomeRegion, deployedRegion}` body.
- Mismatch region + non-annotated `/classes/my` → still 200 (gate is opt-in).

**BLOCKING 5 — in-repo vs deployment-time vs operational certification section.** New section in `HANDOFF-CYCLE32.md` with three clearly-labeled buckets. The cycle-32 closeout is **repo readiness**; **operational certification** is gated on the deployment-time + ongoing buckets and tracks alongside the broader Phase 2 punch list.

**MAJOR 6 — RegionRoutingService scope.** Handoff line 110 narrowed: "today it is a passive lookup; not yet wired into `TenantPrismaService`. The interceptor is the active enforcement; service-layer dynamic regional dependency routing is Phase 2."

**MAJOR 7 — tenant-region migration platform-row verification.** New step 10a in `infra/runbooks/tenant-region-migration.md` with explicit SQL count queries against `platform.platform_tenant_routing`, `platform.iam_person`, `platform.platform_audit_log`, and `platform.platform_dlq_messages` filtered to the migrated tenant. **Do not unfreeze** until the counts match — gates the cutover on Global Database replication convergence.

**MAJOR 8 — backup-validation Pushgateway extracted.** New `tools/failover/backup-validate-push-metric.sh` script holds the Pushgateway POST body, with URL shape validation + a clean exit when `PROM_PUSHGATEWAY_URL` is unset. Workflow step replaced with `bash tools/failover/backup-validate-push-metric.sh` + appropriate env vars.

---

## Round 2 verification trail

(Appended after Round 2 verdict.)
