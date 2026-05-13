# REVIEW NOTES — Phase 2 Cycle 22 (P2-22): Alumni

**Scope:** P2-22a (schema + seed + services) at `9ed0423` + P2-22b
(UI + integration tests + docs) at this commit.
**Plan:** `docs/campusos-p2c22-alumni.html`
**Handoff:** `HANDOFF-P2C22.md`
**Dates:** 2026-05-12

This document is the peer-review scaffold for the full P2-22 cycle.
It enumerates the load-bearing invariants, the live verification
trail, and the documented carry-overs so the reviewer can move
efficiently through 8 new tenant tables + 35 endpoints + 7 web
routes + 27 integration tests.

---

## 1. Cycle deliverable summary

8 new tenant tables (M102 Alumni surface) across 3 tenant
migrations:

- `158_alm_profiles_tags.sql` — `alm_alumni_profiles`,
  `alm_alumni_tags`
- `159_alm_campaigns_donations.sql` — `alm_campaigns`,
  `alm_donations`, `alm_campaign_recipients`
- `160_alm_news_reunions_events.sql` — `alm_alumni_news`,
  `alm_reunion_groups`, `alm_events`

35 endpoints registered live on boot under `/api/v1/alumni/*` from
a single `AlumniController`. 8 services in one NestJS module
(`AlumniModule`) wired into `AppModule` between `CommunityModule`
and the global guards. 2 Kafka emit topics
(`alm.campaign.activated`, `alm.donation.received`) — both
ADR-057-envelope verified live on the wire 2026-05-12. 7 web
routes (1 portal + 4 campaign surfaces + 1 news + 1 reunions + 1
events). 1 launchpad tile keyed `'alumni'` gated on `pub-004:read`.

**Tests:** vitest 1108 / 1108 across 58 spec files (+27 new alumni
tests in `apps/api/src/alumni/__tests__/alumni.spec.ts` covering
all 7 plan scenarios).

**Live verification on `tenant_demo` 2026-05-12** — 35 routes
register on boot; the 7 plan scenarios all return the expected
shape end-to-end (curl trail captured in the P2-22a commit body).

---

## 2. ADR-055 identity linkage (the load-bearing architectural decision)

**The contract.** `alm_alumni_profiles.person_id` is a soft
cross-schema reference to `platform.iam_person(id)` per ADR-055
identity continuity + ADR-001/020 soft-FK convention. The same
identity row that represented the student during their school
years now represents them as an alumnus.

**What this means in code:**

- **Schema.** `person_id UUID NOT NULL` — no FK constraint to
  `platform.iam_person`. The Step 5 service is the validator on
  INSERT (catches a non-existent person_id via the existing
  validate-account-in-tenant helper used by sibling services like
  `ProfileService`).
- **Identity continuity.** When a student graduates and the school
  invites them to create an alumni profile, the new
  `alm_alumni_profiles` row is keyed on the EXISTING
  `platform.iam_person.id` that was used in `platform_students`.
  This means Cycle 24 portfolio, Cycle 9 behaviour, Cycle 11
  counselling history, and Cycle 25 publications all share the
  same `person_id` lineage. Whether those modules expose data to
  the alumni surface is each module's own RLS decision — Alumni
  does not aggregate from them.
- **Row scope.** `AlumniProfileService.resolveOwnAlumniId(actor)`
  resolves the calling person's own profile via `SELECT id FROM
