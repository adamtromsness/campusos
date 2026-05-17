# REVIEW NOTES — Phase 2 Cycle 21 (P2-21): Platform Advanced

**Scope:** P2-21a CRM at `9d69823` + P2-21b Internal Ops + Pricing at `30792a0` + P2-21c Community Exchange at this commit.
**Plan:** `docs/campusos-p2c21-platform-advanced.html`
**Handoff:** `HANDOFF-P2C21.md`
**Dates:** 2026-05-12

This document is the peer-review scaffold for the full P2-21 cycle covering all three sub-cycles. It enumerates the load-bearing invariants, the live verification trail, and the documented carry-overs so the reviewer can move efficiently through 26 tables + 64 endpoints across 3 modules + 2 workers + 2 Kafka consumers.

---

## 1. Cycle deliverable summary

26 platform tables across 3 Prisma migrations:

- `20260512140000_add_p2c21a_crm` — 9 CRM tables
- `20260512150000_add_p2c21b_ops_pricing` — 9 ops + pricing tables
- `20260512160000_add_p2c21c_community_exchange` — 8 community tables

~64 endpoints across 3 NestJS modules (`CrmModule`, `OpsModule`, `CommunityModule`), 5 Kafka emit topics (`ops.tenant_access.granted`, `mkt.listing.published`, `mkt.transaction.completed`), 2 Kafka consumers (`WatchListMatchConsumer`, `SearchIndexConsumer`), 2 periodic workers (`HealthScoreWorker`, `TenantAccessExpiryWorker`). 5 new web tiles: `/internal/crm`, `/internal/ops`, `/internal/pricing`, `/community/marketplace`, `/community/profiles`, `/community/watch-lists` (6 internal + 4 community routes).

**Tests:** 1058 vitest passing across 56 spec files. **Live verification on `tenant_demo` 2026-05-12** — 24 schema-side smoke assertions + 15 service-layer unit tests all green for P2-21c. P2-21a + P2-21b verification trails preserved in their respective sub-cycle commits.

---

## 2. PLATFORM vs TENANT schema split (the load-bearing architectural decision)

**The contract.** Every table in P2-21 lives in the PLATFORM schema, not the tenant schema. This is the deliberate ADR-071..076 architectural call: these tables serve either CampusOS-the-company (CRM, ops, pricing — internal-only) or the cross-school community (marketplace, profiles, search — visible to all tenants).

**What this means in code:**

- **Migrations:** All three P2-21 migrations live in `packages/database/prisma/platform/migrations/` and are applied by `prisma migrate deploy` against the platform schema. Tenant migrations (under `packages/database/prisma/tenant/migrations/`) are unchanged this cycle.
- **Tables are unprefixed by tenant.** A `crm_accounts` row references `school_id` (soft FK to `platform.schools`) but is not partitioned per tenant. Same for `platform_marketplace_listings`, etc.
- **Soft cross-schema refs.** Per ADR-001/020, no DB-enforced FK from PLATFORM tables to tenant-scoped tables. FKs WITHIN the platform schema between sibling P2-21 tables ARE declared (e.g. `platform_asset_transactions.listing_id` → `platform_marketplace_listings(id)` ON DELETE RESTRICT).
- **Read paths.** P2-21a + P2-21b service queries hit `platform.*` directly via `prisma.$queryRawUnsafe`. P2-21c is tenant-scoped (regular guard chain) but writes to platform tables — `getCurrentTenant().schoolId` provides the tenant context but the SQL still reads `platform.platform_marketplace_listings`.

**What to verify in code review:** the three migration files are entirely `CREATE TABLE "platform"."xxx_*"` — no tenant prefix anywhere. The services in `apps/api/src/{crm,ops,community}/services/*.ts` use raw `platform.*` SQL paths.

---

## 3. P2-21a CRM lifecycle state machine

**The contract.** `crm_accounts.status` is a 6-value CHECK (PROSPECT, PILOT, ONBOARDING, ACTIVE, CHURNED, SUSPENDED). Transitions must follow the lifecycle: PROSPECT → PILOT (requires signed_date) → ONBOARDING → ACTIVE (requires onboarding COMPLETED) → ACTIVE → CHURNED. SUSPENDED can be reached from any non-terminal state.

**How it's enforced:** `AccountService.transitionStatus(id, newStatus)` validates the transition map and the precondition columns. The CHECK constraint on `status` is the schema-side belt-and-braces — a buggy service can't land a bogus enum value, but the lifecycle transitions themselves are service-enforced.

