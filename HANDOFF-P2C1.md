# Phase 2 Cycle 1 (P2C1) Handoff — Visitor Management

**Status: COMPLETE + APPROVED at the closeout commit (REVIEW-P2C1-CHATGPT — final verdict).** Round 4 returned **PASS**. Tagged `p2c1-complete` at `2b9ea9e` (the Round 3 fix commit) and `p2c1-approved` at the closeout commit. **Phase 2 (Pilot Readiness) opens with this cycle.**

Review chain: Round 1 (against `9c782aa`) **FAIL** 2 BLOCKING + 4 MAJOR + 3 MINOR → Round 2 commit `aa2aefc` addressed all 6 → Round 2 review confirmed all 6 fixes but flagged 1 new BLOCKING (`VisitorService.loadInternal` unscoped) → Round 3 commit `18e6e99` fixed loadInternal + added defence-in-depth JOINs + 4 isolation tests → Round 3 review confirmed the loadInternal fix but flagged 1 analogous BLOCKING (`VisitorTypeService.loadOrFail` unscoped) → Round 4 commit `2b9ea9e` fixed loadOrFail + 4 visitor-type isolation tests → **Round 4 PASS**. Closeout commit lands the Round 4 non-blocking hygiene item (`VisitorService.createInternal` reload school-scoping) + 3 CodeQL findings (2 polynomial-redos in `configuration.service.ts` CSV email regexes via new `isLikelyEmail()` O(n) helper; 1 identity-replacement in `reference-health.worker.ts` dropping a `replace(/\bs\b/g, 's')` no-op).

**Vitest suite 39 → 67 (R2) → 71 (R3) → 75 (R4) passing tests.** CI parity green at every round: API + web builds clean, format:check + lint:logs clean.

**Round 4 PASS verification record (REVIEW-P2C1-CHATGPT — final verdict):**

> Commit `2b9ea9e` resolves the last blocking issue from Round 3.
> `VisitorTypeService.loadOrFail()` is now school-scoped, all relevant
> visitor-type joins are school-constrained, and regression coverage
> exists for the cross-school UUID attack path. The remaining
> reload-query consistency item should be cleaned up, but it does not
> prevent gate passage. **Final gate: PASS.**

**Closeout fix log (post-PASS hardening, 2026-05-09):**

- **R4 hygiene — `VisitorService.createInternal` post-INSERT reload.** Reviewer's non-blocking R4 callout. Reload now scopes by `school_id` for consistency with every other vis_visitors read. No cross-school path was possible because the row was inserted under the calling tenant's schoolId in the same tx, but the consistency check matches the rest of the module after R2 + R3 hardening.
- **CodeQL js/polynomial-redos × 2.** `configuration.service.ts:1362` (bulk-import staff email) and `:1489` (bulk-import student guardian email) both used `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` which polynomial-backtracks on overlapping character classes when the input has many dots. New shared `isLikelyEmail(s)` helper uses indexOf + slice — O(n) — no backtracking. Length-capped at RFC 5321's 254 characters (the cap alone defeats the polynomial blow-up because n is bounded). Same shape contract as the prior regex (one `@`, ≥1 char each side, ≥1 `.` in domain, non-empty TLD-ish suffix).
- **CodeQL js/identity-replacement.** `reference-health.worker.ts:127` had `entry.where.replace(/\bs\b/g, 's')` — a no-op replacing `'s'` with `'s'`. The canonical `sampleSql` directly below uses `entry.where` verbatim, so the `orphanSql` branch now does the same. Dead code removed.

Ships M90 Visitor Management — all 9 ERD tables in scope, encrypted PII at rest with HMAC blind-index returning-visitor lookup, banned-persons screening with kiosk-level real-time blocking (ADR-015), parent-active QR-code pre-registration with expedited sign-in, recurring contractor schedules, and emergency muster with per-visitor accountability.

**REVIEW-P2C1 Round 3 fix log (2026-05-09):**

