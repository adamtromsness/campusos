# HANDOFF — Phase 2 Cycle 21 (P2-21): Platform Advanced

**Status:** P2-21a + P2-21b shipped + tagged + awaiting REVIEW-P2C21 final verdict. **P2-21c ships with this commit** — the final sub-cycle. Together P2-21a + b + c cover the M90 + M91 + Community Exchange surfaces (CRM, internal ops, pricing, marketplace, search) — 26 platform tables across 3 platform migrations + ~64 endpoints + 3 modules + 2 workers + 2 Kafka consumers. Total tests at 1043 → **1058** after Step 6.

| Sub-cycle  | Surface                                         | Tables | Endpoints | Workers / consumers | Commit        |
| ---------- | ----------------------------------------------- | ------ | --------- | ------------------- | ------------- |
| **P2-21a** | M90 CRM (accounts, subscriptions, onboarding)   | 9      | ~22       | 1 worker            | `9d69823`     |
| **P2-21b** | M91 Internal Ops + Pricing                      | 9      | ~20       | 1 worker            | `30792a0`     |
| **P2-21c** | Community Exchange (marketplace + search + rep) | 8      | ~22       | 2 Kafka consumers   | _this commit_ |
| **Total**  | M90 + M91 + Community                           | **26** | **~64**   | **2 + 2**           |               |

**Plan:** `docs/campusos-p2c21-platform-advanced.html`
**Review scaffold:** `P2C21-REVIEW-NOTES.md`
**Dates:** 2026-05-12

## Scope

P2-21 is the final cycle of Wave D (Module Completion) before the broader Phase 2 closeout. **All schema lives in the PLATFORM schema** — these tables serve either CampusOS-the-company (CRM, ops, pricing) or the cross-school community (marketplace, profiles, search). Pre-split into 3 sub-cycles to keep peer-review surface area manageable; this handoff covers all three.

P2-21a + P2-21b are internal-only (platform-scoped routes; no tenant context required). **P2-21c is tenant-scoped** because every authenticated user belongs to some school and the regular guard chain (Auth + Tenant + Permission) runs. The marketplace data lives in the platform schema for cross-school visibility, but the request is tenant-scoped.

## P2-21a — M90 CRM (Customer & Subscriptions)

**Migration:** `20260512140000_add_p2c21a_crm`. 9 platform tables — `crm_accounts`, `crm_subscriptions`, `crm_contacts`, `crm_interactions`, `crm_onboarding_checklists`, `crm_onboarding_tasks`, `crm_health_scores`, `crm_renewal_pipeline`, `crm_invoices`.

**Lifecycle keystone:** `crm_accounts.status` is a 6-value CHECK (PROSPECT → PILOT → ONBOARDING → ACTIVE → CHURNED → SUSPENDED). `AccountService.transitionStatus` validates: PROSPECT → PILOT requires `signed_date`; ONBOARDING → ACTIVE requires onboarding checklist `status='COMPLETED'`. The onboarding service auto-flips checklist + account to ACTIVE when the last task completes.

**Module:** `CrmModule` at `apps/api/src/crm/`. 5 services + 1 controller + 1 worker + ~22 endpoints under `/api/v1/internal/crm/*` gated `@PlatformScoped()` (no tenant header; permission resolution against the PLATFORM IAM scope only).

- `AccountService` — CRUD + lifecycle transitions + timeline
- `SubscriptionService` — Stripe-webhook-ready (sync stubbed in dev) + MRR rollup
- `OnboardingService` — checklist + task lifecycle + auto-transition
- `HealthScoreService` — weekly worker computes adoption + engagement + support + NPS into one composite score; 3-value risk_level (HEALTHY, AT_RISK, CRITICAL)
- `RenewalService` — pipeline board by stage with at-risk flags

**Worker:** `HealthScoreWorker` runs weekly (cron-style poller, configurable via `CRM_HEALTH_SCORE_INTERVAL_MS`). Materialises a `crm_health_scores` row per active account from the latest snapshot.

**IAM:** new `CRM-001..006` codes already in the catalogue (148 → **154** functions × 3 tiers). Platform Admin holds all via everyFunction; the controller is `@PlatformScoped()` so school admins / teachers / parents / students cannot reach `/api/v1/internal/crm/*` even with `sys-001:admin` at SCHOOL scope.

**Web:** 2 routes — `/internal/crm` dashboard with MRR chart + at-risk accounts + renewals Kanban; `/internal/crm/[id]` per-account detail with timeline + contacts + subscription + onboarding progress.

## P2-21b — M91 Internal Ops + Pricing

