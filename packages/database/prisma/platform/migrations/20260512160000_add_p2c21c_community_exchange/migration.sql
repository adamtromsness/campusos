-- P2-21c Community Exchange — platform schema, cross-school
-- marketplace. Visible to all authenticated users (parents may browse
-- and buy + rate but cannot create listings — enforced at the service
-- layer in MarketplaceListingService).
--
-- 8 platform tables: platform_community_profiles,
-- platform_marketplace_listings, platform_asset_transactions,
-- platform_asset_condition_reports, platform_marketplace_watch_lists,
-- platform_community_ratings, platform_community_reputation_log,
-- platform_search_index.
--
-- ADR-073..076. Keystones:
--   - 5% platform fee CHECK at schema level
--     (platform_fee_cents + seller_receives_cents = total_price_cents)
--   - tsvector GIN index for unified full-text search (ADR-076)
--   - Reputation log is append-only; trigger updates aggregate score
--   - Watch list matching via WatchListMatchWorker on listing publish
--
-- Soft UUID refs to platform.iam_person, platform.schools per
-- ADR-001/020. No DB FKs across to those parents; FKs ARE declared
-- between siblings inside this migration's own bounded set (profile
-- -< listings, listing -< transactions, transaction -< condition
-- reports, profile -< reputation_log, profile -< ratings).
-- =====================================================================

-- ── platform_community_profiles ─────────────────────────────────────
-- One row per iam_person who has any community surface activity. All
-- user types — including parents — get a profile when they first
-- interact. UNIQUE(person_id). The reputation_points denormalises the
-- sum of platform_community_reputation_log.points_delta so the leader-
-- board query stays O(1).

CREATE TABLE IF NOT EXISTS "platform"."platform_community_profiles" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "bio" TEXT,
    "school_name" TEXT,
    "role_label" TEXT,
    "avatar_s3_key" TEXT,
    "reputation_points" INT NOT NULL DEFAULT 0,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_community_profiles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_community_profiles_person_uq" UNIQUE ("person_id")
);

CREATE INDEX IF NOT EXISTS "platform_community_profiles_reputation_idx"
  ON "platform"."platform_community_profiles" ("reputation_points" DESC);

CREATE INDEX IF NOT EXISTS "platform_community_profiles_public_idx"
  ON "platform"."platform_community_profiles" ("is_public") WHERE "is_public" = true;

COMMENT ON TABLE "platform"."platform_community_profiles" IS
  'P2-21c — Per-(iam_person) community profile. All user types including parents have one. UNIQUE(person_id). reputation_points denormalises sum of platform_community_reputation_log.points_delta. is_public flag for privacy controls. ADR-074.';

COMMENT ON COLUMN "platform"."platform_community_profiles"."person_id" IS
  'Soft FK to platform.iam_person(id) per ADR-001/020.';

COMMENT ON COLUMN "platform"."platform_community_profiles"."reputation_points" IS
  'Denormalised aggregate of platform_community_reputation_log.points_delta. Updated by ReputationService inside same tx as log INSERT. Leaderboard ORDER BY reputation_points DESC is O(1) with the index.';


-- ── platform_marketplace_listings ───────────────────────────────────
-- 6-value polymorphic listing types. tsvector index for full-text
-- search. Parents are blocked from POST at the service layer per the
-- product decision (ADR-073) — schema does not enforce it because
-- moderation may need to surface a listing on someone's behalf.

