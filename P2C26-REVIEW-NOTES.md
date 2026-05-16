# REVIEW NOTES — Phase 2 Cycle 26 (P2-26 Publications Advanced)

**Purpose.** Architecture review scaffold for P2-26. Lists the 4 structural keystones, the contract each commits to, and the per-keystone verification trail an external reviewer can cache-bust against.

**Status:** Ready for Round 1 peer review.

**Build state at this commit:** Migration 166 applied; seed-publications-advanced.ts + seed-publications-templates-platform.ts both ran idempotently; 17 new endpoints registered on boot; 1386/1386 vitest tests pass; format:check + lint:logs both clean.

---

## Keystone 1 — Version Immutability (ADR-010)

### Contract

`pub_publication_versions` is IMMUTABLE per ADR-010. The `VersionService` class is the sole writer and exposes ONLY list / getById / checkpoint / revert / captureForStatusChange (internal hook). **NO update method, NO patch method, NO delete method, NO remove method on the prototype.**

Revert is APPEND-ONLY. When the editor reverts to v3, the service:

1. Reads `pub_publication_versions WHERE publication_id=? AND version_number=3` to fetch the target snapshot.
2. INSERTs a NEW row at `version_number = MAX + 1` with `trigger='REVERT'`, `reverted_from_version=3`, and `snapshot_content` copied from the target.
3. Never touches the existing rows.

### Where to look

- `apps/api/src/publications/versions.service.ts:81-208` — class definition + 5 public methods.
- `apps/api/src/publications/versions.service.ts:218-260` — `captureForStatusChange` (internal hook).
- `apps/api/src/publications/versions.service.ts:262-310` — `captureInTx` private helper (shared by checkpoint + captureForStatusChange).
- Spec: `apps/api/src/publications/__tests__/publications-advanced.spec.ts:127-185` — S1 describe block. The "VersionService prototype has NO update or delete method" test introspects the prototype via `Object.getOwnPropertyNames(proto)` and confirms the absence.

### Auto-version hook

`PublicationService.patchStatus` calls `versionService.captureForStatusChange(client, id, actor.accountId, note)` inside the same locked tenant tx as the status flip. The hook is wired via `PublicationsModule.onModuleInit()` (setter pattern, not constructor injection) to break the circular dependency that would otherwise form:

- `apps/api/src/publications/series.service.ts:432-447` — PublicationService constructor + setVersionService setter.
- `apps/api/src/publications/series.service.ts:660-680` — patchStatus auto-hook call.
- `apps/api/src/publications/publications.module.ts:78-91` — PublicationsModule.onModuleInit calls the setter.

### Reviewer cache-bust checklist

1. Read `apps/api/src/publications/versions.service.ts`. Confirm `class VersionService` exposes only the documented methods.
2. Read `apps/api/src/publications/series.service.ts` lines 656-682. Confirm the auto-hook fires before `getById(id, actor)` returns.
3. Read `apps/api/src/publications/publications.module.ts`. Confirm `onModuleInit` wires `setVersionService`.
4. Run `cd apps/api && pnpm exec vitest run src/publications/__tests__/publications-advanced.spec.ts -t "S1 — Version IMMUTABLE"` — expect 4/4 pass.

---

## Keystone 2 — Revert as New Version (Append-Only)

### Contract

A revert to v3 creates a NEW row at v(max+1) with `trigger='REVERT'` and `reverted_from_version=3`. The schema's `revert_chk` multi-column CHECK enforces the lockstep:

```sql
CONSTRAINT pub_versions_revert_chk
  CHECK (
    (trigger = 'REVERT' AND reverted_from_version IS NOT NULL)
    OR (trigger <> 'REVERT' AND reverted_from_version IS NULL)
  )
```

Service-side, `VersionService.revert()` is the only path that produces a REVERT row. The method:

1. Reads the target snapshot (404 if missing).
2. Computes `nextVersionNumber = MAX(version_number) + 1` inside the tx.
3. INSERTs the new row with `trigger='REVERT'` + `reverted_from_version=target` + `snapshot_content=target.snapshot_content`.
4. Catches 23505 on the UNIQUE(publication_id, version_number) constraint and translates to a 409 conflict.

### Where to look

- `apps/api/src/publications/versions.service.ts:166-209` — `revert()` method.
- `packages/database/prisma/tenant/migrations/166_pub_versions_templates_scheduled_analytics.sql:104-119` — schema-side `revert_chk` definition.
- Spec: `apps/api/src/publications/__tests__/publications-advanced.spec.ts:187-235` — S1 revert tests.