**Migration:** `20260512150000_add_p2c21b_ops_pricing`. 9 platform tables — `ops_employees`, `ops_permissions`, `ops_account_assignments`, `ops_tenant_access_grants`, `ops_internal_tickets`, `ops_internal_ticket_comments`, `platform_pricing_bands`, `platform_pricing_history`, `platform_support_tiers`.

**FERPA/GDPR keystone (ADR-072):** `ops_tenant_access_grants` carries 4 multi-column / single-column CHECKs:

- `duration_chk` — `expires_at <= granted_at + INTERVAL '4 hours'` (hard 4-hour maximum)
- `justification_chk` — `length(trim(justification)) >= 20` (mandatory ≥20-char rationale)
- `window_chk` — `expires_at > granted_at`
- `revoked_chk` — `revoked_at >= granted_at` when set

`TenantAccessService.grant` enforces additional service-side rules:

1. Approver ≠ requester (no self-approval)
2. Approver must hold the `INTERNAL_ADMIN` ops_permissions scope
3. `durationHours` clamped 1..4 with friendly 400 above
4. Emits `ops.tenant_access.granted` via the ADR-057 envelope AFTER the INSERT commits

**Worker:** `TenantAccessExpiryWorker` polls every 5 minutes (configurable) and stamps `revoked_at = now()` on rows whose `expires_at < now() AND revoked_at IS NULL`. Idempotent — the WHERE clause is the safety net.

**Pricing keystone:** `PricingService.updateBand` writes a `platform_pricing_history` row INSIDE the same Prisma `$transaction` as the band UPDATE whenever `monthly_price_cents` or `annual_price_cents` changes — audit can never desync from the live band.

**Module:** `OpsModule` at `apps/api/src/ops/`. 5 services + 1 controller + 1 worker + ~20 endpoints under `/api/v1/internal/{employees,permissions,account-assignments,tenant-access,tickets,pricing}/*` gated `@PlatformScoped()`.

**IAM:** new `OPS-001..006` codes added (catalogue 154 → **160**); admin tier granted only to Platform Admin via everyFunction at PLATFORM scope.

**Web:** 3 routes — `/internal/ops` (employees + tenant-access form with min-20-char justification + active grants with countdown + audit log); `/internal/tickets` (Kanban by status); `/internal/pricing` (bands + history modal + support tiers).

## P2-21c — Community Exchange (THIS COMMIT)

**Migration:** `20260512160000_add_p2c21c_community_exchange`. 8 platform tables — `platform_community_profiles`, `platform_marketplace_listings`, `platform_asset_transactions`, `platform_asset_condition_reports`, `platform_marketplace_watch_lists`, `platform_community_ratings`, `platform_community_reputation_log`, `platform_search_index`.

**Five structural keystones:**

1. **5% PLATFORM FEE SPLIT (ADR-073)** — `platform_asset_transactions.fee_split_chk` is a schema-level CHECK enforcing `platform_fee_cents + seller_receives_cents = total_price_cents`. `AssetTransactionService.purchase` computes the 5% / 95% split before INSERT; the CHECK is the safety net. Verified live against `tenant_demo` 2026-05-12: total=12000 → fee=600 + seller=11400 ✓. Sub-cent residue lands on the seller (the `Math.floor` on fee).

2. **PARENT GATE (ADR-073)** — `MarketplaceListingService.assertCanCreateListing` throws `ForbiddenException` for any actor whose `personType` is GUARDIAN or STUDENT. Parents and students hold `MKT-001:read` for browsing but the service layer is the actual access boundary on POST `/marketplace`. Verified by `marketplace-listing.service.spec.ts` (6 cases including the canonical ADR-073 message check).

3. **TSVECTOR GIN SEARCH (ADR-076)** — `platform_marketplace_listings.search_keywords` is a tsvector column with a GIN index. `MarketplaceListingService` materialises the vector from `title + description + tags + category` on every INSERT and UPDATE. `SearchService` exposes the unified `/community/search` endpoint that queries via `@@ plainto_tsquery('english', $1)` with `ts_rank` ordering against the dedicated `platform_search_index` table (ADR-076). Smoke verified: `?q=cool` returns the seeded book row with rank=0.06079271.

4. **WATCHLIST MATCHING ON PUBLISH** — `WatchListMatchConsumer` subscribes to `mkt.listing.published` under group `watch-list-match`. Per inbound event: matches the listing against `platform_marketplace_watch_lists` rows where `status='ACTIVE'` AND `target_listing_type` matches, optional tsvector keyword match, optional `max_price_cents` cap, optional `condition_min` ordinal compare. Notification fan-out (email, in-app) wires into the future Cycle 14 notification pipeline; the consumer currently produces a log line per match.