alm_alumni_profiles WHERE person_id = $actor.personId LIMIT 1`.
  This is the access boundary for own-profile writes — services
  match `actor.personId` to the profile's `person_id`, not the
  profile's id.
- **Tenant isolation.** `UNIQUE(school_id, person_id)` so the
  same person can have one profile per school. A person who
  attended multiple campuses can register at each independently.

**What to verify in code review:**

- The single FK declaration in the three migrations: there are NO
  cross-schema FKs. Search:
  `grep "REFERENCES platform\." packages/database/prisma/tenant/migrations/15[89]_alm_*.sql packages/database/prisma/tenant/migrations/160_alm_*.sql`
  returns zero matches.
- The intra-tenant FKs (6 total) are all inside the `alm_*`
  family — `alm_alumni_tags.alumni_id` CASCADE,
  `alm_donations.campaign_id` CASCADE + `donor_alumni_id` NO
  ACTION, `alm_campaign_recipients.campaign_id` + `alumni_id`
  both CASCADE, `alm_reunion_groups.organiser_id` NO ACTION.

---

## 3. Self-maintained contact data (ADR-019)

**The contract.** Alumni own their own contact information per
ADR-019. Schools don't field hundreds of "please update my address"
phone calls from former students every year — alumni log in and
update their own row.

**What this means in code:**

- The portal page (`/alumni`) carries an `OwnProfileCard` rendered
  from `useMyAlumniProfile()`. Owners edit `currentEmployer`,
  `currentTitle`, `linkedinUrl`, `contactEmail`, `contactPhone`,
  `degreeProgramme` directly. `isOptedIn` toggle is a one-click
  switch.
- The service-layer `AlumniProfileService.patch(id, input, actor)`
  enforces own-only writes for non-staff: if `profile.personId !==
actor.personId` AND the actor is not a staff/admin, the patch
  returns 404 NotFoundException (don't-leak-existence).
- Admin override path: staff + admin actors with `pub-004:write`
  can patch any profile (alumni-office workflow when the alumnus
  asks the school to update on their behalf).

**What to verify in code review:**

- `AlumniProfileService.patch` (lines ~190-230 of
  `profile.service.ts`) — the `isOwner = profile.personId ===