### Reviewer cache-bust checklist

1. Read `versions.service.ts:166-209` — confirm INSERT only, no UPDATE.
2. Read migration 166 lines 100-120 — confirm `revert_chk` exists as documented.
3. Run live verification on a fresh DB:
   ```sql
   SET search_path TO tenant_demo, platform, public;
   -- T1: REVERT without reverted_from_version
   INSERT INTO pub_publication_versions (id, publication_id, version_number, snapshot_content, trigger, created_by)
   VALUES (gen_random_uuid(), '<some-pub-id>'::uuid, 99, '{}'::jsonb, 'REVERT', gen_random_uuid());
   -- Expect: ERROR violates check constraint "pub_versions_revert_chk"
   ```

---

## Keystone 3 — Template `is_system` Protection + COALESCE-Sentinel UNIQUE

### Contract

System templates (platform-seeded via `seed-publications-templates-platform.ts`) have `is_system=true` AND `school_id IS NULL`. The schema's `system_chk` multi-column CHECK enforces this pairing:

```sql
CONSTRAINT pub_templates_system_chk
  CHECK ((is_system = true AND school_id IS NULL) OR (is_system = false))
```

`TemplateService.patch` AND `TemplateService.remove` **refuse any mutation against `is_system=true` rows with 403**, even for school admins. Only the platform seeder writes those rows.

The COALESCE-sentinel UNIQUE INDEX lets a platform-seeded template coexist with same-name custom rows per school:

```sql
CREATE UNIQUE INDEX pub_templates_school_name_uq
  ON pub_templates (
    COALESCE(school_id, '00000000-0000-0000-0000-000000000000'::uuid),
    name
  );
```

Same as the Cycle 5 sch_periods, Cycle 6 enr_intake_capacities, Cycle 12 lib_reading_lists pattern.

### Where to look

- `apps/api/src/publications/versions.service.ts:407-435` — `TemplateService.patch` is_system rejection.
- `apps/api/src/publications/versions.service.ts:455-475` — `TemplateService.remove` is_system rejection.
- `packages/database/prisma/tenant/migrations/166_pub_versions_templates_scheduled_analytics.sql:138-160` — table + system_chk + COALESCE UNIQUE.
- Spec: `apps/api/src/publications/__tests__/publications-advanced.spec.ts:237-289` — S2 patch + delete is_system tests.

### Reviewer cache-bust checklist

1. Read `versions.service.ts:407-475` — confirm both patch + remove call `if (cur[0].is_system) throw new ForbiddenException(...)`.
2. Read migration 166 lines 138-165 — confirm system_chk + COALESCE UNIQUE both present.
3. Run `cd apps/api && pnpm exec vitest run src/publications/__tests__/publications-advanced.spec.ts -t "S2"` — expect 4/4 pass.

---

## Keystone 4 — Scheduled Publish Atomic State Machine + Deterministic Event ID

### Contract

`ScheduledPublishWorker.tickForSchool` runs entirely inside `executeInExplicitSchema` per tenant. Per ripe row (`status='SCHEDULED' AND scheduled_at <= now()`):

1. UPDATE schedule row → `status='PUBLISHED'`, `published_at=now()` (multi-column `published_chk` lockstep satisfied atomically).
2. If parent publication isn't already PUBLISHED, UPDATE it → `status='PUBLISHED'`, `published_at=now()`. (The auto-hook on PublicationService.patchStatus would normally fire here, but the worker bypasses the service and writes SQL directly to avoid a circular-ish path — so the worker manually inserts the final STATUS_CHANGE version inline.)
3. INSERT into pub_publication_versions with trigger='STATUS_CHANGE' + version_note='Published by ScheduledPublishWorker'.
4. Count `pub_distribution_recipients` for the publication (audience pre-materialised by `DistributionService.distribute`).
5. `outbox.enqueueInTx(client, {topic:'pub.publication.published', payload:{...}, eventId: deterministicPublicationPublishedEventId(publicationId)})`.

The deterministic event_id keys on `publicationId`:

```ts
function deterministicPublicationPublishedEventId(publicationId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(publicationId + ':pub.publication.published:v1')
      .digest(),
  );
}
```

This guarantees that a redelivery from the worker AND from `DistributionService.distribute` (the Cycle 25 manual-distribute path) produce the same envelope — the downstream Cycle 14 communications fan-out consumer's idempotency claim catches the dup cleanly.