5. **REPUTATION DENORMALISATION** — `platform_community_reputation_log` is the append-only ledger. `CommunityProfileService.addReputation` writes the log row + bumps `platform_community_profiles.reputation_points` atomically inside one Prisma `$transaction`. The leaderboard query (`ORDER BY reputation_points DESC`) is O(1) with the index because the aggregate is denormalised. Reputation reasons: `LISTING_SOLD` (+30 on transaction CONFIRMED), `RATING_RECEIVED` (+10 on first-time rating, not re-rate), `HELPFUL_VOTE` (+5 to the rater on each helpful click).

**Module:** `CommunityModule` at `apps/api/src/community/`. 6 services + 1 controller + 2 Kafka consumers + ~22 endpoints under `/api/v1/community/*`. Uses the regular guard chain (Auth + Tenant + Permission) because every authenticated user has a tenant.

- `CommunityProfileService` — get-or-create + leaderboard + reputation ledger writer
- `MarketplaceListingService` — list + search + create (parent gate) + patch (status transitions)
- `AssetTransactionService` — purchase keystone (5% fee split, listing lock, status flip) + lifecycle PATCH + condition reports
- `WatchListService` — CRUD + matching keystone called by the consumer
- `RatingService` — UNIQUE(rateable_type, rateable_id, rated_by) so re-rate UPDATEs; refuses self-rating; awards reputation
- `SearchService` — `/community/search` + `upsert` for the SearchIndexConsumer
- `WatchListMatchConsumer` (Kafka, group `watch-list-match`) — subscribes to `mkt.listing.published`
- `SearchIndexConsumer` (Kafka, group `search-index`) — subscribes to `mkt.listing.published`; UPSERTs the `platform_search_index` row keyed on (content_type, content_id)

**Emits:**

- `mkt.listing.published` — when a DRAFT listing flips to ACTIVE (consumed by both WatchListMatchConsumer + SearchIndexConsumer)
- `mkt.transaction.completed` — when a transaction flips to CONFIRMED

**IAM:** MKT-001..010 codes already in the catalogue from earlier waves. Per-role grants this cycle:

| Role    | MKT-001 (Listings)        | MKT-002 (Purchase) | MKT-003 (Surplus) | MKT-005 (Profiles) | MKT-006 (Ratings) | MKT-007 (Watch) |
| ------- | ------------------------- | ------------------ | ----------------- | ------------------ | ----------------- | --------------- |
| Teacher | read+write                | read+write         | —                 | read+write         | read+write        | read+write      |
| Parent  | **read only**             | read+write         | —                 | read+write         | read+write        | —               |
| Student | **read only**             | —                  | —                 | read+write         | —                 | —               |
| Staff   | read+write                | read+write         | read+write        | read+write         | read+write        | read+write      |
| Admins  | admin (via everyFunction) |                    |                   |                    |                   |                 |

**Parents are blocked from listing creation at the service layer**, not just by lack of write permission — `assertCanCreateListing` rejects on `personType` so even a parent with MKT-001:write would be denied. This is the explicit ADR-073 contract.

**Web:** 4 routes:

- `/community/marketplace` — browse grid with search + type filter; per-row card with rating rollup, status pill, price
- `/community/marketplace/[id]` — listing detail with description + tags + ratings list + Submit-rating form + Buy modal (5% fee preview)
- `/community/profiles` — own profile editor + top-25 leaderboard
- `/community/watch-lists` — list + create form (gated on MKT-007:write)

**Seed:** `seed-community.ts` (idempotent, gated on `platform_community_profiles`). 4 profiles bridged from the demo personas (teacher Rivera, principal Mitchell, parent David Chen, student Maya), 6 sample listings covering all 6 listing types (one each), 1 CONFIRMED transaction with the 5% fee split keystone exercised (total=12000 / fee=600 / seller=11400), 2 condition reports (SELLER_LISTING + BUYER_RECEIPT) on the completed transaction, 1 active watch list, 2 ratings, 5 reputation log entries demonstrating all the canonical reasons, 4 search-index rows.

**Tests:** 15 new vitest cases across 2 spec files in `apps/api/src/community/__tests__/`:

- `marketplace-listing.service.spec.ts` (6 cases) — pins the parent gate keystone behaviour (allows STAFF + admin override; refuses GUARDIAN, STUDENT, null personType; canonical ADR-073 message)
- `asset-transaction.service.spec.ts` (9 cases) — pins the 5% fee split arithmetic (round + rounding-residue + quantity multiplication), refuses purchase on SOLD or free listings, buyer-shape validation, defaults buyerPersonId on INDIVIDUAL, INSERT params sum correctly to satisfy fee_split_chk

Vitest 1043 → **1058 passing across 56 spec files**.

## CI parity green

