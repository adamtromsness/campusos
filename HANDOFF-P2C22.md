# HANDOFF — Phase 2 Cycle 22 (P2-22): Alumni

**Status:** COMPLETE pending peer review across both sub-cycles (2026-05-12).
P2-22a (schema + seed + services) shipped at `9ed0423`. P2-22b (UI + integration
tests + handoff/review docs) ships in this commit. **Wave D (Module Completion)
continues — P2-22 closes the M102 Alumni module.**

**Plan:** `docs/campusos-p2c22-alumni.html`
**Review scaffold:** `P2C22-REVIEW-NOTES.md`
**Dates:** 2026-05-12

## Cycle totals (across both sub-cycles)

| Surface                           | Count                              |
| --------------------------------- | ---------------------------------- |
| Tenant migrations                 | 3 (158 / 159 / 160)                |
| New tenant tables                 | 8 (`alm_*`)                        |
| Intra-tenant FKs                  | 6 (CASCADE × 5 + NO ACTION × 1)    |
| Cross-schema FKs                  | 0 (ADR-001/020)                    |
| Backend services                  | 8                                  |
| Controllers                       | 1 (`AlumniController`)             |
| Endpoints registered live on boot | 35                                 |
| Kafka emit topics                 | 2 (durable best-effort)            |
| Permission code                   | PUB-004 (already in catalogue)     |
| Web routes                        | 7                                  |
| React Query hooks                 | 32                                 |
| Integration tests                 | 27 (across 7 plan scenarios)       |
| Total vitest pass count           | 1108 / 1108 (across 58 spec files) |

## Sub-cycle layout

| Sub-cycle  | Surface                                   | Commit        |
| ---------- | ----------------------------------------- | ------------- |
| **P2-22a** | Schema + seed + 8 services + 1 controller | `9ed0423`     |
| **P2-22b** | UI (7 routes) + integration tests + docs  | _this commit_ |

## Schema

### `158_alm_profiles_tags.sql` (P2-22a Step 1)

- **`alm_alumni_profiles`** — one row per alumnus. `person_id` is the
  soft cross-schema ref to `platform.iam_person` per ADR-055 (same
  identity the alumnus held as a student); no FK constraint per
  ADR-001/020. `UNIQUE(school_id, person_id)` so the same person
  cannot register twice at the same school. RLS enforced at the
  service layer — alumni read + update only their own row.
  `is_opted_in BOOLEAN DEFAULT true` controls directory visibility;
  the owner + admin always see the row regardless. `graduation_year`
  range CHECK 1900–2100.
- **`alm_alumni_tags`** — segmentation rows. `UNIQUE(alumni_id, tag)`.
  Tags are free-text TEXT with a `length(trim(tag)) > 0` CHECK.
  Common values: `STEM_MENTOR`, `DONOR`, `INTERNATIONAL`,
  `BOARD_MEMBER`, `CAREER_SPEAKER`. GIN INDEX on
  `to_tsvector('simple', tag)` accelerates the segmentation query
  used by `CampaignService.addRecipientsByTag`.

### `159_alm_campaigns_donations.sql` (P2-22a Step 2)

- **`alm_campaigns`** — fundraising campaign header. 4-value
  `status` CHECK `DRAFT` / `ACTIVE` / `COMPLETED` / `CANCELLED`.
  `reporting_currency CHAR(3) NOT NULL DEFAULT 'USD'` constrained
  by a `~ '^[A-Z]{3}$'` regex CHECK. `goal_amount NUMERIC(10,2) >= 0`
  CHECK when set. `dates_chk` ensures `end_date >= start_date`
  when both populated. Partial INDEX on `(school_id, end_date)
WHERE status='ACTIVE'` powers the active-campaign hot path.
- **`alm_donations`** — multi-currency donation record. The schema
  stores BOTH the original `amount` + `currency` AND the converted
  `amount_in_reporting_currency` + `fx_rate_at_donation`. The
  Step 5 `DonationService` computes
  `amount_in_reporting_currency = amount × fx_rate` BEFORE INSERT;
  the schema enforces both are positive. Campaign totals
  `SUM(amount_in_reporting_currency)` cached in Redis
  `campaign:raised:{id}` TTL=5min, invalidated on every donate.
  CASCADE on `campaign_id` (donations follow campaign lifecycle);
  NO ACTION on `donor_alumni_id` (financial-audit guard — alumni
  with outstanding donations cannot be hard-deleted).
