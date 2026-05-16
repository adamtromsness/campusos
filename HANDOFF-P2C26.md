# HANDOFF — Phase 2 Cycle 26 (P2-26 Publications Advanced, M25 .1)

**Wave D — Module Completion.** P2-26 closes the M25 Publications deferred-table surface that Cycle 25 left in scope. Cycle 25 shipped the core publications surface (series + editions + publications + collaborators + sections + comments + distribution lists + recipients + subscriptions — 11 tables, 34 endpoints). P2-26 lands the 4 advanced tables that complete the editorial workflow: immutable version history with full content snapshots on every status transition, reusable publication templates (platform-seeded + school-custom) with auto-populated section structures, scheduled publishing with timezone-aware queue processing, and per-publication engagement analytics with atomic counter increments.

**Status — COMPLETE pending peer review.** All 7 user-defined steps shipped in a single session (no split). Awaiting Round 1 verdict before tagging `p2c26-complete`.

---

## Plan / Reference Documents

- Plan: `docs/campusos-p2c26-publications-advanced.html`
- Cycle 25 closeout: `HANDOFF-P2C25.md` (the foundation this cycle builds on)
- Review scaffold: `P2C26-REVIEW-NOTES.md`

---

## Step Status

| Step | Title                                                                    | Status     | Notes                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Schema (4 tables) — `166_pub_versions_templates_scheduled_analytics.sql` | ✅ shipped | 4 logical base tables, 4 intra-tenant FKs (CASCADE × 3 + SET NULL × 1), 0 cross-schema FKs. 22 live-verified assertions on `tenant_demo`.                             |
| 2    | Seed data — `seed-publications-advanced.ts`                              | ✅ shipped | 5 versions for Edition #11 covering every trigger value, 3 templates (2 system + 1 custom), 1 SCHEDULED publication for Edition #12, 2 analytics rows                 |
| 3    | VersionService + TemplateService + auto-version hook                     | ✅ shipped | IMMUTABLE versions (no UPDATE/no DELETE method), revert creates new version, FROM-TEMPLATE keystone auto-populates sections, is_system protection                     |
| 4    | ScheduledPublishService + PublicationAnalyticsService + 2 workers        | ✅ shipped | Worker polls every minute, fires schedule + creates final version + emits pub.publication.published. Analytics uses SQL-level atomic increments                       |
| 5    | Publications Advanced UI                                                 | ✅ shipped | 3 new web routes (`/publications/templates`, `/publications/scheduled`, `/publications/analytics`) + version timeline + Schedule + Engagement on `/publications/[id]` |
| 6    | Vertical Slice Integration Test                                          | ✅ shipped | `publications-advanced.spec.ts` — 24 cases across 5 scenarios + 1 auto-hook integration test. 1362 → 1386 (+24) total vitest                                          |
| 7    | Platform template seeder (idempotent)                                    | ✅ shipped | `seed-publications-templates-platform.ts` — 3 system templates upserted into every active tenant via COALESCE-sentinel UNIQUE                                         |

---

## Schema Migration

### `166_pub_versions_templates_scheduled_analytics.sql` (Step 1)

Four new tenant base tables:

1. **`pub_publication_versions`** — **IMMUTABLE** per ADR-010. No UPDATE method, no DELETE method at the service layer. Each row is a complete JSONB snapshot of the publication's content at a point in time.
   - `publication_id UUID NOT NULL FK pub_publications ON DELETE CASCADE`
   - `version_number INT NOT NULL CHECK (version_number > 0)`
   - `snapshot_content JSONB NOT NULL` — `{title, status, publicationType, publishedAt, sections: [{id, title, body, sectionType, sortOrder, isApproved}]}`
   - `trigger TEXT NOT NULL CHECK (trigger IN ('STATUS_CHANGE','MANUAL_CHECKPOINT','REVERT'))`
   - `reverted_from_version INT` — populated only on REVERT rows
   - **Multi-column `revert_chk` keystone** — `(trigger = 'REVERT' AND reverted_from_version IS NOT NULL) OR (trigger <> 'REVERT' AND reverted_from_version IS NULL)`
   - UNIQUE(publication_id, version_number) — monotonic version counter
   - Indexes: `(publication_id, version_number DESC)` + `(created_at DESC)`

