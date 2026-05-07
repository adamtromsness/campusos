# DR Readiness Checklist

**Cycle 32 Step 10 — sign-off checklist.** This is the gate that
certifies CampusOS as disaster-ready. Every item below must be
checked before the platform is approved for pilot deployment with
real schools.

---

## Database

- [ ] **Global Database active.** RDS Aurora Global Database
      configured with primary in us-east-1 and standby in us-west-2.
      EU shard with primary in eu-west-2 and standby in eu-west-1.
- [ ] **Replication lag <30s.** Verified continuously via the
      `rds_replication_lag_seconds` Prometheus gauge; the Cycle 31
      Step 8 alert rule fires above 30s.
- [ ] **Weekly backup validation passing.** GitHub Actions workflow
      `backup-validation.yml` ran successfully within the last 8
      days. `backup_validation_last_success_timestamp` stale-window
      alert is green.
- [ ] **Monthly PITR test successful.** Most recent first-Monday
      `pitr` run restored within 30 minutes of the target timestamp
      with row-count + table-count parity.
- [ ] **Cross-region snapshots verified restorable.** Quarterly
      restore from a us-west-2 snapshot back to us-east-1 succeeded.

## Kafka

- [ ] **MirrorMaker2 replicating all topics.** `dev.*` and `prod.*`
      topics replicating from primary to standby.
- [ ] **Consumer offset translation verified.** Synthetic failover
      test confirms standby consumers resume from the translated
      offset, not from earliest.
- [ ] **Replication lag <5 minutes.** MM2 checkpoint metric stays
      below 5 minutes sustained.
- [ ] **Idempotency records replicating.** Cycle 31 Step 7
      `platform_event_consumer_idempotency` table content visible in
      the standby region via Global Database replication.
- [ ] **DLQ sync confirmed.** A DLQ row inserted in primary appears
      in the standby's DLQ admin dashboard within 60 seconds.

## Redis

- [ ] **Global Datastore replicating.** `iam:access:*` and
      `tenant:routing:*` cache prefixes visible in both primary and
      standby Redis clusters.
- [ ] **Cold-start rebuild tested.** Killed Redis in standby; IAM
      cache rebuilt within 5 minutes per
      `infra/runbooks/redis-cold-start-rebuild.md`.
- [ ] **Suspension propagation verified.** SADD against the primary
      `SUSPENDED_ACCOUNTS` set is reflected in the standby within 5
      seconds.

## S3

- [ ] **CRR active for all buckets.** us-east-1 → us-west-2
      replication on every CampusOS bucket (lesson videos, paystubs,
      profile images, credential vault, DPA documents, etc.).
- [ ] **EU data residency verified.** Upload as an EU tenant; object
      lands in eu-west-2 only; bucket policy denies PutObject from
      non-EU principals.
- [ ] **CloudFront PII restrictions active.** Geo-restriction
      configured on the EU PII distribution; signed URLs with
      1-hour expiry on all PII fetches.
- [ ] **Versioning + lifecycle.** Versioning ON for all buckets;
      non-current versions expired after 90 days; multipart aborted
      after 7 days.

## Tenant routing

- [ ] **`home_region` enforced at API gateway.** `RegionMismatchInterceptor`
      returns HTTP 421 when `process.env.AWS_REGION` doesn't match
      `tenant.homeRegion` on `@HomeRegionRequired()` routes.
- [ ] **Regional DPO routing verified.** Cycle 30 governance
      controller carries `@HomeRegionRequired()`; SAR / erasure /
      breach routes reject cross-region calls.
- [ ] **Tenant region migration procedure tested.** A staging
      tenant moved from us-east-1 to eu-west-2 via
      `infra/runbooks/tenant-region-migration.md`; <30 min of
      downtime.

## Runbook

- [ ] **All 6 scenarios documented.** `infra/runbooks/dr-runbook.md`
      covers single instance, AZ, primary DB, full region, Kafka,
      and data corruption.
- [ ] **Communication templates reviewed by school relations.**
      `infra/runbooks/communication-templates.md` approved by
      schools relations team and legal.
- [ ] **Escalation matrix current.** `infra/runbooks/oncall.md`
      reflects today's rotation, including DPO on-call for
      data-residency incidents.

## Failover testing

- [ ] **At least 2 successful monthly synthetic failovers** completed.
- [ ] **RTO <15 min achieved** in both runs.
- [ ] **RPO <30s achieved** in both runs.
- [ ] **Consumer resume verified** in both runs (no replay-from-earliest).
- [ ] **Cache rebuild verified** within 5 minutes in both runs.

## Chaos engineering

- [ ] **All 6 staging experiments completed** (`tools/chaos/01..06`).
- [ ] **No critical findings outstanding.** Each experiment's result
      doc shows pass + invariants held.
- [ ] **Identified weaknesses remediated.** Tracked in the chaos
      programme retrospective.

## Tabletop

- [ ] **First quarterly tabletop exercise conducted.** Decision log
      captured at `infra/runbooks/tabletop-exercise-2026-Q2.md`.
- [ ] **Tabletop framework documented** at
      `infra/runbooks/tabletop-exercise-framework.md`.
- [ ] **Action items from first exercise** assigned with owners +
      deadlines.

---

## Sign-off

| Role                 | Name | Date | Signature |
| -------------------- | ---- | ---- | --------- |
| Engineering Lead     |      |      |           |
| Architecture Lead    |      |      |           |
| Security / DPO       |      |      |           |
| Schools Relations    |      |      |           |
| CEO / VP Engineering |      |      |           |

Sign-off requires every box above checked + the most recent
quarterly tabletop within the last 90 days.

**When this checklist is signed, the core CampusOS roadmap is
complete and the platform is ready for pilot deployment.**