- **`alm_campaign_recipients`** — per-(campaign, alumni) outreach
  funnel. `UNIQUE(campaign_id, alumni_id)` so the same alumnus is
  not added twice; the bulk-add-by-tag idempotency uses
  `ON CONFLICT DO NOTHING` to skip duplicates. 6-value
  `outreach_status` CHECK `PENDING` / `SENT` / `OPENED` /
  `RESPONDED` / `DONATED` / `UNSUBSCRIBED`. Both FKs CASCADE.

### `160_alm_news_reunions_events.sql` (P2-22a Step 3)

- **`alm_alumni_news`** — alumni newsletter article. 4-value
  `category` CHECK `ACHIEVEMENT` / `EVENT` / `OPPORTUNITY` /
  `GENERAL`. `published_at NULL` = draft (staff-only visibility);
  `published_at NOT NULL` = published. Title + body non-empty
  CHECKs. Partial INDEX on `(school_id, published_at DESC) WHERE
published_at IS NOT NULL` for the chronological feed.
- **`alm_reunion_groups`** — class-year reunion organising row.
  4-value `status` CHECK `PLANNING` / `CONFIRMED` / `COMPLETED` /
  `CANCELLED`. `rsvp_deadline <= event_date` CHECK when both set.
  `organiser_id` real FK NO ACTION to `alm_alumni_profiles` —
  reunion record cannot dangle when the organiser leaves.
- **`alm_events`** — alumni event header.
  `evt_event_id UUID` is a **DISPLAY-ONLY soft reference to
  `evt_events(id)` — NO FK constraint by design**. The Alumni
  module compiles and runs regardless of whether the Events module
  is enabled for this tenant. The Step 6 `AlumniEventService`
  resolves at read time via a defensive `SELECT FROM evt_events`
  joined to `evt_ticket_tiers` and gracefully falls back to
  `ticketsAvailable: null` when the table is missing or the row
  doesn't exist. The Alumni UI falls back to `rsvp_url`.

### IAM grants (Step 4)

`PUB-004` was already in `permissions.json`. Distribution after
`seed-iam.ts` + `build-cache.ts`:

| Persona                       | PUB-004 tiers held                         |
| ----------------------------- | ------------------------------------------ |
| Teacher                       | read                                       |
| Parent                        | read                                       |
| Student                       | read + write                               |
| Staff                         | read + write                               |
| School Admin / Platform Admin | read + write + admin (via `everyFunction`) |

Effective access cache (live verification):

- `admin@demo.campusos.dev` → `pub-004:read+write+admin`
- `principal@demo.campusos.dev` → `pub-004:read+write+admin`
- `vp@demo.campusos.dev` → `pub-004:read+write`
- `counsellor@demo.campusos.dev` → `pub-004:read+write`
- `teacher@demo.campusos.dev` → `pub-004:read`
- `parent@demo.campusos.dev` → `pub-004:read`
- `student@demo.campusos.dev` → `pub-004:read+write`

**Service-layer access boundary.** Generic
`PUB-004:write` at the role tier is not sufficient for staff-only
mutation paths. Every campaign / news / event / reunion mutation
runs through `hasStaffScope(actor)` which short-circuits on
`actor.isSchoolAdmin`, then checks `PUB-004:admin` at the tenant
scope, then requires `personType === 'STAFF'` AND `PUB-004:write`.
A student with `PUB-004:write` is bound to own-profile + own-tag
surfaces by `resolveOwnAlumniId(actor)` row scope at the service
layer.

## Seed (P2-22a Step 4)

`seed-alumni.ts` (idempotent, gated on first `alm_alumni_profiles`
row for the demo school). Wired as `seed:alumni` in
`packages/database/package.json` and appended to the
`seed-all.ts` chain after `seed-community.ts`.