2. **`pub_templates`** — reusable publication structure.
   - `school_id UUID` nullable — NULL means platform-seeded
   - `name TEXT NOT NULL`
   - `publication_type TEXT NOT NULL CHECK` (6-value mirror of pub_publications)
   - `template_content JSONB NOT NULL` — `{sections: [{title, sortOrder, ownerHint}], suggestedFrequency, defaultDistributionLists}`
   - `is_system BOOLEAN NOT NULL DEFAULT false`
   - `parent_template_id UUID FK pub_templates ON DELETE SET NULL` (historical reference for the from-template path)
   - **Multi-column `system_chk` keystone** — `(is_system = true AND school_id IS NULL) OR (is_system = false)`
   - **COALESCE-sentinel UNIQUE INDEX** — `(COALESCE(school_id, '00000000-0000-0000-0000-000000000000'::uuid), name)` so a platform-seeded "Monthly Newsletter" coexists with same-name custom rows in each tenant

3. **`pub_scheduled_publications`** — editor-scheduled publish queue. **UNIQUE(publication_id)** so a publication carries at most one active schedule.
   - `scheduled_at TIMESTAMPTZ NOT NULL`
   - `timezone TEXT NOT NULL DEFAULT 'America/Chicago'` — display zone only; DB stores every timestamp in UTC per ADR convention
   - `status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','PUBLISHED','CANCELLED'))`
   - `worker_attempts INT NOT NULL DEFAULT 0` + `last_error TEXT` — populated by the Step 4 worker on transient failures
   - **Multi-column `published_chk` lockstep** — `(status = 'PUBLISHED' AND published_at IS NOT NULL) OR (status <> 'PUBLISHED' AND published_at IS NULL)`
   - **Multi-column `cancelled_chk` lockstep** — `(status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL) OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL)`
   - Partial INDEX `(status, scheduled_at) WHERE status = 'SCHEDULED'` — the worker's hot path

4. **`pub_publication_analytics`** — per-publication engagement counters. `publication_id` is both PK and FK CASCADE to `pub_publications`.
   - `total_recipients`, `total_views`, `unique_views`, `total_opens`, `total_link_clicks`, `total_bounces` — all `INT NOT NULL DEFAULT 0`
   - `avg_read_time_seconds INT` nullable
   - **Multi-column `counters_chk`** — every counter `>= 0`
   - Counters are incremented atomically via SQL-level `UPDATE ... SET counter = counter + 1` so concurrent events cannot lose counts

**Tenant logical base table count** after migration 166: `tenant_demo` reports 1244 tables including partition leaves. Cycle-specific count: +4 (`pub_publication_versions`, `pub_templates`, `pub_scheduled_publications`, `pub_publication_analytics`).

**Splitter audit** — 1 stray `;` caught in the block-comment header pre-provision (rewritten with em-dash); both `tenant_demo` + `tenant_test` provisioned cleanly on first attempt after audit. **38th migration in a row to clear the splitter trap on first provision attempt after audit** (Cycles 4–P2-26 unbroken streak).

---

## Backend Module (Step 3 + Step 4)

`apps/api/src/publications/` extended with:

### `versions.service.ts` (~520 LoC)

- **`VersionService`** — sole writer to `pub_publication_versions`. Exposes ONLY:
  - `listForPublication(actor, publicationId)` — list without snapshot_content
  - `getById(actor, versionId)` — full snapshot
  - `checkpoint(actor, publicationId, input)` — INSERT with trigger=MANUAL_CHECKPOINT
  - `revert(actor, publicationId, versionNumber, input)` — REVERT KEYSTONE: reads target snapshot, INSERTs new row at version_number = max+1 with trigger='REVERT' and `reverted_from_version` populated
  - `captureForStatusChange(client, publicationId, accountId, note)` — internal helper called by `PublicationService.patchStatus` inside its locked tx
  - **NO UPDATE METHOD. NO DELETE METHOD.** Confirmed via prototype introspection in the spec.