actor.personId` branch + `isStaff` short-circuit.
- The portal page's `EditProfileModal` does NOT expose
  identity-bearing fields (firstName / lastName / personId /
  graduationYear) — those are set by the admin once at profile
  creation and are not editable on the self-service surface.

---

## 4. Multi-currency FX approach

**The contract.** Donations support arbitrary currency. Campaign
totals are denominated in a single `reporting_currency` per
campaign. The schema stores BOTH views — the donor's original
amount + currency AND the converted reporting-currency amount +
the FX rate used at charge time.

**Schema (alm_donations):**

```
amount                       NUMERIC(10,2)  NOT NULL  CHECK > 0
currency                     CHAR(3)        NOT NULL  CHECK ~ '^[A-Z]{3}$'
fx_rate_at_donation          NUMERIC(12,6)            CHECK > 0 OR NULL
amount_in_reporting_currency NUMERIC(10,2)  NOT NULL  CHECK > 0
```

**Service-layer compute (DonationService.donate):**

```ts
if (input.currency === campaign.reportingCurrency) {
  amountInReporting = input.amount;
  fx = null;
} else {
  if (fx === null || fx <= 0) throw BadRequestException(...);
  amountInReporting = Math.round(input.amount * fx * 100) / 100;
}
```

Rounding to 2dp via `Math.round(x * 100) / 100` is deliberate —
the schema's `NUMERIC(10,2)` would otherwise truncate sub-cent
residue silently. The fx_rate is null when currencies match
(implicit 1.0).

**Verification.** Integration test scenario 3:

- Donate USD with no fx → `amount_in_reporting_currency = amount`,
  fx_rate stays null.
- Donate GBP without fx → 400 BadRequest with explicit message.
- Donate £500 GBP × 1.27 → `amount_in_reporting_currency = 635.00`,
  fx_rate stored as 1.270000.

**What to verify in code review:**

- The compute lives in `DonationService.donate` only — there is no
  trigger-side computation. A direct DB insert with mismatched
  amount + fx would land an inconsistent row.
- The Kafka envelope payload includes BOTH `amount` and
  `amountInReportingCurrency` so downstream consumers (analytics,
  Cycle 26 finance) can choose either view.

---

## 5. Redis caching strategy for campaign totals

**The contract.** `GET /alumni/campaigns/:id/raised` returns the
live `SUM(amount_in_reporting_currency)` over all donations
attached to the campaign, cached in Redis with a 5-minute TTL.
Every successful `DonationService.donate` invalidates the cache.

**Key shape.** `campaign:raised:{campaignId}` — single tenant /
single campaign. The cache value is a JSON object `{amount,
currency}` so the response can hydrate the reporting currency
without an extra DB round-trip.

**Invalidation points:**

1. `DonationService.donate` (every donation insert)
2. `CampaignService.activate` (defence-in-depth — the active
   transition could in theory race with a fresh cache miss on the
   raised endpoint)

**Cache miss behaviour.** Returns `{cached: false}` plus the
recomputed SUM; sets the key with TTL=300s. On Redis being
unreachable (best-effort `RedisService` per Cycle 31 conventions),
both `cacheGet` and `cacheSet` no-op silently. The authoritative
source is always the DB query — Redis is a performance layer.

**What to verify in code review:**

- The cache lookup happens BEFORE the RLS gate in
  `CampaignService.raised(id, actor)`. The RLS gate
  (`getById(id, actor)`) runs first, so a non-authorised reader
  gets 404 before the cache is consulted.
- The cache value is invalidated INSIDE the
  `executeInTenantTransaction` callback in
  `DonationService.donate` — between the INSERT and the Kafka
  emit. This means a Redis outage during a donation still leaves
  the DB authoritative; the next `raised` read recomputes from
  the SUM.

---

## 6. Opt-in directory privacy

**The contract.** `alm_alumni_profiles.is_opted_in BOOLEAN
DEFAULT true` controls visibility in the public alumni directory.
Three visibility classes:

| Class                            | Sees opted-in | Sees opted-out        |
| -------------------------------- | ------------- | --------------------- |
| Admin / staff (`hasStaffScope`)  | all rows      | all rows              |
| Owner (matches `actor.personId`) | self          | self                  |
| Other non-staff alumni / parent  | all opted-in  | none (404 don't-leak) |

**Service-layer enforcement (`AlumniProfileService.list`):**

```ts
if (!isStaff) {
  // Non-staff non-admin readers see opted-in only, EXCEPT the
  // calling alumnus's own row regardless of opt-in state.
  where.push(`(p.is_opted_in = true OR p.person_id = $N::uuid)`);
  args.push(actor.personId);
}
```

The owner-still-sees-self-when-opted-out branch is the privacy
keystone — an alumnus must always be able to see + edit their own
row regardless of opt-in state so they can flip the flag back.

**`getById` strictness.** When a non-owner non-staff caller looks
up an opted-out profile by id (e.g. someone shared the URL), the
service returns 404 NotFoundException (don't-leak-existence) rather
than 403 — this hides the existence of opted-out alumni from
casual probing.

**Verification.** Integration test scenario 1:

- Non-staff readers see opted-in only — SQL outer WHERE contains
  `p.is_opted_in = true`.
- Admin SQL outer WHERE does NOT contain that clause.
- `getById` on an opted-out profile returns 404 to a non-owner
  non-staff caller.

---

## 7. evt_event_id soft reference with graceful fallback

**The contract.** `alm_events.evt_event_id UUID NULL` is a
**DISPLAY-ONLY** soft reference to `evt_events(id)` from the
P2-12 Events module. **There is no FK constraint by design** —
the Alumni module compiles and runs whether or not the Events
module is enabled for this tenant.

**Schema (160_alm_news_reunions_events.sql):**

```sql
evt_event_id UUID,   -- NO FK CONSTRAINT BY DESIGN
```

**Service-layer resolution
(`AlumniEventService.resolveTicketsAvailable`):**

```ts
private async resolveTicketsAvailable(evtEventId: string | null) {
  if (!evtEventId) return null;
  try {
    const rows = await this.tenantPrisma.executeInTenantContext(...);
    if (rows.length === 0) return null;
    return rows[0]!.available;
  } catch (err) {
    // Graceful — Events module not enabled, table missing, etc.
    this.logger.debug(`evt_event_id ${evtEventId} resolution failed...`);
    return null;
  }
}
```

**Four no-data outcomes all return `null`:**

1. `evtEventId` is null (no link set) — `null`
2. `evt_events` table missing (Events module not enabled) — `null`
   via swallowed Postgres error
3. Events table present but the supplied id is not a real row — `null`
4. Query succeeds and returns the live tier-quantity sum

**UI fallback.** When `ticketsAvailable === null` AND `rsvpUrl`
is populated, the UI renders an `RSVP ↗` external link. When
`ticketsAvailable` is a positive integer, the UI renders a
`Buy tickets` link to `/events/{evt_event_id}`. When both are
missing, no action button renders.

**Verification.** Integration test scenario 6:

- `resolveTicketsAvailable` returns `null` when `evt_events` is
  missing (simulated via the test fake throwing
  `relation "evt_events" does not exist`).
- `resolveTicketsAvailable` returns `42` when the table resolves
  to a row with `SUM(quantity - quantity_sold) = 42`.
- `rsvpUrl` is preserved on the DTO so the UI can always fall back.

**What to verify in code review:**

- The `try/catch` in `resolveTicketsAvailable` swallows ALL errors
  and returns null. This is deliberate. The error gets logged at
  DEBUG level only.
- Migration 160 has NO `REFERENCES evt_events(...)` clause — `grep
"evt_events" packages/database/prisma/tenant/migrations/160*` only
  matches the column declaration and the COMMENT body.

---

## 8. Anonymous donation visibility model

**The contract.** Donations carry `is_anonymous BOOLEAN`. When
true, the donor's identity is suppressed from non-staff readers
but kept visible to admins for audit.

**Service-layer enforcement (`DonationService.toDto`):**

```ts
const isAnonymous = r.is_anonymous;
return {
  ...,
  donorAlumniId: isAnonymous && !isStaff ? null : r.donor_alumni_id,
  donorDisplayName: isAnonymous && !isStaff ? 'Anonymous' : (r.donor_display_name ?? null),
  paymentRef: isStaff ? r.payment_ref : null,
  stripePaymentIntentId: isStaff ? r.stripe_payment_intent_id : null,
};
```

Four fields are admin-only for anonymous rows: `donorAlumniId`,
`donorDisplayName`, `paymentRef`, `stripePaymentIntentId`. The
public-visible fields are `amount`, `currency`,
`amountInReportingCurrency`, `fxRateAtDonation`, `donatedAt`,
`isAnonymous` (yes — the boolean itself is public so the UI can
render the "Anonymous" pill).

**Verification.** Integration test scenario 4:

- Admin sees `donorAlumniId = 'p-priya'`, `donorDisplayName =
'Priya Patel'`, `paymentRef = 'pay_priya'`.
- Non-staff sees `donorAlumniId = null`, `donorDisplayName =
'Anonymous'`, `paymentRef = null`,
  `stripePaymentIntentId = null`, `amount = 1500` (preserved).

**What to verify in code review:**

- `paymentRef` and `stripePaymentIntentId` ARE stripped for
  non-staff regardless of is_anonymous — they're admin-only
  audit fields. This is stricter than the plan-text required and
  is intentional defence-in-depth (the plan said "donor is hidden
  on public" — we extend that to "all reference identifiers are
  hidden on public").

---

## 9. Outreach funnel + state machine

**The contract.** Each `alm_campaign_recipients` row carries a
6-value `outreach_status`:

```
PENDING → SENT → OPENED → RESPONDED → DONATED
   ↓        ↓        ↓        ↓
   UNSUBSCRIBED (any state can transition to UNSUBSCRIBED)