- **R3 BLOCKING — `VisitorTypeService.loadOrFail` school-scoping.** Analogous to the R2 fix on `VisitorService.loadInternal`. The internal visitor-type loader (called by `VisitorService.create / patch`, `VisitorService.createInternal` from sign-in new-visitor + pre-reg new-visitor) now reads `getCurrentTenant()` and adds `WHERE school_id = $1::uuid AND id = $2::uuid`. Cross-school UUIDs return 404 with "Visitor type not found" (collapsed don't-leak-existence). Inactive same-school types still throw 400 "Visitor type is inactive". Defence-in-depth `AND vt.school_id = v.school_id` JOIN predicate added to every `vis_visitor_types vt` JOIN: `SELECT_VISITOR_BASE` (visitor service), `SELECT_SIGNIN_BASE` (sign-in service), and the muster `INSERT...SELECT`. The post-INSERT reload in `VisitorTypeService.create` also tightened to scope by school_id for consistency.
- **R3 test coverage.** New describe block in `apps/api/src/visitors/visitor.service.spec.ts` ships 4 visitor-type isolation regression tests (SQL shape assertion, same-school happy path, cross-school 404, missing-UUID 404) using the same stubbed `TenantPrismaService` pattern as the R2 visitor isolation tests.

**REVIEW-P2C1 Round 2 fix log (2026-05-09):**

- **R2 BLOCKING — `VisitorService.loadInternal` school-scoping.** The internal visitor loader (called by `SignInService.create` / `PreRegistrationService.create` / `RecurringVisitorService.create` whenever the caller passes a `visitorId` directly) now reads `getCurrentTenant()` and adds `WHERE v.school_id = $1::uuid AND v.id = $2::uuid` to its SELECT. Returns 404 (collapsed don't-leak-existence) for cross-school UUIDs so the caller cannot tell the difference between "doesn't exist" and "exists in another school". Defence-in-depth applied to every JOIN that brings visitor rows into a school-scoped query: `SELECT_SIGNIN_BASE`, `SELECT_PREREG_BASE`, `SELECT_RECUR_BASE`, the `MusterService.create` batch INSERT, and the `PreRegistrationService.scan` inner SELECT all gain `AND v.school_id = s.school_id` (or `pr.school_id` / `r.school_id`) on the visitor JOIN. So even if a row predates the loadInternal() fix, the JOIN refuses to surface a cross-school visitor on the read path.
- **R2 ancillary — `accessSchedule` DTO validation.** Pre-existing latent bug surfaced when the live R2 verification ran a real recurring create against the new code path. `@Type(() => AccessScheduleDto)` alone wasn't enough — the global `forbidNonWhitelisted` ValidationPipe was rejecting `accessSchedule` as an unknown property because nested validation wasn't wired. Added `@IsObject()` + `@ValidateNested()` to `CreateRecurringVisitorDto.accessSchedule` + `UpdateRecurringVisitorDto.accessSchedule`. Live verified: cross-school recurring now correctly returns 404 (was previously 400 on DTO validation, masking the real visitor lookup result).
- **R2 test coverage.** New `apps/api/src/visitors/visitor.service.spec.ts` ships 4 isolation regression tests: (1) `loadInternal` SQL includes BOTH `school_id` AND `id` predicates with the right argument ordering; (2) same-school lookup returns the row; (3) cross-school lookup throws `NotFoundException` (don't-leak-existence); (4) genuinely-missing UUID also throws `NotFoundException`. Stubbed `TenantPrismaService` captures the SQL string + arguments so the assertion is deterministic and runs without a live DB.

**REVIEW-P2C1 Round 1 fix log (2026-05-09):**

- **BLOCKING 1 — muster batch INSERT.** `MusterService.create` now uses one `INSERT INTO vis_muster_entries (...) SELECT … FROM vis_sign_ins JOIN vis_visitors LEFT JOIN vis_visitor_types WHERE s.school_id = $1 AND s.signed_out_at IS NULL`. Walks the partial INDEX `vis_si_active_idx` once. UUIDs generated via `gen_random_uuid()` — the one muster-entry exception to the application-layer UUIDv7 convention; acceptable because muster_entries are internal audit rows never sorted across services or exposed in deterministic-ordering contracts.
- **BLOCKING 2 — school_id-scoped mutations.** Every mutation path in the visitor module now scopes lock + UPDATE + reload by `school_id = $tenant.schoolId`. Touched: `BannedPersonService.patch`, `VisitorTypeService.patch`, `VisitorService.patch`, `SignInService.signOut + bypassSafeguarding`, `PreRegistrationService.scan` (UPDATE used_at), `RecurringVisitorService.patch`, `MusterService.updateEntry + close`. `MusterService.updateEntry` rewritten to use a single locked JOIN against the parent muster's school_id rather than the previous lock-then-tenantCheck-then-UPDATE chain.
- **MAJOR 1 — tenant-bound HMAC.** `emailHash` / `phoneHash` / `nameHash` now take `schoolId` as their first argument and prefix the HMAC material with `schoolId + '|'`. Same email seeded into school A vs school B produces two different hashes. Updated all 8 callsites across the visitors module + `seed-visitors.ts`.
- **MAJOR 2 — automated test coverage.** New `apps/api/src/visitors/crypto.spec.ts` ships 25 tests covering AES-256-GCM round-trip + tamper rejection + malformed-wire rejection, every HMAC helper's per-school binding, Unicode normalisation pipeline, exact-but-not-fuzzy match contract, and QR token randomness. Vitest suite 39 → 67 passing.
- **MAJOR 3 — name normalisation.** New `normaliseNameComponent(s)` helper applies NFKD Unicode normalize → strip combining marks → lowercase → strip non-letter / non-digit / non-space → collapse whitespace → trim. So `José` → `jose`, `O'Brien` → `o brien`, `Smith-Jones` → `smith jones`. Applied symmetrically in seed + runtime so the seeded "John Doe" + DOB still matches `JOHN DOE` / `john   doe` / `john-doe` etc. Aliases and phonetic / fuzzy matching remain out of scope by design; admin workflow records multiple banned-person rows for known aliases.
- **MAJOR 4 — banned-person check oracle.** `POST /banned-persons/check` re-gated from `saf-002:write` to `safeguarding_ban:read` (admin-only). Reception staff can no longer probe the registry as a Boolean oracle. Verified live: teacher 403, principal 201. Canonical kiosk path is the implicit screening inside `POST /sign-in` which throws a neutral 403 with no body field that reveals match/no-match.
- MINOR 7 / 8 / 9 acknowledged + tracked on the Phase 2 punch list.

**Branch:** `main`
**Plan reference:** `docs/campusos-p2c1-visitor-management.html`
**Vertical-slice deliverable:** Admin configures 4 visitor types → admin adds a banned person (John Doe, COURT_ORDER) → teacher pre-registers a guest speaker (QR token) → speaker arrives, kiosk scans QR, sign-in auto-created → parent arrives, kiosk lookup detects returning visitor via HMAC email_hash → contractor arrives, banned-persons HMAC check passes, safeguarding check PASSED, sign-in created → someone matching the banned person's HMAC arrives, kiosk BLOCKS with neutral "please see reception staff" message and emits `vis.banned_person.detected` → fire alarm sounds → admin creates emergency muster snapshot → all currently signed-in visitors batch-inserted into `vis_muster_entries` with status=UNKNOWN → reception marks each as ACCOUNTED_FOR / EVACUATED → summary verifies total on-site count.

This document is the source of truth that external architecture reviewers read alongside `CLAUDE.md`.

---

## Step status

| Step | Title                                                               | Status   |
| ---- | ------------------------------------------------------------------- | -------- |
| 1    | Visitor Types + Visitors + Sign-In Settings Schema                  | Complete |
| 2    | Sign-Ins + Pre-Registrations + Recurring Schema                     | Complete |
| 3    | Banned Persons + Emergency Muster Schema                            | Complete |
| 4    | Seed Data — types, visitors, sign-ins, banned, pre-reg, muster      | Complete |
| 5    | Visitor + Sign-In NestJS Module (incl. crypto helpers + 2 services) | Complete |
| 6    | Pre-Registration + Recurring + Banned Persons NestJS Module         | Complete |
| 7    | Emergency Muster NestJS Module                                      | Complete |
| 8    | Visitor UI — Kiosk + Reception Dashboard                            | Complete |
| 9    | Visitor UI — Admin (banned persons, types, pre-reg, muster, log)    | Complete |
| 10   | Vertical-slice CAT script `docs/p2c1-cat-script.md`                 | Complete |

---

## Decisions made vs the plan

The implementation plan calls for **SAF-001 (Visitor Management)** but the
catalogue at `packages/database/data/permissions.json` already has
`SAF-001 = Emergency Management` and `SAF-002 = Visitor Management`.
P2C1 honours the existing catalogue and uses **SAF-002** as the
function code throughout. The plan's reference to SAF-001 is documentation
drift; renaming the catalogue would break the reservation for the future
M91/M92 emergency + drill cycles. This is documented in the CAT script
"Reviewer attention items" so peer review sees the deviation up front.

A new dedicated permission code **`safeguarding_ban`** lands as a non-XXX-NNN
catalogue entry (mirrors Cycle 11's `student_counseling_record`). Only
`safeguarding_ban:read` is granted today — and only to School Admin and
Platform Admin via the `everyFunction` grant. Reception staff (Staff role)
explicitly do NOT hold this code; they only ever see the silent BLOCKED
kiosk outcome via the `vis.banned_person.detected` Kafka emit.

Tenant migration numbering: the plan suggests `095_vis_visitors.sql` /
`096_vis_sign_ins.sql` / `097_vis_banned_muster.sql` but those slots are
taken by analytics + DPO migrations. P2C1 uses **`102` / `103` / `104`**.

---

## Per-step records

### Step 1 — Visitor Types + Visitors + Sign-In Settings Schema ✓

**Migration:** `packages/database/prisma/tenant/migrations/102_vis_visitors.sql`

3 tables:

- **`vis_visitor_types`** — per-school catalogue. UNIQUE(school_id, name).
  6-value `badge_color` CHECK (blue / green / amber / rose / purple / gray)
  aligned to the kiosk + reception UI palette. `requires_safeguarding_check`
  drives the Step 5 SignInService kiosk flow. `is_active` flag for soft
  deactivation. Partial INDEX on `(school_id) WHERE is_active = true`.

- **`vis_visitors`** — directory of every signed-in person. **SECURITY
  KEYSTONE.** PII at rest is encrypted: `email_encrypted` and
  `phone_encrypted` carry AES-256-GCM ciphertext (same wire format as
  Cycle 22 IT vault — `base64(iv).base64(tag).base64(ciphertext)`).
  `email_hash` and `phone_hash` are HMAC-SHA256 blind indexes for
  returning-visitor lookup at the kiosk. **UNIQUE(school_id, email_hash)**
  is the dedup gate. INDEX(email_hash), partial INDEX on `phone_hash WHERE
phone_hash IS NOT NULL`, and INDEX(school_id, last_name, first_name).
  Intra-tenant FK `visitor_type_id → vis_visitor_types(id) ON DELETE
RESTRICT` so admin must reassign visitors before retiring a type.

- **`vis_sign_in_settings`** — per-school configuration row.
  UNIQUE(school_id) so each school carries exactly one settings record.
  `auto_sign_out_hours` 1–48 CHECK. `badge_template` 3-value CHECK
  (STANDARD / COMPACT / PHOTO). Auto-created with sensible defaults on
  first read.

**Live verification on `tenant_demo` 2026-05-09:** all 3 tables present
in `information_schema.tables`. Single intra-tenant FK
(visitor_type_id → vis_visitor_types). 0 cross-schema FKs. Splitter
trap caught + fixed mid-provision (block-comment header had a `;` on
line 22 — splitter cuts on every `;` regardless of comment context;
rewritten with em-dash before successful re-provision).

### Step 2 — Sign-Ins + Pre-Registrations + Recurring Schema ✓

**Migration:** `packages/database/prisma/tenant/migrations/103_vis_sign_ins.sql`

3 tables:

- **`vis_sign_ins`** — every sign-in event. **EMERGENCY MUSTER QUERY
  KEYSTONE** — `Partial INDEX vis_si_active_idx (school_id, signed_in_at)
WHERE signed_out_at IS NULL` is the index the Step 7 MusterService walks
  in one batch INSERT to materialise `vis_muster_entries` rows for everyone
  currently on-site. 4-value `safeguarding_check_status` CHECK (PASSED /
  FLAGGED / BYPASSED_BY_ADMIN / NOT_REQUIRED). **Multi-column `vis_si_bypass_chk`
  lockstep** — `safeguarding_check_status='BYPASSED_BY_ADMIN'` requires
  `bypass_admin_id` populated AND `bypass_reason` populated AND
  `length(trim(bypass_reason)) > 10` so a one-word "ok" cannot bypass
  safeguarding. `safeguarding_check_ref` stores the third-party reference
  ID **only** per ADR-015 — never the registry payload. BRIN INDEX on
  `signed_in_at` for historical compliance reports. Soft FKs to
  `host_id` (platform.platform_users), `bypass_admin_id`, `building_id`
  (fac_buildings — soft because nullable). Intra-tenant FK to
  `vis_visitors(id) ON DELETE RESTRICT`.

- **`vis_pre_registrations`** — staff-initiated expected-visitor records.
  **UNIQUE qr_code_token** so every QR code resolves to exactly one
  pre-reg. **Partial INDEX `(expires_at) WHERE used_at IS NULL`** is the
  kiosk QR scan keystone — single-row lookup keyed on the token. Cleanup
  job: `DELETE WHERE expires_at < now() AND used_at IS NULL`.

- **`vis_recurring_visitors`** — regular contractors with recurring
  schedules. `access_schedule JSONB` carries days + time windows.
  **GIN INDEX** on `access_schedule` for the JSONB containment
  `@>` queries the Step 6 RecurringVisitorService.today() endpoint runs.
  Per-(visitor, valid_from, valid_to) INDEX so the today() lookup avoids
  scanning every recurring row.

**Live verification:** all 3 tables present, FK constraints in place,
multi-column CHECKs verified via `pg_constraint`. Splitter trap caught
on first audit (line 98 had `;` in a COMMENT ON COLUMN string for
qr_code_token — rewritten with comma before re-provision).

### Step 3 — Banned Persons + Emergency Muster Schema ✓

**Migration:** `packages/database/prisma/tenant/migrations/104_vis_banned_muster.sql`

3 tables:

- **`vis_banned_persons`** — **SAFETY KEYSTONE.** The reception kiosk
  consults this on every sign-in attempt. **`name_hash`** is an
  HMAC-SHA256 blind index of normalised lowercase trimmed full name +
  optional DOB (`firstName + ' ' + lastName + '|' + dob`). 5-value
  `ban_type` CHECK (COURT_ORDER / SCHOOL_DECISION / SAFEGUARDING /
  RESTRAINING_ORDER / OTHER). **`Partial INDEX vis_banned_kiosk_lookup_idx
(school_id, name_hash) WHERE is_active = true`** backs the real-time
  kiosk lookup. Plaintext `first_name + last_name + ban_order_s3_key` are
  visible only to admins holding `safeguarding_ban:read`. Multi-column
  `vis_banned_dates_chk` enforces `effective_to >= effective_from` when
  set; `effective_to IS NULL` means indefinite.

- **`vis_emergency_muster`** — one row per emergency snapshot.
  6-value `drill_type` CHECK. `incident_id` soft to future
  `inc_incidents` (M91 — schema not yet built). `total_on_site_at_snapshot`
  frozen at creation time. `closed_at` + `closed_by` populated when
  the muster ends.

- **`vis_muster_entries`** — per-visitor accountability tracker.
  `visitor_name` + `visitor_type` + `visitor_company` + `building` are
  **SNAPSHOT fields** frozen at creation time so the row remains
  meaningful even when the underlying `vis_visitors` row is later
  updated. UNIQUE(muster_id, sign_in_id). 4-value `status` CHECK
  (UNKNOWN / ACCOUNTED_FOR / EVACUATED / ASSISTANCE_NEEDED). **Multi-column
  `vis_muster_entry_marked_chk` lockstep** — UNKNOWN requires
  `marked_by + marked_at` NULL; any non-UNKNOWN status requires both
  populated. Reception staff cannot mark a visitor without identifying
  themselves and the time. Intra-tenant FKs: `muster_id → vis_emergency_muster
ON DELETE CASCADE`, `sign_in_id → vis_sign_ins ON DELETE RESTRICT`.

**Live verification:** all 9 vis\_\* tables present in `tenant_demo`.
Splitter trap not tripped on this migration (clean on first audit).

### Step 4 — Seed Data ✓

**Script:** `packages/database/src/seed-visitors.ts` wired as
`seed:visitors` in `package.json` and appended to `seed-all.ts`. Idempotent —
gated on whether `vis_visitor_types` already has rows for the demo school.

Sections:

- **A) 4 visitor types** — Parent (no safeguarding, blue), Contractor
  (safeguarding, amber), Guest Speaker (safeguarding, green), Volunteer
  (safeguarding, purple — links to platform_volunteer_profiles per
  ADR-032 once that table ships).
- **B) 5 visitors with encrypted PII + HMAC blind index** — David Chen
  - Patricia Nguyen + Marcus Owen (returning parents), Greg Hayes
    (Acme Maintenance contractor), Anita Patel (Springfield Science
    Outreach guest speaker). All emails + phones encrypted via the
    same crypto helper as the runtime VisitorService.
- **C) 1 sign-in settings row** — require_purpose=true, auto_sign_out_hours=12.
- **D) 8 sign-ins** — 3 currently on-site (drives the muster keystone)
  - 5 historical. One historical sign-in carries `safeguarding_check_status
= BYPASSED_BY_ADMIN` with bypass_admin_id + bypass_reason populated
    per the multi-column lockstep so the schema CHECK is exercised by seed.
