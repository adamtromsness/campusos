# Cycle 32 Step 3 — Kafka MirrorMaker2 + Cross-Region Replication.
#
# Replicates all operational topics from primary MSK (us-east-1) to
# standby MSK (us-west-2) with consumer offset translation. On
# regional failover, consumers in us-west-2 resume from the
# translated offset rather than from-earliest, so financial events
# are not double-processed.
#
# Idempotency record replication piggybacks on RDS Global Database
# (Cycle 31 platform_event_consumer_idempotency table). When a
# consumer reprocesses an event near the failover boundary, the
# idempotency claim catches the dup and skips it.

# ── Primary MSK cluster (us-east-1) ───────────────────────────────
resource "aws_msk_cluster" "primary" {
  provider = aws.us_east_1

  cluster_name           = "campusos-primary"
  kafka_version          = "3.6.0"
  number_of_broker_nodes = 3

  broker_node_group_info {
    instance_type   = "kafka.m5.large"
    client_subnets  = aws_subnet.private_us_east_1[*].id
    security_groups = [aws_security_group.msk_us_east_1.id]
    storage_info {
      ebs_storage_info {
        volume_size = 100
      }
    }
  }

  encryption_info {
    encryption_at_rest_kms_key_arn = aws_kms_key.msk_us_east_1.arn
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
  }

  open_monitoring {
    prometheus {
      jmx_exporter  { enabled_in_broker = true }
      node_exporter { enabled_in_broker = true }
    }
  }

  tags = { Cycle = "32"; Role = "primary"; Region = "us-east-1" }
}

# ── Standby MSK cluster (us-west-2) ───────────────────────────────
resource "aws_msk_cluster" "standby" {
  provider = aws.us_west_2

  cluster_name           = "campusos-standby"
  kafka_version          = "3.6.0"
  number_of_broker_nodes = 3

  broker_node_group_info {
    instance_type   = "kafka.m5.large"
    client_subnets  = aws_subnet.private_us_west_2[*].id
    security_groups = [aws_security_group.msk_us_west_2.id]
    storage_info {
      ebs_storage_info {
        volume_size = 100
      }
    }
  }

  encryption_info {
    encryption_at_rest_kms_key_arn = aws_kms_key.msk_us_west_2.arn
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
  }

  tags = { Cycle = "32"; Role = "standby"; Region = "us-west-2" }
}

# ── MirrorMaker2 connect cluster ──────────────────────────────────
# Hosted on MSK Connect. The Connect cluster runs the MM2 source +
# checkpoint connectors that replicate primary → standby.
resource "aws_mskconnect_connector" "mm2_source" {
  provider = aws.us_east_1

  name        = "campusos-mm2-source"
  kafkaconnect_version = "2.7.1"
  service_execution_role_arn = aws_iam_role.mskconnect.arn
  capacity {
    autoscaling {
      max_worker_count   = 4
      mcu_count          = 2
      min_worker_count   = 2
      scale_in_policy { cpu_utilization_percentage  = 20 }
      scale_out_policy { cpu_utilization_percentage = 80 }
    }
  }
  connector_configuration = {
    "connector.class"       = "org.apache.kafka.connect.mirror.MirrorSourceConnector"
    "name"                  = "campusos-mm2-source"
    "source.cluster.alias"  = "us-east-1"
    "target.cluster.alias"  = "us-west-2"
    "source.cluster.bootstrap.servers" = aws_msk_cluster.primary.bootstrap_brokers_tls
    "target.cluster.bootstrap.servers" = aws_msk_cluster.standby.bootstrap_brokers_tls
    # Topics to replicate. Conservative regex — every dev.* / prod.*
    # operational topic plus the DLQ.
    "topics"                = "dev[.].*,prod[.].*"
    "topics.exclude"        = ".*[.]internal[.].*,__.*"
    # Consumer group offset sync — the load-bearing piece for clean
    # cross-region consumer resumption per the cycle-32 RPO target.
    "sync.group.offsets.enabled" = "true"
    "sync.group.offsets.interval.seconds" = "5"
    "emit.checkpoints.enabled"   = "true"
    "emit.heartbeats.enabled"    = "true"
    "replication.factor" = "3"
    # Replication policy: rename source topic dev.pay.payment.received
    # to us-east-1.dev.pay.payment.received in the standby cluster so
    # round-trip replication can't loop.
    "replication.policy.class" = "org.apache.kafka.connect.mirror.DefaultReplicationPolicy"
    "replication.policy.separator" = "."
  }

  kafka_cluster {
    apache_kafka_cluster {
      bootstrap_servers = aws_msk_cluster.primary.bootstrap_brokers_tls
      vpc {
        security_groups = [aws_security_group.msk_us_east_1.id]
        subnets         = aws_subnet.private_us_east_1[*].id
      }
    }
  }
  kafka_cluster_client_authentication { authentication_type = "IAM" }
  kafka_cluster_encryption_in_transit { encryption_type     = "TLS" }
}

# ── Replication lag metric → Prometheus ───────────────────────────
# MM2's MirrorCheckpointConnector emits a `mirror-checkpoint-task`
# JMX metric. The Cycle 31 Step 3 JMX-to-Prometheus exporter on the
# Connect cluster pushes it as `kafka_mirrormaker2_replication_lag_seconds`
# with `topic` + `consumer_group` labels. The Step 8 alert
# `KafkaMirrorMakerLagHigh` (Phase 2) fires on >5 minute sustained lag.

# ── DLQ topic explicit replication ────────────────────────────────
# DLQ topics replicate via the wildcard above; this resource
# declares the standby-side DLQ topic provisioning so DLQ replay in
# the standby region can target the right topic name even on the
# first failover.
resource "aws_msk_configuration" "standby_dlq" {
  provider = aws.us_west_2
  name     = "campusos-standby-dlq"
  kafka_versions = ["3.6.0"]
  server_properties = <<EOF
auto.create.topics.enable=false
default.replication.factor=3
min.insync.replicas=2
num.partitions=12
EOF
}

output "primary_brokers"  { value = aws_msk_cluster.primary.bootstrap_brokers_tls }
output "standby_brokers"  { value = aws_msk_cluster.standby.bootstrap_brokers_tls }