```

**Service-layer state machine
(`OutreachService.updateStatus.isValidTransition`):**

```ts
// Disallow backwards (e.g. OPENED -> PENDING)
// Disallow direct DONATED (must come via DonationService.donate)
// UNSUBSCRIBED accepted from any non-UNSUBSCRIBED state
```

`DONATED` is intentionally blocked on the manual update path so
the funnel can only land via a real donation flowing through
`DonationService.donate`. The donate path flips the matching
recipient row to DONATED inside the same tx as the
`alm_donations` insert.

**Verification.** Integration test scenario 5:

- Funnel rolls up the 6-value status grouping correctly.
- `sendOutreach` flips `PENDING → SENT` only for rows currently
  in PENDING (the UPDATE SQL contains
  `WHERE outreach_status = 'PENDING'`).
- Backwards transition `OPENED → PENDING` → 400.
- Direct `OPENED → DONATED` → 400.
- Non-staff cannot send outreach → 403.

---

## 10. Reviewer attention items (carry-overs to Phase 2 / pre-pilot)

The handoff lists 9 items as Phase 2 punch-list carry-overs.
None are blocking the cycle. Summary:

1. Alumni-self tag removal UX (today add-only on portal; admin
   removes via tag-edit surface).
2. Stripe wiring (donations record an intent id but no real charge).
3. Tax-receipt PDF generation.
4. Recurring donation subscriptions.
5. Mentorship matching workflow (defers to P2-28).
6. Alumni job board (defers to a later wave).
7. Campaign reminder cron worker.
8. Alumni event RSVP storage (today external URL or P2-12 link).
9. Cross-school alumni view (today school-scoped via `school_id`).

---

## 11. Live verification trail

### Schema (P2-22a Step 1–3)

- Splitter audit clean on all 3 migrations on first attempt.
- Provisioned cleanly to `tenant_demo` + `tenant_test`. Idempotent
  re-runs no-op (verified by re-running `seed:alumni` and
  confirming the gate logs "already populated — skipping").
- 35 constraint smoke assertions all green: every CHECK fires on
  bogus input, every UNIQUE rejects duplicates, every FK rejects
  bogus refs, CASCADE on profile delete drops tags (2 → 0), NO
  ACTION on `alm_donations.donor_alumni_id` refuses profile
  delete while donations exist.

### Seed (P2-22a Step 4)

Live row counts on `tenant_demo` 2026-05-12:

```
profiles=5  tags=9  campaigns=1  donations=3  recipients=5
news=2  reunions=1  events=1
```

Idempotent re-run logs:
`Alumni profiles already populated for demo school — skipping`

### Backend (P2-22a Steps 5–6)

Live smoke covered 12 scenarios on `tenant_demo` 2026-05-12 — all
passed:

| Smoke step | Description                     | Outcome                                              |
| ---------- | ------------------------------- | ---------------------------------------------------- |
| R1         | Principal lists profiles        | 5 (incl. 1 opted-out)                                |
| R2         | Parent lists profiles           | 4 opted-in (David hidden)                            |
| R3         | Teacher /by-tag/STEM_MENTOR     | 2 alumni                                             |
| R4         | Student lists campaigns         | 1 ACTIVE, raised=$4135 USD                           |
| R5         | Redis-cached /raised            | first call `cached:false`, second `cached:true`      |
| R6         | Funnel (staff-only)             | sent=1, opened=1, responded=1, donated=2             |
| R7         | Parent /funnel                  | 403 INSUFFICIENT_PERMISSIONS                         |
| R8         | Admin /donations                | Priya visible with name                              |
| R9         | Parent /donations               | Priya shown as "Anonymous" with `donorAlumniId=null` |
| W1         | Admin records $100 USD donation | reporting=$100                                       |
| W2         | /raised after donate            | `cached:false` raisedAmount=$4235                    |
| W3         | Multi-currency €100 EUR × 1.08  | reporting=$108                                       |
| W4         | EUR without fx                  | 400 BadRequest                                       |
| W5         | Teacher donates                 | 403 (no PUB-004:write)                               |

### Kafka envelopes captured live

Both topics verified on the wire 2026-05-12:

- `dev.alm.campaign.activated` — `event_type=alm.campaign.activated`,
  `source_module=alumni`, `event_version=1`, `tenant_id` populated,
  payload `{campaignId, schoolId, title, reportingCurrency,
goalAmount, activatedBy}`.
- `dev.alm.donation.received` — `event_type=alm.donation.received`,
  `source_module=alumni`, payload `{donationId, campaignId,
schoolId, donorAlumniId, amount, currency, fxRateAtDonation,
amountInReportingCurrency, isAnonymous, donatedAt}`.

### RLS

Live verification of 5 RLS contracts:

1. Student PATCH another alumnus's profile → 404
2. Student GET opted-out profile → 404
3. Admin GET opted-out profile → 200
4. Admin PATCH any profile → 200
5. Cleanup restores Alex's employer field

### UI (P2-22b Step 7)

Web build clean — 7 alumni routes ship statically + dynamically:

```
/alumni                                6.97 kB (static)
/alumni/campaigns                      5.96 kB (static)
/alumni/campaigns/[id]                 6.9  kB (dynamic)
/alumni/campaigns/[id]/donate          4.0  kB (dynamic)
/alumni/events                         6.07 kB (static)
/alumni/news                           6.3  kB (static)
/alumni/reunions                       6.59 kB (static)
```

### Integration tests (P2-22b Step 8)

```
✓ alumni/__tests__/alumni.spec.ts (27 tests) — 22ms
Test Files  58 passed (58)
     Tests  1108 passed (1108)