- **E) 1 pre-registration** — Anita Patel for Thursday's assembly,
  QR token generated via crypto.randomBytes(32).toString('hex'), expires +14d.
- **F) 1 recurring visitor** — Greg Hayes (Acme Maintenance) on
  Tuesdays + Thursdays 8am–4pm, valid current month. JSONB schedule
  exercises the GIN INDEX.
- **G) 1 banned person** — "John Doe" COURT_ORDER, court order document
  uploaded, effective indefinitely. `name_hash` computed from normalised
  "john doe" + DOB "1985-03-12".
- **H) 1 muster snapshot from last week's fire drill** + 3 entries
  (2 ACCOUNTED_FOR + 1 EVACUATED). Each entry's marked_by + marked_at
  populated atomically per the lockstep.

**Live counts on `tenant_demo` after seed:** types=4, visitors=5,
sign_ins=8 (3 active + 5 historical), pre_regs=1, recurring=1, banned=1,
musters=1, muster_entries=3, settings=1. Idempotent re-run skips cleanly.

### Step 5 — Visitor + Sign-In NestJS Module (foundation) ✓

**Files:** `apps/api/src/visitors/crypto.ts` (encryption + HMAC helpers),
`apps/api/src/visitors/dto/visitor.dto.ts` (~20 DTOs),
`apps/api/src/visitors/visitor.service.ts`
(VisitorTypeService + VisitorService + SignInSettingsService),
`apps/api/src/visitors/sign-in.service.ts`
(SignInService + PreRegistrationService + RecurringVisitorService —
combined for tight cross-call references). 14 endpoints land in this
step (3 visitor-types + 5 visitors + 2 settings + 4 sign-ins).