- **`TemplateService`** — CRUD + the from-template keystone:
  - `list(actor, includeInactive)` — returns system + custom templates
  - `getById(actor, id)`
  - `create(actor, input)` — always writes `is_system=false`
  - `patch(actor, id, input)` — **rejects `is_system=true` with 403**
  - `remove(actor, id)` — **rejects `is_system=true` with 403**
  - `createFromTemplate(actor, templateId, input)` — FROM-TEMPLATE KEYSTONE: validates `is_active=true`, INSERTs `pub_publications` + auto-populates `pub_sections` from `template_content.sections`, all inside one tenant tx

### `scheduled-publish.service.ts` (~600 LoC)

- **`ScheduledPublishService`** — request-path CRUD for scheduling:
  - `list(actor)` — every active schedule
  - `getById(actor, id)`
  - `getForPublication(actor, publicationId)` — returns the active schedule (if any) or null
  - `schedule(actor, publicationId, input)` — validates timestamp is valid + future, validates parent publication is in DRAFT/IN_REVIEW/APPROVED, UNIQUE catch on duplicate schedule
  - `cancel(actor, publicationId, input)` — locks row inside tx, flips status to CANCELLED with cancelled_at + cancelled_by populated atomically per multi-column lockstep

- **`PublicationAnalyticsService`** — atomic-counter ingestion + reads:
  - `get(actor, publicationId)` — returns analytics row (zero-shell if none)
  - `summary(actor)` — admin-only school-wide rollup (top 100 by `last_event_at DESC`)
  - `ingestEvent(publicationId, input)` — the **ATOMIC COUNTER KEYSTONE**: upserts a zero-shell row if needed, then runs `UPDATE pub_publication_analytics SET total_views = total_views + 1, unique_views = unique_views + $1, ...` — SQL-level INCREMENT so concurrent events cannot lose counts. VIEW events with `readTimeSeconds` populated apply the running-average formula `avg_new = avg_old + ((value - avg_old) / count)`. Unique-view dedup via Redis SADD on `notif:pub-views:{publicationId}` with 24h TTL (SADD returns 1 if new → unique_views += 1).
  - `setRecipientTotal(publicationId, total)` — called by DistributionService.distribute + ScheduledPublishWorker once audience is materialised

- **`ScheduledPublishWorker`** — polls every minute (configurable via `PUB_SCHEDULED_PUBLISH_INTERVAL_MS`). Per active school:
  - Selects ripe rows (`status='SCHEDULED' AND scheduled_at <= now()`) via the partial INDEX hot path
  - For each: flips schedule to PUBLISHED + flips parent publication to PUBLISHED if not already + auto-creates final STATUS_CHANGE version + enqueues `pub.publication.published` to the platform outbox INSIDE the same tenant tx
  - Deterministic event_id via `deterministicPublicationPublishedEventId(publicationId)` so a redelivery from this worker AND from `DistributionService.distribute` produce the same envelope (key=publicationId)
  - On transient failure: bumps `worker_attempts` + records `last_error` (truncated 500 chars) — row stays SCHEDULED for the next poll

### `event-ids.ts` (new file)

Exports `deterministicPublicationPublishedEventId(publicationId)` — SHA-256 first 16 bytes reshaped into a v5-shape UUID. Matches the helpers across Cycles 11 / 12 / P2-12 / P2-14 / P2-20 / P2-21 / P2-22 / P2-23 / P2-24 / P2-25.

### Auto-version hook (the Step 3 keystone)