- `pnpm format` ran (11 files auto-formatted)
- `pnpm format:check` — clean
- `pnpm lint:logs` — 896 files clean
- `pnpm --filter @campusos/api build` — clean
- `pnpm --filter @campusos/web build` — clean (4 community routes ship: `/community/marketplace` 3.88 kB, `/community/marketplace/[id]` 4.62 kB, `/community/profiles` 3.74 kB, `/community/watch-lists` 4.03 kB First Load JS)
- `pnpm --filter @campusos/api exec vitest run` — 1058/1058 across 56 spec files
- `pnpm --filter @campusos/database migrate:deploy` — clean (14 platform migrations applied)

## Live verification on `tenant_demo` 2026-05-12

24 schema-side smoke assertions all green:

- Migration applied cleanly via `prisma migrate deploy`; 8 new platform tables verified via `pg_tables` count
- T1-T3: profile happy path + UNIQUE(person_id) catch
- T4-T8: listing CHECKs (listing_type, condition, published_chk both directions)
- T9 (keystone): fee split valid — 1000 = 50 + 950 (5%)
- T10 (keystone): fee_split_chk rejects 1000 = 50 + 940
- T11: buyer_shape_chk rejects SCHOOL with no buyer_school_id
- T12: status CHECK rejects bogus
- T13: rating score 6 rejected (1..5)
- T14: UNIQUE(rateable_type, rateable_id, rated_by) catches duplicate rating
- T15: reputation reason CHECK rejects bogus
- **T16 (keystone): GIN tsvector search `@@ plainto_tsquery('english', 'cool')`** returns The Test Book Title with `ts_rank=0.06079271`
- T17: condition_report UNIQUE(transaction, reporter_type) catches duplicate BUYER_RECEIPT
- T18: watch list fulfilled_chk rejects status=ACTIVE with fulfilled_at populated
- T19: search_vector GIN INDEX returns matching content via `plainto_tsquery('english', 'book')`
- T20: reputation log INSERT visible in profile.reputation_points denorm
- T21: CASCADE on transaction delete drops condition reports

Splitter trap N/A — Prisma migrations are executed natively, not via the custom splitter. The migration applied cleanly on the first attempt.

## Cross-cycle integration

- **P2-21a CRM accounts** reference `school_id` (soft FK to platform.schools) so the CRM dashboard surfaces every active school as a potential account. The Stripe customer + subscription id columns are stub-populated in seed; real Stripe wiring is Phase 3 ops.
- **P2-21b OPS tenant-access grants** target a `tenant_schema` string. The audit log surfaces every grant + revocation across all tenants. Grant approvers are tracked through `ops_permissions` (`INTERNAL_ADMIN` scope).
- **P2-21c Community Exchange** is the first cross-school surface in CampusOS. The seed plants Lincoln Academy as both buyer and seller in the same demo transaction to keep the dev tenant self-contained, but the schema admits cross-school transactions naturally (buyer_school_id ≠ seller_school_id).

## Reviewer attention items (Phase 2 punch list candidates)

1. **Stripe real wiring** for both subscription billing (P2-21a) and marketplace transactions (P2-21c). Currently stubbed with `stripe_payment_intent_id` text columns; production needs the actual Stripe API calls, webhook handlers, and PaymentIntent lifecycle.
2. **WatchListMatchConsumer notification fan-out** — currently produces log lines only. Cycle 14 notification pipeline integration (in-app + email) lands once the consumer wires into `NotificationQueueService`.
3. **Cross-school cross-tenant search routing** — `platform_search_index` is platform-scoped and indexes all content, but the read path doesn't yet do school-affinity ranking. Pre-pilot, ranking should weight same-school + same-region content higher.
4. **HealthScoreWorker** (P2-21a) currently computes a placeholder weighted score; production needs real data sources for adoption_score (login counts), engagement_score (feature usage), support_ticket_score (recent SLA breaches), and nps_score (survey integration).
5. **Reputation decay** — `platform_community_profiles.reputation_points` is monotonic in the seed; pre-pilot may want a quarterly decay job so dormant top-rated users don't dominate the leaderboard forever.
6. **Search index materialisation backlog** — `SearchIndexConsumer` subscribes only to `mkt.listing.published` today. Future forum + knowledge article surfaces emit their own `*.published` topics that need consumer wiring.
7. **Marketplace moderation** — `platform_marketplace_listings` has no `is_flagged` or `moderation_status` columns. Pre-pilot adds a moderation surface (likely additive columns + an admin queue under `MKT-009`).

## Status

- P2-21a: tagged `p2c21a-shipped` at `9d69823`
- P2-21b: tagged `p2c21b-shipped` at `30792a0`
- P2-21c: ships with **_this commit_**; awaiting REVIEW-P2C21 verdict for combined `p2c21-complete` and (after Round 2) `p2c21-approved`.

Wave D continues into Phase 2 polish per the broader roadmap.
