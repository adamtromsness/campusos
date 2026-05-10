# P2C8 Review Notes — Athletics Advanced

**Plan:** `docs/campusos-p2c8-athletics-advanced.html`.
**Scope:** All 18 ERD tables for M66 Athletics .1 across 2 sub-cycles (P2-8a Equipment + Conferences + Media; P2-8b Streaming + Officials + Recruiting).
**Migrations:** `130_ath_equipment_conferences.sql` (P2-8a, 9 tables, tenant), `131_ath_streaming_officials.sql` (P2-8b, 7 tables, tenant), `20260510_add_p2c8_athletics_officials/migration.sql` (P2-8b, 2 tables, platform).
**Endpoint count:** ~42 across the cycle (~20 from P2-8a + ~22 from P2-8b).
**Kafka emits:** `ath.equipment.replacement_charge` (P2-8a), `ath.highlight_clip.portfolio_link_requested`, `ath.official.assignment.completed` (P2-8b).

---

## 1. Platform vs tenant split for officials (ADR-063)

The single biggest schema decision in P2C8 is **placing official profiles in the platform schema**. Per ADR-063 ("Officials Marketplace"), an official like Karen Wright works basketball games at multiple Kansas schools. If her profile lived in `tenant_demo.ath_officials` we would either:

(a) duplicate the profile in every tenant she officiates at, drift between rows on each update, and need a synchronisation channel,
(b) make every school enter their own copy of every official's certifications independently, multiplying work for a shared bench,
(c) build a cross-tenant aggregation layer to merge the rows on read.

All three are bad. Putting officials at the platform schema gives us a single source of truth that any tenant's `ath_official_assignments` row references via a soft UUID per ADR-001/020.

**Implementation:**

- `platform.platform_official_profiles` — the canonical official record (sports[], certification, base_fee, contact info). UNIQUE(person_id) enforces one profile per platform person.
- `platform.platform_official_availability` — per-(profile, date, slot) availability. UNIQUE(official_profile_id, available_date, start_time) caps each official at one row per (date, start_time). NULL start_time means all-day, enforced by `window_chk` (start and end must both be NULL or both populated with end > start).
- `tenant.ath_official_assignments.official_profile_id UUID` — soft FK to platform per ADR-001/020. The Step 4 service validates the platform profile exists before the tenant INSERT.

**Why a UUID soft ref and not a DB-enforced cross-schema FK?** Per ADR-001/020 + the project's architectural convention (CLAUDE.md "Soft cross-schema refs"), tenant tables MUST NOT have DB-enforced FK constraints to platform.\* tables. The validation lives in the service layer (`createAssignment` does a platform-side existence check before the tenant INSERT).

**Alternative considered + rejected:** Store officials per-tenant with periodic cross-tenant sync. Rejected as adding ops burden without solving the dual-source-of-truth problem.

---

## 2. Bidirectional rating model

`ath_official_ratings` carries `rater_type` 2-value CHECK SCHOOL_RATES_OFFICIAL plus OFFICIAL_RATES_SCHOOL with `UNIQUE(assignment_id, rater_type)`. Both directions are required for the marketplace to surface useful averages without one-sided rating bias:

- **SCHOOL_RATES_OFFICIAL** — the AD evaluates the official after the game (professionalism, knowledge, communication, punctuality, overall). Aggregates inform the marketplace browse view (`OfficialProfileResponseDto.averageOverallRating`).
- **OFFICIAL_RATES_SCHOOL** — the official evaluates the school as a workplace (organisation, crowd control, fee promptness). Aggregates inform a future per-school reputation dashboard (Phase 3).

Both row types per assignment is the maximum. UNIQUE caps each direction at 1 row per assignment so the official cannot rate the same game twice and the school cannot rate the same official twice for the same game. Re-running submitRating after the partial UNIQUE has fired returns a friendly 400 ("A rating already exists for this (assignment, rater_type) pair. Edit the existing rating instead.").

**Why not let either side rate without the other?** Either side rating without the other invites bias — schools could bury bad officials by NOT rating them while the official's only feedback channel is silence. Bidirectional ratings give both sides voice, which is the ADR-063 contract.