`PublicationsModule.onModuleInit()` calls `publicationService.setVersionService(versionService)` to bridge the two services without a circular constructor dependency. Then `PublicationService.patchStatus` calls `versionService.captureForStatusChange(client, id, actor.accountId, ...)` inside the same locked tenant tx as the status flip — every DRAFT → IN_REVIEW → APPROVED → PUBLISHED transition creates a STATUS_CHANGE version automatically.

### Controller (`publications.controller.ts`)

Adds 17 new endpoints under PUB-001 permission codes:

- **Version history** (4): `GET /publications/:id/versions`, `GET /publications/versions/:versionId`, `POST /publications/:id/checkpoint`, `POST /publications/:id/revert/:versionNumber`
- **Templates** (6): `GET /publications/templates`, `GET /publications/templates/:id`, `POST /publications/templates`, `PATCH /publications/templates/:id`, `DELETE /publications/templates/:id`, `POST /publications/from-template/:templateId`
- **Scheduled publishing** (4): `GET /publications/scheduled`, `GET /publications/:id/schedule`, `POST /publications/:id/schedule`, `DELETE /publications/:id/schedule`
- **Analytics** (3): `GET /publications/:id/analytics`, `GET /publications/analytics/summary`, `POST /publications/:id/analytics/events`

Total Publications endpoints after P2-26: **51** (34 from Cycle 25 + 17 new).

---

## Seed Data (Step 2 + Step 7)

### `seed-publications-advanced.ts` — tenant-scoped (tenant_demo)

Idempotent (gated on `pub_publication_versions` row count). 5 sections:

- 5 versions for "The Weekly Eagle — Edition #11" covering every trigger value (v1 STATUS_CHANGE / v2 MANUAL_CHECKPOINT / v3 STATUS_CHANGE / v4 REVERT with `reverted_from_version=1` / v5 STATUS_CHANGE PUBLISHED)
- 3 templates (2 system + 1 custom — "Lincoln Custom Newsletter" school-specific)
- 1 SCHEDULED publication for Edition #12 set to next Friday at 3pm Central (20:00 UTC during DST)
- 2 analytics rows: Edition #11 with realistic numbers (450 views / 312 unique / 89 clicks / 2 bounces / 145s avg read) and "End of Year Reminders" bulletin (smaller)
- No new permission codes — PUB-001 already exists from Cycle 25

### `seed-publications-templates-platform.ts` — platform-tier (every active tenant)

Idempotent at every layer:

- Iterates over `platform.platform_tenant_routing WHERE is_active = true` so new tenants pick up templates on the next run
- Per (tenant, template name): `ON CONFLICT (COALESCE(school_id, sentinel-uuid), name) DO NOTHING` so re-runs against existing rows are no-ops
- 3 system templates: Monthly School Newsletter (5 sections), Weekly Bulletin (2 sections), Annual Report (7 sections)
- All rows: `is_system=true`, `school_id=NULL`, `template_content` JSONB with sections + suggested frequency + default distribution lists
- Re-run output: `0 template row(s) inserted, 3 skipped (already present)` — verified idempotent on tenant_demo

Wired into `seed-all.ts` chain after `seed:publications` and before `seed:publications-advanced` so the templates exist when the advanced seed inserts versions / scheduled rows.

---

## Web Surface (Step 5)

3 new routes + extended publication detail page:

- **`/publications/templates`** — system + custom template grid with `Use template →` CTA opening a modal that POSTs `/publications/from-template/:id` with a title. New-custom-template modal for school admins / staff. System templates render with a blue tinted card + read-only badge.
- **`/publications/scheduled`** — queue with status pills (SCHEDULED amber / PUBLISHED emerald / CANCELLED gray) + countdown ("in 2d 14h") + worker attempts + scheduled-by column.
- **`/publications/analytics`** — school-wide engagement summary table sorted by total views DESC. Per-row: recipients, views, unique, opens, clicks, bounces (rose), open-rate %, last event.
- **`/publications/[id]`** — existing detail page extended with: Save-checkpoint button + Schedule-publish button (visible when canEdit and no active schedule and status≠PUBLISHED). Scheduled-publish amber panel renders when active. 4×2 Engagement grid renders when analytics row exists. Version history timeline with per-row Revert button + RevertModal explaining the append-only contract.