CREATE TABLE IF NOT EXISTS "platform"."platform_marketplace_listings" (
    "id" UUID NOT NULL,
    "listing_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "seller_school_id" UUID NOT NULL,
    "seller_profile_id" UUID NOT NULL,
    "price_cents" INT,
    "condition" TEXT,
    "category" TEXT,
    "tags" TEXT[],
    "photo_s3_keys" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "search_keywords" TSVECTOR,
    "published_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_marketplace_listings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_marketplace_listings_seller_profile_fkey" FOREIGN KEY ("seller_profile_id")
      REFERENCES "platform"."platform_community_profiles"("id") ON DELETE RESTRICT,
    CONSTRAINT "platform_marketplace_listings_type_chk" CHECK (
      "listing_type" IN ('EDUCATIONAL', 'PORTFOLIO', 'FIELD_TRIP', 'SURPLUS_ASSET', 'BOOK', 'KNOWLEDGE')
    ),
    CONSTRAINT "platform_marketplace_listings_status_chk" CHECK (
      "status" IN ('DRAFT', 'ACTIVE', 'SOLD', 'EXPIRED')
    ),
    CONSTRAINT "platform_marketplace_listings_condition_chk" CHECK (
      "condition" IS NULL OR "condition" IN ('NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'POOR')
    ),
    CONSTRAINT "platform_marketplace_listings_price_chk" CHECK (
      "price_cents" IS NULL OR "price_cents" >= 0
    ),
    CONSTRAINT "platform_marketplace_listings_published_chk" CHECK (
      ("status" = 'DRAFT' AND "published_at" IS NULL)
      OR ("status" IN ('ACTIVE', 'SOLD', 'EXPIRED') AND "published_at" IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS "platform_marketplace_listings_search_gin"
  ON "platform"."platform_marketplace_listings" USING GIN ("search_keywords");

CREATE INDEX IF NOT EXISTS "platform_marketplace_listings_active_idx"
  ON "platform"."platform_marketplace_listings" ("listing_type", "status")
  WHERE "status" = 'ACTIVE';

CREATE INDEX IF NOT EXISTS "platform_marketplace_listings_seller_school_idx"
  ON "platform"."platform_marketplace_listings" ("seller_school_id");

CREATE INDEX IF NOT EXISTS "platform_marketplace_listings_seller_profile_idx"
  ON "platform"."platform_marketplace_listings" ("seller_profile_id");

COMMENT ON TABLE "platform"."platform_marketplace_listings" IS
  'P2-21c — Cross-school marketplace listings. 6-value polymorphic listing_type CHECK (EDUCATIONAL, PORTFOLIO, FIELD_TRIP, SURPLUS_ASSET, BOOK, KNOWLEDGE). 4-value status with multi-column published_chk lockstep keeping published_at in sync with non-DRAFT statuses. tsvector search_keywords backed by GIN INDEX for the full-text search keystone (ADR-076). Parents blocked from POST at MarketplaceListingService (cannot create listings; can browse + buy + rate). seller_school_id is a soft FK to platform.schools(id) per ADR-001/020. ADR-073.';

COMMENT ON COLUMN "platform"."platform_marketplace_listings"."search_keywords" IS
  'PostgreSQL tsvector populated by MarketplaceListingService from title + description + tags + category. Maintained on every INSERT and UPDATE.';

COMMENT ON COLUMN "platform"."platform_marketplace_listings"."seller_profile_id" IS
  'FK to platform_community_profiles(id) RESTRICT — listings outlive their creator profile being soft-deactivated; cannot hard-delete a profile that has historical listings.';


-- ── platform_asset_transactions ─────────────────────────────────────
-- THE FEE-SPLIT KEYSTONE — schema-level CHECK on
-- (platform_fee_cents + seller_receives_cents = total_price_cents).
-- The service computes 5% / 95% split before INSERT; the schema is
-- the safety net. 7-state lifecycle from PENDING_PAYMENT to REFUNDED.

CREATE TABLE IF NOT EXISTS "platform"."platform_asset_transactions" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "buyer_type" TEXT NOT NULL,
    "buyer_school_id" UUID,
    "buyer_person_id" UUID,
    "seller_school_id" UUID NOT NULL,
    "seller_profile_id" UUID NOT NULL,
    "quantity" INT NOT NULL DEFAULT 1,
    "unit_price_cents" INT NOT NULL,
    "total_price_cents" INT NOT NULL,
    "platform_fee_cents" INT NOT NULL,
    "seller_receives_cents" INT NOT NULL,
    "stripe_payment_intent_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    "shipping_method" TEXT,
    "tracking_number" TEXT,
    "paid_at" TIMESTAMPTZ,
    "shipped_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "confirmed_at" TIMESTAMPTZ,
    "refunded_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_asset_transactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_asset_transactions_listing_fkey" FOREIGN KEY ("listing_id")
      REFERENCES "platform"."platform_marketplace_listings"("id") ON DELETE RESTRICT,
    CONSTRAINT "platform_asset_transactions_seller_profile_fkey" FOREIGN KEY ("seller_profile_id")
      REFERENCES "platform"."platform_community_profiles"("id") ON DELETE RESTRICT,
    CONSTRAINT "platform_asset_transactions_buyer_type_chk" CHECK (
      "buyer_type" IN ('SCHOOL', 'INDIVIDUAL')
    ),
    CONSTRAINT "platform_asset_transactions_buyer_shape_chk" CHECK (
      ("buyer_type" = 'SCHOOL' AND "buyer_school_id" IS NOT NULL)
      OR ("buyer_type" = 'INDIVIDUAL' AND "buyer_person_id" IS NOT NULL)
    ),
    CONSTRAINT "platform_asset_transactions_status_chk" CHECK (
      "status" IN ('PENDING_PAYMENT', 'PAID', 'SHIPPING', 'DELIVERED', 'CONFIRMED', 'DISPUTED', 'REFUNDED')
    ),
    CONSTRAINT "platform_asset_transactions_shipping_chk" CHECK (
      "shipping_method" IS NULL OR "shipping_method" IN ('PICKUP', 'SCHOOL_DELIVERY', 'CARRIER')
    ),
    CONSTRAINT "platform_asset_transactions_quantity_chk" CHECK ("quantity" > 0),
    CONSTRAINT "platform_asset_transactions_unit_price_chk" CHECK ("unit_price_cents" >= 0),
    CONSTRAINT "platform_asset_transactions_total_chk" CHECK ("total_price_cents" >= 0),
    CONSTRAINT "platform_asset_transactions_fee_chk" CHECK ("platform_fee_cents" >= 0),
    CONSTRAINT "platform_asset_transactions_seller_receives_chk" CHECK ("seller_receives_cents" >= 0),
    CONSTRAINT "platform_asset_transactions_fee_split_chk" CHECK (
      "platform_fee_cents" + "seller_receives_cents" = "total_price_cents"
    )
);

CREATE INDEX IF NOT EXISTS "platform_asset_transactions_listing_idx"
  ON "platform"."platform_asset_transactions" ("listing_id");

CREATE INDEX IF NOT EXISTS "platform_asset_transactions_buyer_school_idx"
  ON "platform"."platform_asset_transactions" ("buyer_school_id")
  WHERE "buyer_school_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "platform_asset_transactions_buyer_person_idx"
  ON "platform"."platform_asset_transactions" ("buyer_person_id")
  WHERE "buyer_person_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "platform_asset_transactions_seller_school_idx"
  ON "platform"."platform_asset_transactions" ("seller_school_id");

CREATE INDEX IF NOT EXISTS "platform_asset_transactions_status_idx"
  ON "platform"."platform_asset_transactions" ("status");

COMMENT ON TABLE "platform"."platform_asset_transactions" IS
  'P2-21c — School-to-school asset transactions with 5% platform fee + 95% to seller. THE FEE-SPLIT KEYSTONE is the schema-level fee_split_chk: platform_fee_cents + seller_receives_cents = total_price_cents. AssetTransactionService.purchase computes the 5% split before INSERT; the schema is the safety net. 7-state lifecycle. buyer_shape_chk enforces SCHOOL needs buyer_school_id, INDIVIDUAL needs buyer_person_id. ADR-073.';

COMMENT ON CONSTRAINT "platform_asset_transactions_fee_split_chk"
  ON "platform"."platform_asset_transactions" IS
  'KEYSTONE: platform_fee_cents + seller_receives_cents = total_price_cents. The 5% / 95% split is computed at the service layer; this CHECK is the schema-side belt-and-braces.';


-- ── platform_asset_condition_reports ────────────────────────────────
-- Two condition reports per transaction — SELLER_LISTING (what the
-- seller advertised) and BUYER_RECEIPT (what the buyer received).
-- Disputes happen when they diverge.

CREATE TABLE IF NOT EXISTS "platform"."platform_asset_condition_reports" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "reporter_type" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "condition_notes" TEXT,
    "photo_s3_keys" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "reported_by" UUID NOT NULL,
    "reported_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_asset_condition_reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_asset_condition_reports_transaction_fkey" FOREIGN KEY ("transaction_id")
      REFERENCES "platform"."platform_asset_transactions"("id") ON DELETE CASCADE,
    CONSTRAINT "platform_asset_condition_reports_reporter_type_chk" CHECK (
      "reporter_type" IN ('SELLER_LISTING', 'BUYER_RECEIPT')
    ),
    CONSTRAINT "platform_asset_condition_reports_condition_chk" CHECK (
      "condition" IN ('NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'POOR')
    ),
    CONSTRAINT "platform_asset_condition_reports_uq"
      UNIQUE ("transaction_id", "reporter_type")
);

CREATE INDEX IF NOT EXISTS "platform_asset_condition_reports_transaction_idx"
  ON "platform"."platform_asset_condition_reports" ("transaction_id");

COMMENT ON TABLE "platform"."platform_asset_condition_reports" IS
  'P2-21c — Condition reports per transaction. UNIQUE(transaction_id, reporter_type) so each transaction has at most one SELLER_LISTING and one BUYER_RECEIPT report. Divergence triggers DISPUTED status. reported_by is a soft FK to platform.iam_person(id). CASCADE on transaction.';


-- ── platform_marketplace_watch_lists ────────────────────────────────
-- Schools register search criteria; WatchListMatchWorker matches on
-- every new listing publication and notifies matching schools.

CREATE TABLE IF NOT EXISTS "platform"."platform_marketplace_watch_lists" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "target_listing_type" TEXT NOT NULL,
    "search_keywords" TEXT,
    "max_price_cents" INT,
    "condition_min" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_by" UUID NOT NULL,
    "fulfilled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_marketplace_watch_lists_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_marketplace_watch_lists_target_type_chk" CHECK (
      "target_listing_type" IN ('EDUCATIONAL', 'PORTFOLIO', 'FIELD_TRIP', 'SURPLUS_ASSET', 'BOOK', 'KNOWLEDGE')
    ),
    CONSTRAINT "platform_marketplace_watch_lists_condition_min_chk" CHECK (
      "condition_min" IS NULL OR "condition_min" IN ('NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'POOR')
    ),
    CONSTRAINT "platform_marketplace_watch_lists_status_chk" CHECK (
      "status" IN ('ACTIVE', 'FULFILLED')
    ),
    CONSTRAINT "platform_marketplace_watch_lists_max_price_chk" CHECK (
      "max_price_cents" IS NULL OR "max_price_cents" >= 0
    ),
    CONSTRAINT "platform_marketplace_watch_lists_fulfilled_chk" CHECK (
      ("status" = 'ACTIVE' AND "fulfilled_at" IS NULL)
      OR ("status" = 'FULFILLED' AND "fulfilled_at" IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS "platform_marketplace_watch_lists_active_idx"
  ON "platform"."platform_marketplace_watch_lists" ("target_listing_type", "status")
  WHERE "status" = 'ACTIVE';

CREATE INDEX IF NOT EXISTS "platform_marketplace_watch_lists_school_idx"
  ON "platform"."platform_marketplace_watch_lists" ("school_id");

COMMENT ON TABLE "platform"."platform_marketplace_watch_lists" IS
  'P2-21c — Watch lists with criteria. WatchListMatchWorker fires on mkt.listing.published, iterates ACTIVE rows, and notifies schools whose criteria match. Multi-column fulfilled_chk keeps status + fulfilled_at in lockstep. school_id is a soft FK to platform.schools per ADR-001/020.';


-- ── platform_community_ratings ──────────────────────────────────────
-- 3-value polymorphic rateable_type (LISTING, TRANSACTION, FORUM_POST).
-- UNIQUE(rateable_type, rateable_id, rated_by) so one rating per user
-- per item. Score is 1..5 stars. helpful_votes is bumped via the
-- /helpful endpoint.

CREATE TABLE IF NOT EXISTS "platform"."platform_community_ratings" (
    "id" UUID NOT NULL,
    "rateable_type" TEXT NOT NULL,
    "rateable_id" UUID NOT NULL,
    "rated_by" UUID NOT NULL,
    "score" INT NOT NULL,
    "review_text" TEXT,
    "helpful_votes" INT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_community_ratings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_community_ratings_rateable_type_chk" CHECK (
      "rateable_type" IN ('LISTING', 'TRANSACTION', 'FORUM_POST')
    ),
    CONSTRAINT "platform_community_ratings_score_chk" CHECK ("score" BETWEEN 1 AND 5),
    CONSTRAINT "platform_community_ratings_helpful_chk" CHECK ("helpful_votes" >= 0),
    CONSTRAINT "platform_community_ratings_uq"
      UNIQUE ("rateable_type", "rateable_id", "rated_by")
);

CREATE INDEX IF NOT EXISTS "platform_community_ratings_rateable_idx"
  ON "platform"."platform_community_ratings" ("rateable_type", "rateable_id", "score");

CREATE INDEX IF NOT EXISTS "platform_community_ratings_rated_by_idx"
  ON "platform"."platform_community_ratings" ("rated_by");

COMMENT ON TABLE "platform"."platform_community_ratings" IS
  'P2-21c — Polymorphic star ratings (1..5). UNIQUE(rateable_type, rateable_id, rated_by) caps each user at one rating per item. helpful_votes bumped via POST /community/ratings/:id/helpful. rated_by is a soft FK to platform.iam_person(id). ADR-074.';


-- ── platform_community_reputation_log ───────────────────────────────
-- Append-only ledger of reputation changes. Service-side IMMUTABLE.
-- On INSERT, ReputationService updates
-- platform_community_profiles.reputation_points inside the same tx so
-- the leaderboard denormalisation stays consistent.

CREATE TABLE IF NOT EXISTS "platform"."platform_community_reputation_log" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "points_delta" INT NOT NULL,
    "reason" TEXT NOT NULL,
    "reference_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_community_reputation_log_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_community_reputation_log_profile_fkey" FOREIGN KEY ("profile_id")
      REFERENCES "platform"."platform_community_profiles"("id") ON DELETE CASCADE,
    CONSTRAINT "platform_community_reputation_log_reason_chk" CHECK (
      "reason" IN (
        'LISTING_SOLD', 'RATING_RECEIVED', 'HELPFUL_VOTE',
        'FORUM_ANSWER_ACCEPTED', 'REPORT_UPHELD', 'ADMIN_ADJUSTMENT'
      )
    )
);

CREATE INDEX IF NOT EXISTS "platform_community_reputation_log_profile_idx"
  ON "platform"."platform_community_reputation_log" ("profile_id", "created_at" DESC);

COMMENT ON TABLE "platform"."platform_community_reputation_log" IS
  'P2-21c — Append-only ledger of reputation deltas. Service-side IMMUTABLE — ReputationService has no UPDATE / DELETE methods. On INSERT, the service updates platform_community_profiles.reputation_points = SUM(points_delta) for this profile inside the SAME tx so the denormalised aggregate stays consistent. CASCADE on profile delete drops the entire ledger (the profile is the audit boundary).';


-- ── platform_search_index ───────────────────────────────────────────
-- Unified tsvector full-text index across all community content types.
-- Materialised by SearchIndexWorker on content events (listing
-- published, profile updated, forum post created, knowledge article
-- published). ADR-076.

CREATE TABLE IF NOT EXISTS "platform"."platform_search_index" (
    "id" UUID NOT NULL,
    "content_type" TEXT NOT NULL,
    "content_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body_preview" TEXT,
    "search_vector" TSVECTOR NOT NULL,
    "school_id" UUID,
    "author_profile_id" UUID,
    "content_date" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_search_index_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_search_index_content_type_chk" CHECK (
      "content_type" IN ('LISTING', 'FORUM_POST', 'KNOWLEDGE_ARTICLE', 'PROFILE')
    ),
    CONSTRAINT "platform_search_index_content_uq"
      UNIQUE ("content_type", "content_id")
);

CREATE INDEX IF NOT EXISTS "platform_search_index_vector_gin"
  ON "platform"."platform_search_index" USING GIN ("search_vector");

CREATE INDEX IF NOT EXISTS "platform_search_index_content_date_idx"
  ON "platform"."platform_search_index" ("content_date" DESC) WHERE "content_date" IS NOT NULL;

COMMENT ON TABLE "platform"."platform_search_index" IS
  'P2-21c — Unified tsvector full-text search index across all community content types. UNIQUE(content_type, content_id) so re-publishing the same content UPSERTs cleanly. Materialised by SearchIndexWorker on content events. GIN INDEX on search_vector backs the /community/search endpoint. ADR-076.';

COMMENT ON COLUMN "platform"."platform_search_index"."search_vector" IS
  'PostgreSQL tsvector populated by SearchIndexWorker from title + body_preview at materialisation time. Queried via @@ plainto_tsquery(...) with ts_rank ordering.';