On failure: `worker_attempts += 1`, `last_error` truncated to 500 chars, row stays SCHEDULED so the next poll retries.

### Where to look

- `apps/api/src/publications/scheduled-publish.service.ts:430-560` — `ScheduledPublishWorker.tickForSchool` flow.
- `apps/api/src/publications/event-ids.ts` — deterministic id helper.
- `packages/database/prisma/tenant/migrations/166_pub_versions_templates_scheduled_analytics.sql:175-220` — schedule table with published_chk + cancelled_chk lockstep.
- Spec: `apps/api/src/publications/__tests__/publications-advanced.spec.ts:291-360` — S3 schedule tests.

### Reviewer cache-bust checklist

1. Read `scheduled-publish.service.ts:430-560` — confirm the atomic tx structure + deterministic event_id usage.
2. Read `event-ids.ts` — confirm v5-shape + sha256 + the `:v1` versioning marker.
3. Read migration 166 lines 165-225 — confirm published_chk + cancelled_chk both have the multi-column lockstep shape.
4. Run `cd apps/api && pnpm exec vitest run src/publications/__tests__/publications-advanced.spec.ts -t "S3"` — expect 5/5 pass.

---

## Keystone 5 — Analytics Atomic Counter Approach

### Contract

`PublicationAnalyticsService.ingestEvent` issues SQL-level INCREMENT statements (`UPDATE ... SET total_views = total_views + 1`) rather than read-then-write. This means:

1. Two concurrent VIEW events from the Cycle 14 fan-out pipeline cannot lose counts — Postgres serialises the UPDATEs on the same row.
2. The `counters_chk` constraint guarantees every counter is `>= 0` so a buggy decrement cannot land a negative.
3. Unique-view dedup uses Redis SADD (with 24h TTL on the SET) — `unique_views` increments only when the recipient_account_id is new to the set within the 24h window. When Redis is unavailable, the SADD returns 0 and unique_views does NOT increment (degrades gracefully).
4. VIEW events with `readTimeSeconds` populated apply the running-average formula `avg_new = avg_old + ((value - avg_old) / count)` inside the same UPDATE so concurrent writes can't drift the average.

The first event for a publication upserts a zero-shell row via `INSERT ... ON CONFLICT (publication_id) DO NOTHING` before the UPDATE — solves the "first event arrives before any UI ever read /analytics" race.

### Where to look

- `apps/api/src/publications/scheduled-publish.service.ts:284-345` — `ingestEvent` implementation.
- `apps/api/src/notifications/redis.service.ts:441-465` — `markUniquePublicationView` helper.
- `packages/database/prisma/tenant/migrations/166_pub_versions_templates_scheduled_analytics.sql:225-255` — table + counters_chk.
- Spec: `apps/api/src/publications/__tests__/publications-advanced.spec.ts:362-440` — S4 analytics tests.

### Reviewer cache-bust checklist

1. Read `scheduled-publish.service.ts:284-345`. Confirm the UPDATE issues `total_views = total_views + 1` (not a JS-side compute).
2. Read `redis.service.ts:441-465`. Confirm SADD returns the new-member count.
3. Run `cd apps/api && pnpm exec vitest run src/publications/__tests__/publications-advanced.spec.ts -t "S4"` — expect 4/4 pass.

---

## Visibility Matrix (Step 9 keystone)

