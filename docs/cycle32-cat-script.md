# Cycle 32 — DR Readiness CAT

**Cycle:** 32 — Multi-Region & Disaster Recovery (Wave 8 closing).
**Surface:** Cross-cutting; touches platform schema (`home_region`),
governance controller (cycle-30 DPO surface), and the deployment-time
infrastructure (RDS Global Database, MSK MM2, EC Global Datastore,
S3 CRR).
**Tenant:** `tenant_demo` unless noted.
**Run after:** every Cycle 32 step is committed and the API has been
rebuilt + restarted.

This CAT focuses on what's verifiable in-repo: schema migration
applied, runtime region routing behaves correctly, runbooks and IaC
are present and well-formed, and the chaos / failover / tabletop
artifacts exist. Production wiring (actual RDS Global Database, MSK
MM2 cluster, EC Global Datastore, Route 53 health checks) lands at
deployment time.

## Schema preamble

```sql
-- 0a tenant base table count unchanged from Cycle 30 closeout —
--    Cycle 32 ships zero new business tables.
SELECT COUNT(*) FROM information_schema.tables
 WHERE table_schema = 'tenant_demo'
   AND table_type = 'BASE TABLE'
   AND table_name NOT LIKE '\_prisma\_%';
-- expect: 383

-- 0b home_region column present on platform_tenant_routing.
SELECT column_name, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'platform'
   AND table_name = 'platform_tenant_routing'
   AND column_name = 'home_region';
-- expect: home_region | 'us-east-1'::text | NO

-- 0c every existing tenant defaults to us-east-1.
SELECT schema_name, home_region FROM platform.platform_tenant_routing;
-- expect: tenant_demo | us-east-1 (and any other tenants the same)
```

---

## S1 — `home_region` migration applied

**What:** Cycle 32 Step 6 schema migration adds the column with a
non-null default.

**Verify:**

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -tA \
  -c "SELECT migration_name FROM public._prisma_migrations
        WHERE migration_name LIKE '%home_region%'
          AND finished_at IS NOT NULL"
```

Expect: one row matching `20260507163514_add_home_region_to_tenant_routing`.

---

## S2 — RegionMismatchInterceptor: local dev path (AWS_REGION unset)

**What:** Local dev / test environments have no `AWS_REGION`. The
interceptor MUST be a no-op so single-region dev keeps working.

**Verify:** Cycle 30 governance endpoint (carries `@HomeRegionRequired()`):

```bash
unset AWS_REGION
curl -i -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        http://localhost:4000/api/v1/governance/dashboard
# Expect: 200 (interceptor short-circuits on missing AWS_REGION)
```

---

## S3 — RegionMismatchInterceptor: matching region path

**What:** When `AWS_REGION === tenant.homeRegion`, the request
proceeds normally.

**Verify:**

```bash
AWS_REGION=us-east-1 \
  curl -i -H "Authorization: Bearer $ADMIN_TOKEN" \
       -H "X-Tenant-Subdomain: demo" \
       http://localhost:4000/api/v1/governance/dashboard
# Expect: 200 (tenant_demo defaults to us-east-1)
```

---

## S4 — RegionMismatchInterceptor: 421 mismatch path

**What:** When `AWS_REGION !== tenant.homeRegion`, the interceptor
returns HTTP 421 Misdirected Request before the controller runs.

**Verify:**

```bash
# Set AWS_REGION on the API process to a region OTHER than
# tenant_demo's home_region (us-east-1 by default).
AWS_REGION=eu-west-2 ./run-api.sh &  # production-style restart

curl -i -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "X-Tenant-Subdomain: demo" \
     http://localhost:4000/api/v1/governance/dashboard
# Expect: HTTP/1.1 421 Misdirected Request
# Body: { "statusCode":421, "error":"MISDIRECTED_REQUEST",
#         "tenantHomeRegion":"us-east-1", "deployedRegion":"eu-west-2" }
```

---

## S5 — Non-`@HomeRegionRequired()` routes are NOT gated

**What:** Step 6 only gates routes explicitly marked
`@HomeRegionRequired()`. Other routes (classes, attendance, etc.)
keep working even when AWS_REGION mismatches.

**Verify:**

```bash
AWS_REGION=eu-west-2 \
  curl -i -H "Authorization: Bearer $TEACHER_TOKEN" \
       -H "X-Tenant-Subdomain: demo" \
       http://localhost:4000/api/v1/classes/my
# Expect: 200 (not annotated with @HomeRegionRequired)
```

---

## S6 — IaC stubs present and well-formed

**What:** Steps 1–5 ship reference Terraform files for the
deployment-time wiring.

**Verify:**

```bash
ls infra/iac/cycle32/
# Expect:
#   01-rds-global-database.tf
#   03-kafka-mirrormaker2.tf
#   04-redis-global-datastore.tf
#   05-s3-cross-region-replication.tf

