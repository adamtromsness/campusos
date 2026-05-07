# REVIEW-CYCLE32-CHATGPT

**Cycle:** 32 — Multi-Region & Disaster Recovery (Wave 8 closing). The
final cycle of the core CampusOS roadmap. Like Cycle 31, **zero new
business tables**. Active-passive cross-region replication with <15
min RTO, <30 sec RPO; RDS Global Database, Kafka MirrorMaker2,
ElastiCache Global Datastore, S3 CRR with EU data residency, tenant
home-region enforcement, DR runbook, automated failover testing,
chaos engineering programme, quarterly tabletop framework.

**Round 1 commit:** `cycle32-complete` at the closeout commit on `main`.
**Round 1 verdict:** _pending_.
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

## Triage table

| #   | Severity | Item | Status |
| --- | -------- | ---- | ------ |
|     |          |      |        |

(Filled in by the reviewer.)

---

## Round 2 verification trail

(Appended after closeout commit, if Round 1 returns Reject pending fixes.)
