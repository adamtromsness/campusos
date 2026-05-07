# Redis Cold-Start Rebuild Strategy

**Cycle 32 Step 4 — runbook.** Documents the rebuild path when Redis
is completely lost in the standby region and the Global Datastore
replication did not catch the writes (e.g., the standby Redis was
provisioned for the first time mid-incident, or a regional outage
took out both primary + replica).

CampusOS Redis caches all rebuild from the database. None of the
caches are authoritative — every cache prefix has a documented
fallback per `apps/api/src/observability/cache-contracts.md`.

## Rebuild order

When the standby Redis is empty and traffic is failing over, the
caches rebuild lazily on first miss. Warm-up time for a single school
of ~500 students is approximately 5 minutes. The order in which the
caches refill is determined by traffic patterns:

1. **`iam:access:{accountId}:{scopeId}`** (5-min TTL) — every
   authenticated request touches this. Rebuilds from
   `iam_role_assignment + roles + role_permissions` at the
   `PermissionCheckService.hasAnyPermission` call site. Cold-miss
   latency ~200ms; subsequent hits ~10ms.
2. **`tenant:routing:{subdomain}`** (1-hour TTL) — tenant resolution
   on every non-public request. Rebuilds from
   `platform.platform_tenant_routing`.
3. **`ledger:balance:{accountId}`** (30-sec TTL) — Cycle 6 family
   billing. Rebuilds from `pay_ledger_entries` aggregation.
4. **`notif:inapp:{accountId}`** (sorted set, no TTL) — Cycle 3
   notification inbox. The cold-start path treats an empty inbox as
   "no unread" until the next Kafka envelope lands.
5. **`SUSPENDED_ACCOUNTS`** (set, no TTL) — IAM Pub/Sub. The IAM
   `iam.account.suspended` consumer rebuilds the set on first read by
   pulling all `platform_users WHERE suspended_at IS NOT NULL`.

## Suspension propagation verification

The cycle-32 plan calls out that account suspension must be effective
in the standby region within 5 seconds of the primary write. Verify:

```bash
# Primary region
redis-cli -h $PRIMARY_REDIS SADD SUSPENDED_ACCOUNTS '<account-uuid>'
date +%s.%N

# Standby region (should reflect within 5 seconds)
sleep 5
redis-cli -h $STANDBY_REDIS SISMEMBER SUSPENDED_ACCOUNTS '<account-uuid>'
# Expect: 1
```

If the standby returns 0 after 5 seconds, the Global Datastore is
mis-configured or the replication is paused.

## Failover behaviour

On planned failover (manual promotion of the standby):

- The standby Redis becomes the new primary.
- Application reconnects via the `STANDBY_REDIS_ENDPOINT` env
  variable, which is updated by the Cycle 31 Step 6 RegionRoutingService
  reading the failover signal from `platform.platform_tenant_routing.cluster_id`.
- Cache contents survive the promotion (the standby was already a
  full replica).

On unplanned failover (primary is down):

- Cache contents may have lagged the primary by up to a few seconds.
- The cold-start rebuild path described above kicks in for any keys
  that were written near the failover boundary and didn't replicate.
- Eventual consistency: the database is the source of truth; caches
  reconverge as TTLs expire and reads happen.

## Capacity sizing

The standby Redis runs a `cache.r6g.large` (12.3 GB usable). At
~500 students per school, ~50 schools per tenant cluster, the IAM
cache + tenant routing cache total ~200 MB. Headroom is enormous
because most cache prefixes have short TTLs and the high-volume
prefixes (notification inbox) cap at 100 entries per account. Going
to `cache.r6g.xlarge` only happens past ~500 schools per cluster.

## Circuit breaker integration

Cycle 31 Step 7 ships the circuit-breaker library at
`apps/api/src/observability/circuit-breaker.ts`. The
`PermissionCheckService` Redis path is the canonical integration
point: on Redis breaker OPEN, IAM access falls back to direct
`iam_effective_access_cache` reads. Slower (~50ms vs ~10ms) but
correct. The Step 8 alert rule `CircuitBreakerOpen` PAGEs the on-call
when the breaker stays OPEN for more than a minute.
