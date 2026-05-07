# Cycle 32 Step 4 — Redis ElastiCache Global Datastore.
#
# Cross-region Redis replication for the IAM cache + tenant routing
# cache (both introduced/wired in Cycle 31 Step 6). Also propagates
# the SUSPENDED_ACCOUNTS Pub/Sub set so account suspension is
# effective in the standby region within 5 seconds of the primary
# write.

# ── Primary Redis cluster (us-east-1, multi-AZ) ───────────────────
resource "aws_elasticache_replication_group" "primary" {
  provider = aws.us_east_1

  replication_group_id          = "campusos-primary"
  description                   = "CampusOS primary Redis (us-east-1)"
  engine                        = "redis"
  engine_version                = "7.1"
  node_type                     = "cache.r6g.large"
  num_cache_clusters            = 2  # Multi-AZ with automatic failover
  parameter_group_name          = "default.redis7"
  port                          = 6379
  multi_az_enabled              = true
  automatic_failover_enabled    = true
  at_rest_encryption_enabled    = true
  transit_encryption_enabled    = true
  auth_token                    = var.redis_auth_token
  snapshot_retention_limit      = 7
  snapshot_window               = "03:00-04:00"
  maintenance_window            = "sun:04:00-sun:05:00"

  # Used by the Cycle 31 Step 6 cache-key prefix conventions:
  # iam:access:{accountId}:{scopeId}, ledger:balance:{accountId},
  # notif:inapp:{accountId}, etc. See
  # apps/api/src/observability/cache-contracts.md for the full list.

  tags = { Cycle = "32"; Role = "primary"; Region = "us-east-1" }
}

# ── Standby Redis cluster (us-west-2, replica of the primary) ─────
resource "aws_elasticache_replication_group" "standby" {
  provider = aws.us_west_2

  replication_group_id          = "campusos-standby"
  description                   = "CampusOS standby Redis (us-west-2)"
  global_replication_group_id   = aws_elasticache_global_replication_group.campusos.global_replication_group_id

  node_type                     = "cache.r6g.large"
  num_cache_clusters            = 2
  parameter_group_name          = "default.redis7"
  port                          = 6379
  multi_az_enabled              = true
  automatic_failover_enabled    = true
  at_rest_encryption_enabled    = true
  transit_encryption_enabled    = true

  tags = { Cycle = "32"; Role = "standby"; Region = "us-west-2" }
}

# ── Global Datastore parent (replicates primary → standby) ────────
resource "aws_elasticache_global_replication_group" "campusos" {
  global_replication_group_id_suffix = "campusos"
  primary_replication_group_id       = aws_elasticache_replication_group.primary.id
}

# ── EU regional Redis (eu-west-2 with eu-west-1 standby) ──────────
# Same shape as the US side; the EU Global Datastore stays within EU
# per the Cycle 30 + Cycle 32 Step 5 GDPR data residency contract.
resource "aws_elasticache_replication_group" "eu_primary" {
  provider = aws.eu_west_2

  replication_group_id          = "campusos-eu-primary"
  description                   = "CampusOS EU primary Redis (eu-west-2)"
  engine                        = "redis"
  engine_version                = "7.1"
  node_type                     = "cache.r6g.large"
  num_cache_clusters            = 2
  multi_az_enabled              = true
  automatic_failover_enabled    = true
  at_rest_encryption_enabled    = true
  transit_encryption_enabled    = true
  auth_token                    = var.redis_auth_token_eu

  tags = { Cycle = "32"; Role = "primary"; Region = "eu-west-2"; DataResidency = "EU" }
}

variable "redis_auth_token"    { type = string; sensitive = true }
variable "redis_auth_token_eu" { type = string; sensitive = true }

output "primary_redis_endpoint"  { value = aws_elasticache_replication_group.primary.primary_endpoint_address }
output "standby_redis_endpoint"  { value = aws_elasticache_replication_group.standby.primary_endpoint_address }
output "eu_redis_endpoint"       { value = aws_elasticache_replication_group.eu_primary.primary_endpoint_address }