**Why is `overall` required but the four sub-scores nullable?** Real schools don't always know how to grade individual dimensions but always have an opinion on overall. Forcing all five fields would suppress ratings. Schema reflects: overall is required, sub-scores nullable, all in [1, 5]. The four sub-score CHECK constraints are individually scoped so a partial submission is accepted.

**Authorisation today:** The ADR says both school and official can submit. Today both go through admin/AD because the official-self-service onboarding path (officials hold platform user accounts) is a Phase 3 carry-over. Until officials hold platform user accounts, the AD records on behalf of the official by submitting both rater_types from the admin UI.

---

## 3. Safety equipment compliance enforcement (P2-8a carry-over)

`ath_safety_equipment` is the safety-compliance keystone for live games. Per the plan ("Safety compliance must be verified before game participation"), the schema makes per-(roster_member, equipment_type) the unit of compliance via `UNIQUE(roster_member_id, equipment_type)`. Each athlete has at most one row per safety equipment type — the Step 2 service patches the existing row instead of inserting a new one.

The compliance state computed from the row drives a 4-state visibility:

- **GREEN** — `issued=true` AND `meets_safety_standard=true` AND certification not expired AND `recall_status=false`.
- **AMBER** — certification expiring within 30 days.
- **ROSE** — certification expired OR `meets_safety_standard=false` OR `recall_status=true`.
- **NEUTRAL** — `issued=false` and no certification on file.

The **enforcement before game participation** is a service-layer check that's deferred (the plan says "verified before game participation" — the in-repo enforcement gate is the schema invariants + the compliance dashboard; a pre-game checklist that BLOCKS the GameService.create when any roster member is in ROSE state is a Phase 3 add-on per the plan's reviewer attention items).

---

## 4. Highlight clip consent flow (ADR-068)

Per ADR-068 ("Athletic Event Streaming"), athletic events are public performances and photo-privacy flags do NOT apply to game footage. However, when a game clip is **promoted from the stream into a student's portfolio**, that becomes a personal-record action and consent is required.

The schema enforces this with two layers:

**1. Multi-column `portfolio_consent_chk` on `ath_highlight_clips`:**

```sql
CHECK (added_to_portfolio = false OR consent_status = 'CONSENTED')
```

This is the schema-side belt-and-braces. A direct SQL UPDATE that tries to set `added_to_portfolio=true` on a PENDING or DECLINED clip is rejected at the database layer.

**2. Service-layer gate in `GameStreamService.addClipToPortfolio`:**

- Locks the clip row inside `executeInTenantTransaction` with `FOR UPDATE OF c`.
- Reads `consent_status` from the locked snapshot.
- Refuses with friendly 400 when consent_status ≠ CONSENTED.
- Refuses with friendly 400 when `added_to_portfolio` is already true.
- Sets `added_to_portfolio=true` inside the same tx.
- Emits `ath.highlight_clip.portfolio_link_requested` AFTER the tx commits.
- The Cycle 24 portfolio module's consumer (Phase 3 ops) materialises the `pfl_portfolio_items` row and updates `ath_highlight_clips.portfolio_item_id` via a separate idempotent service call.

**Who can record consent?**