- 5 alumni profiles (Class of 2020): Alex Rivera (TechCorp,
  Software Engineer, STEM_MENTOR + DONOR), Priya Patel (Goldman
  Sachs, DONOR + BOARD_MEMBER), Hiroshi Tanaka (University of
  Tokyo, INTERNATIONAL + STEM_MENTOR), Sophia Martinez (Pixar,
  CAREER_SPEAKER + DONOR), David Okonkwo (opted out,
  INTERNATIONAL). Total tags: 9.
- 1 ACTIVE campaign "New Science Lab" $50K goal USD, created by
  Sarah Mitchell.
- 3 donations: $2K USD Alex, $1.5K USD Priya (anonymous),
  £500 GBP × 1.27 = $635 Hiroshi. **Total raised in
  reporting currency: $4,135**.
- 5 campaign recipients across funnel states: 1 SENT (David),
  1 OPENED (Sophia), 1 RESPONDED (Hiroshi), 2 DONATED (Alex +
  Priya — exercises both anonymous + named donor paths).
- 2 alumni news articles: 1 ACHIEVEMENT (Class of 2020 update)
  - 1 OPPORTUNITY (mentorship recruiting). Both published.
- 1 reunion group "Class of 2020 — 5-Year Reunion" PLANNING,
  Alex as organiser, event 2026-08-22, RSVP by 2026-08-01.
- 1 alumni event "Homecoming Weekend" 2026-10-15 with a
  synthetic `evt_event_id` (UUID
  `00000000-0000-0000-0000-000022000001`) demonstrating the
  graceful-fallback path — the seed plants the soft link; the
  UI exercises ticket resolution at read time.

## Backend (P2-22a Steps 5–6)

### `apps/api/src/alumni/` module structure

| File                   | Purpose                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `access.ts`            | Shared helpers — `hasStaffScope`, `resolveOwnAlumniId`, `loadCampaignOrFail`, `loadAlumniProfileOrFail`, `isUniqueViolation`. |
| `profile.service.ts`   | `AlumniProfileService` + `AlumniTagService`                                                                                   |
| `campaign.service.ts`  | `CampaignService` + `DonationService` + `OutreachService`                                                                     |
| `news.service.ts`      | `AlumniNewsService` + `ReunionGroupService` + `AlumniEventService`                                                            |
| `alumni.controller.ts` | `AlumniController` (35 routes)                                                                                                |
| `alumni.module.ts`     | Wires services + controller; imports `TenantModule`, `IamModule`, `KafkaModule`, `NotificationsModule` (for `RedisService`)   |
| `dto/alumni.dto.ts`    | All request + response DTOs (with class-validator decorators)                                                                 |

### Endpoint inventory (35 registered routes)

| Route                                 | Method | Permission      |
| ------------------------------------- | ------ | --------------- |
| `/alumni/profiles`                    | GET    | `pub-004:read`  |
| `/alumni/profiles/me`                 | GET    | `pub-004:read`  |
| `/alumni/profiles/by-tag/:tag`        | GET    | `pub-004:read`  |
| `/alumni/profiles/:id`                | GET    | `pub-004:read`  |
| `/alumni/profiles`                    | POST   | `pub-004:write` |
| `/alumni/profiles/:id`                | PATCH  | `pub-004:write` |
| `/alumni/tags`                        | POST   | `pub-004:write` |
| `/alumni/tags/:id`                    | DELETE | `pub-004:write` |
| `/alumni/campaigns`                   | GET    | `pub-004:read`  |
| `/alumni/campaigns/:id`               | GET    | `pub-004:read`  |
| `/alumni/campaigns`                   | POST   | `pub-004:write` |
| `/alumni/campaigns/:id`               | PATCH  | `pub-004:write` |
| `/alumni/campaigns/:id/activate`      | POST   | `pub-004:write` |
| `/alumni/campaigns/:id/raised`        | GET    | `pub-004:read`  |
| `/alumni/campaigns/:id/funnel`        | GET    | `pub-004:write` |
| `/alumni/campaigns/:id/recipients`    | POST   | `pub-004:write` |
| `/alumni/campaigns/:id/recipients`    | GET    | `pub-004:write` |
| `/alumni/campaigns/:id/send-outreach` | POST   | `pub-004:write` |
| `/alumni/campaign-recipients/:id`     | PATCH  | `pub-004:write` |
| `/alumni/campaigns/:id/donate`        | POST   | `pub-004:write` |
| `/alumni/campaigns/:id/donations`     | GET    | `pub-004:read`  |
| `/alumni/news`                        | GET    | `pub-004:read`  |
| `/alumni/news/:id`                    | GET    | `pub-004:read`  |
| `/alumni/news`                        | POST   | `pub-004:write` |
| `/alumni/news/:id`                    | PATCH  | `pub-004:write` |
| `/alumni/news/:id`                    | DELETE | `pub-004:write` |
| `/alumni/reunions`                    | GET    | `pub-004:read`  |
| `/alumni/reunions/:id`                | GET    | `pub-004:read`  |
| `/alumni/reunions`                    | POST   | `pub-004:write` |
| `/alumni/reunions/:id`                | PATCH  | `pub-004:write` |
| `/alumni/events`                      | GET    | `pub-004:read`  |
| `/alumni/events/:id`                  | GET    | `pub-004:read`  |
| `/alumni/events`                      | POST   | `pub-004:write` |
| `/alumni/events/:id`                  | PATCH  | `pub-004:write` |
| `/alumni/events/:id`                  | DELETE | `pub-004:write` |