Modal usage: all 3 modals on the detail page (Checkpoint, Schedule, Revert) pass `open={true}` since they're conditionally rendered (`{showCheckpoint && <CheckpointModal ... />}`).

Format helpers in `apps/web/src/lib/publications-format.ts`: `VERSION_TRIGGER_LABELS` + `VERSION_TRIGGER_PILL` + `SCHEDULED_STATUS_LABELS` + `SCHEDULED_STATUS_PILL` + `formatCountdown` + `formatEngagement`.

13 new React Query hooks in `apps/web/src/hooks/use-publications.ts`: useVersionsForPublication, useVersionDetail, useCheckpointVersion, useRevertToVersion, useTemplates, useTemplate, useCreateTemplate, useUpdateTemplate, useDeleteTemplate, useCreateFromTemplate, useScheduledPublications, useScheduleForPublication, useSchedulePublication, useCancelSchedule, usePublicationAnalytics, usePublicationAnalyticsSummary, useIngestAnalyticsEvent.

Build sizes: `/publications/templates` 6.29 kB / `/publications/scheduled` 2.8 kB / `/publications/analytics` 2.86 kB First Load JS.

---

## Tests (Step 6)

`apps/api/src/publications/__tests__/publications-advanced.spec.ts` — 24 cases across 6 describe blocks:

- **S1 Version IMMUTABLE** (4 cases) — prototype has NO update/delete/patch/remove method; checkpoint INSERTs MANUAL_CHECKPOINT (no UPDATE); revert creates NEW version (no UPDATE); 404 on missing target
- **S2 Templates** (4 cases) — patch is_system=true 403; delete is_system=true 403; from-template auto-populates sections; from-template inactive 400
- **S3 Scheduled publishing** (5 cases) — past timestamp 400; invalid timestamp 400; cancel locks parent + flips status with cancelled_chk lockstep satisfied; cancel no-active 404; deterministicPublicationPublishedEventId stable + v5-shaped
- **S4 Analytics atomic counters** (4 cases) — VIEW issues `UPDATE ... SET total_views = total_views + 1`; LINK_CLICK increments total_link_clicks; first event upserts zero-shell; summary refuses non-admin 403
- **S5 Visibility matrix** (5 cases) — VersionService.listForPublication refuses non-collaborator 403; 404 on missing publication; TemplateService.create refuses parent (GUARDIAN) 403; refuses student 403; PublicationAnalyticsService.get refuses non-collaborator 403; ScheduledPublishService.schedule refuses non-editor 403
- **S6 captureForStatusChange auto-hook** (1 case) — inserts a row with trigger=STATUS_CHANGE (parameterised via $5) inside the supplied tx

**Vitest result: 1386 passed across 66 spec files** (1362 → 1386, +24 new P2-26 tests). CI green.

---

## CI Parity (Step 8)

- `pnpm format:check` — All matched files use Prettier code style!
- `pnpm lint:logs` — 955 files clean
- `pnpm --filter @campusos/api build` — `nest build` clean
- `pnpm --filter @campusos/web build` — clean, 3 new static routes
- `pnpm exec vitest run` (from apps/api) — 66 spec files / 1386 tests pass

---

## Permission Distribution

PUB-001 already in catalogue from Cycle 25. P2-26 added no new function code. Distribution unchanged: Teacher / Student / Parent have `pub-001:read`; Staff + admin have `pub-001:read+write`; admin tier via `everyFunction`.

**Service-layer gates enforce the access boundary for advanced surfaces:**