| Surface                                               |  Admin   | Editor (pub-001:write STAFF) | Collaborator (any role) | Parent (GUARDIAN) | Student  | Other reader |
| ----------------------------------------------------- | :------: | :--------------------------: | :---------------------: | :---------------: | :------: | :----------: |
| `GET /publications/:id/versions`                      |    ✅    |              ✅              |           ✅            |     ❌ (403)      | ❌ (403) |   ❌ (404)   |
| `POST /publications/:id/checkpoint`                   |    ✅    |              ✅              |           ✅            |     ❌ (403)      | ❌ (403) |   ❌ (404)   |
| `POST /publications/:id/revert/:versionNumber`        |    ✅    |              ✅              |           ✅            |     ❌ (403)      | ❌ (403) |   ❌ (404)   |
| `POST /publications/templates`                        |    ✅    |          ✅ (STAFF)          |        ❌ (403)         |     ❌ (403)      | ❌ (403) |   ❌ (403)   |
| `PATCH /publications/templates/:id` (is_system=true)  | ❌ (403) |           ❌ (403)           |        ❌ (403)         |     ❌ (403)      | ❌ (403) |   ❌ (403)   |
| `DELETE /publications/templates/:id` (is_system=true) | ❌ (403) |           ❌ (403)           |        ❌ (403)         |     ❌ (403)      | ❌ (403) |   ❌ (403)   |
| `POST /publications/from-template/:id`                |    ✅    |          ✅ (STAFF)          |        ❌ (403)         |     ❌ (403)      | ❌ (403) |   ❌ (403)   |
| `POST /publications/:id/schedule`                     |    ✅    |              ✅              |           ✅            |     ❌ (403)      | ❌ (403) |   ❌ (404)   |
| `DELETE /publications/:id/schedule`                   |    ✅    |              ✅              |           ✅            |     ❌ (403)      | ❌ (403) |   ❌ (404)   |
| `GET /publications/:id/analytics`                     |    ✅    |              ✅              |           ✅            |     ❌ (403)      | ❌ (403) |   ❌ (403)   |
| `GET /publications/analytics/summary`                 |    ✅    |           ❌ (403)           |        ❌ (403)         |     ❌ (403)      | ❌ (403) |   ❌ (403)   |

The `canEditPublication` helper (shared with Cycle 25) drives the visibility for versions / scheduled / analytics. `TemplateService.assertCanManage` adds the additional `personType === 'STAFF'` restriction. `PublicationAnalyticsService.summary` is school-admin-only at the service layer.

Don't-leak-existence pattern: VersionService.assertCanAccess returns 404 (not 403) for non-existent publications.

---

## Carry-overs for Phase 2 punch list (non-blocking)

1. Visual diff renderer between two versions (UI-only — backend already returns full snapshots).
2. IANA timezone validation on schedule submission + wall-clock-in-school-timezone helper on the queue page.
3. Exponential backoff on ScheduledPublishWorker retry (currently 1m fixed).
4. Cycle 14 NotificationConsumer wiring on `pub.publication.published` for IN_APP fan-out (the emit lands cleanly today; the consumer ships in the next Communications cycle).
5. Snapshot trimming for very large publications (only the diff from previous, with periodic full snapshot).
6. School-custom template Edit modal on `/publications/templates` (PATCH endpoint exists; UI surface deferred).

---

## Round 1 reviewer prompt suggestion

> Phase 2 Cycle 26 (P2-26 Publications Advanced) ships 4 tables + 17 endpoints + 2 services + 1 worker + auto-version hook for the existing PublicationService.patchStatus. Review the 4 structural keystones and the visibility matrix. Cache-bust each affected file in code — do NOT trust HANDOFF-P2C26.md or P2C26-REVIEW-NOTES.md alone.
>
> Specifically verify:
>
> 1. `VersionService` prototype contains NO mutation methods.
> 2. `TemplateService.patch` AND `TemplateService.remove` refuse is_system=true with 403.
> 3. `ScheduledPublishWorker` uses `deterministicPublicationPublishedEventId(publicationId)` — keyed on publication ID, not schedule ID, so the same envelope fires from both DistributionService.distribute and the worker.
> 4. `PublicationAnalyticsService.ingestEvent` issues SQL-level `counter = counter + 1` (atomic).
> 5. The auto-version hook on `PublicationService.patchStatus` fires inside the same locked tenant tx as the status flip.
>
> Build at: `<commit hash>`. Run `cd apps/api && pnpm exec vitest run src/publications/__tests__/publications-advanced.spec.ts` to confirm all 24 tests pass.

---

## REVIEW-P2C26 Round 1 — verification trail

**Round 1 verdict against the initial cycle ship:** REJECT pending 5 BLOCKING + 2 MAJOR. The triage was binary across the file boundaries: every fix is in the same systemic class — service-layer reads / writes that resolved direct-object refs by surrogate id alone, without joining through the parent `pub_publications.school_id`. In a multi-school tenant pool that lets School A leak / mutate School B publications via guessed UUIDs.

### Per-finding fix verification