### Kafka emits

1. **`alm.campaign.activated`** — fires in `CampaignService.activate`
   AFTER the `executeInTenantTransaction` callback returns. Payload:
   `{campaignId, schoolId, title, reportingCurrency, goalAmount,
activatedBy}`. The activate path itself runs the status flip
   `DRAFT → ACTIVE` + stamps `activated_at` inside one locked-row
   tx (`SELECT … FOR UPDATE`).
2. **`alm.donation.received`** — fires in `DonationService.donate`
   AFTER the tx commits. Payload: `{donationId, campaignId, schoolId,
donorAlumniId, amount, currency, fxRateAtDonation,
amountInReportingCurrency, isAnonymous, donatedAt}`. The donate
   path runs the INSERT + recipient flip `→ DONATED` + Redis cache
   invalidate inside one tx.

ADR-057 envelope shape verified live on `tenant_demo` 2026-05-12 —
both topics carry `event_type`, `source_module='alumni'`,
`event_version=1`, `tenant_id`, fresh UUIDv7 `event_id` +
`correlation_id`, plus the documented payload.

## UI (P2-22b Step 7)

### 7 web routes

| Route                           | Surface                                                                        | Build size |
| ------------------------------- | ------------------------------------------------------------------------------ | ---------- |
| `/alumni`                       | Portal: own profile editor + directory search                                  | 6.97 kB    |
| `/alumni/campaigns`             | Campaign list with filter chips + Create-DRAFT modal                           | 5.96 kB    |
| `/alumni/campaigns/[id]`        | Campaign detail: header card + funnel + recipients + donations + admin actions | 6.9 kB     |
| `/alumni/campaigns/[id]/donate` | Donation form with multi-currency + FX picker + anonymous toggle               | 4.0 kB     |
| `/alumni/news`                  | News feed with category chips + compose + edit                                 | 6.3 kB     |
| `/alumni/reunions`              | Reunion list with class-year filter + organiser-edit                           | 6.59 kB    |
| `/alumni/events`                | Event calendar with Buy-Tickets / RSVP fallback                                | 6.07 kB    |

### Launchpad tile

`AlumniModule` adds a single launchpad tile keyed `'alumni'` gated
on `pub-004:read` with `routePrefix: '/alumni'` so every nested
route keeps the tile lit. Icon: `AcademicCapIcon` (reused from
Admissions). Persona-aware description copy:

- Staff: "Campaigns, donations, news, reunions, events"
- Student: "Your alumni profile (after graduation) and directory"
- Guardian: "Alumni directory and school news"
- Default: "Directory, campaigns, news, events"

### Hooks (`apps/web/src/hooks/use-alumni.ts`)

32 React Query hooks: 8 profile/tag, 11 campaign/recipient/donation,
5 news, 4 reunion, 4 event. Every mutation invalidates the matching
list + per-id detail + raised + funnel + recipients query keys so
the dashboard auto-refreshes after a donate.

### Format helpers (`apps/web/src/lib/alumni-format.ts`)