- VersionService — admin OR pub-001:write OR collaborator (via `canEditPublication`). Non-collaborator non-editor → 403.
- TemplateService — admin OR (pub-001:write AND personType=STAFF). Parents + students 403 even with pub-001:read.
- TemplateService.patch/remove on is_system=true rows — refused for everyone except the platform seeder. School admins 403.
- ScheduledPublishService — `canEditPublication` (same gate as version history).
- PublicationAnalyticsService.get — `canEditPublication`. summary — `actor.isSchoolAdmin` only.
- PublicationAnalyticsService.ingestEvent — gated only by `pub-001:read` at the controller (downstream from any Cycle 14 fan-out emit, no further actor scope needed because event payloads carry the recipient context).

---

## Kafka Events

- **`pub.publication.published`** (reused from Cycle 25) — fired by `DistributionService.distribute` AND now by `ScheduledPublishWorker`. Deterministic event_id via `deterministicPublicationPublishedEventId(publicationId)` so both paths produce the same envelope. Worker-fired emits set `payload.triggeredBy = 'SCHEDULED_PUBLISH_WORKER'`.

No new Kafka topics in P2-26.

---

## Reviewer attention items (carried to Phase 2 / pre-pilot)

1. **Diff rendering on version detail** — current `/publications/versions/:versionId` returns the full snapshot JSON; the UI does not yet render a visual diff between two versions. The plan's "Diff view" deliverable was scaled back to "preview any version" in the UI for this cycle.
2. **Schedule timezone tooling** — `timezone` is metadata only (display zone for editor UI). The DB stores all timestamps in UTC. A pre-pilot polish item: validate `timezone` against the IANA list at submission time, then show a wall-clock-in-school-timezone helper on the queue page.
3. **Worker retry backoff** — `ScheduledPublishWorker` retries every minute on failure. Pre-pilot may want exponential backoff (1m / 5m / 15m / 1h) before declaring the row dead.
4. **Analytics ingestion source** — `POST /publications/:id/analytics/events` is gated on `pub-001:read` and trusts the caller's `eventType`. Real-world wiring will be Cycle 14 NotificationConsumer + the Cycle 3 email tracking pixel; until then, the endpoint accepts manual events for testing.
5. **Version snapshot trimming** — current snapshot captures the full sections array; large publications could land multi-MB rows. A pre-pilot polish item: snapshot only the diff from the previous version (with a periodic full snapshot) to bound table growth.
6. **Template editor UI** — the templates page ships New + Use; an admin Edit modal for school-custom templates is a polish item (the PATCH endpoint exists and rejects is_system=true correctly).

---

## REVIEW-P2C26 Round 1 — fix log

**Round 1 verdict:** REJECT pending 5 BLOCKING + 2 MAJOR findings. Every finding traced back to the same systemic gap — direct-object reads / writes on `pub_versions / pub_templates / pub_scheduled_publications / pub_publication_analytics` were resolved by surrogate id alone, with no school predicate joined through the parent `pub_publications` row. In a multi-school tenant pool that lets School A leak / mutate School B publications via guessed UUIDs.

**Fix commit lands all 5 BLOCKING + both MAJOR + 20 new pinned regression tests + 1 new tenant migration:**

(R-B1 — TemplateService school-scope) Every read + write on `TemplateService` now joins / where-clauses through `(pub_templates.school_id IS NULL OR school_id = $tenant.schoolId)` for reads and `school_id = $tenant.schoolId` for writes. `list`, `getById`, `patch`, `remove`, and `createFromTemplate` lookup all carry the predicate. `is_system=true` rows refused on `patch` / `remove` with ForbiddenException AFTER the school-predicate lookup succeeds (so a forged template id collapses to 404 before the immutability message ever fires).

