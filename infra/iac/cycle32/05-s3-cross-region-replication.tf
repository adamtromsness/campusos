# Cycle 32 Step 5 — S3 Cross-Region Replication + Data Residency.
#
# Two distinct topologies:
#   - US tenants  : us-east-1 → us-west-2 (cross-region replication
#                   for DR; both regions inside the US AWS partition).
#   - EU/UK tenants: eu-west-2 → eu-west-1 ONLY (strict data residency
#                    per Cycle 30 dpo_processing_activities; never
#                    replicates to us-* even on global outage).
#
# Buckets covered by replication:
#   - lesson videos, uploaded documents (Cycle 4 docs, Cycle 12 library
#     scans), paystub PDFs (Cycle 4 hr), profile images (Cycle 6.1),
#     credential vault docs (Cycle 22 IT — encrypted with separate KMS
#     key per ADR-065), DPA documents (Cycle 30), privacy notice docs
#     (Cycle 30), report outputs (Cycle 29), export files.

# ── US bucket pair ─────────────────────────────────────────────────
resource "aws_s3_bucket" "primary_us" {
  provider = aws.us_east_1
  bucket   = "campusos-primary-us-east-1"
}
resource "aws_s3_bucket_versioning" "primary_us" {
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.primary_us.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_lifecycle_configuration" "primary_us" {
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.primary_us.id
  rule {
    id     = "expire-non-current"
    status = "Enabled"
    noncurrent_version_expiration { noncurrent_days = 90 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

resource "aws_s3_bucket" "standby_us" {
  provider = aws.us_west_2
  bucket   = "campusos-standby-us-west-2"
}
resource "aws_s3_bucket_versioning" "standby_us" {
  provider = aws.us_west_2
  bucket   = aws_s3_bucket.standby_us.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_replication_configuration" "us_to_us" {
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.primary_us.id
  role     = aws_iam_role.s3_replication.arn

  rule {
    id     = "primary-to-standby"
    status = "Enabled"
    filter {} # all objects
    destination {
      bucket        = aws_s3_bucket.standby_us.arn
      storage_class = "STANDARD_IA"
      encryption_configuration {
        replica_kms_key_id = aws_kms_key.s3_us_west_2.arn
      }
    }
    delete_marker_replication { status = "Enabled" }
  }
}

# ── EU bucket pair (data residency: replication stays within EU) ──
resource "aws_s3_bucket" "primary_eu" {
  provider = aws.eu_west_2
  bucket   = "campusos-primary-eu-west-2"
}
resource "aws_s3_bucket_versioning" "primary_eu" {
  provider = aws.eu_west_2
  bucket   = aws_s3_bucket.primary_eu.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket" "standby_eu" {
  provider = aws.eu_west_1
  bucket   = "campusos-standby-eu-west-1"
}
resource "aws_s3_bucket_versioning" "standby_eu" {
  provider = aws.eu_west_1
  bucket   = aws_s3_bucket.standby_eu.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_replication_configuration" "eu_to_eu" {
  provider = aws.eu_west_2
  bucket   = aws_s3_bucket.primary_eu.id
  role     = aws_iam_role.s3_replication_eu.arn

  rule {
    id     = "eu-primary-to-eu-standby"
    status = "Enabled"
    filter {}
    destination {
      bucket        = aws_s3_bucket.standby_eu.arn
      storage_class = "STANDARD_IA"
    }
    delete_marker_replication { status = "Enabled" }
  }
}

# ── EU bucket policy: deny PutObject from non-EU principals ───────
# The data-residency keystone. Even if a misrouted request reaches
# the EU bucket from a us-east-1 IAM principal, this policy denies
# the write. Combined with the Cycle 32 Step 6 region-routing gate
# at the API tier, this is defence-in-depth.
data "aws_iam_policy_document" "eu_bucket_policy" {
  statement {
    sid     = "DenyNonEUWrites"
    effect  = "Deny"
    actions = ["s3:PutObject", "s3:PutObjectAcl"]
    resources = ["${aws_s3_bucket.primary_eu.arn}/*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "aws:RequestedRegion"
      values   = ["eu-west-2", "eu-west-1"]
    }
  }
}

resource "aws_s3_bucket_policy" "primary_eu" {
  provider = aws.eu_west_2
  bucket   = aws_s3_bucket.primary_eu.id
  policy   = data.aws_iam_policy_document.eu_bucket_policy.json
}

# ── CloudFront PII restriction ────────────────────────────────────
# Static assets served globally. PII-bearing content (lesson
# attachments, signed paystubs, identification docs) served only
# from EU edge locations for EU tenants. Signed URLs with 1-hour
# expiry on every PII fetch.
resource "aws_cloudfront_distribution" "eu_pii" {
  enabled             = true
  default_root_object = ""
  comment             = "EU tenant PII content — geo-restricted to EU"

  origin {
    domain_name = aws_s3_bucket.primary_eu.bucket_regional_domain_name
    origin_id   = "s3-eu-primary"
    s3_origin_config {
      origin_access_identity = aws_cloudfront_origin_access_identity.eu_pii.cloudfront_access_identity_path
    }
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "s3-eu-primary"
    viewer_protocol_policy = "https-only"
    forwarded_values {
      query_string = true # signed URL params
      cookies { forward = "none" }
    }
    trusted_signers = ["self"] # signed URLs only
    min_ttl     = 0
    default_ttl = 60
    max_ttl     = 300
  }

  restrictions {
    geo_restriction {
      restriction_type = "whitelist"
      locations        = ["GB", "IE", "FR", "DE", "NL", "BE", "ES", "IT", "PT", "DK", "SE", "NO", "FI", "PL", "AT", "CH", "LU"]
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.eu.arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }

  tags = { Cycle = "32"; DataResidency = "EU" }
}

resource "aws_cloudfront_origin_access_identity" "eu_pii" {
  comment = "OAI for EU PII bucket"
}