**`crypto.ts` keystones:**

- `encryptPII(plaintext)` / `decryptPII(wire)` — AES-256-GCM via Node
  crypto. Wire format `base64(iv).base64(tag).base64(ciphertext)`,
  matching Cycle 22 IT vault. **Production fail-closed** — module-load
  throws when `NODE_ENV=production` and `VISITOR_PII_KEY` or
  `VISITOR_HMAC_SECRET` env vars are missing. Dev/test fall back to
  deterministic seed strings so the seeded ciphertext decrypts cleanly.
- `emailHash(email)` — HMAC-SHA256 of `email.toLowerCase().trim()`.
  Equality lookup at the kiosk via `SELECT WHERE email_hash = $hash`.
- `phoneHash(phone)` — HMAC-SHA256 of normalised digits (E.164-ish).
- `nameHash(firstName, lastName, dob?)` — HMAC-SHA256 of
  `lowercase(first) + ' ' + lowercase(last) + (dob ? '|' + dob : '')`.
  Used by `vis_banned_persons.name_hash` for kiosk screening.
- `generateQrToken()` — `crypto.randomBytes(32).toString('hex')`.

**`VisitorService` keystone — `lookupByEmail(email)`** is the
KIOSK RETURNING-VISITOR LOOKUP. Computes `emailHash(email)` and
SELECTs by `email_hash`. Never decrypts. Returns visitor id + name +
type for kiosk auto-fill. Returns `null` (200 with body) when no match;
the kiosk falls through to new-visitor capture.