(R-B2 — ScheduledPublishService + Worker school-scope) `list`, `getById`, `getForPublication`, `schedule`, and `cancel` all JOIN through `pub_publications p ON p.id = s.publication_id AND p.school_id = $tenant.schoolId`. `schedule` locks the parent publication FOR UPDATE with the school predicate inside the same tx as the INSERT; `cancel` looks up the schedule via the parent JOIN with `FOR UPDATE OF s` and reloads via the same JOIN. `ScheduledPublishWorker.tickForSchool` ripe-query JOINs through pub_publications; the schedule UPDATE uses `FROM pub_publications WHERE ... school_id`; the parent publication UPDATE adds school_id; the inline version INSERT uses school-joined `nextVersionNumber`; the recipient count JOINs publications; the failure UPDATE on a worker hiccup carries the school predicate.

(R-B3 — PublicationAnalyticsService school-scope) `get`, `summary`, `ingestEvent`, and `setRecipientTotal` all JOIN through `pub_publications.school_id`. The publication existence check fires BEFORE the canEditPublication admin short-circuit so a school admin cannot pull foreign-school analytics by guessing a publication UUID — the previous order let `isSchoolAdmin` return early without ever validating the publication's school.

(R-B4 — Analytics contribution ledger) New tenant migration `167_pub_analytics_contributions.sql` adds the `pub_publication_analytics_contributions` table with UNIQUE(consumer_group, source_event_id, publication_id, event_type). `ingestEvent` accepts optional `consumerGroup` + `sourceEventId` (defaults `MANUAL` + fresh UUID), wraps the ledger INSERT + counter UPDATE in one `executeInTenantTransaction`, INSERTs the ledger row first, catches 23505 via `isUniqueViolation` and short-circuits to return the current analytics row WITHOUT bumping any counter. A redelivered envelope with the same (group, event_id, publication_id, event_type) tuple is now idempotent at the schema layer. The Cycle 14 fan-out consumer SHOULD pass the envelope's event_id + its consumer group when it wires this surface to live notification events.

(R-B5 — VersionService follow-up reads school-scope) `listForPublication`, `getById`, `revert`, the private `composeSnapshot`, the private `nextVersionNumber`, the checkpoint reload, and every captureInTx call path all JOIN through `pub_publications p ON p.id = v.publication_id AND p.school_id = $tenant.schoolId`. A forged version id for a foreign-school publication collapses to 404 at the SQL layer before the `assertCanAccess` permission check fires. The `assertCanAccess` helper itself was already school-scoped from the initial cycle ship; R-B5 closes the follow-up reads that loaded version rows after the access check passed.

(R-M1 — assertAccountInCurrentTenant school predicate) `access.ts::assertAccountInCurrentTenant` now carries the `school_id = $tenant.schoolId` predicate through all 3 projections (sis_students via platform_students, sis_guardians, hr_employees). Without this, a multi-school tenant pool could let a School A staff editor invite a School B platform_user as a publication collaborator (or pass their accountId to any future feature that uses this helper) because both schools live in the same tenant schema today.

(R-M2 — ScheduledPublishWorker inline version capture) Worker comments + the handoff doc now spell out that the worker INSERTs the final STATUS_CHANGE version row via direct SQL (not via `VersionService.captureForStatusChange`) so it does not pull the request-path service + its setter-wired VersionService dependency into a background worker. The inline INSERT mirrors `VersionService.captureInTx` + carries the school predicate through the parent publication JOIN. Future maintainers won't reach for the request-path service when extending the worker.

**Test coverage:** new `apps/api/src/publications/__tests__/publications-advanced-review-p2c26.spec.ts` ships 20 pinned regression tests covering R-B1 (5 tests — list / getById / patch is_system / delete is_system / createFromTemplate school predicate), R-B2 (4 tests — list / getById / schedule / cancel JOIN through publications), R-B3 (4 tests — get fires existence check first / summary JOIN / ingestEvent validates ownership / setRecipientTotal validation), R-B4 (2 tests — ingestEvent inserts ledger row before counter / redelivered 23505 short-circuits with no counter bump), R-B5 (2 tests — listForPublication carries school predicate / getById JOINs through publications), R-M1 (3 tests — each projection carries school predicate / empty result rejects with field-name message / any projection match passes). Existing `publications-advanced.spec.ts` retrofitted to match the new SQL shapes — all 24 original tests still pass. Vitest total: 1386 → **1406** across 67 spec files (+20 new pinned regression tests).

