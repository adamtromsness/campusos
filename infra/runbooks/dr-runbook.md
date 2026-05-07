# Disaster Recovery Runbook

**Cycle 32 Step 7 — DR Runbook.** The procedures the on-call team
follows when CampusOS infrastructure fails. Six failure scenarios
ordered from least to most severe.

**Targets:**

- **RTO** (Recovery Time Objective) for regional failure: **<15 minutes**
- **RPO** (Recovery Point Objective) for regional failure: **<30 seconds**

**Owner:** campusos-platform on-call (primary), campusos-architecture
on-call (secondary).

**See also:**

- `infra/runbooks/oncall.md` — rotation + escalation matrix
- `infra/runbooks/communication-templates.md` — incident notification
- `infra/runbooks/redis-cold-start-rebuild.md` — Redis failover specifics
- `infra/runbooks/tenant-region-migration.md` — moving a tenant region

---

## Scenario 1 — Single instance failure

**Symptom:** ECS task dies. Health check on a single API task fails;
load balancer routes around it.

**Expected behaviour:** ECS service scheduler replaces the task
within 2 minutes. No manual action.

**Verify:**

```bash
aws ecs describe-services --cluster campusos --services campusos-api \
  --query 'services[0].{desired:desiredCount, running:runningCount}'
# Expect: desired == running, after the 2-min replacement window
```

**Escalate if:** replacement does not complete within 5 minutes.

---

## Scenario 2 — Availability Zone failure

**Symptom:** One AZ in us-east-1 goes down. Multiple tasks fail
simultaneously; ALB target group health drops.

**Expected behaviour:**

- Multi-AZ RDS fails over automatically (<30 seconds).
- ECS tasks redistribute to healthy AZs.
- ElastiCache sentinel promotes replica.
- All services operational within 5 minutes.

**Manual action:** none.

**Verify:**

- `aws rds describe-db-clusters --db-cluster-identifier campusos-primary`
  → `Status: available`, `AvailabilityZones` reflects the surviving AZs.
- `aws ecs describe-services` shows `runningCount` recovering toward
  `desiredCount`.
- Check `infra/runbooks/api-latency.md` if user-facing latency
  doesn't recover within 5 minutes.

**Escalate if:** any service stays degraded >10 minutes.

---

## Scenario 3 — Primary database failure

**Symptom:** RDS primary instance unresponsive. Application logs
show `ECONNREFUSED` or hung writes.

**Expected behaviour:**

- Global Database promotes the secondary cluster
  (`campusos-standby` in us-west-2) to primary.
- PgBouncer reconnects to the new primary endpoint via DNS.
- Kafka consumers pause and resume on reconnection.

**Targets:** RTO <5 minutes, RPO <1 second.

**Manual action:**

1. Confirm RDS Global Database failover from CloudWatch dashboard.
2. Trigger PgBouncer reload to pick up the new endpoint:
   ```bash
   aws ecs update-service --cluster campusos \
     --service campusos-pgbouncer --force-new-deployment
   ```
3. Verify Kafka consumers resumed (check Cycle 31 Step 9
   `/admin/platform/dlq` for new arrivals).
4. Validate data integrity post-failover:
   ```bash
   bash tools/failover/post-failover-data-integrity.sh
   ```
5. Communicate per Scenario 3 template (see communication-templates.md).

---

## Scenario 4 — Full regional failure

**Symptom:** us-east-1 completely unavailable. Route 53 health checks
fail 3× in a row. Multiple alerting rules fire simultaneously.

**Expected behaviour:**

- Route 53 health-check DNS failover: traffic shifts to us-west-2
  within ~3 minutes (3 health checks × 30 seconds + DNS propagation).
- Global Database promotes us-west-2 to primary.
- Kafka MirrorMaker2 had been syncing offsets; consumers in us-west-2
  resume from the translated offsets.
- Redis cold-start rebuild begins (~5 minutes for a 500-student
  school per `redis-cold-start-rebuild.md`).
- S3 reads from the replicated us-west-2 bucket.

**Targets:** RTO <15 minutes, RPO <30 seconds.

**Manual action:**

1. **Acknowledge the page** from Route 53 health-check alarm.
2. **Confirm DNS failover.** Resolve the API hostname with
   `dig +short api.campusos.com` — expect us-west-2 endpoints.