**`createInternal(input)`** is upsert-style: if a visitor with the same
`email_hash` exists in this school, returns the existing row instead of
creating a duplicate. Belt-and-braces against the UNIQUE(school_id,
email_hash) race window.

### Step 6 — Pre-Registration + Recurring + Banned Persons ✓

**Files:** `apps/api/src/visitors/banned-person.service.ts` —
**`BannedPersonService.checkAtKiosk(input, actor)` is the SAFETY KEYSTONE.**
Computes `nameHash(firstName, lastName, dob?)` and SELECTs from
`vis_banned_persons WHERE school_id = $1 AND name_hash = $2 AND
is_active = true AND effective_from <= CURRENT_DATE AND (effective_to IS NULL
OR effective_to >= CURRENT_DATE)`. On match: emits `vis.banned_person.detected`
with `payload.bannedPersonId` only (never the entered name) and returns
`{ blocked: true, detectedAt }`. The visitor never learns why.

**`SignInService.create()`** flow:

1. Resolve or create the visitor (returning visitor via HMAC, otherwise
   `VisitorService.createInternal`).
2. **`BannedPersonService.checkAtKiosk`** on every sign-in. Match →
   throw `ForbiddenException('Please see reception staff')`.
3. Visitor type policy resolution. `requires_safeguarding_check=true`
   without a ref → status=FLAGGED (kiosk routes to reception). With a
   ref → status=PASSED. `requires_safeguarding_check=false` →
   status=NOT_REQUIRED.