Per-enum label + pill-class maps (`CAMPAIGN_STATUS_PILL`,
`OUTREACH_STATUS_PILL`, `ALUMNI_NEWS_CATEGORY_PILL`,
`REUNION_STATUS_PILL`); `COMMON_ALUMNI_TAGS` autocomplete seed;
`COMMON_CURRENCIES` list; `formatCurrency` via `Intl.NumberFormat`;
`formatCampaignProgress` (X% of goal); `formatDateOnly`;
`formatRelative` (just now / Nm ago / Nh ago / Nd ago).

## Integration test (P2-22b Step 8)

`apps/api/src/alumni/__tests__/alumni.spec.ts` — 27 vitest cases
covering all 7 plan scenarios:

1. **Profile + directory visibility (RLS).** Admin / staff see all;
   non-staff filter to opted-in OR own. Opted-out profile 404 to
   non-owner non-staff. Non-staff cannot create on behalf of
   another person.
2. **Tag segmentation.** Non-owner non-staff cannot tag another
   alumnus. Owner can self-tag. Duplicate tag → 409. `listByTag`
   SQL correctly joins through `alm_alumni_tags`.
3. **Campaign + multi-currency donation keystone.** Activate emits
   `alm.campaign.activated` + invalidates Redis. Donate USD
   computes `amount_in_reporting_currency = amount`. Donate GBP
   without `fxRateAtDonation` → 400. Donate GBP × 1.27 → $635
   reporting. Recipient row flips to `DONATED` in same tx. Kafka
   envelope verified.
4. **Anonymous donation visibility.** Admin sees donor name +
   payment refs; non-staff sees `"Anonymous"` with `donorAlumniId`,
   `paymentRef`, and `stripePaymentIntentId` all null. Amount and
   timestamp remain visible to everyone.
5. **Outreach funnel.** 6-value status grouping rolls up correctly.
   `sendOutreach` flips `PENDING → SENT` for all matching rows.
   `updateStatus` refuses backwards transitions and direct
   `DONATED` writes. Non-staff cannot send outreach.
6. **Events graceful fallback.** When `evt_events` table is missing
   (Events module not enabled), `ticketsAvailable` resolves to
   `null` and the `rsvp_url` is preserved for the UI fallback.
   When Events resolves, `ticketsAvailable` returns the live
   count. Non-staff cannot mutate events.
7. **Visibility matrix.** Non-staff campaign list filters to
   `ACTIVE` + `COMPLETED` only. Staff sees all statuses. Parent
   cannot read funnel. Non-staff news list excludes drafts.
   Reunion `CONFIRMED` requires `event_date`. Teacher (no
   `pub-004:write`) cannot create news.

## REVIEW-P2C22 Round 1 fix log

Round 1 of REVIEW-P2C22-CHATGPT (against the P2-22b closeout commit
`262d867`) returned **REJECT** with 6 BLOCKING items. All 6 fixes
landed in the Round 1 closeout commit + 9 new pinned regression
tests so the contracts cannot regress. The pre-existing alumni spec
file was retrofitted in place (helper `makeKafka()` rerouted to a
new `makeOutbox()` capturing `enqueueInTx(tx, opts)` calls; six
pre-existing fake-handler match patterns rewritten to recognise
the new school-scoped SQL shape; one `staff campaign list returns
all statuses` test split into two — one for `pub-004:admin` (sees
all) + one for `pub-004:write` (sees ACTIVE/COMPLETED only) — to
verify the B6 narrowing).

**BLOCKING fixes:**

1. **Outbox for `alm.campaign.activated` + `alm.donation.received`**
   — `CampaignService` + `DonationService` constructors flipped from
   `KafkaProducerService` to `OutboxService` (KafkaModule already
   exports both, so DI resolves automatically). `CampaignService.activate`
   now enqueues via `outbox.enqueueInTx(tx, …)` INSIDE the same
   `executeInTenantTransaction` callback as the DRAFT → ACTIVE flip.
   `DonationService.donate` enqueues inside the same tx as the donation
   INSERT + recipient flip. New `apps/api/src/alumni/event-ids.ts`
   exports `deterministicCampaignActivatedEventId(campaignId)` and
   `deterministicDonationReceivedEventId(donationId)` — both v5-shaped
   UUIDs via `sha256(<key>:<topic>:v1)` matching the helpers across
   Cycles 11 / 12 / P2-12 / P2-14 / P2-20 / P2-21. Outbox retries
   land the same envelope event_id so downstream consumers dedupe
   cleanly through the consumer-group idempotency claim.

