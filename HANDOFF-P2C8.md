# HANDOFF — Phase 2 Cycle 8 (P2-8): Athletics Advanced

**Plan:** `docs/campusos-p2c8-athletics-advanced.html` (M66 Athletics .1).
**Status:** P2-8a COMPLETE + APPROVED at `62ba7aa` (Round 1 separate). P2-8b COMPLETE pending peer review.
**Sub-cycle structure:** 18 ERD tables split across 2 independently shippable sub-cycles.

| Sub-cycle | Scope                              | Tables                | Endpoints | Migrations           | Commit    |
| --------- | ---------------------------------- | --------------------- | --------- | -------------------- | --------- |
| **P2-8a** | Equipment + Conferences + Media    | 9 tenant              | ~20       | `130_*.sql`          | `62ba7aa` |
| **P2-8b** | Streaming + Officials + Recruiting | 7 tenant + 2 platform | ~22       | `131_*.sql` + Prisma | _this_    |

**Wave B (Pilot Enhancement) — last full cycle of the wave per the roadmap.** Cross-module dependencies on Cycle 13 ath\_\* core (programmes, seasons, rosters, games — already in repo), Cycle 24 pfl_portfolio_items (highlight clip → portfolio link), Cycle 6 pay_invoices (replacement charge link from P2-8a), and Cycle 29 rpt_student_academic_summary (recruiting profile GPA snapshot).

---

## P2-8a — Equipment + Conferences + Media (already approved)

`Migration 130_ath_equipment_conferences.sql` ships 9 tenant tables:

- `ath_equipment` — Inventory item per (school, programme). 6-value `item_type` CHECK + 5-value `condition` CHECK + non-negative quantity + non-negative `unit_cost`. INDEX(school_id, programme_id) for the equipment manager list view.
- `ath_equipment_checkouts` — Per-(equipment, person) checkout audit. **Multi-column `returned_chk` lockstep** keeps `returned_at` and `condition_at_return` populated together. 3-value `condition_at_return` CHECK GOOD/DAMAGED/LOST. Partial INDEX on `(assigned_to_person_id, returned_at) WHERE returned_at IS NULL` for the active-checkouts hot path. Partial INDEX on `expected_return_date` filters the overdue dashboard.
- `ath_safety_equipment` — Per-(roster_member, equipment_type) safety compliance. UNIQUE keystone caps each member at one row per safety equipment type. 6-value equipment_type CHECK. `meets_safety_standard` + `certification_expiry` + `recall_status` drive the per-roster checklist UI green/amber/rose state.
- `ath_conferences` — Platform-level conference catalogue. UNIQUE(name, sport).
- `ath_conference_memberships` — Per-(conference, school, programme) membership. UNIQUE on the triple.
- `ath_conference_schedules` — Per-(conference, season) cross-school game slot. INDEX(conference_id, scheduled_date) drives the season schedule grid view.
- `ath_team_photos` — Per-(roster) team photo. 3-value photo_type CHECK. CASCADE on parent roster.
- `ath_media_assets` — Per-(school, programme) media asset catalogue. 4-value asset_type CHECK PHOTO/VIDEO/DOCUMENT/LOGO.
- `ath_equipment_maintenance` — Per-equipment maintenance log. 4-value maintenance_type CHECK CLEANING/REPAIR/INSPECTION/RECONDITIONING.

**Step 2 — `apps/api/src/athletics/`:** EquipmentService + EquipmentController + SafetyEquipmentService + SafetyEquipmentController + ConferenceService + ConferenceController + TeamMediaService + TeamMediaController. ~20 endpoints under `ath-001..004`. **Damaged or lost equipment returns emit `ath.equipment.replacement_charge`** so the Cycle 6 family billing engine raises an invoice with the equipment unit cost defaulted as the charge.

**Web routes:** `/athletics/equipment`, `/athletics/safety`, `/athletics/conferences`, `/athletics/media`.

**Tests:** 17 keystone unit tests in `athletics-advanced.spec.ts` covering AD-scope gate + DAMAGED/LOST emit shape + UNIQUE catch + roster validation + cross-school ownership refusal.

**Status:** Tagged `p2c8a-complete` (informally on `62ba7aa`). Closed Round 1 of REVIEW-P2-8a separately.

---

## P2-8b — Streaming + Officials + Recruiting (this commit)

### Schema — 7 tenant tables (migration 131) + 2 platform tables (Prisma)

**Tenant `131_ath_streaming_officials.sql`:**

