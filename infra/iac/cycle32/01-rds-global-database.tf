# Cycle 32 Step 1 — RDS Global Database
#
# Reference Terraform configuration. Production deployment applies via
# the ops Terraform pipeline (out of repo). This file is the
# authoritative shape for the multi-region database topology.
#
# Architecture per ADR-042 (cross-region replication) + Architecture
# Review §21.2 (active-passive). RPO target <30s, RTO target <15 min
# for unplanned regional failover.

# ── Global Database parent ─────────────────────────────────────────
resource "aws_rds_global_cluster" "campusos" {
  global_cluster_identifier = "campusos-global"
  engine                    = "aurora-postgresql"
  engine_version            = "16.1"
  database_name             = "campusos"
  storage_encrypted         = true
  deletion_protection       = true
}

# ── Primary cluster (us-east-1) ────────────────────────────────────
resource "aws_rds_cluster" "primary" {
  provider = aws.us_east_1

  cluster_identifier        = "campusos-primary"
  engine                    = aws_rds_global_cluster.campusos.engine
  engine_version            = aws_rds_global_cluster.campusos.engine_version
  global_cluster_identifier = aws_rds_global_cluster.campusos.id

  master_username    = "campusos_admin"
  master_password    = var.master_password # AWS Secrets Manager
  database_name      = "campusos"
  port               = 5432
  storage_encrypted  = true
  kms_key_id         = aws_kms_key.rds_us_east_1.arn

  backup_retention_period      = 35
  preferred_backup_window      = "03:00-04:00"
  preferred_maintenance_window = "sun:04:00-sun:05:00"

  copy_tags_to_snapshot     = true
  deletion_protection       = true
  enabled_cloudwatch_logs_exports = ["postgresql"]

  # Cycle 31 Step 6 PgBouncer + Step 8 SLO alerting hook.
  # Performance Insights enabled so the Step 4 backup-validation +
  # Step 8 PITR test workflows can read pg_stat_statements.
  performance_insights_enabled    = true
  performance_insights_retention_period = 7

  tags = {
    Cycle = "32"
    Role  = "primary"
    Region = "us-east-1"
  }
}

resource "aws_rds_cluster_instance" "primary_writer" {
  provider = aws.us_east_1

  identifier         = "campusos-primary-writer-1"
  cluster_identifier = aws_rds_cluster.primary.id
  instance_class     = "db.r6g.xlarge"
  engine             = aws_rds_cluster.primary.engine
  engine_version     = aws_rds_cluster.primary.engine_version
}

resource "aws_rds_cluster_instance" "primary_reader" {
  provider = aws.us_east_1
  count    = 2

  identifier         = "campusos-primary-reader-${count.index + 1}"
  cluster_identifier = aws_rds_cluster.primary.id
  instance_class     = "db.r6g.large"
  engine             = aws_rds_cluster.primary.engine
  engine_version     = aws_rds_cluster.primary.engine_version
}

# ── Standby cluster (us-west-2) ────────────────────────────────────
# Warm standby. Replication is storage-level via the Global Database;
# typical lag <1s, worst-case <30s (the cycle-32 RPO target).
resource "aws_rds_cluster" "standby" {
  provider = aws.us_west_2

  cluster_identifier        = "campusos-standby"
  engine                    = aws_rds_global_cluster.campusos.engine
  engine_version            = aws_rds_global_cluster.campusos.engine_version
  global_cluster_identifier = aws_rds_global_cluster.campusos.id

  # Inherit master credentials from the primary; do not duplicate them
  # here. AWS_RDS will use the global cluster's stored credentials on
  # promotion.
  storage_encrypted = true
  kms_key_id        = aws_kms_key.rds_us_west_2.arn

  backup_retention_period = 7  # Less in standby; primary keeps 35.
  copy_tags_to_snapshot   = true
  deletion_protection     = true

  tags = {
    Cycle = "32"
    Role  = "standby"
    Region = "us-west-2"
  }
}

resource "aws_rds_cluster_instance" "standby_reader" {
  provider = aws.us_west_2
  count    = 1

  identifier         = "campusos-standby-reader-1"
  cluster_identifier = aws_rds_cluster.standby.id
  instance_class     = "db.r6g.large"
  engine             = aws_rds_cluster.standby.engine
  engine_version     = aws_rds_cluster.standby.engine_version
}

# ── EU/UK regional cluster (eu-west-2 / London) ────────────────────
# GDPR data residency requirement (Cycle 30 + Cycle 32 Step 5 + 6).
# Full primary in eu-west-2 with Ireland (eu-west-1) as standby.
# Cross-region replication stays within the EU; never replicates to
# us-east-1 / us-west-2.
resource "aws_rds_global_cluster" "campusos_eu" {
  global_cluster_identifier = "campusos-eu-global"
  engine                    = "aurora-postgresql"
  engine_version            = "16.1"
  database_name             = "campusos"
  storage_encrypted         = true
  deletion_protection       = true
}

resource "aws_rds_cluster" "eu_primary" {
  provider = aws.eu_west_2

  cluster_identifier        = "campusos-eu-primary"
  engine                    = aws_rds_global_cluster.campusos_eu.engine
  engine_version            = aws_rds_global_cluster.campusos_eu.engine_version
  global_cluster_identifier = aws_rds_global_cluster.campusos_eu.id

  master_username   = "campusos_admin"
  master_password   = var.master_password_eu
  database_name     = "campusos"
  port              = 5432
  storage_encrypted = true
  kms_key_id        = aws_kms_key.rds_eu_west_2.arn

  backup_retention_period = 35
  deletion_protection     = true

  tags = {
    Cycle = "32"
    Role  = "primary"
    Region = "eu-west-2"
    DataResidency = "EU"
  }
}

resource "aws_rds_cluster" "eu_standby" {
  provider = aws.eu_west_1

  cluster_identifier        = "campusos-eu-standby"
  engine                    = aws_rds_global_cluster.campusos_eu.engine
  engine_version            = aws_rds_global_cluster.campusos_eu.engine_version
  global_cluster_identifier = aws_rds_global_cluster.campusos_eu.id

  storage_encrypted = true
  kms_key_id        = aws_kms_key.rds_eu_west_1.arn

  backup_retention_period = 7
  deletion_protection     = true

  tags = {
    Cycle = "32"
    Role  = "standby"
    Region = "eu-west-1"
    DataResidency = "EU"
  }
}

# ── Variables (filled at apply time from secrets backend) ──────────
variable "master_password"    { type = string; sensitive = true }
variable "master_password_eu" { type = string; sensitive = true }

# Outputs consumed by the application's runtime config + the Cycle 31
# Step 9 Platform Admin /admin/platform/tenants endpoint:
output "primary_cluster_endpoint"  { value = aws_rds_cluster.primary.endpoint }
output "primary_reader_endpoint"   { value = aws_rds_cluster.primary.reader_endpoint }
output "standby_cluster_endpoint"  { value = aws_rds_cluster.standby.endpoint }
output "eu_primary_endpoint"       { value = aws_rds_cluster.eu_primary.endpoint }
output "eu_standby_endpoint"       { value = aws_rds_cluster.eu_standby.endpoint }