3. **Trigger PagerDuty incident comms** with Scenario 4 template.
4. **Send emergency SMS to all school admins** using pre-cached
   numbers in standby region:
   ```bash
   bash tools/failover/emergency-sms-fanout.sh
   ```
5. **Monitor consumer resume.** Expected: every consumer group's lag
   drops to 0 within 5 minutes after failover.
6. **Watch the cache rebuild metric.** `redis_cache_misses_total`
   spikes initially; normalises within 10 minutes.
7. **Validate data integrity** with `tools/failover/post-failover-data-integrity.sh`.
8. **30-minute and 60-minute updates** to schools with progress.

**Escalate if:** RTO target missed at the 15-minute mark, OR data
integrity check reports any anomaly.

---

## Scenario 5 — Kafka cluster failure

**Symptom:** MSK cluster unresponsive. Producers buffering
in-memory; KafkaJS connect errors in API logs.

**Expected behaviour:**

- Producers buffer in memory for ~30 seconds.
- MSK auto-recovers brokers (Multi-AZ within the cluster).
- Consumer offsets recovered from the coordination topic.

**Targets:** RTO <10 minutes.

**Manual action:**

1. Check MSK cluster status in AWS console.
2. If full cluster loss is suspected:
   - Replay-from-earliest is acceptable because Cycle 31's
     `processWithIdempotency` claim-after-success contract dedups
     events. Financial events double-processing is prevented by the
     `platform.platform_event_consumer_idempotency` table.
   - Confirm new MSK cluster shows healthy.
3. Monitor `kafka_consumer_lag` metric for catch-up.

**Escalate if:** lag does not start dropping within 15 minutes.

---

## Scenario 6 — Data corruption

**Symptom:** Logical data corruption detected (bad migration,
application bug). Verified by an operator query against the database
showing impossible state (negative GL totals, orphaned FKs, etc.).

**Expected behaviour:** none automatic — corruption requires manual
investigation.

**Manual action:**

1. **Isolate affected tenants immediately.** Set them frozen via the
   Cycle 0 ADR-031 contract:
   ```sql
   UPDATE platform.platform_tenant_routing SET is_frozen = true
    WHERE tenant_id IN (...);
   ```
   Reads continue; writes refused with `WRITE_FROZEN`.
2. **Identify the corruption window.** Tail audit logs + GL entries
   to find the earliest bad write.
3. **PITR to before the corruption window.**
   ```bash
   bash tools/failover/backup-validate-restore.sh pitr
   # Then specifically:
   aws rds restore-db-cluster-to-point-in-time \
     --restore-to-time $TIMESTAMP_BEFORE_CORRUPTION
   ```
4. **Selective schema restore.** `pg_dump` the affected tenant
   schemas from the PITR instance, `pg_restore` into production.
   Atomic via wrapping in a transaction.
5. **Data integrity checks** on the restored schemas.
6. **Communicate.** Notify affected schools per the data-corruption
   template (longer recovery time, transparent timeline).
7. **Unfreeze** affected tenants only after verification.

**Escalate if:** corruption affects financial data — DPO + School
Relations + leadership all engaged before unfreezing.

---

## Cross-cutting verification suite

Every scenario except #1 ends with the same data integrity check:

```bash
bash tools/failover/post-failover-data-integrity.sh
```

This script:

1. Counts rows in 10 critical tables and compares to a baseline
   captured 5 minutes before the incident.
2. Walks the GL: `SUM(amount) GROUP BY school_id` should match the
   pre-incident snapshot.
3. Checks the `platform_event_consumer_idempotency` table for any
   `event_id` claimed twice (would indicate replay drift).
4. Pings each Kafka consumer's last-committed offset.
5. Asserts the IAM cache responds within 200ms (cold-start path).

Output is a green/red summary on each check. Any red blocks unfreeze
of affected tenants.

---

## Post-incident review

Every incident produces a post-incident report within 48 hours per
`infra/runbooks/communication-templates.md`. Required sections:

- Timeline (5-minute granularity from first alert through resolution)
- Root cause
- Impact (tenants affected, duration, data lost if any)
- Remediation actions (what was done during the incident)
- Preventive measures (what changes prevent recurrence)
- Follow-up items (with owners + deadlines)

Quarterly tabletop exercises (`tabletop-exercise-framework.md`) walk
through these scenarios + novel ones to keep the team sharp.