| ID    | Finding                                                                                                                                                                                                | Fix file(s)                                                                                                  | Verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| R-B1  | TemplateService — list / getById / patch / remove / createFromTemplate did not carry a `(school_id IS NULL OR school_id = $tenant)` predicate. School-custom templates from other schools leakable. | `versions.service.ts` (TemplateService.list / getById / patch / remove / createFromTemplate)                  | 5 pinned regression tests in `publications-advanced-review-p2c26.spec.ts` (R-B1 block) assert each SQL shape now includes the predicate + that `is_system=true` rows refuse `patch` / `remove` with `ForbiddenException` AFTER the predicate succeeds. Test names are `list query allows school_id IS NULL OR school_id = $tenant` / `getById carries school predicate and 404s on miss` / `patch refuses is_system=true with 403 AFTER the school predicate lookup` / `delete refuses is_system=true with 403 AFTER the school predicate lookup` / `createFromTemplate lookup carries school predicate`. All 5 pass.        |
| R-B2  | ScheduledPublishService + Worker — list / getById / getForPublication / schedule / cancel + worker tickForSchool did not JOIN through pub_publications. Cross-school schedule mutation possible.    | `scheduled-publish.service.ts` (ScheduledPublishService.list / getById / getForPublication / schedule / cancel; ScheduledPublishWorker.tickForSchool) | 4 regression tests in R-B2 block pin the JOIN through `pub_publications p ON p.id = s.publication_id AND p.school_id = $1::uuid` (for list) or `$2::uuid` (for getById / cancel) on every code path. Schedule's pre-tx assertCanAccess existence check carries the predicate as a separate assertion. Worker fixed in the same file's `tickForSchool` — the ripe-query JOIN + per-row `UPDATE … FROM pub_publications WHERE … school_id` are documented in inline comments and pinned by the existing S3 vertical-slice tests (no new pin needed because the worker pattern was already covered by the worker integration test). |
| R-B3  | PublicationAnalyticsService — get / summary / ingestEvent / setRecipientTotal did not validate that the publicationId belonged to the calling tenant's school. Admin short-circuit fired before the existence check. | `scheduled-publish.service.ts` (PublicationAnalyticsService.get / summary / ingestEvent / setRecipientTotal + new private assertCanRead order) | 4 regression tests in R-B3 block pin the existence check fires BEFORE the admin short-circuit (a missing publication returns 404 even for admins), summary JOINs through publications with $1::uuid, ingestEvent validates ownership BEFORE any counter write (asserts 0 UPDATE statements when existence fails), and setRecipientTotal validates publication ownership before UPSERT. All 4 pass.                                                                                                                                                                                                                       |
| R-B4  | Analytics counter writes were not redelivery-safe — a Cycle 14 fan-out consumer that re-emits the same view event would double-count.                                                                  | `167_pub_analytics_contributions.sql` (NEW) + `scheduled-publish.service.ts` (PublicationAnalyticsService.ingestEvent) + `dto/publications.dto.ts` (IngestAnalyticsEventDto) | New `pub_publication_analytics_contributions` table with UNIQUE(consumer_group, source_event_id, publication_id, event_type). `ingestEvent` now wraps ledger INSERT + counter UPDATE in one tenant tx, INSERTs the ledger row first, catches 23505 via `isUniqueViolation` to short-circuit + return the current row WITHOUT bumping. DTO gains optional `consumerGroup` + `sourceEventId` fields (defaults MANUAL + fresh UUID). 2 regression tests pin (a) ledger INSERT before counter UPDATE and (b) 23505 redelivery doesn't bump counters. Both pass. Migration provisioned cleanly after splitter audit caught 2 stray `;` in COMMENT strings. |
| R-B5  | VersionService — listForPublication / getById / revert / composeSnapshot / nextVersionNumber follow-up reads did not JOIN through pub_publications. Forged version ids could surface foreign-school content. | `versions.service.ts` (VersionService.listForPublication / getById / revert + private composeSnapshot + private nextVersionNumber + checkpoint reload + captureInTx-path reload) | 2 regression tests in R-B5 block pin (a) `listForPublication` carries the school predicate on assertCanAccess existence query, and (b) `getById` JOINs through pub_publications with `p.school_id = $2::uuid` (this is a 2-arg query — $1=versionId, $2=schoolId). Both pass. The existing S1 vertical-slice tests (checkpoint / revert / proto immutability) also cover the broader contract.                                                                                                                                                                                                                                  |
| R-M1  | `assertAccountInCurrentTenant` projections (sis_students via platform_students + sis_guardians + hr_employees) had no school_id predicate. A cross-school user in the same tenant schema could satisfy. | `access.ts` (assertAccountInCurrentTenant)                                                                   | 3 regression tests in R-M1 block pin (a) each projection sub-query carries `school_id = $2::uuid`, (b) empty result raises `BadRequestException` with the supplied field-name in the message, and (c) any projection match passes the check. All 3 pass. The helper is now consistent with the Cycle 25 / Cycle 12 / Cycle 11 / Cycle 14 / Cycle 22 / Cycle 24 pattern.                                                                                                                                                                                                                                                  |
| R-M2  | Inline version capture in `ScheduledPublishWorker.tickForSchool` was not clearly documented as deliberate vs accidental dependency avoidance. Future maintainers might reach for `VersionService.captureForStatusChange` instead. | `scheduled-publish.service.ts` inline comments + this handoff section                                       | Worker-side comments + handoff doc now spell out that the worker INSERTs the final STATUS_CHANGE version row via direct SQL (not via VersionService.captureForStatusChange) to avoid pulling the request-path service + its setter-wired VersionService dependency into a background worker. The inline INSERT mirrors `VersionService.captureInTx` + carries the school predicate through the parent publication JOIN. Documentation-only fix — no behavioral change.                                                                                                                                                  |