2. **School-scoped access helpers** — `apps/api/src/alumni/access.ts`
   `resolveOwnAlumniId` / `loadAlumniProfileOrFail` /
   `loadCampaignOrFail` all bind to `school_id = $tenant.schoolId`.
   Cross-school UUIDs collapse to `NotFoundException` at the loader
   layer instead of being accepted by downstream services. Every
   service that previously routed through these helpers (campaign,
   donation, outreach, news, reunion, event, profile, tag) now
   inherits the school predicate for free.

3. **School-scoped campaign + recipient + outreach mutations** —
   `CampaignService.patch` UPDATE now carries `WHERE id=$ AND school_id=$`.
   `CampaignService.raised` SUM query JOINs through `alm_campaigns
c ON c.id = d.campaign_id WHERE c.school_id = $tenant.schoolId`.
   `CampaignService.funnel` SQL JOINs through `alm_campaigns` and
   uses `r.outreach_status` (table-aliased) so cross-school recipient
   counts cannot leak. `CampaignService.addRecipientsByTag` resolves
   `campaign.schoolId` from the school-scoped loader instead of a
   nested SELECT. `CampaignService.listRecipients` SQL JOINs through
   `alm_campaigns` with `c.school_id` predicate.
   `OutreachService.sendOutreach` rewrites the UPDATE to
   `UPDATE alm_campaign_recipients r SET … FROM alm_campaigns c WHERE
r.campaign_id = $1 AND c.id = r.campaign_id AND c.school_id = $2
AND r.outreach_status = 'PENDING' RETURNING r.id`.
   `OutreachService.updateStatus` FOR UPDATE lock now JOINs through
   `alm_campaigns c ON c.id = r.campaign_id WHERE r.id = $1 AND
c.school_id = $2 FOR UPDATE OF r`. `DonationService.donate`
   recipient flip UPDATE also JOINs through `alm_campaigns`.