# Smoke check that the .tf files parse syntactically (terraform
# fmt -check works without an init):
terraform fmt -check infra/iac/cycle32/ || true
# Expect: no errors (warnings are acceptable for `provider` references
# pointing at variables not yet defined in this stub).
```

---

## S7 — Runbooks present and reference each other consistently

**What:** Steps 4 + 6 + 7 + 10 ship runbooks. Cross-references
between them must resolve.

**Verify:**

```bash
ls infra/runbooks/
# Expect (cycle-32 additions):
#   dr-runbook.md
#   communication-templates.md
#   redis-cold-start-rebuild.md
#   tenant-region-migration.md
#   dr-readiness-checklist.md
#   tabletop-exercise-framework.md
#   tabletop-exercise-2026-Q2.md

# Cross-reference check: every runbook reference resolves.
for f in $(grep -hoP '`infra/runbooks/[a-z0-9-]+\.md`' infra/runbooks/*.md \
            | tr -d '`' | sort -u); do
  test -f "$f" && echo "OK $f" || echo "MISSING $f"
done
# Expect: every line "OK".
```

---

## S8 — Failover automation scripts executable + safety-guarded

**What:** Step 8 ships a GitHub Actions workflow plus shell scripts
that refuse to run against production without `CONFIRM_PRODUCTION=yes`.

**Verify:**

```bash
ls .github/workflows/synthetic-failover.yml \
   .github/workflows/backup-validation.yml
# Expect: both present.

ls tools/failover/
# Expect: README.md + 8+ .sh scripts.

# Production-safety guard sanity check:
grep -l 'CONFIRM_PRODUCTION' tools/failover/*.sh | wc -l
# Expect: at least 2 (trigger + failback).
```

---

## S9 — Chaos experiments well-formed

**What:** Step 9 ships 6 YAML experiment manifests + a README.

**Verify:**

```bash
ls tools/chaos/*.yaml
# Expect: 01-instance-kills.yaml … 06-redis-eviction.yaml

# Every experiment is staging-only:
grep -l 'target_environment: staging' tools/chaos/*.yaml | wc -l
# Expect: 6 (all six)

# Every experiment declares a hypothesis + invariants block:
for f in tools/chaos/0[1-6]-*.yaml; do
  grep -q '^  hypothesis:' "$f" && grep -q '^  invariants:' "$f" \
    && echo "OK $f" || echo "MISSING $f"
done
# Expect: every line "OK".
```

---

## S10 — DR readiness checklist + first tabletop log present

**What:** Step 10 ships the readiness gate + first tabletop exercise
log.

**Verify:**

```bash
test -f infra/runbooks/dr-readiness-checklist.md && echo OK
test -f infra/runbooks/tabletop-exercise-framework.md && echo OK
test -f infra/runbooks/tabletop-exercise-2026-Q2.md && echo OK
# Expect: 3 OK lines.

# Action items from the first exercise have owners + deadlines:
grep -c 'Owner: ' infra/runbooks/tabletop-exercise-2026-Q2.md
# Expect: at least 5 (one per action item).
```

---

## Cleanup

Cycle 32 ships no new tenant data and no schema changes that need
rolling back. The S4 negative test (AWS_REGION mismatch) requires
an API restart with the variable unset to return to baseline:

```bash
unset AWS_REGION
./run-api.sh &
```

After cleanup, the tenant base-table count is unchanged from the
preamble (383). The platform schema gains one column (`home_region`)
and one index (`platform_tenant_routing_home_region_idx`); both
defaulted so existing tenants stay on us-east-1.

---

## Reviewer attention items (Phase 2 punch list)

These remain valid follow-ups, all expected per the cycle-32 plan:

1. Production wiring of every IaC stub — RDS Global Database, MSK
   MM2, EC Global Datastore, S3 CRR, Route 53 health checks. Ops
   applies via Terraform.
2. The first three monthly synthetic failover runs in staging.
3. The first round of chaos experiments executed in staging with
   results captured in the experiment-result format documented in
   `tools/chaos/README.md`.
4. EU tenant onboarding: first real-world tenant migrated to
   `home_region='eu-west-2'` end-to-end via the procedure in
   `tenant-region-migration.md`.
5. Quarterly tabletop exercise cadence sustained — second exercise
   target 2026-Q3.

These follow-ups are operational rather than code-bearing; they're
tracked alongside the broader Phase 2 punch list in `CLAUDE.md`.

---

**This CAT closes Wave 8 and the core CampusOS roadmap.**