### CI parity green

- `pnpm format:check` — clean
- `pnpm lint:logs` — clean (956 files)
- `pnpm --filter @campusos/api build` — clean
- `pnpm --filter @campusos/web build` — clean (all routes ship)
- `pnpm --filter @campusos/api exec vitest run` — **1406 / 1406 passing across 67 spec files** (+20 new pinned regression tests in `publications-advanced-review-p2c26.spec.ts`)

### Schema delta

- 1 additive tenant migration `167_pub_analytics_contributions.sql` adds the contribution ledger table + UNIQUE INDEX. Splitter-safe; idempotent. Provisioned cleanly to both `tenant_demo` and `tenant_test`. Tenant logical base table count climbs by 1 (the partition leaves of the existing partitioned tables are still not counted as logical base tables).

### Awaiting Round 2 verdict

Tag `p2c26-complete` after Round 2 APPROVED. The Phase 2 / pre-pilot punch list items from the initial ship remain unchanged.

---

## REVIEW-P2C26 Round 2 — PASS verdict (final gate)

**Round 2 verdict against `e66e757`:** `Approved`. Reviewer cache-busted each affected file in code on Round 2 and confirmed every Round 1 fix matches:

| Prior Finding | Status | Evidence |
| --- | --- | --- |
| Template list/get/patch/delete/from-template not school-scoped | FIXED | Reads use `school_id IS NULL OR school_id = tenant.schoolId`; writes require `school_id = tenant.schoolId`; system templates remain read-only |
| Scheduled publication list/get/cancel/schedule + worker sweep not school-scoped | FIXED | Request paths join through `pub_publications.school_id`; worker ripe query, schedule update, parent publication update, inline version insert, recipient count, failure update all carry school ownership |
| Publication analytics get/summary/ingest/setRecipientTotal not school-scoped | FIXED | Analytics paths join through `pub_publications.school_id`; publication ownership validation happens before school-admin short-circuit |
| Analytics additive counters not redelivery-safe | FIXED | New contribution table `pub_publication_analytics_contributions` enforces UNIQUE(consumer_group, source_event_id, publication_id, event_type); ingestEvent inserts ledger row before counter update in one tenant transaction and short-circuits on duplicate 23505 |
| Version follow-up reads/reloads not school-scoped | FIXED | `listForPublication`, `getById`, `revert`, `composeSnapshot`, `nextVersionNumber`, checkpoint reload, captureInTx reload paths all join through `pub_publications.school_id` |
| `assertAccountInCurrentTenant` lacked school predicates | FIXED | Student / guardian / employee projection checks carry `school_id = tenant.schoolId`, preventing cross-school collaborator/account validation |
| Worker inline version capture comments misleading | FIXED | Handoff + inline comments document that the scheduled-publish worker performs direct SQL for the final status-change version rather than invoking the request-path service |
| Regression coverage | FIXED | New `publications-advanced-review-p2c26.spec.ts` adds 20 pinned tests covering the 5 blockers + 2 majors; original 24 tests updated for the new SQL shapes; suite 1406/1406 |

**Updated dimension scores:** Templates / Scheduled Publishing / Publication Analytics / Version History / Account Projection Helper / Test Coverage — all `PASS`.

**Final gate: PASS.** P2-26 tagged `p2c26-complete` at `e66e757` (the Round 1 fix commit that earned Round 2 PASS) and `p2c26-approved` at the closeout commit. Publications Advanced now meets the Phase 2 bar for school-scoped object references, school-safe worker processing, redelivery-safe analytics counters, and regression coverage.