- `ath_game_streams` — Per-game streaming configuration. **UNIQUE(game_id) caps each game at one stream.** 4-value `stream_status` CHECK SCHEDULED/LIVE/ENDED/FAILED. 4-value `access_level` CHECK PUBLIC/SCHOOL_ONLY/BOTH_SCHOOLS/COACHES_ONLY (ADR-068 — athletic events are public performances). **Multi-column lifecycle CHECK** keeps `started_at` and `ended_at` consistent with status. Partial INDEX on `(stream_status) WHERE stream_status IN ('SCHEDULED','LIVE')`.
- `ath_highlight_clips` — Per-(stream, student) extracted clip. 3-value `consent_status` CHECK PENDING/CONSENTED/DECLINED. **Multi-column `portfolio_consent_chk` keystone** rejects `added_to_portfolio = true` unless `consent_status = CONSENTED` — schema-side belt-and-braces for the highlight-clip consent contract. `portfolio_item_id` is a soft ref to Cycle 24 pfl_portfolio_items per ADR-001/020 — populated when the Step 4 service emits the link request.
- `ath_game_recordings` — Per-game recording catalogue distinct from stream-recorded video. 3-value `recording_type` CHECK FULL_GAME/HIGHLIGHT_REEL/COACHES_FILM.
- `ath_official_assignments` — Per-(game, official, role) assignment. **`official_profile_id` is a soft FK to platform.platform_official_profiles per ADR-001/020 + ADR-063** (officials are portable across schools and live above the tenant boundary). 7-value `role` CHECK + 6-value `status` CHECK POSTED/ACCEPTED/CONFIRMED/COMPLETED/CANCELLED/NO_SHOW + 3-value `payment_status` CHECK. Multi-column `cancel_chk` enforces non-empty `cancellation_reason` on CANCELLED. Multi-column `completed_chk` keeps `completed_at` populated only for COMPLETED. Partial UNIQUE INDEX on `(game_id, official_profile_id, role) WHERE status NOT IN ('CANCELLED','NO_SHOW')` prevents double-assignment. Partial INDEX on `(payment_status, completed_at) WHERE status='COMPLETED' AND payment_status='PENDING'` for the AP queue.
- `ath_official_ratings` — **Per-(assignment, rater_type) bidirectional rating.** 2-value `rater_type` CHECK SCHOOL_RATES_OFFICIAL plus OFFICIAL_RATES_SCHOOL drives the bidirectional rating contract. UNIQUE(assignment_id, rater_type) caps each direction at one row per assignment. Five numeric scores with [1, 5] CHECKs — the four sub-scores nullable, `overall` required.
- `ath_recruiting_profiles` — **Per-student recruiting profile, STUDENT-OWNED.** UNIQUE(student_id) one profile per athlete. **Multi-column `published_chk` lockstep** keeps `published_at` populated only when `is_published=true`. `gpa NUMERIC(4,3)` snapshot from rpt_student_academic_summary refreshed at publication time, with `gpa_snapshot_at` recording when. Bound CHECKs on graduation_year [2024, 2050], height_inches (0, 120], weight_lbs (0, 1000], gpa [0, 5]. Partial INDEX on `(graduation_year, sport) WHERE is_published=true` for the public marketplace browse path.
- `ath_recruiting_interests` — Per-(profile, college) interest tracker. 4-value `interest_level` CHECK EXPLORING/INTERESTED/APPLIED/COMMITTED. CASCADE on parent profile.

**Platform `20260510_add_p2c8_athletics_officials/migration.sql`:**

- `platform.platform_official_profiles` — Per-(person) official profile. **UNIQUE(person_id) — one official profile per person across all schools.** Non-empty `sports TEXT[]` via `cardinality_chk`. Non-negative CHECKs on `years_experience`, `max_travel_miles`, `base_fee`. The Prisma model is `PlatformOfficialProfile`.
- `platform.platform_official_availability` — Per-(official, date, slot) availability. **UNIQUE(official_profile_id, available_date, start_time) caps each official at one row per (date, start_time) tuple.** start_time/end_time both nullable (a NULL pair means all-day available). `window_chk` enforces all-day-or-specific-window. CASCADE on parent profile. Prisma model `PlatformOfficialAvailability`.

**FKs:** 7 new intra-tenant FKs (CASCADE × 5 + NO ACTION × 0 + UNIQUE × 1 + 1 platform-side cascade); 0 cross-schema DB FKs (officials live in platform schema and are reached as soft UUIDs from every tenant).