**Onboarding auto-complete:** `OnboardingService.completeTask` runs in one tenant tx — flips the task to COMPLETED, counts remaining tasks, and on zero counts flips the checklist to COMPLETED + auto-transitions the account from ONBOARDING to ACTIVE. No separate cron — atomic on the last task.

**What to verify in code review:** `apps/api/src/crm/services/account.service.ts::transitionStatus` and `apps/api/src/crm/services/onboarding.service.ts::completeTask`. The transition map matches the documented lifecycle. The onboarding auto-complete runs inside `$transaction`.

---

## 4. P2-21b FERPA/GDPR tenant-access audit (ADR-072 KEYSTONE)

**The contract.** `ops_tenant_access_grants` is a permanent audit trail of every CampusOS employee entering a school tenant. Four constraints make compliance enforceable at the database layer:

1. **Hard 4-hour maximum:** `duration_chk CHECK (expires_at <= granted_at + INTERVAL '4 hours')`
2. **Mandatory ≥20-char justification:** `justification_chk CHECK (length(trim(justification)) >= 20)`
3. **Window order:** `window_chk CHECK (expires_at > granted_at)`
4. **Revocation order:** `revoked_chk CHECK (revoked_at IS NULL OR revoked_at >= granted_at)`

**Service-layer additions:**

- Approver ≠ requester (no self-approval)
- Approver must hold `INTERNAL_ADMIN` ops_permissions scope
- DTO `@MinLength(20)` catches the common case before the SQL fires; schema CHECK is the safety net
- `durationHours` clamped 1..4 with friendly 400
- Emits `ops.tenant_access.granted` via ADR-057 envelope AFTER INSERT commits

**Auto-expiry:** `TenantAccessExpiryWorker` polls every 5 minutes (configurable) and stamps `revoked_at = now()` on rows whose `expires_at < now() AND revoked_at IS NULL`. Idempotent.

**What to verify in code review:**

- `packages/database/prisma/platform/migrations/20260512150000_add_p2c21b_ops_pricing/migration.sql` — the four CHECK constraints
- `apps/api/src/ops/services/tenant-access.service.ts::grant` — service-layer gates, the SQL INSERT, the post-commit emit
- `apps/api/src/ops/__tests__/tenant-access.service.spec.ts` — pinned regression tests for every gate

---

## 5. P2-21c — FEE SPLIT KEYSTONE (ADR-073)

**The contract.** Every `platform_asset_transactions` row satisfies `platform_fee_cents + seller_receives_cents = total_price_cents` (5% platform fee, 95% to seller). This is enforced at THREE layers:

1. **Schema CHECK:** `fee_split_chk CHECK (platform_fee_cents + seller_receives_cents = total_price_cents)`
2. **Service compute:** `AssetTransactionService.purchase` computes `platformFeeCents = Math.floor(totalPriceCents * 5 / 100)` and `sellerReceivesCents = totalPriceCents - platformFeeCents`. Sub-cent residue lands on the seller (because we `floor()` the fee).
3. **DTO constant:** `PLATFORM_FEE_PERCENT = 5` is exported from `apps/api/src/community/dto/community.dto.ts` so the math is auditable in one place.

**Live verification on `tenant_demo` 2026-05-12:**

```
T9 (good):  1000 cents → fee=50 + seller=950   (50+950=1000 ✓)
T10 (bad):  1000 cents → fee=50 + seller=940   → ERROR fee_split_chk ✓
T9 seed:    12000 cents → fee=600 + seller=11400 ✓
```

**Unit tests** in `apps/api/src/community/__tests__/asset-transaction.service.spec.ts` pin:

- `PLATFORM_FEE_PERCENT === 5`
- Round numbers: 10000 → 500 + 9500
- Rounding residue: 333 → 16 + 317 (16 + 317 = 333, fee floor is 16.65 → 16)
- Quantity multiplication: 1000 × 5 = 5000 → 250 + 4750
- INSERT params satisfy fee_split_chk

**Purchase concurrency:** the purchase runs in a Prisma `$transaction` that takes `SELECT ... FOR UPDATE` on the listing row BEFORE computing the fee + INSERTing the transaction. Concurrent purchases on the same listing serialise on the row lock; the second purchase sees `status='SOLD'` and 400s.