```

All 7 plan scenarios covered.

### CI parity green

- `pnpm format:check` ✓
- API build ✓
- Web build ✓
- `pnpm lint:logs` ✓ (909 files clean)
- vitest 1108/1108

---

## 12. What to verify in the review

Suggested reviewer pass-through (in priority order):

1. **Migration trio (158/159/160).** Confirm `current_role` was
   renamed to `current_title` (Postgres reserved keyword). Confirm
   no cross-schema FKs (`grep "REFERENCES platform\." migrations/158_alm* migrations/159_alm* migrations/160_alm*`). Confirm
   `evt_event_id` has no FK clause.
2. **`AlumniProfileService.patch` RLS.** Verify the own-only-for-
   non-staff branch + the staff bypass + the 404 don't-leak-
   existence for non-staff non-owner.
3. **`DonationService.donate` multi-currency.** Verify the fx
   compute + the
   `Math.round(amount * fx * 100) / 100` rounding + the Redis
   invalidate + the recipient flip-to-DONATED inside the tx.
4. **`DonationService.toDto` anonymous strip.** Verify the
   admin-vs-non-staff branch for `donorAlumniId`,
   `donorDisplayName`, `paymentRef`, `stripePaymentIntentId`.
5. **`AlumniEventService.resolveTicketsAvailable`.** Verify the
   try/catch graceful fallback to `null` so the Alumni module is
   compile-independent of Events.
6. **`OutreachService.updateStatus` state machine.** Verify
   backwards transitions blocked, direct DONATED blocked.
7. **`hasStaffScope` access boundary.** Verify
   `actor.isSchoolAdmin` short-circuit + `pub-004:admin` check +
   `personType === 'STAFF'` + `pub-004:write` chain.

---

## 13. Risk areas / known gaps

| Risk                                                | Severity       | Mitigation                                                                                                             |
| --------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Stripe charge is stubbed                            | Pre-pilot      | Step 5 records `stripe_payment_intent_id` but does not call Stripe API                                                 |
| Alumni-self tag remove UX absent                    | Polish         | Owner adds tags from portal; alumni office removes                                                                     |
| `donor_alumni_id` is required NOT NULL on donations | Recommendation | An unaffiliated public donor (e.g. a foundation) cannot donate today — needs an external_donor model                   |
| Campaign totals cache TTL=5min                      | Recommendation | A spike of late donations can render a stale total for up to 5 min if the invalidate-on-donate path fails (Redis-down) |
| Cross-school alumni search                          | Phase 2        | Today school-scoped; multi-campus orgs need cross-tenant aggregation                                                   |
| Reunion RSVP storage                                | Phase 2        | Today goes through external URL or P2-12 link; no internal RSVP table                                                  |