4. **School-scoped news + reunion + event mutations** —
   `AlumniNewsService.patch` UPDATE adds `AND school_id = $N::uuid`.
   `AlumniNewsService.remove` DELETE adds `AND school_id = $2::uuid`
   and raises `NotFoundException` on zero-row result (collapses
   "not found" + "not yours" to don't-leak-existence).
   `ReunionGroupService.patch` UPDATE adds the same predicate.
   `AlumniEventService.patch` UPDATE + `AlumniEventService.remove`
   DELETE both add the school predicate. Same pattern applied for
   defence-in-depth on `AlumniProfileService.patch` and
   `AlumniTagService.removeTag` (the JOIN through `alm_alumni_profiles
WHERE school_id` was added too so the DELETE cannot land via a
   leaked cross-school tag UUID).

5. **School-scoped `evt_event_id` ticket enrichment** —
   `AlumniEventService.resolveTicketsAvailable` SQL adds
   `AND e.school_id = $2::uuid` and passes `tenant.schoolId` as `$2`.
   A stale `evt_event_id` pointing at a sister school's tickets
   cannot leak counts into the current school's alumni event card;
   the row resolves to `null` (treated as "no link") and the UI
   falls back to the `rsvp_url`. The graceful fallback for the
   Events-module-not-enabled case still works (try/catch swallow
   on `relation "evt_events" does not exist`).

6. **Module-wide admin authority requires `pub-004:admin`** —
   new `hasAdminScope(permCheck, actor)` in `apps/api/src/alumni/access.ts`
   returns `true` when `actor.isSchoolAdmin OR actor holds
pub-004:admin at the tenant scope`. Legacy `hasStaffScope` kept
   as a `@deprecated` alias delegating to the new helper so the
   transition is non-breaking. Every management surface across
   `CampaignService` / `DonationService` / `OutreachService` /
   `AlumniNewsService` / `ReunionGroupService` / `AlumniEventService`
   / `AlumniProfileService` / `AlumniTagService` now calls
   `hasAdminScope`. Generic STAFF + `pub-004:write` continues to
   manage their OWN profile + own tags via per-row owner checks at
   the service layer, but no longer inherits module-wide admin
   authority. The pre-existing `Scenario 7 — staff campaign list
returns all statuses` test was split into two: one for an
   admin (`pub-004:admin` holder — sees all statuses) and one for
   the B6 narrowing case (`pub-004:write` only — sees ACTIVE +
   COMPLETED only, same as a non-admin reader).

**Test coverage:** the existing 35 alumni vertical-slice integration
tests retrofitted to use `makeOutbox()` and the school-scoped SQL
patterns + **9 new pinned regression tests in the REVIEW-P2C22
ROUND 1 describe block** covering: deterministic event_id stability
for both topics (3 tests); school-scoped helper SQL shape (3 tests);
campaign + recipient JOIN through `alm_campaigns.school_id` (2 tests);
news + reunion + event UPDATE/DELETE school predicate (3 tests);
`evt_event_id` ticket enrichment school predicate (1 test); module-
wide admin authority distribution across STAFF with `pub-004:write`
vs STAFF with `pub-004:admin` (4 tests). Total alumni spec: **44
passing tests**. Full API vitest suite: **1125 passing across 58
spec files** (was 1116 before Round 1 fixes; +9 regression tests).

**CI parity green** at the Round 1 fix commit: `format:check` + `lint:logs`
(909 files clean) + API build clean + web build clean + vitest
1125/1125. No schema migrations in Round 1 — every fix is service-
layer + new `event-ids.ts` helper + module-wiring (DI auto-resolves
the new constructor signatures via the existing `KafkaModule`
exports).

Awaiting Round 2 verdict before tagging `p2c22-complete`. See
`P2C22-REVIEW-NOTES.md` for the per-blocker verification trail.

## Reviewer attention items

The following items are documented as carry-overs to Phase 2 / pre-
pilot rather than blocking the cycle. None affect the M102 surface
itself.

1. **Alumni-self tag removal UX.** The portal page can add tags but
   cannot remove them (the API DTO returns `tags: string[]` without
   row ids, so click-to-remove can't resolve the `:id` for the
   `DELETE /alumni/tags/:id` endpoint). Two fixes in scope for a
   future polish: (a) surface `tagRows: AlumniTagDto[]` on the
   profile DTO; or (b) add a `DELETE /alumni/profiles/:id/tags/:tag`
   path that takes the tag value directly. Today the alumni office
   removes tags on behalf of the alumnus via the admin tag-edit
   surface.
2. **Stripe wiring.** Donations record a `stripe_payment_intent_id`
   column but the actual Stripe SDK integration is stubbed —
   donations land as recorded inside the database transaction
   without a real charge. The pre-pilot Stripe wiring extends the
   `DonationService.donate` path to create a PaymentIntent + wait
   for the webhook + tighten the donation row to CHARGED on
   success.
3. **Tax-receipt generation.** Donations are recorded but the IRS
   tax-receipt PDF is not yet generated. A future endpoint
   `GET /alumni/donations/:id/tax-receipt.pdf` is intended to
   render the receipt from the `alm_donations` row + the school's
   501(c)(3) information stored in `school_config`.
4. **Recurring donation subscriptions.** The plan defers monthly
   recurring donations to a future cycle. The schema would need a
   new `alm_donation_subscriptions` table with `frequency` enum +
   `next_charge_at` cursor + a worker that emits a fresh
   `alm.donation.received` per period.
5. **Alumni mentorship matching.** Tag-based discovery is in scope
   for P2-22; a structured mentor-mentee request/accept workflow
   defers to P2-28 (Community .1 Bundle).
6. **Alumni job board.** A separate table set for alumni-posted
   jobs + applications defers to a later wave.
7. **Campaign reminder cron worker.** A scheduled job that finds
   PENDING recipients on campaigns older than N days and emits
   reminder outreach defers to Phase 2 polish.
8. **Alumni event RSVP storage.** Today alumni events provide an
   external `rsvp_url` OR a soft link to `evt_events` for ticketed
   events. Phase 2 may add an `alm_event_rsvps` table for
   non-ticketed events whose RSVP coordination should live in the
   Alumni module rather than an external Google Form.
9. **Cross-school alumni view.** The directory is currently
   school-scoped via `school_id`. A future cross-school alumni
   network (e.g. for a multi-campus organisation) would aggregate
   profiles across tenants via a platform-scoped read; out of
   scope for P2-22.

## CI parity

- `pnpm format:check` ✓
- API build (`pnpm --filter @campusos/api build`) ✓
- Web build (`pnpm --filter @campusos/web build`) ✓ — 7 alumni
  routes ship (sizes above).
- `pnpm lint:logs` ✓ (909 files clean)
- `pnpm --filter @campusos/api test` ✓ — **1108 / 1108 across 58
  spec files** (+27 new alumni tests)

## Cross-cycle integration

- **ADR-055 identity.** `alm_alumni_profiles.person_id` links to
  `platform.iam_person`. The Cycle 7 graduation audit COMPLETED
  signal is the planned trigger for the school to invite a student
  to register as an alumnus — once the audit closes, the school
  admin sends an invitation that creates an `alm_alumni_profiles`
  row with the same `person_id` as the student's
  `platform_students.person_id`. Identity continuity preserves
  Cycle 24 portfolio, Cycle 9 behaviour history, and Cycle 11
  counselling notes from the student years (though those are
  intentionally not exposed on the alumni directory — they remain
  staff-only or self-only depending on the source module's RLS).
- **Cycle 6 Stripe Payments.** Donations carry
  `stripe_payment_intent_id`. The wiring (PaymentIntent creation,
  webhook handling, idempotency) is stubbed for the cycle and
  documented as Phase 2 pre-pilot.
- **Cycle 14 Communications.** `OutreachService.sendOutreach`
  flips `PENDING → SENT` and is the integration point for a future
  Communications-module consumer that watches for the funnel-flip
  event and dispatches templated email via the school's preferred
  delivery provider.
- **P2-12 Events.** `alm_events.evt_event_id` is the soft link.
  The Alumni module compiles and runs whether or not the Events
  module is enabled. The graceful-fallback verification test in
  the integration spec asserts the contract under both
  table-missing and table-present conditions.

## Next steps

Awaiting peer review verdict. Once `cycle22-complete` is tagged at
the closeout commit + the review returns PASS, `cycle22-approved`
gets tagged.

## Decisions made during the cycle

- **`current_role` → `current_title`.** PostgreSQL reserves the
  identifier `current_role` (it is a function). Unquoted DDL fails.
  Renamed to `current_title` (LinkedIn-aligned naming). This is the
  only deviation from the plan-text column names; documented in the
  P2-22a commit body.
- **Migration numbers.** The plan called out migrations 146 / 147 /
  148, but those slots were taken by P2-15 read-model migrations
  (`rpt_operations_readmodels` / `rpt_engagement_readmodels` /
  `rpt_event_contributions`). P2-22 uses 158 / 159 / 160 — the next
  available slots after the P2-20 IT Advanced migrations (156 +
  157).
- **`evt_event_id` no-FK contract.** Documented in the migration
  body and the service-layer comment: "DISPLAY-ONLY soft reference
  to evt_events(id). No FK constraint per the P2-22 plan — the
  Alumni module is independent of the Events module. Service layer
  enriches the response with ticket data when the Events API
  responds, and falls back to rsvp_url otherwise."
- **Reporting-currency vs donation-currency.** The schema stores
  both `amount + currency` (the donor's view) AND `fx_rate_at_donation
  - amount_in_reporting_currency` (the campaign's view). FX rate is
    null when currency matches reporting_currency (rate is implicitly
    1.0). Campaign totals sum the reporting-currency column. Redis
    cache key includes the campaign id; the reporting currency is
    fixed per-campaign at create time and cannot change.
- **Permission code reuse vs new code.** `PUB-004` was already in
  `permissions.json` from earlier waves. Reusing it keeps the
  catalogue stable at 495 codes. The plan-text grant model
  ("PUB-004:read to Alumni, PUB-004:write to Alumni") maps cleanly
  to the existing CampusOS role model — Alumni is a `personType`
  (`ALUMNI` enum value), not a Role, so the same role-level grants
  apply across personas with row scope at the service layer
  enforcing the boundary.