- **Student-self** (resolved via `actor.personId → platform_students → sis_students`).
- **Linked guardian** (resolved via `sis_student_guardians + sis_guardians`).
- **AD or admin** (admin override for COPPA cases where under-13 students cannot legally consent — the school administrator records consent on behalf with a parent's separate written approval).

**Why three personas?** Real schools have COPPA-protected students (under 13) where the platform self-consent flow is legally invalid. Carving out the admin override path lets the school comply with COPPA's "school-as-agent" provision. Default flow is student / guardian self-consent.

---

## 5. Recruiting profiles — student-owned data model

`ath_recruiting_profiles` is the **fifth student-input write surface** in CampusOS after Cycle 11.1 wellbeing check-ins (`COU-004:read+write`), Cycle 12 reading logs / book reviews (`LIB-003:read+write`), Cycle 17 service hours (`CLB-004:read+write`), and Cycle 24 portfolio items (`ACH-002:read+write`).

**Authorisation model (service-layer row-scope):**

| Persona         | Read                    | Write profile | Write coach recommendation |
| --------------- | ----------------------- | ------------- | -------------------------- |
| Student (self)  | Own profile always      | Yes           | NO                         |
| Coach / staff   | All profiles            | Yes           | Yes                        |
| Admin           | All profiles            | Yes           | Yes                        |
| Linked guardian | Own children's profiles | NO            | NO                         |
| Other students  | Published profiles only | NO            | NO                         |
| Other parents   | Published profiles only | NO            | NO                         |

Implementation lives in `recruiting.service.ts` — `isStudentSelf()` resolves the student identity through `actor.personId → platform_students → sis_students`; `isLinkedGuardian()` resolves via `sis_student_guardians + sis_guardians`; `hasCoachScope()` checks `ath-001:write OR isSchoolAdmin`.

**Why `coachRecommendation` is coach/admin-only:** Real-world recruiting profiles include a "letter of recommendation" from the head coach. The student should not author their own recommendation letter — that defeats the purpose. The `updateProfile` service refuses any update where `coachRecommendation` is supplied unless the actor passes `hasCoachScope`.

**GPA snapshot model:** `gpa NUMERIC(4,3)` is denormalised from `rpt_student_academic_summary` at publication time. The plan's note: "snapshot from rpt_student_academic_summary refreshed at publication time, not maintained live." The Step 4 service reads from the rpt read model when `is_published` flips to true and stamps `gpa_snapshot_at`. Live recomputation is rejected to prevent the recruiter-facing GPA from changing mid-recruiting-cycle without the student/coach reviewing first.

**Authorisation gate at the controller layer:** Every recruiting endpoint is gated on `ath-001:read` at the controller. The actual access boundary is the service-layer row scope. Why so permissive at the gate? Because the row-scope is more nuanced than IAM permissions can express — different write authority depending on the field being written. The controller-layer gate is the rough cut, the service is the load-bearing check.

---

## 6. Splitter trap discipline maintained

Per CLAUDE.md "Conventions" — every migration that lands the same comment text inside a `COMMENT ON TABLE` or `COMMENT ON COLUMN` string has to avoid `;` since the SQL splitter cuts on every `;` regardless of quoting context.

P2-8b migration 131 caught **4 stray `;` instances** inside COMMENT strings on the first Python audit:

1. `ath_highlight_clips.portfolio_item_id` comment ("Cycle 24 portfolio module is the canonical writer of pfl_portfolio_items rows;…") — rewritten with em-dash.
2. `ath_official_ratings` table comment ("a rater can submit only the overall score; overall is required") — rewritten with em-dash.
3. `ath_official_ratings` table comment ("for the marketplace browse UI; per-school averages aggregate over…") — rewritten with "plus".
4. `ath_official_ratings.rated_by` column comment ("For SCHOOL_RATES_OFFICIAL this is the AD account; for OFFICIAL_RATES_SCHOOL this is the official account") — rewritten with "and".

All four caught by the audit script before any provision attempt. Both `tenant_demo` and `tenant_test` provisioned cleanly on the second pass.

---

## 7. ADR alignment

| ADR     | Title                                                      | How P2C8 honours it                                                                                                                             |
| ------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-001 | Tenant tables MUST NOT have DB-enforced FKs to platform.\* | `ath_official_assignments.official_profile_id` is a soft UUID; service validates platform existence pre-INSERT.                                 |
| ADR-020 | Soft cross-schema refs are app-layer only                  | Same as above + `ath_highlight_clips.portfolio_item_id` is soft to `pfl_portfolio_items`.                                                       |
| ADR-055 | Identity flows through `iam_person`                        | `platform_official_profiles.person_id` is UNIQUE FK to `iam_person`.                                                                            |
| ADR-063 | Officials Marketplace                                      | Officials in platform schema; tenant rows reference via soft UUID; bidirectional rating UNIQUE(assignment, rater_type).                         |
| ADR-068 | Athletic Event Streaming                                   | `ath_game_streams.access_level` 4-value CHECK; `ath_highlight_clips` has `consent_status` gating with `portfolio_consent_chk` schema invariant. |
| ADR-069 | CampusOS-to-CampusOS Athletic Integration                  | Cross-tenant integration is a Phase 3 carry-over per the plan; in-repo seed exercises within a single tenant.                                   |

---

## 8. IAM permission distribution

The plan's title strip says "ATH-001..004" but P2-8b uses the existing catalogue codes:

| Code    | Name                    | P2-8b usage                                 | Granted to (per cycle 13 + earlier seeds)       |
| ------- | ----------------------- | ------------------------------------------- | ----------------------------------------------- |
| ATH-001 | Team Management         | Recruiting profile gate (controller)        | Teacher/Parent/Student :read; Staff :read+write |
| ATH-003 | Game & Event Management | Officials marketplace + assignments         | Staff :read+write                               |
| ATH-005 | Athletic Streaming      | Game streams + highlight clips + recordings | Staff :read+write (as-is from Cycle 13)         |

The recruiting endpoints are gated on `ath-001:read` at the controller because students must access their own profile through the same code already granted, with the service-layer row-scope as the load-bearing check. Adding a new ATH-011 "Athletic Recruiting" code was considered but rejected — the controller-tier gate is intentionally rough and the row-scope handles the nuance.

---

## 9. Open questions for the reviewer

1. **Officials self-onboarding (Phase 3)** — Today the AD creates official profiles on behalf. Once officials hold platform user accounts, should we add ATH-011 "Athletic Recruiting" as a new permission? Same question for `OFFICIAL_RATES_SCHOOL` ratings — today AD records on behalf; once officials self-onboard, what's the gate?

2. **Recruiting public marketplace** — The partial INDEX `(graduation_year, sport) WHERE is_published=true` is in place but no public unauthenticated read path exists in P2-8b. Phase 3 work; do we want this to live in the same `/athletics/recruiting` route or a separate `/recruiting/public` surface?

3. **Streaming integration with Video Processing service** — The schema has the URL fields but no in-repo capture pipeline. Today the AD pastes a manual stream URL. The plan says "Streaming requires Video Processing extracted service (stub if not deployed)." Do we want a Phase 2 polish item to add the Kafka consumer that transitions a stream from SCHEDULED → LIVE when the Video Processing service emits `video.stream.started`?

4. **Highlight clip portfolio consumer** — `addClipToPortfolio` emits `ath.highlight_clip.portfolio_link_requested` but the Cycle 24 portfolio consumer that materialises the `pfl_portfolio_items` row is not in repo. Do we want this to land in P2-8b polish or wait until the Cycle 24 portfolio module's queue worker reaches Phase 3 ops?

5. **Cross-tenant ratings rollup** — Today `OfficialProfileResponseDto.averageOverallRating` aggregates over THIS tenant's ath_official_ratings. The official's full reputation score across all tenants needs a cross-tenant aggregation. ADR-063 mentions this but the implementation is Phase 3. Do we want a `platform_official_rating_aggregate` materialised view that spans all tenants?

---

## 10. Test coverage map

Total tests: **428 passing across 24 spec files** (was 415 before P2-8b; +13 new from `athletics-advanced-b.spec.ts`).

Athletics-specific coverage:

- `athletics-advanced.spec.ts` (P2-8a) — 17 tests covering equipment AD scope, DAMAGED/LOST emit shape, safety UNIQUE, conference UNIQUE, team media gate, and controller @RequirePermission metadata regression.
- `athletics-advanced-b.spec.ts` (P2-8b) — 13 tests covering stream AD scope, highlight clip consent keystone (3 paths: PENDING-rejected / already-linked-rejected / CONSENTED-emits), official rating non-COMPLETED rejection + UNIQUE catch, transition COMPLETED emit + cancellation gate, recruiting STUDENT-OWNED keystone (non-self-non-coach rejection + coach-recommendation field gate), and controller @RequirePermission metadata regression for all 3 P2-8b controllers.

CI parity confirmed across format:check, lint:logs (679 files clean), api build, web build, and full vitest suite.