**What to verify in code review:**

- `packages/database/prisma/platform/migrations/20260512160000_add_p2c21c_community_exchange/migration.sql:fee_split_chk`
- `apps/api/src/community/services/asset-transaction.service.ts::purchase` — the `$transaction` with FOR UPDATE, the fee compute, the INSERT
- `apps/api/src/community/dto/community.dto.ts::PLATFORM_FEE_PERCENT`

---

## 6. P2-21c — PARENT GATE (ADR-073)

**The contract.** Parents can browse + buy + rate marketplace listings, but they CANNOT create listings. This is enforced at the SERVICE layer in `MarketplaceListingService.assertCanCreateListing`:

```typescript
assertCanCreateListing(actor: ResolvedActor): void {
  if (actor.isSchoolAdmin) return;
  if (actor.personType === 'STAFF') return;
  throw new ForbiddenException(
    'Only school staff can create marketplace listings. ' +
    'Parents and students may browse and purchase but cannot list items (ADR-073).',
  );
}
```

**Why service layer, not permission gate?** Parents hold `MKT-001:read` for browsing — they don't have `MKT-001:write`. But we explicitly DO NOT want to lock the door at the permission tier because (a) Teachers DO have MKT-001:write and (b) a future moderation surface may need to surface a listing on someone's behalf via admin override. The personType check is the actual access boundary.

**Unit tests** in `marketplace-listing.service.spec.ts` pin 6 cases:

- STAFF actor: allowed
- school admin override (personType=GUARDIAN + isSchoolAdmin=true): allowed
- GUARDIAN: 403 with canonical ADR-073 message
- STUDENT: 403
- null personType: 403 (defence-in-depth)
- Error message contains "Only school staff", "Parents and students may browse", and "ADR-073"

**IAM grants reinforce the contract:**

| Role    | MKT-001 grant |
| ------- | ------------- |
| Teacher | read+write    |
| Parent  | **read only** |
| Student | **read only** |
| Staff   | read+write    |

**What to verify in code review:** `apps/api/src/community/services/marketplace-listing.service.ts::assertCanCreateListing`, then `packages/database/src/seed-iam.ts` for the per-role grant table.

---

## 7. P2-21c — TSVECTOR FULL-TEXT SEARCH (ADR-076)

**The contract.** Two tsvector GIN indexes back the unified search:

1. **`platform_marketplace_listings.search_keywords`** — tsvector column populated by `MarketplaceListingService` from `title + description + category + tags` on every INSERT/UPDATE. GIN index for the `@@ plainto_tsquery` operator. Queried by `MarketplaceListingService.list({search})` with `ts_rank` ordering.
2. **`platform_search_index.search_vector`** — unified index across all community content types (LISTING, FORUM_POST, KNOWLEDGE_ARTICLE, PROFILE). UNIQUE(content_type, content_id) so re-publishing the same content cleanly UPSERTs. Materialised by `SearchIndexConsumer` on `mkt.listing.published`.

**Why two indexes?** The first is for the marketplace-specific browse experience with type/price/condition filters. The second is for the cross-surface `/community/search` endpoint that needs to return listings + future forum posts + future knowledge articles + profiles in one ranked list.

**Live verification:**

```
search_keywords:  ?q=cool → "Test Book Title" rank=0.06079271 ✓
search_vector:    ?q=book → "Test Book Title" via plainto_tsquery ✓
```

**What to verify in code review:**

- `migration.sql` — `CREATE INDEX ... USING GIN ("search_keywords")` and `... GIN ("search_vector")`
- `MarketplaceListingService.create / patch` — `to_tsvector('english', searchText)` materialisation
- `SearchService.upsert` — ON CONFLICT keyed on `(content_type, content_id)`
- `SearchIndexConsumer.handle` — subscribes to `mkt.listing.published` and calls `search.upsert` with the body preview + searchable text

---

## 8. P2-21c — WATCHLIST MATCHING

**The contract.** Schools register `platform_marketplace_watch_lists` rows with criteria (target listing type, optional keywords, optional max price, optional min condition). On every new listing publication, `WatchListMatchConsumer` matches the listing against active watch lists and produces a log line per match. Notification fan-out is documented as a Phase 2 carry-over (would wire into the Cycle 14 NotificationConsumer chain).

**Matching logic** in `WatchListService.matchListing`:

- `status='ACTIVE'` AND `target_listing_type = listing.listing_type` (always required)
- IF `search_keywords` set: `to_tsvector(listingSearchableText) @@ plainto_tsquery(watchKeywords)`
- IF `max_price_cents` set: `max_price_cents >= listing.priceCents`
- IF `condition_min` set: ordinal compare on the 5-value enum (NEW=5 .. POOR=1)

**Idempotency:** the consumer uses the standard `processWithIdempotency` claim-after-success pattern. The match operation is read-only against the watch-list table so redelivery is safe.

**What to verify in code review:**

- `apps/api/src/community/services/watch-list.service.ts::matchListing` — the dynamic WHERE construction
- `apps/api/src/community/watch-list-match.consumer.ts::handle` — the subscribe + processWithIdempotency invocation

---

## 9. P2-21c — REPUTATION DENORMALISATION

**The contract.** `platform_community_profiles.reputation_points` is a denormalised aggregate of `platform_community_reputation_log.points_delta` for the matching profile. The denormalisation is maintained by `CommunityProfileService.addReputation` which writes the log row + the aggregate UPDATE inside one Prisma `$transaction`:

```typescript
await this.platform.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(`INSERT INTO platform_community_reputation_log ...`);
  await tx.$executeRawUnsafe(
    `UPDATE platform_community_profiles SET reputation_points = ... + $1 WHERE id = $2`,
  );
});
```

**Reasons (6-value CHECK):**

- `LISTING_SOLD` — +30 to seller on transaction creation
- `RATING_RECEIVED` — +10 to author on FIRST rating (not re-rate)
- `HELPFUL_VOTE` — +5 to rater on each helpful click
- `FORUM_ANSWER_ACCEPTED` — reserved (forum module not in this cycle)
- `REPORT_UPHELD` — reserved (moderation surface)
- `ADMIN_ADJUSTMENT` — open for manual operator action

**Service-side immutability:** the log table has no UPDATE / DELETE methods exposed on `CommunityProfileService`. Adjustments go through new `ADMIN_ADJUSTMENT` rows.

**What to verify in code review:** `apps/api/src/community/services/community-profile.service.ts::addReputation` — the `$transaction` wraps both writes; there's no public `updateReputation` or `removeReputationLog`.

---

## 10. ENDPOINTS SUMMARY (P2-21c)

22 endpoints under `/api/v1/community/*`:

**Profiles (4):**

- `GET /community/profiles/leaderboard` (mkt-005:read)
- `GET /community/profiles/me` (mkt-005:read)
- `PATCH /community/profiles/me` (mkt-005:write)
- `GET /community/profiles/:id` (mkt-005:read)

**Marketplace (4):**

- `GET /community/marketplace` (mkt-001:read) — tsvector search
- `GET /community/marketplace/:id` (mkt-001:read)
- `POST /community/marketplace` (mkt-001:write + PARENT GATE)
- `PATCH /community/marketplace/:id` (mkt-001:write)

**Transactions (5):**

- `GET /community/transactions/my` (mkt-002:read)
- `GET /community/transactions/:id` (mkt-002:read)
- `POST /community/marketplace/:listingId/purchase` (mkt-002:write + 5% FEE KEYSTONE)
- `PATCH /community/transactions/:id` (mkt-002:write)
- `POST /community/transactions/:id/condition-report` (mkt-002:write)
- `GET /community/transactions/:id/condition-reports` (mkt-002:read)

**Watch lists (5):**

- `GET /community/watch-lists` (mkt-007:read)
- `GET /community/watch-lists/:id` (mkt-007:read)
- `POST /community/watch-lists` (mkt-007:write)
- `POST /community/watch-lists/:id/fulfill` (mkt-007:write)
- `POST /community/watch-lists/:id/delete` (mkt-007:write)

**Ratings (3):**

- `GET /community/ratings/:rateableType/:rateableId` (mkt-006:read)
- `POST /community/ratings` (mkt-006:write)
- `POST /community/ratings/:id/helpful` (mkt-006:write)

**Search (1):**

- `GET /community/search` (mkt-001:read) — unified across all content types via platform_search_index

**Catalogue (1):**

- `GET /community/catalogue` (mkt-001:read) — enum reference

---

## 11. CARRY-OVERS to Phase 2 / pre-pilot

Acceptable scope for this cycle to defer:

1. **Stripe real wiring** — both subscription billing (P2-21a) and marketplace transactions (P2-21c) currently stub the Stripe API. Production needs the actual PaymentIntent create + webhook handler + lifecycle. `stripe_payment_intent_id` column already in place.

2. **WatchListMatchConsumer notification fan-out** — currently produces log lines per match. Cycle 14 notification pipeline integration (in-app + email) is the natural next surface; the consumer is ready to call `NotificationQueueService.enqueue()` when that wiring lands.

3. **Search index materialisation backlog** — `SearchIndexConsumer` subscribes only to `mkt.listing.published`. Future forum + knowledge article surfaces emit their own `*.published` topics that need consumer wiring as those modules ship.

4. **Cross-school search affinity ranking** — `platform_search_index` is platform-scoped; the read path doesn't yet do same-school or same-region ranking weights. Pre-pilot polish.

5. **Marketplace moderation surface** — `platform_marketplace_listings` has no `is_flagged` / `moderation_status` columns. Pre-pilot adds a `MKT-009`-gated admin queue (additive columns + new tables + service surface).

6. **HealthScoreWorker** (P2-21a) currently computes a placeholder weighted score; production needs real adoption + engagement + support + NPS data sources.

7. **Reputation decay** — current `reputation_points` is monotonic; pre-pilot may want a quarterly decay job so dormant top-rated users don't dominate the leaderboard.

8. **OPS-005 audit-only listing of platform-wide pricing changes** — pricing_history is per-band; a tenant-by-tenant materialised view of "current prices across the platform" would be a useful admin dashboard before pricing-team rollout.

---

## 12. WHAT TO VERIFY IN CODE REVIEW (per sub-cycle)

### P2-21a:

- 9 CRM tables in `20260512140000_add_p2c21a_crm/migration.sql`
- `AccountService.transitionStatus` lifecycle map matches the documented 6-value enum graph
- `OnboardingService.completeTask` auto-flips checklist + account inside one $transaction
- HealthScoreWorker is registered as a periodic worker (not Kafka consumer)
- `/api/v1/internal/crm/*` mounted with `@PlatformScoped()` decorator (no tenant header path)
- Web `/internal/crm` + `/internal/crm/[id]` ship

### P2-21b:

- 9 ops + pricing tables in `20260512150000_add_p2c21b_ops_pricing/migration.sql`
- `ops_tenant_access_grants` carries all 4 CHECK constraints (duration, justification, window, revoked)
- `TenantAccessService.grant` runs all 4 service-layer gates + emits `ops.tenant_access.granted`
- TenantAccessExpiryWorker is registered as a periodic worker (5-minute poll)
- `PricingService.updateBand` writes history row + band UPDATE in one $transaction
- 29 vitest cases for the ops surface
- `/api/v1/internal/{ops,tickets,pricing}/*` mounted with `@PlatformScoped()`

### P2-21c (this commit):

- 8 community tables in `20260512160000_add_p2c21c_community_exchange/migration.sql`
- **5% fee_split_chk** verified live + via 9 unit tests
- **Parent gate** verified live + via 6 unit tests
- tsvector GIN indexes on both `platform_marketplace_listings.search_keywords` and `platform_search_index.search_vector`
- `WatchListMatchConsumer` + `SearchIndexConsumer` register on `mkt.listing.published`
- Reputation log + denormalisation maintained inside $transaction
- `/api/v1/community/*` mounted with the regular guard chain (tenant-scoped, not @PlatformScoped)
- Parent IAM grant table: read-only on MKT-001 + 005, write on MKT-002 + 006 (no MKT-007)
- 4 web routes ship: `/community/marketplace`, `/community/marketplace/[id]`, `/community/profiles`, `/community/watch-lists`

---

## 13. SHIPPING STATE

- ✅ Schema migrations applied to local dev tenant
- ✅ Idempotent seed lands 4 profiles + 6 listings + 1 transaction + 2 condition reports + 1 watch list + 2 ratings + 5 reputation log entries + 4 search index rows
- ✅ Both API + web builds clean
- ✅ Prettier + lint:logs green (896 files)
- ✅ Vitest 1058/1058 across 56 spec files
- ✅ Live smoke verifies all 5 keystones on `tenant_demo`

**Awaiting:** REVIEW-P2C21 Round 1 verdict for the full P2-21 cycle (a + b + c). Tags after verdict: `p2c21-complete` (Round 1 fix commit) and `p2c21-approved` (Round 2 PASS commit).
