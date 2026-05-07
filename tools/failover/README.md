# Cycle 32 — Failover + Backup Validation Tooling

This directory holds the shell + node scripts the deployment-time
backup-validation workflow (`/.github/workflows/backup-validation.yml`)
and the monthly synthetic failover workflow
(`/.github/workflows/synthetic-failover.yml`) invoke. The scripts are
intentionally thin wrappers over `aws rds *` calls + psql validations
because the heavy lifting belongs at the AWS API layer.

## Files

- `backup-validate-restore.sh` — restores latest snapshot (or PITR
  target) to a temporary cluster; writes endpoint to
  `/tmp/temp-endpoint.txt` for the next step.
- `backup-validate-migration.sh` — verifies `_prisma_migrations` on
  the temporary cluster matches the primary's most recent migration
  set.
- `backup-validate-table-count.sh` — table count parity (±1%) on the
  platform schema and per-tenant schemas.
- `backup-validate-row-counts.sh` — spot check on 10 critical tables
  (`sis_students`, `iam_person`, `fin_journal_entries`,
  `platform_audit_log`, `msg_messages`, `pay_ledger_entries`,
  `trn_ridership_records`, `fds_meal_transactions`, `pfl_portfolios`,
  `dpo_data_breach_records`).
- `backup-validate-teardown.sh` — drops the temporary cluster.
- `synthetic-failover-trigger.sh` — initiates RDS Global Database
  failover from primary to standby in staging.
- `synthetic-failover-verify.sh` — verifies the application
  reconnects, Kafka consumers resume from the right offsets, Redis
  cache is available (replicated or rebuilt), and the smoke-test
  suite passes against the standby.
- `synthetic-failover-failback.sh` — fails back to the original
  primary after verification.

## Prerequisites

The scripts assume:

- AWS credentials available via OIDC (`AWS_BACKUP_VALIDATION_ROLE_ARN`).
- Primary cluster identifier in `RDS_PRIMARY_CLUSTER_ID` env.
- Standby cluster identifier in `RDS_STANDBY_CLUSTER_ID` env.
- A Postgres password from secrets manager pulled into `PGPASSWORD`.

## Local execution

`AWS_PROFILE=campusos-staging bash backup-validate-restore.sh weekly`
runs against the staging cluster. The scripts refuse to run against
production without `CONFIRM_PRODUCTION=yes`.

## Metrics

Every script writes its outcome (success / failure / duration) to the
Prometheus Pushgateway (`PROM_PUSHGATEWAY_URL`). The Step 8 alert
`BackupValidationStale` (`backup_validation_last_success_timestamp`
older than 8 days) fires when this stops happening.