4. INSERT `vis_sign_ins`.
5. Emit `vis.visitor.signed_in` AFTER tx commits with full payload
   (signInId, visitorId, visitorName, visitorTypeName, hostAccountId,
   safeguardingCheckStatus, signedInAt, sourceRefId).

**`SignInService.bypassSafeguarding()`** is School-Admin only at the
service layer (mirrors the @RequirePermission gate). Validates
`reason.trim().length > 10` as defence-in-depth (DTO already enforces
via `@MinLength(11)`). Locks the sign-in row + UPDATEs all three
columns (`safeguarding_check_status='BYPASSED_BY_ADMIN'`,
`bypass_admin_id`, `bypass_reason`) atomically per the multi-column
`vis_si_bypass_chk` lockstep.

**`PreRegistrationService.scan(input, actor)`** locks the pre-reg row
inside `executeInTenantTransaction` with `SELECT … FOR UPDATE OF pr`.
Validates `used_at IS NULL` (otherwise 410 Gone) and `expires_at > now()`
(otherwise 410 Gone). Stamps `used_at`, then calls
`SignInService.createFromPreReg` to auto-create the sign-in with
status=PASSED (when type requires safeguarding) or NOT_REQUIRED.
Pre-registered visitors are pre-vetted at issue time so the safeguarding
gate defaults to PASSED.

**`RecurringVisitorService.listToday()`** uses the JSONB containment
operator: `WHERE r.access_schedule -> 'days' @> $today::jsonb`. The
GIN INDEX from Step 2 backs this query. Translates today's
`Date.getDay()` to a `MON..SUN` token via `DAY_INDEX_TO_TOKEN`.

### Step 7 — Emergency Muster ✓

**File:** `apps/api/src/visitors/muster.service.ts` —
**`MusterService.create(input, actor)` is the EMERGENCY SNAPSHOT KEYSTONE.**
Inside one tenant transaction:

1. SELECT every active sign-in (`signed_out_at IS NULL`) with visitor +
   type joined. Walks the partial INDEX `vis_si_active_idx`.
2. INSERT `vis_emergency_muster` with `total_on_site_at_snapshot = active.length`.
3. For each active sign-in, INSERT `vis_muster_entries` with
   `visitor_name + visitor_type + visitor_company` SNAPSHOT-frozen.

After commit, emits `vis.muster.created` with `musterId`, `schoolId`,
`drillType`, `totalOnSiteAtSnapshot`.

**`MusterService.updateEntry(entryId, input, actor)`** locks the entry
row + verifies it belongs to a muster in the calling tenant (defence-
in-depth tenant scope check). When status=UNKNOWN, the UPDATE clears
marked_by + marked_at to satisfy the multi-column `vis_muster_entry_marked_chk`
lockstep. When status is anything else, both columns are stamped
atomically.

**`MusterService.close(id, actor)`** locks the muster row + stamps
`closed_at + closed_by` atomically. Refuses double-close with 400.

