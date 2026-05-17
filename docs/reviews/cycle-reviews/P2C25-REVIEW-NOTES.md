# P2C25-REVIEW-NOTES.md — Library Advanced (M24 .1)

Peer-review scaffold for Phase 2 Cycle 25. Reviewer should walk through the per-area sections, confirm or reject each design decision, and surface issues as either BLOCKING (must fix before merge), MAJOR (recommend fix before pilot), or MINOR (recommendation-class follow-up).

**Cycle scope:** 6 new tenant tables (3 reading-lists + class-sets schema in 164; 3 recommendations + ILL + import schema in 165) + 2 ALTER columns on Cycle 12 `lib_reading_lists` + 1 ALTER column on Cycle 12 `lib_checkouts`. ~22 new endpoints + 1 Kafka emit (`lib.import.completed`). 4 new web routes + recommendations shelf injected into student `/library/my`. Bulk-import worker + class-set overdue worker.

---

## 1. Class set auto-checkout pattern

**The keystone.** `ClassSetService.create(input, actor)` runs the full INSERT chain inside one `executeInTenantTransaction`:

```
1. Validate the catalogue item exists in tenant (SELECT FROM lib_catalogue_items WHERE id = $1 AND school_id = $2).
2. Validate the teacher patron resolves to an hr_employees.person_id row in this tenant.
3. SELECT … FOR UPDATE on lib_catalogue_copies WHERE is_available = true AND catalogue_item_id = $1 LIMIT $copyCount  — locks the copies so a concurrent caller cannot reserve the same ones.
4. If locked < copyCount → BadRequestException (insufficient inventory) — tx rolls back.
5. INSERT INTO lib_class_set_checkouts (status='ACTIVE', returned_count=0, ...) RETURNING id.
6. For each locked copy:
     INSERT INTO lib_checkouts (copy_id, patron_id, class_set_checkout_id, checkout_date, due_date, status='ACTIVE') VALUES ...
     UPDATE lib_catalogue_copies SET is_available = false, location_status = 'CHECKED_OUT' WHERE id = $copyId.
7. Reload the parent for the response DTO.
```

**Why this shape:** the FOR UPDATE lock prevents two librarians from racing on the same available-copies pool. By picking N specific copies up-front and writing the children inside the same tx, we get per-copy traceability (each child row in `lib_checkouts` names the exact barcode) without an N-statement-race window.

**Trade-offs considered:**