**Tenant base tables after P2-8b:** 538 (530 after P2-8a + 7 from P2-8b; the 2 platform tables don't count toward the tenant total).

### Step 4 — Seed + Services + UI + Tests

**Seed (`seed-athletics-advanced-b.ts`):** Idempotent, gated on `platform.platform_official_profiles` row count. Wired as `seed:athletics-advanced-b` in `package.json` and into `seed-all.ts` chain after P2-8a.

- 3 platform_official_profiles (Karen Wright BB+VB, Robert Thompson FB, Maria Sanchez Soccer)
- 6 availability rows
- 2 game streams (1 ENDED with recording, 1 SCHEDULED)
- 3 highlight clips (1 CONSENTED + added to portfolio, 1 PENDING, 1 DECLINED)
- 2 game recordings (FULL_GAME + COACHES_FILM)
- 4 official assignments (POSTED, CONFIRMED, COMPLETED, NO_SHOW)
- 2 bidirectional ratings on the COMPLETED assignment
- 2 recruiting profiles (Maya BASKETBALL grad 2027 published; Ethan BASKETBALL grad 2027 draft)
- 3 recruiting interests (KU + KSU on Maya, Pittsburg State on Ethan)

**Services + endpoints (~22 endpoints, 1 Kafka emit):**

`GameStreamService` + `GameStreamController` — 14 endpoints under `ath-005:read/write`:

- `GET /streams/live` — Live now
- `GET /streams/:id`, `GET /games/:gameId/stream`
- `POST /games/:gameId/stream` — Configure stream (UNIQUE(game_id) trap into 400)
- `PATCH /streams/:id` — Lifecycle transition (SCHEDULED → LIVE → ENDED, FAILED terminal alternate); locks the row and stamps `started_at` / `ended_at` automatically based on status
- `GET /streams/:streamId/clips`
- `GET /students/:studentId/highlight-clips`
- `GET /highlight-clips/:id`
- `POST /streams/:streamId/clips` — Extract clip with timeline timestamps; refuses `endTime <= startTime`
- `POST /highlight-clips/:id/consent` — **CONSENT KEYSTONE: open to student-self / linked guardian / AD-admin (admin override for COPPA)**
- `POST /highlight-clips/:id/add-to-portfolio` — **REFUSED unless consent_status = CONSENTED**; emits `ath.highlight_clip.portfolio_link_requested` so the Cycle 24 portfolio module materialises a `pfl_portfolio_items` row
- `GET /games/:gameId/recordings`, `GET /recordings/:id`, `POST /games/:gameId/recordings`

`OfficialService` + `OfficialController` — 14 endpoints under `ath-003:read/write`:

- `GET /officials` — Search marketplace by sport / availability / search term
- `GET /officials/:id` — Full profile with average ratings aggregated from THIS tenant's ath_official_ratings
- `POST /officials/profile`, `PATCH /officials/:id`
- `GET /officials/:id/availability`, `POST /officials/:id/availability`
- `GET /games/:gameId/officials`, `GET /officials/:id/assignments`, `GET /official-assignments/:id`
- `POST /games/:gameId/officials` — Post assignment (validates official exists in platform; UNIQUE(game, official, role) trap)
- `PATCH /official-assignments/:id` — **STATE MACHINE KEYSTONE.** POSTED → ACCEPTED → CONFIRMED → COMPLETED, with CANCELLED + NO_SHOW as terminal alternates from each non-terminal state. CANCELLED requires `cancellationReason` (rejected with 400 if missing). **Emits `ath.official.assignment.completed` on the COMPLETED transition.**
- `GET /official-assignments/:id/ratings` — List bidirectional ratings
- `POST /official-assignments/:id/rate` — **BIDIRECTIONAL KEYSTONE.** Refuses ratings on non-COMPLETED assignments. UNIQUE(assignment, rater_type) caught + translated to friendly 400 ("A rating already exists for this (assignment, rater_type) pair").

`RecruitingService` + `RecruitingController` — 8 endpoints under `ath-001:read` (row-scoped at service layer):

- `GET /recruiting` — Visibility model: admin/coach all; STUDENT own only via `actor.personId → platform_students → sis_students`; GUARDIAN linked children only via sis_student_guardians; everyone else only `is_published=true` profiles.
- `GET /recruiting/:id`, `GET /students/:studentId/recruiting`
- `POST /recruiting` — **STUDENT-OWNED KEYSTONE.** Student-self OR coach/admin; non-self non-coach refused. UNIQUE(student_id) trap.
- `PATCH /recruiting/:id` — Student-self OR coach/admin. **Coach recommendation field is coach/admin only — student cannot author their own recommendation letter.** Publishing snapshots `gpa` from `rpt_student_academic_summary` and stamps `gpa_snapshot_at`.
- `GET /recruiting/:id/interests`, `POST /recruiting/:id/interests`, `PATCH /recruiting-interests/:id` — Student-self OR coach/admin write authority.

**Web routes:** `/athletics/streaming`, `/athletics/officials`, `/athletics/recruiting` (3 stub pages with the live/live-now panel + filtered marketplace + profile gallery). Hooks in `apps/web/src/hooks/use-athletics-advanced.ts` cover all 22 endpoints (~30 React Query hooks added in this cycle).

**Tests:** 13 keystone unit tests in `athletics-advanced-b.spec.ts`:

1. GameStreamService AD-scope gate (non-admin without ath-005:write → 403)
2. addClipToPortfolio refuses non-CONSENTED clips with 400
3. addClipToPortfolio refuses already-linked clips with 400
4. CONSENTED happy path emits `ath.highlight_clip.portfolio_link_requested` with full payload contract
5. createRating refuses non-COMPLETED assignments with 400
6. createRating UNIQUE catch translated to 400
7. transitionAssignment COMPLETED emits `ath.official.assignment.completed`
8. transitionAssignment CANCELLED without reason rejected with 400
9. RecruitingService.createProfile refuses non-self non-coach (STUDENT-OWNED keystone)
10. RecruitingService.updateProfile refuses students from writing `coachRecommendation`
    11–13. Controller @RequirePermission metadata regression — Stream/clip/recording on `ath-005`, Officials on `ath-003`, Recruiting on `ath-001:read` (row-scoped at service layer).

### CI parity

- `pnpm format:check` — clean (all files Prettier-formatted)
- `pnpm lint:logs` — 679 files clean
- `pnpm --filter @campusos/api build` — clean (nest build success)
- `pnpm --filter @campusos/web build` — clean (3 new athletics routes ship: /streaming 5.94 kB, /officials 6.01 kB, /recruiting 5.96 kB First Load JS)
- `pnpm --filter @campusos/api exec vitest run` — **428 tests passing across 24 spec files** (was 415 before P2-8b; +13 new spec entries)
- Migration provisions cleanly to both `tenant_demo` and `tenant_test`
- Idempotent re-run: `pnpm seed:athletics-advanced-b` correctly skips with "platform_official_profiles already populated — skipping"

### Splitter trap log

- Migration 131: caught 4 stray `;` instances inside COMMENT strings on first audit (1 in `ath_highlight_clips.portfolio_item_id` comment, 1 in `ath_official_ratings` table comment, 1 in `ath_official_ratings.rated_by` column comment, 1 third-party regression in pre-edit pass). All rewritten with em-dashes / "and" / "plus" connectives before re-provision.
- Migration 131 cleared the audit on the second pass — the established Cycle 4-onwards "audit-then-provision" discipline held.

### Cross-module integration plan

- **Cycle 24 portfolio integration:** Step 4's `addClipToPortfolio` emits `ath.highlight_clip.portfolio_link_requested` with payload `{clipId, studentId, s3Key, title, schoolId, sourceRefId}`. Cycle 24's portfolio module is the canonical writer of `pfl_portfolio_items` rows; the consumer (lands in Phase 3 ops) materialises the portfolio_item row and updates `ath_highlight_clips.portfolio_item_id` via a separate service call.
- **Cycle 6 family billing integration (carry-over from P2-8a):** `ath.equipment.replacement_charge` emit lands the charge for the future Cycle 6 family billing consumer to raise an invoice.
- **Cycle 29 reporting integration:** `ath_recruiting_profiles.gpa` snapshot reads from `rpt_student_academic_summary` at publication time. Refreshing the snapshot is a separate manual step (a coach can update + republish to refresh, or Phase 3 cron job).

### Phase 3 carry-overs (per the plan)

- Official-self-service onboarding path (officials hold platform user accounts and can author/edit their own profile + availability). Today the AD records on behalf via admin-only writes.
- Streaming integration with Video Processing extracted service (the URL fields are populated externally; no in-repo capture pipeline).
- Cross-tenant officials marketplace search (today scoped to platform schema browse but tenant-internal aggregation only).
- Cross-tenant ratings rollup for the official's reputation.
- Recruiting profile public marketplace (the partial INDEX `(graduation_year, sport) WHERE is_published=true` is in place but the public unauthenticated read path is deferred).

### Reviewer attention items

The peer review of full P2-8 (P2-8a + P2-8b) covers:

- Schema correctness against ERD v11 (all 18 tables).
- Platform vs tenant placement of officials per ADR-063 — migration sets the platform tables and tenant carries soft refs only.
- Bidirectional rating UNIQUE(assignment_id, rater_type) keystone.
- Highlight clip consent gating chain: schema CHECK + service-layer gate + portfolio link emit.
- STUDENT-OWNED recruiting profile authorisation model (student-self / coach / admin; row-scope by personType).
- IAM gating: ath-001/003/005 grants and the row-scope-as-actual-gate convention on recruiting.
- Idempotency of the seed.
- Concurrency contract on `transitionAssignment` (FOR UPDATE OF a + lifecycle transition guards).

See `P2C8-REVIEW-NOTES.md` for the design decisions, schema choices, and ADR alignment.
