# Cycle 25 Handoff — Publications

**Status:** Cycle 25 **COMPLETE pending architecture review** — Wave 5 (Academic Advanced) closeout cycle. All 10 steps shipped + vertical-slice CAT verified live on `tenant_demo` 2026-05-06. Cycle 25 ships the M42 Publications module — 11 of the 15 ERD tables in scope (4 deferred to Cycle 25.1: pub_publication_versions, pub_media_assets, pub_approval_delegations, pub_templates). Recurring publication series (the brand) carrying numbered editions (specific issues), individual publications (content documents) with multi-section content structure and per-section ownership + contributor attribution, role-based approval workflow per ADR-035 (staff publish directly, student-authored content requires approval), targeted distribution lists with rule-based audience resolution (ROLE / GRADE / CLASS / GROUP_MEMBERSHIP), per-recipient delivery tracking (PENDING / DELIVERED / OPENED / BOUNCED), and series subscriptions with self-service opt-out. **Closes Wave 5 (Academic Advanced).**

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle25-implementation-plan.html`
**Vertical-slice deliverable:** Admin creates "The Weekly Eagle" newsletter series (NEWSLETTER, WEEKLY) → editor creates Edition #12 "Spring 2026" with cover image + editorial note → adds 4 sections incl. "Student Spotlight" (Maya — student, requires approval per ADR-035) → admin approves Maya's section → edition status: DRAFT → IN_REVIEW → APPROVED → PUBLISHED via /distribute → distribution list targets ALL_PARENTS + ALL_STAFF via rules → audience resolved with UNSUBSCRIBED rows excluded → `pub.publication.published` fires with full ADR-057 envelope shape → David Chen receives the newsletter, clicks "Unsubscribe" → next distribution skips David.

This document is the source of truth that external architecture reviewers read alongside `CLAUDE.md`.

---

## Step status

| Step | Title                                                   | Status   |
| ---- | ------------------------------------------------------- | -------- |
| 1    | Series + Editions + Publications Schema                 | Complete |
| 2    | Sections + Contributors + Comments Schema               | Complete |
| 3    | Distribution + Subscriptions Schema                     | Complete |
| 4    | Seed Data + PUB-001..003 IAM grants                     | Complete |
| 5    | Series + Publications NestJS Module                     | Complete |
| 6    | Sections + Contributors NestJS Module                   | Complete |
| 7    | Distribution + Subscriptions NestJS Module              | Complete |
| 8    | Publications UI — Series + Editor + Authoring           | Complete |
| 9    | Publications UI — Distribution + Reader + Subscriptions | Complete |
| 10   | Vertical Slice Integration Test                         | Complete |

**Final cycle totals:** 11 tenant `pub_*` base tables across 3 migrations (083 + 084 + 085). Tenant logical base table count 325 → **336**. 15 intra-tenant FKs (CASCADE × 9 + SET NULL × 4 + NO ACTION × 2). 0 cross-schema DB-enforced FKs. **34 endpoints** under `pub-001:read/write/admin` + `pub-002:read/write/admin` + `pub-003:read/write/admin` across 9 services + 1 controller. **1 Kafka emit topic** (`pub.publication.published`). **5 web routes** (`/publications`, `/publications/series/[id]`, `/publications/editions/[id]`, `/publications/[id]`, `/publications/subscriptions`). IAM: Teacher gains `PUB-001:read+write` + `PUB-002:read+write` (83 perms total, +4); Student gains `PUB-001:read` + `PUB-002:read+write` (47, +3); Parent gains `PUB-001:read` (42, +1); Staff gains `PUB-001..003:read+write` (132, +6). Catalogue stays at **454**. Vertical-slice CAT at `docs/cycle25-cat-script.md` walks 7 plan scenarios end-to-end (auto-increment edition numbering; ADR-035 keystone refusing APPROVED while student section pending; audience preview with UNSUBSCRIBED exclusion; PUBLISH + DISTRIBUTE keystone with `pub.publication.published` ADR-057 envelope captured live; subscription opt-out; permission denials). **Splitter trap caught + fixed pre-/mid-provision** on migration 081 (Cycle 24 MAJOR 7 fix had introduced a `;` mid-string), 084 (1 stray `;` in block comment), 085 (1 stray `;` in block comment + 1 stray `;` in COMMENT string); 083 clean on first audit. Both `tenant_demo` and `tenant_test` provisioned cleanly. Plan at `docs/campusos-cycle25-implementation-plan.html`. Awaiting peer review verdict before tagging `cycle25-complete`.

---

## What this cycle adds on top of Cycle 24

**Greenfield — clean `pub_*` namespace.** Cycle 25 ships the M42 Publications module from scratch. Closes Wave 5.

- **11 new tenant base tables** across 3 migrations (083 + 084 + 085). Tenant base table count after Cycle 24 was 325 → **336** after Cycle 25.
- **1 new backend module** (PublicationsModule) with 9 services + 1 controller + 34 endpoints under `pub-001:read/write/admin` + `pub-002:read/write/admin` + `pub-003:read/write/admin`.
- **1 new Kafka emit topic**: `pub.publication.published` (fires after the PUBLISH + DISTRIBUTE keystone resolves the audience, INSERTs recipient rows with PENDING status, and flips publication status to PUBLISHED).
- **5 new web routes**: `/publications` (persona-aware landing with series + published feed), `/publications/series/[id]` (series manager + edition list + create-edition), `/publications/editions/[id]` (edition editor with status transition bar + section CRUD + audience preview + distribute keystone), `/publications/[id]` (reader view), `/publications/subscriptions` (my subscriptions + subscribe/unsubscribe toggle).
- **No new permission codes**: PUB-001 + PUB-002 + PUB-003 already in the catalogue. Catalogue stays at **454**. PUB-003 catalogue label currently reads "Parent Portal" — at runtime Cycle 25 uses it as the Distribution gate per the plan; rename before pilot.

**Three structural keystones for the cycle:**

1. **ADR-035 approval gate (KEYSTONE).** `pub_publications.status` lifecycle (DRAFT → IN_REVIEW → APPROVED → PUBLISHED → ARCHIVED). Staff-authored sections (have an `hr_employees` owner_id) default to `is_approved=true`; student-authored sections default to `is_approved=false`. Step 5 `PublicationService.patchStatus` refuses APPROVED transitions while any section has `is_approved=false`. Verified live: DRAFT → IN_REVIEW (200) → add student section → APPROVED (400) → approve section → APPROVED (200).

2. **Rule-based audience resolution.** `DistributionService.resolveAudience` walks the `pub_distribution_rules` rows, OR-aggregates matching `account_ids` across 4 rule types (ROLE / GRADE / CLASS / GROUP_MEMBERSHIP), then excludes recipients with status='UNSUBSCRIBED' on `pub_series_subscriptions`. ROLE matches via `iam_role_assignment + roles + iam_scope` keyed on the school + platform scope chain (matches the existing AudienceFanOutWorker pattern from Cycle 3). GRADE matches guardians of students in the grade. CLASS matches enrolled students + assigned teachers. GROUP_MEMBERSHIP matches active group members.

3. **PUBLISH + DISTRIBUTE keystone.** `DistributionService.distribute` runs in `executeInTenantTransaction` — locks the publication row FOR UPDATE, validates `status='APPROVED'` or already PUBLISHED (re-distribute is supported), INSERTs `pub_distribution_recipients` rows for every resolved account_id with `delivery_status='PENDING'` (ON CONFLICT DO NOTHING for redelivery idempotency), flips publication status to PUBLISHED + stamps `published_at`, then emits `pub.publication.published` AFTER the tx commits. The Cycle 14 Communications consumer can listen to this topic to fan out IN_APP / EMAIL deliveries.

**Existing-system touchpoints:**

- `wsk_approval_requests(id)` (Cycle 7) — soft `approval_request_id` column on both `pub_edition` and `pub_publications` per ADR-035; future workflow integration.
- `platform.platform_users(id)` — soft refs on `pub_publications.created_by`, `pub_publication_collaborators.user_id`, `pub_section_contributors.contributor_id`, `pub_section_comments.author_id`, `pub_distribution_recipients.recipient_id`, `pub_series_subscriptions.subscriber_id`.
- `hr_employees(id)` — DB-enforced FK on `pub_series.created_by`, `pub_edition.editor_id`, `pub_sections.owner_id` with `ON DELETE SET NULL`.
- `sis_classes(id)` — soft ref via `pub_distribution_rules.rule_value` when `rule_type='CLASS'`.
- `grp_groups(id)` (Cycle 18) — soft ref via `pub_distribution_rules.rule_value` when `rule_type='GROUP_MEMBERSHIP'`.

What does not change: every existing module continues to function. Cycle 25 is purely additive on a clean `pub_*` namespace.

---

## Step 1 — Series + Editions + Publications Schema

`packages/database/prisma/tenant/migrations/083_pub_series_publications.sql` lands 4 logical base tables: `pub_series` (UNIQUE(school, title); 6-value publication_type + 7-value frequency CHECK; `created_by` DB-enforced FK on hr_employees with SET NULL), `pub_edition` (UNIQUE(series, edition_number); 5-value status CHECK; CASCADE on parent series; `editor_id` DB-enforced FK on hr_employees with SET NULL; soft `approval_request_id` ref to wsk_approval_requests per ADR-035), `pub_publications` (5-value status CHECK; multi-column `edition_chk` enforces edition_id IS NULL OR series_id IS NOT NULL; NO ACTION on series + edition deletes preserves the publication audit; created_by soft ref to platform_users per ADR-001/020), `pub_publication_collaborators` (4-value role CHECK + UNIQUE(publication, user); CASCADE on publication delete; user_id soft ref to platform_users). 5 new intra-tenant DB-enforced FKs (CASCADE × 2 + NO ACTION × 2 + SET NULL × 2 across the 4 tables). 0 cross-schema DB-enforced FKs. Tenant logical base table count: 325 → **329**. **Splitter trap caught mid-provision** on migration 081 (a Cycle 24 MAJOR 7 fix had introduced a `;` mid-string in a COMMENT) — rewritten with em-dash before the third provision attempt cleared. 15-assertion smoke green: every CHECK fires, all 4 UNIQUE rejects dups, edition_chk fires on orphan edition without series, standalone publication accepted (series_id + edition_id both NULL), CASCADE on series delete drops editions, NO ACTION refuses series delete with referencing publication, all 6 publication_type + 7 frequency values accepted in single inserts. **Catalog readout** confirms FK delete actions exactly: pub_collab_publication_fk=c, pub_edition_editor_fk=n, pub_edition_series_fk=c, pub_publication_edition_fk=a, pub_publication_series_fk=a, pub_series_created_by_fk=n.

## Step 2 — Sections + Contributors + Comments Schema

`packages/database/prisma/tenant/migrations/084_pub_sections.sql` lands 3 logical base tables: `pub_sections` (5-value section_type CHECK ARTICLE/ANNOUNCEMENT/PHOTO_GALLERY/CALENDAR/CUSTOM; `is_approved` is the ADR-035 keystone; CASCADE on publication; `owner_id` DB-enforced FK on hr_employees with SET NULL), `pub_section_contributors` (UNIQUE(section, contributor); CASCADE on section; `contributor_id` soft ref to platform_users), `pub_section_comments` (multi-column `resolved_chk` keystone keeping is_resolved + resolved_by + resolved_at in lockstep; threaded replies via parent_comment_id self-FK SET NULL; CASCADE on section). 4 new intra-tenant DB-enforced FKs (CASCADE × 3 + SET NULL × 1 self-FK). Tenant logical base table count: 329 → **332**. Splitter trap caught + fixed pre-provision (1 stray `;` in block-comment header rewritten with "and"). Tenant base table count: 332.

## Step 3 — Distribution + Subscriptions Schema

`packages/database/prisma/tenant/migrations/085_pub_distribution.sql` lands 4 logical base tables completing the schema phase: `pub_distribution_lists` (CASCADE on publication), `pub_distribution_rules` (4-value rule*type CHECK + CASCADE on list; rule_value is a TEXT slot interpreted via rule_type), `pub_distribution_recipients` (4-value delivery_status CHECK + UNIQUE(publication, recipient) for idempotency; CASCADE on publication; recipient_id soft ref to platform_users), `pub_series_subscriptions` (2-value status CHECK + multi-column lockstep_chk keeping unsubscribed_at populated only when status=UNSUBSCRIBED; UNIQUE(series, subscriber); CASCADE on series). 4 new intra-tenant DB-enforced FKs (CASCADE × 4). Tenant logical base table count: 332 → **336**. \*\*Cycle 25 schema phase complete: 11 pub*\* tables across 3 migrations, 15 intra-tenant FKs (CASCADE × 9 + SET NULL × 4 + NO ACTION × 2).\*\* Splitter trap caught + fixed pre-provision on migration 085 (1 stray `;` in block-comment header + 1 stray `;` in COMMENT string both rewritten with em-dash / "and"). Tenant base table count: 336.

## Step 4 — Seed Data + PUB-001..003 IAM grants

`packages/database/src/seed-publications.ts` (idempotent, gated on whether "The Weekly Eagle" series already exists in tenant_demo) wired as `seed:publications` in `package.json`. 7 sections seeded on `tenant_demo`: 1 series ("The Weekly Eagle" NEWSLETTER WEEKLY) + 2 editions (#11 PUBLISHED + #12 DRAFT) + 3 publications (Edition #11 newsletter PUBLISHED + Edition #12 newsletter DRAFT + standalone "End of Year Reminders" BULLETIN PUBLISHED) + 4 collaborators on Edition #12 (Mitchell EDITOR + Rivera CONTRIBUTOR + Hayes REVIEWER + Maya CONTRIBUTOR — exercises the ADR-035 student gate) + 4 sections on Edition #11 (3 staff approved + 1 student Spotlight pending) + 2 section contributors (Maya on Spotlight + Hayes on Sports) + 2 threaded comments on Spotlight (Hayes feedback + Maya reply) + 1 distribution list "All Parents + Staff" with 2 ROLE rules (PARENT + STAFF) + 5 pre-computed recipients across 4 delivery_status values (1 PENDING + 2 DELIVERED + 2 OPENED) + 3 subscriptions (David SUBSCRIBED + Rivera SUBSCRIBED + Hayes UNSUBSCRIBED). `seed-iam.ts` extended: Teacher gains `PUB-001:read+write` + `PUB-002:read+write` (83 perms, +4); Student gains `PUB-001:read` + `PUB-002:read+write` (47, +3); Parent gains `PUB-001:read` (42, +1); Staff gains `PUB-001..003:read+write` (132, +6). Catalogue stays at **454**. Cache rebuild reports 7 account-scope pairs.

## Step 5 — Series + Publications NestJS Module

`apps/api/src/publications/series.service.ts` ships SeriesService + EditionService + PublicationService + CollaboratorService. SeriesService (list + get + create + patch under pub-001:read/write; UNIQUE(school, title) catch). EditionService (auto-increment edition_number per series via locked SELECT MAX + INSERT inside one tx; status transition gate via ALLOWED_TRANSITIONS map covering DRAFT/IN_REVIEW/APPROVED/PUBLISHED/ARCHIVED; PUBLISHED stamp populates published_at). PublicationService (list with status + seriesId filters; getById with collaborators inlined; **patchStatus is the ADR-035 KEYSTONE** — locks the publication row FOR UPDATE, validates the transition is allowed, then for APPROVED transitions counts pending sections and refuses if any has is_approved=false). CollaboratorService (invite via UNIQUE(publication, user) catch; admin-only remove).

## Step 6 — Sections + Contributors NestJS Module

`apps/api/src/publications/sections.service.ts` ships SectionService + ContributorService + CommentService. SectionService (CRUD with auto-incremented sort_order when not supplied; ADR-035 default — sections with no employee owner_id default to is_approved=false; **approve flips is_approved=true**, refuses students approving their own section). ContributorService (UNIQUE(section, contributor) catch). CommentService (threaded replies via parent_comment_id; resolve flips multi-column lockstep atomically).

## Step 7 — Distribution + Subscriptions NestJS Module

`apps/api/src/publications/distribution.service.ts` ships DistributionService + SubscriptionService + 1 Kafka emit (`pub.publication.published`). **`resolveAudience` is the audience-resolution keystone** — walks `pub_distribution_rules` and OR-aggregates matching account_ids across the 4 rule types (ROLE / GRADE / CLASS / GROUP_MEMBERSHIP), then excludes accounts with status='UNSUBSCRIBED' on `pub_series_subscriptions`. ROLE matches via `iam_role_assignment + roles + iam_scope + iam_scope_type` keyed on the school + platform scope chain (matches AudienceFanOutWorker from Cycle 3). GRADE matches guardians of students in the grade. CLASS matches enrolled students + assigned teachers. GROUP_MEMBERSHIP matches active group members. **`distribute` is the PUBLISH + DISTRIBUTE keystone** — locks the publication, validates APPROVED status, INSERTs recipient rows ON CONFLICT DO NOTHING for idempotency, flips status to PUBLISHED + stamps published_at, emits `pub.publication.published` after tx commits. SubscriptionService (subscribe/unsubscribe is idempotent — re-subscribe path resets unsubscribed_at to NULL; multi-column lockstep_chk satisfied atomically). **Cycle 25 endpoint count: 34** under pub-001/002/003. **1 Kafka emit topic.**

**Live verification on `tenant_demo` 2026-05-06:** ADR-035 keystone — DRAFT → IN_REVIEW (200) → student section added (201) → IN_REVIEW → APPROVED (400) → approve section (200) → IN_REVIEW → APPROVED (200). Audience preview returns `{totalRecipients: 2, excludedUnsubscribed: 1, sampleNames: ["David Chen", "Linda Park"]}` (Hayes filtered out as UNSUBSCRIBED). Distribute returns `{totalRecipients: 6, alreadyExisted: 5, status: "PUBLISHED"}` and the wire envelope on `dev.pub.publication.published` carries `event_type=pub.publication.published`, `source_module=publications`, full ADR-057 shape with payload {publicationId, sourceRefId, schoolId, title, seriesId, totalRecipients, publishedById, publishedAt}. Subscription unsubscribe + re-subscribe round-trip clean. 3 permission denials all return 403 (student create series, parent create section, teacher distribute).

## Step 8 — Publications UI: Series + Editor + Authoring

New `Publications` launchpad tile in `apps/web/src/components/shell/apps.tsx` gated on `pub-001:read` using new `NewspaperIcon`; persona-aware copy. New `apps/web/src/lib/publications-format.ts` with PUB const arrays + label maps + status pill maps + role pill map + section type labels + subscription status pill + formatDate / formatDateTime helpers. New `apps/web/src/hooks/use-publications.ts` with 21 React Query hooks covering every Step 5–7 endpoint. **5 web routes:** `/publications` persona-aware landing (staff sees series list + published feed; reader sees published-only feed + my-subscriptions link); `/publications/series/[id]` (3-stat header + edition list with status pills + "New edition" button auto-incrementing edition_number); `/publications/editions/[id]` (status transition bar with all 5 status buttons; section list with per-section approve button on student-pending sections; **PUBLISHED-status pubs surface "Preview audience" + "Distribute" keystone buttons**); `/publications/[id]` reader view (collaborator chips + section render with body in `whitespace-pre-wrap`; pending sections rose-tinted with banner); `/publications/subscriptions` (subscribe/unsubscribe toggle per series + history table with status pills).

## Step 9 — Publications UI: Distribution + Reader + Subscriptions

(See Step 8 — distribution surfaces are inline on the edition editor; reader view + subscriptions ship as `/publications/[id]` and `/publications/subscriptions` routes.)

## Step 10 — Vertical Slice Integration Test

`docs/cycle25-cat-script.md` — 6-check schema preamble + 7 plan scenarios verified live on `tenant_demo` 2026-05-06: S1 series + auto-increment editions; S2 publication detail with collaborators + sections; **S3 ADR-035 keystone — APPROVED gated by pending student sections**; S4 audience preview + distribute keystone with `pub.publication.published` ADR-057 envelope captured live; S5 distribution status rollup; S6 subscription lifecycle including re-subscribe path; S7 3 permission denials. Cleanup restores `tenant_demo` to post-Step-3 seed shape.

**Cycle 25 ships clean to the post-cycle architecture review.**

Reviewer attention items (non-blocking, deferred):

- **`pub_publication_versions`** (Cycle 25.1) — full version history with diff tracking.
- **`pub_media_assets`** (Cycle 25.1) — shared media library across publications.
- **`pub_approval_delegations`** (Cycle 25.1) — delegation of approval authority during absences.
- **`pub_templates`** (Cycle 25.1) — reusable publication templates with pre-built section layouts.
- **PDF rendering for print distribution** — Phase 3 ops.
- **Email HTML template builder** — Phase 3 ops; plain-text delivery via Cycle 14 fan-out is the current path.
- **Analytics dashboard** (open + click rates) — Phase 2 polish.
- **District-level publications** — school-level only this cycle.
- **Scheduled future publishing cron** — schema ready (`scheduled_publish_at`); cron worker is Phase 3.
- **`PUB-003` permission rename** — catalogue currently labels PUB-003 "Parent Portal" but Cycle 25 uses it as the Distribution gate per the plan's PUB-001..003 mapping. Rename the catalogue label before pilot to match runtime semantics.