- A counter-only model (`copy_count INT`, no per-copy children) would have been cheaper but rules out barcoded overdue notifications (admin can't say "Bring back copy LIB-NTS-014" when 2 of 25 are still out — they could only say "2 unspecified copies").
- A 2-statement insert chain (parent → fan-out via INSERT … SELECT) would have been atomic at the schema level but harder to read + harder to log per-copy.

**Return path: `returnCopies(id, {copiesReturned, barcodes?}, actor)`** mirrors the same shape — locks the parent, optionally locks the named child barcodes (otherwise picks oldest ACTIVE children), flips children to RETURNED + copies back to ON_SHELF + UPDATEs parent `returned_count` + recomputes status. Refuses over-return (returning more copies than outstanding).

**Sweep contract: `sweepOverdueForCurrentTenant()`** is a single UPDATE that flips `status='OVERDUE'` for rows with `status IN ('ACTIVE','PARTIALLY_RETURNED') AND due_date < CURRENT_DATE AND returned_count < copy_count`. Idempotent across re-runs.

**Reviewer check:**

- Lock order safe (no deadlock against the Cycle 12 single-copy `CheckoutService.checkout` which locks the same copies table)?
- Multi-school tenant isolation OK on the FOR UPDATE — copies query already constrained to current tenant via `executeInTenantTransaction` SET LOCAL search_path?
- Edge case: copy in catalogue but already in another active class set → covered by `is_available=false` filter on the FOR UPDATE.

---

## 2. Recommendation engine 5-strategy scoring

**Five strategies:**

1. **COLLABORATIVE_FILTERING** — students who shared ≥3 checkouts with this student, surface their other checkouts not yet read. Co-checkout frequency = raw score.
2. **READING_LEVEL_MATCH** — catalogue items within ±50 Lexile (or AR band) of the student's reading level.
3. **SUBJECT_MATCH** — overlap between catalogue subject tags + the student's checkout-history subject tags.
4. **NEW_ARRIVAL** — items catalogued in the last 30 days matching the student's subject preferences.
5. **STAFF_PICK** — items on librarian-curated `list_type='GENERAL'` published reading lists.

**Final ranking** uses the per-school weight blend from `school_config` key `library_recommendation_weights` (default `{30, 25, 20, 15, 10}` summing to 100). The worker normalises raw scores within each strategy to [0..1], applies the weights, and inserts the top 20 per student.

**Why a full DELETE + INSERT (not UPSERT):**

- A weekly worker produces a fresh ranked list per student; old rows would otherwise accumulate.
- Per-(student, item) UNIQUE would force complex deletion logic when the candidate pool changes (a book the student already read no longer needs to be on their feed).
- Cap of 20 enforces the partial INDEX hot path; a higher cap would invalidate the index assumption.

The `replaceForStudent` helper is **public** in the service so a future LibraryRecommendationWorker can call it without re-implementing the contract. Until that worker ships, the seed (15 representative rows across 3 students × 5 strategies) provides realistic data for the UI.

**Dismissal soft-hide:** student dismisses a recommendation → `dismissed_at + dismissed_by` stamped. The next worker run produces a fresh batch that excludes dismissed items (the worker is responsible for the candidate filter; the read endpoint already strips dismissed rows from the default list).

**Reviewer check:**

- Schema-level uniqueness — no UNIQUE on (student, item) which is intentional: the worker's full-replace pattern means uniqueness is enforced by the workflow, not the schema. Acceptable?
- The "weeks of stale recommendations" concern — until the worker ships, dismiss is the only way to clear a stale row. Should `dismissed_at` lookback (90 days) live in the schema as a partial index?
- 20-cap location — currently in `replaceForStudent` service layer. Acceptable as the contract or should be a DB CHECK?

---

## 3. Recommendation engine weight configuration (Step 8)

**Per-school weights** stored in `school_config` row keyed `library_recommendation_weights` as JSONB `{collaborativeFiltering, readingLevelMatch, subjectMatch, newArrival, staffPick}`. Defaults applied when the row is absent.

**Read endpoint:** `GET /library/recommendation-config` gated on `lib-002:read` (librarian + admin). Audit trail visibility — librarians can see the current blend.

**Update endpoint:** `PATCH /library/recommendation-config` gated on `lib-002:admin` OR `lib-003:admin` (school admin only — librarian reads but cannot mutate). PATCH-merge semantics: only supplied keys overwrite. Validates merged weights sum to 100 (±0.5 tolerance, matching the P2-24 EngagementScoreService convention).

**Why split read vs admin:** schools that prioritise reading-level alignment over collaborative filtering should make that decision at the school-admin tier, not the librarian tier. The librarian audits + understands the blend but the policy decision sits with leadership.

**Tenant config storage choice:** `school_config` (per-tenant key/value JSONB) — same carry-over as P2-24's engagement score weights. The plan referenced `platform_tenant_configs` but that table does not exist; `school_config` is the canonical Cycle-0 home for per-school configuration.

**Reviewer check:**

- 100-sum tolerance ±0.5 — matches P2-24 convention. Acceptable?
- PATCH-merge semantics — a school admin who supplies only `collaborativeFiltering: 50` mutates that one key and leaves the others at their stored values. The 100-sum check uses the resulting merged set. Acceptable, or should partial PATCHes require all 5 keys?
- Admin-only mutation gate — `lib-002:admin OR lib-003:admin OR isSchoolAdmin`. Librarian (`lib-002:write`) cannot mutate. Reviewer should confirm this aligns with the school-side org chart for "policy vs operations".

---

## 4. Interlibrary loan state machine

**Schema-side direction_chk:** `LENT` rows require `catalogue_item_id` populated (the title being shipped out is in our catalogue); `BORROWED` may omit it (the title is not in our catalogue — we asked a partner for it). Multi-column CHECK enforces.

**6-state lifecycle:** `REQUESTED → IN_TRANSIT → ACTIVE → RETURNED | LOST` with `ACTIVE → OVERDUE` from the sweep. `RETURNED + LOST` are terminal.

**ALLOWED_TRANSITIONS map** lives in `InterlibraryLoanService`:

- REQUESTED → IN_TRANSIT, ACTIVE, LOST
- IN_TRANSIT → ACTIVE, LOST, RETURNED
- ACTIVE → RETURNED, OVERDUE, LOST
- OVERDUE → RETURNED, LOST

`patch(id, body, actor)` locks the row, validates the target transition, applies date stamps from the body (sentDate / receivedDate / dueDate / returnedDate), then UPDATEs.

**Sweep contract: `sweepOverdueForCurrentTenant()`** — UPDATE `WHERE status='ACTIVE' AND due_date < CURRENT_DATE` returning ids. Nightly worker.

**Reviewer check:**

- Cross-school district routing — single-school today (each tenant tracks its own ILL records). Phase 3 punch list item.
- Direction shape — `BORROWED` rows with no `catalogue_item_id` mean the title only exists as text. If the partner returns the book and we keep it, we'd need a separate "promote to catalogue" workflow. Out of scope this cycle.
- `LOST` from `OVERDUE` — accepted; reviewer should confirm the schema CHECK doesn't accidentally block this transition.

---

## 5. Catalogue import error handling

**Inline encoding for ISBN_BATCH:** the service stores the ISBN list as `inline://<json-array>` in `source_file_s3_key`. The worker recognises the `inline://` prefix and parses the JSON in-process — no S3 round-trip for small lists.

**CSV / MARC / WORLDCAT_SYNC** continue to use real S3 keys; the parser libraries are wired for CSV today (Phase 3 for MARC + WORLDCAT).

**Dedup contract:** duplicate ISBNs (an ISBN that already exists in `lib_catalogue_items` for this school) count as **`records_skipped`**, NOT `records_failed`. Failed = a row that couldn't be parsed or whose required fields are missing.

**Error log generation:** when `records_failed > 0` the worker materialises an error CSV at `error_log_s3_key` listing each failed row's index + reason. The Step 6 UI exposes the S3 key in the job detail Modal.

**Terminal transition emits `lib.import.completed`** via outbox INSIDE the same tx as the COMPLETED status flip. Deterministic event_id via `deterministicLibImportCompletedEventId(jobId)` (v5-shape, `sha256(jobId + ':lib.import.completed:v1')`). Retries land the same envelope every time and downstream consumers can dedup cleanly.

**Reviewer check:**

- Dedup-by-ISBN — what about an ISBN that exists but with a different title/author? Currently treated as a duplicate (skipped). Acceptable, or should this surface as a "data conflict" failure for librarian review?
- Inline encoding limit — small lists OK. Should there be a max-isbns cap on the DTO before the inline encoding rule no longer applies?
- Error log retention — currently no TTL; the school's S3 bucket lifecycle handles it. Acceptable?

---

## 6. ALTER pattern on existing Cycle 12 table

**Adding columns to a live table** is rare in our migration discipline — most cycles ship net-new tables. P2-25 has two ALTERs that needed care:

1. **`lib_reading_lists`** gains `target_grade_level TEXT` + `curriculum_unit_id UUID`. Both nullable so existing rows stay valid. INDEX added on `curriculum_unit_id WHERE NOT NULL` to support the new filter query.
2. **`lib_checkouts`** gains `class_set_checkout_id UUID FK lib_class_set_checkouts ON DELETE NO ACTION`. Nullable — existing single-copy checkouts have NULL. Partial INDEX `(class_set_checkout_id) WHERE class_set_checkout_id IS NOT NULL` for the per-set child query.

**Why ALTER instead of new tables:** the alternative would be a `lib_class_set_checkout_children` link table joining `class_set_checkout` to `lib_checkouts`, but that adds a join on every per-set query for no schema-level benefit. The FK from `lib_checkouts.class_set_checkout_id` is cleaner.

**Provisioning safety:** both ALTERs use `IF NOT EXISTS` style guards so re-running the migration is idempotent. Splitter trap checked — no `;` inside COMMENT strings or block comments.

**Reviewer check:**

- ALTER on `lib_checkouts` ON DELETE NO ACTION — the right choice? If a class set is hard-deleted (admin cleanup), should the child checkouts cascade? Today they'd refuse and force the admin to delete the children first. Acceptable for audit safety?
- Adding columns to a populated production table — migration discipline?

---

## 7. Permission distribution

| Code                                    | Read                                                                                         | Write                                                                        | Admin                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| `LIB-002` (Circulation extended)        | Librarian + admin + teacher (request class sets) + students/parents (own only via row scope) | Librarian + admin (class set checkout, ILL create/transition, import create) | Recommendation engine config mutation            |
| `LIB-003` (Reading Programmes extended) | Everyone (browse published reading lists, students read own recommendations)                 | Librarian + teacher (create + edit reading lists; admin override)            | Recommendation engine config mutation (alt code) |

**Recommendation config mutation gate:** `lib-002:admin OR lib-003:admin OR isSchoolAdmin`. Held by School Admin + Platform Admin via `everyFunction`. Librarian (`lib-002:write`) reads only.

**Class set checkout authority:** `lib-002:write` (librarian + admin). The Step 6 UI gates on the same.

**Reviewer check:**

- The "teachers request class sets via API" path — currently the teacher calls `POST /library/class-sets` directly with their own personId on `teacher_patron_id`, gated on `lib-002:write`. Reviewer should confirm whether teachers should hold `lib-002:write` or whether there should be a "request" workflow where the librarian fulfils.

---

## Open follow-ups (Phase 2 / pre-pilot punch list)

1. **`curriculum_unit_id` write-time validation** (soft ref today) — `EXISTS` probe against `cur_units` before INSERT.
2. **`lib_recommendations.dismissed_by` for student dismissals** — currently NULL because students don't have `hr_employees` rows. Pre-pilot extend the audit trail with a polymorphic `dismissed_by_account_id`.
3. **LibraryRecommendationWorker cron deployment** — schema + `replaceForStudent` helper ready; the actual weekly per-student aggregation worker ships next.
4. **CatalogueImportWorker MARC + WORLDCAT parsers** — out of scope this cycle.
5. **AI embedding enhancement for COLLABORATIVE_FILTERING** — Phase 3 once AI Inference deploys.
6. **Cross-school district ILL routing** — single-school today.
7. **Class set reservation calendar** — teachers can pre-book future sets manually; a calendar with overlap detection is a polish item.
8. **Digital resource lending (ebooks / audiobooks)** — out of scope this cycle.
9. **Score normalisation per strategy in `replaceForStudent`** — the helper accepts raw scores today; production worker should normalise within strategy then apply weights.

---

## CI parity (this commit)

- format:check + lint:logs clean (940 files clean)
- API build clean
- Web build clean (4 new library routes ship 9.23–10.1 kB First Load JS)
- vitest **1343/1343 across 64 spec files** (+48 library cases: 30 from P2-25a unit + 18 from P2-25b vertical slice)

Awaiting reviewer verdict.