**CI parity green:** format:check clean + lint:logs (956 files) clean + API build clean + web build clean + vitest 1406/1406. One additive tenant migration `167_pub_analytics_contributions.sql` — splitter-safe; provisioned cleanly to both `tenant_demo` and `tenant_test` on first attempt after audit (caught + fixed 2 stray `;` in COMMENT strings).

**Files touched:**

- `packages/database/prisma/tenant/migrations/167_pub_analytics_contributions.sql` (NEW)
- `apps/api/src/publications/access.ts` (R-M1)
- `apps/api/src/publications/versions.service.ts` (R-B1 + R-B5)
- `apps/api/src/publications/scheduled-publish.service.ts` (R-B2 + R-B3 + R-B4 + R-M2)
- `apps/api/src/publications/dto/publications.dto.ts` (R-B4 — added `consumerGroup` + `sourceEventId` optional fields)
- `apps/api/src/publications/publications.controller.ts` (R-B3 — ingestEvent threads actor to service)
- `apps/api/src/publications/__tests__/publications-advanced.spec.ts` (test stubs updated for new SQL shapes)
- `apps/api/src/publications/__tests__/publications-advanced-review-p2c26.spec.ts` (NEW — 20 pinned regression tests)
- `HANDOFF-P2C26.md` (this Round 1 fix log section)
- `P2C26-REVIEW-NOTES.md` (Round 1 verification trail)
- `CLAUDE.md` (status section)

---

## REVIEW-P2C26 Round 2 — PASS verdict

**Round 2 verdict against `e66e757`:** `Approved` — final gate decision. Reviewer cache-busted each affected file in code on Round 2 and confirmed all 5 BLOCKING + 2 MAJOR fixes match: template read/write boundaries are school-scoped; scheduled-publish request paths + worker flow are school-scoped with durable outbox intact; analytics reads/writes are school-scoped + additive counters are redelivery-safe via the new contribution ledger; version follow-up reads + snapshot helpers carry parent publication school predicates; `assertAccountInCurrentTenant` collaborator/account validation is current-school scoped; 20 new pinned regression tests + 24 retrofitted vertical-slice tests = 44/44 publications passing within the broader 1406/1406 suite.

**Updated dimension scores (all PASS):**

| Dimension                 | Rating | Notes                                                                                                |
| ------------------------- | -----: | ---------------------------------------------------------------------------------------------------- |
| Templates                 | PASS   | System + school-custom template read/write boundaries correct                                        |
| Scheduled Publishing      | PASS   | Request paths + worker flow school-scoped; durable publish outbox intact                             |
| Publication Analytics     | PASS   | Reads/writes school-scoped; additive counters redelivery-safe                                        |
| Version History           | PASS   | Follow-up reads + snapshot helpers carry parent publication school predicates                        |
| Account Projection Helper | PASS   | Collaborator/account validation current-school scoped                                                |
| Test Coverage             | PASS   | Round 1 findings have pinned regression coverage; suite 1406/1406                                    |

**Tags applied:**

- `p2c26-complete` → `e66e757` (the Round 1 fix commit that earned Round 2 PASS)
- `p2c26-approved` → closeout commit (this commit; updates CLAUDE.md to APPROVED state + appends Round 2 PASS verdict to HANDOFF + REVIEW-NOTES)

**No carry-overs from Round 2.** The 6 reviewer attention items from the initial cycle ship (visual diff renderer, IANA timezone validation, exponential backoff on worker retry, Cycle 14 NotificationConsumer wiring on `pub.publication.published`, snapshot trimming for large publications, school-custom template Edit modal) remain on the pre-pilot polish punch list as recommendation-class work — none flagged by Round 2.

**Cycle 26 ships clean. Wave D continues.**