### Step 8 — Visitor UI: Kiosk + Reception Dashboard ✓

**Files:** `apps/web/src/app/(app)/visitors/page.tsx` (reception
dashboard), `apps/web/src/app/(app)/visitors/kiosk/page.tsx`,
`apps/web/src/app/(app)/visitors/log/page.tsx`,
`apps/web/src/hooks/use-visitors.ts` (~25 hooks),
`apps/web/src/lib/visitors-format.ts` (label maps + pill class maps +
formatters), plus the new `Visitors` launchpad tile + `AppKey`
registration in `apps/web/src/components/shell/apps.tsx` (gated on
`saf-002:read`, persona-aware copy).

**`/visitors`** reception dashboard:

- Active emergency muster banner (rose-tinted, deep link to muster) when
  `useActiveMuster()` returns non-null.
- Quick action buttons: Open kiosk / Pre-register / Emergency muster (Staff)
  - Banned persons / Visitor types (Admin only).
- **Currently on-site panel** with live count + per-row sign-out button.
  Refetches every 30s + on focus.
- Upcoming pre-registrations list with QR token preview.

**`/visitors/kiosk`** — full-screen kiosk surface:

- "Have a QR code?" textarea + Scan button — pastes the 64-char hex
  token. Backend auto-creates the sign-in.
- "Or sign in by email" form — email + Check button calls the
  `lookup` endpoint; returning visitor surfaces a sky-tinted "Welcome
  back" card with a "Use these details" button that auto-fills the form.
- Visitor type dropdown drawn from active types only.
- Submit POSTs `/sign-in` and surfaces a green emerald confirmation
  card with the visitor's name + badge colour pill.
- **BANNED PERSON** flow surfaces as a 403 with the message "Please
  see reception staff" — the kiosk renders this via Toast and never
  displays the ban reason.

**`/visitors/log`** — historical sign-in log with from/to date filters.

### Step 9 — Visitor UI: Admin (banned persons, types, pre-reg, muster) ✓

**Files:** `apps/web/src/app/(app)/visitors/admin/banned/page.tsx`
(restricted, gated on `safeguarding_ban:read` with a friendly empty
state for non-admin actors), `apps/web/src/app/(app)/visitors/admin/types/page.tsx`,
`apps/web/src/app/(app)/visitors/pre-register/page.tsx`,
`apps/web/src/app/(app)/visitors/muster/page.tsx`,
`apps/web/src/app/(app)/visitors/muster/[id]/page.tsx`.

**`/visitors/admin/banned`** — admin-only banned persons registry.
List with active/inactive filter, name + DOB + ban type pill +
effective dates + last-reviewed date. Add modal with name + DOB +
ban_type + reason (>10 chars enforced client-side) + court-order S3 key
(client-side warning when COURT_ORDER / RESTRAINING_ORDER selected
without an S3 key).

**`/visitors/admin/types`** — visitor type CRUD with badge color picker
(6 colour swatches), safeguarding-required checkbox, isActive toggle.

**`/visitors/pre-register`** — staff form to create a pre-registration;
on success shows the QR token in a copyable monospace card with a
"Pre-register another" button.

**`/visitors/muster`** — emergency muster control with prominent rose
"Create Muster Snapshot" button that requires `confirm()` then routes to
the per-muster accountability tracker. Below: history of recent musters.

**`/visitors/muster/[id]`** — per-muster accountability tracker.
5-cell summary bar (Total / Unknown / Accounted for / Evacuated /
Assistance needed) auto-refreshes every 15s. Per-entry row with
status pill + per-status mark buttons. Close button closes the
muster atomically. When closed, the mark buttons are hidden.

**Build sizes (web):** `/visitors` 6.32 kB, `/visitors/kiosk` 4.21 kB,
`/visitors/log` 3.23 kB, `/visitors/admin/banned` 6.79 kB,
`/visitors/admin/types` 4.33 kB, `/visitors/pre-register` 5.56 kB,
`/visitors/muster` 4 kB, `/visitors/muster/[id]` 3.93 kB First Load JS.

### Step 10 — Vertical-slice CAT script ✓

**File:** `docs/p2c1-cat-script.md` — 10-scenario reproducible
walkthrough verified live on `tenant_demo` 2026-05-09.

7-check schema preamble (9 vis\_\* tables / encrypted PII columns
present / HMAC INDEX present / `vis_si_bypass_chk` constraint present /
partial INDEX on banned-persons + on-site sign-ins / Step 4 seed
counts) plus 10 plan scenarios:

1. Visitor type CRUD + UNIQUE(school_id, name) 409 catch.
2. New visitor sign-in writes encrypted PII + HMAC blind index.
3. Returning visitor lookup via HMAC blind index, case-insensitive normalisation.
4. **KEYSTONE** Pre-registration QR scan — auto-creates sign-in, re-scan returns 410.
5. **KEYSTONE** Safeguarding admin bypass — short reason 400, valid reason 200 with multi-column lockstep.
6. **KEYSTONE** Banned-persons HMAC — kiosk BLOCK with neutral message + `vis.banned_person.detected` envelope captured live on the wire.
7. Banned-persons non-match — sign-in proceeds normally.
8. **KEYSTONE** Emergency muster snapshot — batch INSERTs `vis_muster_entries` from active sign-ins + multi-column `marked_chk` lockstep on entry update + `vis.muster.created` envelope on the wire.
9. Sign-out — multi-column lockstep + double-sign-out 400.
10. Permission matrix — Teacher /on-site 200 (saf-002:read), Teacher
    POST /sign-in 403 (saf-002:write), Teacher /banned-persons 403
    (safeguarding_ban:read), Parent /on-site 403 (no SAF-002 grant).

Cleanup section restores tenant to post-Step-4 seed shape exactly.

---

## P2C1 quantities

- **9** new tenant base tables (vis_visitor_types, vis_visitors,
  vis_sign_in_settings, vis_sign_ins, vis_pre_registrations,
  vis_recurring_visitors, vis_banned_persons, vis_emergency_muster,
  vis_muster_entries). Tenant logical base table count: ~408.
- **5** intra-tenant FKs (visitor_type_id → vis_visitor_types RESTRICT,
  visitor_id → vis_visitors RESTRICT × 3, muster_id → vis_emergency_muster
  CASCADE, sign_in_id → vis_sign_ins RESTRICT). 0 cross-schema FKs.
- **3** new tenant migrations (102 / 103 / 104).
- **0** new platform schema columns or migrations.
- **1** new permission code (`safeguarding_ban` — non-XXX-NNN entry
  for the dedicated banned-persons gate). SAF-002 already in catalogue.
- **6** services (VisitorTypeService, VisitorService, SignInSettingsService,
  SignInService, PreRegistrationService, RecurringVisitorService,
  BannedPersonService, MusterService — 8 by class, organised in 4
  files for tight cross-call references).
- **1** controller (VisitorsController) + **~28 endpoints** under
  `/api/v1/visitors/*`.
- **3** Kafka emit topics: `vis.visitor.signed_in`,
  `vis.banned_person.detected`, `vis.muster.created`.
- **1** new web launchpad tile (Visitors, ShieldIcon, gated on
  `saf-002:read`).
- **8** new web routes under `/visitors/*` (dashboard, kiosk, log,
  admin/banned, admin/types, pre-register, muster, muster/[id]).
- **~25** React Query hooks in `apps/web/src/hooks/use-visitors.ts`.
- **0** new tests (CAT script is the verification surface; unit-test
  scaffolding for the crypto + lockstep helpers stays on the broader
  Phase 2 punch list).

---

## Reviewer carry-over

**Awaiting peer review verdict before tagging `p2c1-complete`.** CI parity
green: API + web builds clean, all CAT scenarios verified live.

**Phase 2 punch list items added by P2C1:**

- **PHASE2-P2C1-1.** Wire `vis.banned_person.detected` into the Cycle 3
  NotificationConsumer pipeline so safeguarding officers are paged
  in real time (currently the emit lands cleanly but no consumer
  fans it out to IN_APP / SMS).
- **PHASE2-P2C1-2.** Photo capture at the kiosk (camera capture +
  upload to S3 + reference on `vis_sign_ins.photo_s3_key` — schema
  doesn't have the column yet, deferred per the plan).
- **PHASE2-P2C1-3.** Third-party DBS / background-check API integration
  (manual ref entry today; plan deferred the live API call).
- **PHASE2-P2C1-4.** NDA / agreement digital signature capture at
  the kiosk for visitor types that require it.
- **PHASE2-P2C1-5.** Multi-building sign-in tracking (single building
  this cycle; building_id soft ref to fac_buildings is forward-compatible).
- **PHASE2-P2C1-6.** Visitor analytics dashboard
  (`rpt_visitor_summary` deferred to Cycle 29.1).
- **PHASE2-P2C1-7.** SAF-001 catalogue rename — the catalogue currently
  has SAF-001 = Emergency Management and SAF-002 = Visitor Management.
  The plan referred to SAF-001 throughout but the catalogue was already
  populated. Document the rename or accept the catalogue as authoritative
  and update the plan accordingly.
- **PHASE2-P2C1-8.** Kiosk session — currently the kiosk runs as the
  reception staff actor (whoever is logged in to the tablet). A
  dedicated kiosk session model (with limited permissions and
  auto-rotation of the API token) lands once a school deploys real
  hardware.
- **PHASE2-P2C1-9.** Pre-registration email delivery — staff get the
  QR token displayed on screen but the seeded pre-reg does not send
  the visitor an email automatically. Wire the Cycle 3 notification
  pipeline once an email transport is configured.

**Phase 2 (Pilot Readiness) opens with this cycle.** Next P2 cycles
continue with M91 Incident Reporting, M92 Drill Scheduling, the broader
role-split punch list from CLAUDE.md, and the .1 cycles for the remaining
deferred ERD tables.
