# Cycle 12 CAT — Library

**Status:** verified live on `tenant_demo` 2026-05-05 against the Step 9 build (commit `84527b5` on `main`). All 10 plan scenarios pass. **One ADR-057 wire envelope captured live** (`lib.fine.issued` with the full envelope shape — fineId / checkoutId / patronId / fineType=OVERDUE / amount=0.5 / daysOverdue=2 / status=OUTSTANDING / sourceRefId).

**Vertical slice:** Sarah Mitchell (school admin acting as librarian) adds **Bridge to Terabithia** to the catalogue with 2 copies (`LIB-CAT-101 NEW` and `LIB-CAT-102 GOOD` on the Fiction Shelves). The **GIN full-text keystone** ranks live for both `?q=Terabithia` (title hit) and `?q=Paterson` (author surname hit via the `COALESCE(author, '')` concatenation) — the search hits the new title within the same query that maintains the index. The librarian then scans `LIB-CAT-101` for Maya through the **`POST /library/checkouts` barcode keystone** which serialises concurrent scans with `SELECT … FOR UPDATE`, resolves Maya's patron-type via `platform.platform_students` first then `hr_employees`, reads the matching `lib_checkout_policies` (STUDENT 5/14d/2/$0.25), validates `is_available=true` AND `count(active checkouts) < policy.maxCheckouts`, INSERTs the checkout row with `due_date = today + 14d`, UPDATEs the copy to `is_available=false / location_status='CHECKED_OUT'`, all inside one tenant tx. Three more spare-copy checkouts bring Maya to the 5-active limit; the 6th attempt returns 400 with the policy message. With both Bridge copies out, the librarian places a **PENDING hold** for Ethan (Bridge availableCopies=0, activeHoldsCount=1). Maya's checkout is then back-dated 2 days overdue and the librarian returns it via `POST /library/checkouts/:id/return` — the **auto-fine + hold-reassignment keystone** fires inside one tenant tx: `days_overdue = GREATEST(CURRENT_DATE - due_date, 0)::int = 2`, an OVERDUE fine is INSERTed at `2 × $0.25 = $0.50`, the hold queue is walked with `SELECT … WHERE catalogue_item_id=$1 AND status='PENDING' ORDER BY placed_at ASC LIMIT 1 FOR UPDATE`, Ethan's hold flips to READY with `notified_at=now()`, the copy walks to `ON_HOLD_SHELF / is_available=false`, and `lib.fine.issued` emits **after** the tx commits — envelope captured live on `dev.lib.fine.issued`. Renewal lifecycle then tested against another active checkout: renew #1 → `renewalCount=1, dueDate=+14d`; renew #2 → `renewalCount=2`; renew #3 → 400 "Renewal limit reached (2 for STUDENT patrons)". **THE SECOND STUDENT-INPUT KEYSTONE** Maya logs Bridge to Terabithia as completed today (128 pages, 5★) via `POST /library/reading-log` — the `ReadingLogService` validates the catalogue item, INSERTs the log, then runs the **programme-progress auto-upsert** via SCHOOL_WIDE / CLASS audience-matching SQL: `INSERT ... ON CONFLICT (programme_id, student_id) DO UPDATE SET books_read += 1, pages_read += pagesRead, last_updated_at = now()` followed by an `is_complete` recompute against the programme thresholds — all inside the same tenant tx. Live verification: Maya's progress jumps `books_read 2 → 3, pages_read 313 → 441`. Maya then submits a 5★ review on Bridge; a duplicate-review attempt is caught by the UNIQUE(item, student) keystone with the friendly PATCH-redirect message. Teacher Rivera (lib-003:write but not list-author) creates a "Grade 5 Adventure Reads" reading list as DRAFT, adds Bridge as REQUIRED, then publishes via the **multi-column `published_chk` lockstep keystone** — the service stamps `is_published=true AND published_at=now()` atomically; the student's default `GET /library/reading-lists` (drafts hidden) immediately reveals the new list. Visibility model verified across 5 personas: Maya sees own checkouts/holds/fines/log only (the `?patronId=` query param is silently ignored for non-librarians); the parent has no `lib-002:read` so `GET /library/fines` returns **403 INSUFFICIENT_PERMISSIONS** at the gate; teacher and parent both 403 on `POST /library/checkouts` (lib-002:write required). Fine management closes the loop: librarian marks the new $0.50 OVERDUE fine PAID; admin (also Sarah) waives the seeded $0.50 OVERDUE fine on Holes with reason; re-pay attempt on the PAID fine returns 400 ("Cannot pay a fine in status PAID — only OUTSTANDING").

**Pre-conditions:**

- `pnpm seed` + the full Cycle 1–11 + Cycle 11.1 + Cycle 12 seed pipeline run on `tenant_demo` (the `seed:library` step is the relevant Cycle 12 addition).
- `tsx src/build-cache.ts` rebuilt the IAM cache. 7 personas:
  - admin / principal: 450 perms (every code × every tier via everyFunction)
  - counsellor / vp: 54 perms (Staff role — full LIB-001..002 read+write + LIB-003:write + everything from prior cycles)
  - teacher: 50 perms (incl. lib-001:read + lib-002:read + lib-003:write — author reading lists + see own staff checkouts)
  - **student: 24 perms (incl. lib-001:read + lib-002:read + `lib-003:read+write` — the SECOND STUDENT-INPUT PERMISSION in CampusOS** after Cycle 11.1 wellbeing's COU-004; row scope at the Step 7 services binds students to their own `student_id`)
  - parent: 24 perms (incl. lib-001:read only — catalogue browse; no lib-002:read so /checkouts + /holds + /fines all 403)
- `dev.lib.fine.issued` Kafka topic auto-created on first emit.
- API running on `localhost:4000` from `pnpm --filter @campusos/api build && node apps/api/dist/main.js`.

## Schema preamble (8 checks)

```sql
-- 1. Tenant logical base table count after Cycle 12 (3 schema migrations: 043 + 044 + 045)
SELECT COUNT(*) FROM information_schema.tables t
WHERE table_schema='tenant_demo' AND table_type='BASE TABLE'
  AND NOT EXISTS (
    SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = t.table_schema AND c.relname = t.table_name
  );
-- expected: 189

-- 2. Cycle 12 library tables: 3 from Step 1 (locations / catalogue items / copies)
--    + 4 from Step 2 (checkout policies / checkouts / holds / fines)
--    + 7 from Step 3 (programmes / reading logs / progress / completions / lists / list_items / reviews) = 14
SELECT COUNT(*) FROM information_schema.tables
WHERE table_schema='tenant_demo' AND table_name LIKE 'lib_%';
-- expected: 14

-- 3. 20 intra-tenant FKs across Cycle 12 library tables (2 from Step 1 + 3 from Step 2 + 15 from Step 3)
SELECT COUNT(*) FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE c.contype='f' AND n.nspname='tenant_demo' AND t.relname LIKE 'lib_%';
-- expected: 20

-- 4. 0 cross-schema FKs across all Cycle 12 library tables (per ADR-001/020)
SELECT COUNT(*) FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_class ft ON ft.oid = c.confrelid
JOIN pg_namespace fn ON fn.oid = ft.relnamespace
WHERE c.contype='f' AND n.nspname='tenant_demo' AND t.relname LIKE 'lib_%' AND fn.nspname <> 'tenant_demo';
-- expected: 0

-- 5. GIN full-text index on catalogue items
SELECT indexname FROM pg_indexes
WHERE schemaname='tenant_demo' AND tablename='lib_catalogue_items' AND indexdef LIKE '%gin%';
-- expected: 1 row, lib_catalogue_items_search_idx (or similar)

-- 6. IAM catalogue size after Cycle 12 (LIB-001..003 + LIB-004 reserved = 4 functions × 3 tiers + 438 from prior cycles)
SELECT COUNT(*) FROM platform.permissions;
-- expected: 450

-- 7. LIB-* permissions in the catalogue
SELECT COUNT(*) FROM platform.permissions WHERE code LIKE 'lib-%';
-- expected: 12 (LIB-001 + LIB-002 + LIB-003 + LIB-004, each × 3 tiers)

-- 8. Cycle 12 seed shape after seed:library on tenant_demo
SELECT 'locations' AS t, COUNT(*) FROM tenant_demo.lib_locations
UNION ALL SELECT 'catalogue_items',     COUNT(*) FROM tenant_demo.lib_catalogue_items
UNION ALL SELECT 'catalogue_copies',    COUNT(*) FROM tenant_demo.lib_catalogue_copies
UNION ALL SELECT 'checkouts',           COUNT(*) FROM tenant_demo.lib_checkouts
UNION ALL SELECT 'holds',               COUNT(*) FROM tenant_demo.lib_holds
UNION ALL SELECT 'fines',               COUNT(*) FROM tenant_demo.lib_fines
UNION ALL SELECT 'programmes',          COUNT(*) FROM tenant_demo.lib_reading_programmes
UNION ALL SELECT 'progress',            COUNT(*) FROM tenant_demo.lib_programme_progress
UNION ALL SELECT 'reading_logs',        COUNT(*) FROM tenant_demo.lib_reading_logs
UNION ALL SELECT 'reading_lists',       COUNT(*) FROM tenant_demo.lib_reading_lists
UNION ALL SELECT 'reading_list_items',  COUNT(*) FROM tenant_demo.lib_reading_list_items
UNION ALL SELECT 'reviews',             COUNT(*) FROM tenant_demo.lib_reviews
ORDER BY 1;
-- expected: locations=3, catalogue_items=5, catalogue_copies=11, checkouts=3, holds=1,
--           fines=1, programmes=1, progress=1, reading_logs=2, reading_lists=1,
--           reading_list_items=3, reviews=1
```

## Setup

```bash
API=http://localhost:4000/api/v1

# Persona tokens (dev login)
for email in admin@demo.campusos.dev principal@demo.campusos.dev teacher@demo.campusos.dev student@demo.campusos.dev parent@demo.campusos.dev; do
  TOKEN=$(curl -s -X POST "$API/auth/dev-login" -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' -d "{\"email\":\"$email\"}" | python3 -c "import sys, json; print(json.load(sys.stdin).get('accessToken','FAIL'))")
  alias=$(echo "$email" | cut -d@ -f1)
  echo "$TOKEN" > "/tmp/cat-tok-$alias"
done
HDR_PRINCIPAL=$(cat /tmp/cat-tok-principal)
HDR_TEACHER=$(cat /tmp/cat-tok-teacher)
HDR_STUDENT=$(cat /tmp/cat-tok-student)
HDR_PARENT=$(cat /tmp/cat-tok-parent)

# Maya = student@, person id from platform.platform_users.person_id
MAYA_PID=019dc92d-0885-7442-abf5-e91b3931585c
ETHAN_PID=019dc9e8-2e7a-7771-9aa9-6b298b308548   # from sis_students → platform_students → iam_person
PRINCIPAL_PID=019dc92d-087b-7442-abf5-cb569d8c725b
LOC_FICTION=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -t -A -c \
  "SELECT id FROM tenant_demo.lib_locations WHERE name='Fiction Shelves'")
```

## Scenario 1 — Catalogue lifecycle + GIN search

Sarah (acting as librarian, admin tier) adds **Bridge to Terabithia** to the catalogue with 2 copies. The GIN full-text index is maintained by Postgres on every INSERT, so search hits land immediately.

```bash
# S1.A — POST /library/catalogue
ITEM_RESP=$(curl -s -X POST "$API/library/catalogue" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d '{
  "title":"Bridge to Terabithia",
  "author":"Katherine Paterson",
  "isbn":"978-0064401845",
  "publisher":"HarperCollins",
  "publishYear":1977,
  "category":"Children'"'"'s Fiction",
  "deweyDecimal":"813.54",
  "description":"A friendship that spans the magical kingdom of Terabithia."
}')
ITEM_ID=$(echo "$ITEM_RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")

# S1.B — Add 2 copies on Fiction Shelves
curl -s -X POST "$API/library/catalogue/$ITEM_ID/copies" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d "{\"barcode\":\"LIB-CAT-101\",\"locationId\":\"$LOC_FICTION\",\"condition\":\"NEW\",\"replacementValue\":12.99}"
curl -s -X POST "$API/library/catalogue/$ITEM_ID/copies" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d "{\"barcode\":\"LIB-CAT-102\",\"locationId\":\"$LOC_FICTION\",\"condition\":\"GOOD\",\"replacementValue\":12.99}"

# S1.C — GIN search keystone (student-readable)
curl -s "$API/library/catalogue?q=Terabithia" -H "Authorization: Bearer $HDR_STUDENT" -H 'X-Tenant-Subdomain: demo'
# → 1 hit: Bridge to Terabithia by Katherine Paterson (avail 2/2)

curl -s "$API/library/catalogue?q=Paterson" -H "Authorization: Bearer $HDR_STUDENT" -H 'X-Tenant-Subdomain: demo'
# → 1 hit (author-surname via the COALESCE(author, '') concatenation in the GIN expression)

curl -s "$API/library/catalogue/$ITEM_ID" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo'
# → totalCopies=2, availableCopies=2, activeHoldsCount=0
```

**Verified live**: GIN ranks the new title in both directions (title + author surname) within the same INSERT cycle.

## Scenario 2 — Checkout by barcode + max_checkouts enforcement

The `POST /library/copies/barcode/:barcode` endpoint resolves a copy to its full state (item + checkout) in one round-trip. The `POST /library/checkouts` endpoint then serialises concurrent scans with `SELECT … FOR UPDATE`, validates the policy, and flips copy state.

```bash
# S2.A — Barcode lookup (no active checkout yet)
curl -s "$API/library/copies/barcode/LIB-CAT-101" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo'
# → copy=LIB-CAT-101, item=Bridge to Terabithia, activeCheckout=None

# S2.B — Principal checks out for Maya (already has 1 active from seed)
CHECKOUT_RESP=$(curl -s -X POST "$API/library/checkouts" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d "{\"barcode\":\"LIB-CAT-101\",\"patronId\":\"$MAYA_PID\"}")
# → status=ACTIVE, dueDate=today+14d, daysUntilDue=14

# S2.C — Bring Maya to the STUDENT max=5, then attempt the 6th
# (3 spare available copies + LIB-CAT-101 + The Giver from seed = 5 active)
for B in LIB-FIC-002 LIB-FIC-003 LIB-FIC-101; do
  curl -s -X POST "$API/library/checkouts" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d "{\"barcode\":\"$B\",\"patronId\":\"$MAYA_PID\"}"
done

curl -s -X POST "$API/library/checkouts" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d "{\"barcode\":\"LIB-CAT-102\",\"patronId\":\"$MAYA_PID\"}"
# → 400 "Patron has reached the maximum of 5 active checkouts for STUDENT patrons. Return a book before checking out another."

# S2.D — Teacher cannot process checkouts (controller gate)
curl -s -X POST "$API/library/checkouts" -H "Authorization: Bearer $HDR_TEACHER" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d "{\"barcode\":\"LIB-CAT-102\",\"patronId\":\"$MAYA_PID\"}"
# → 403 INSUFFICIENT_PERMISSIONS, required=["lib-002:write"]
```

**Verified live**: max_checkouts pre-flight refuses the 6th cleanly. Teacher 403'd at the gate.

## Scenario 3 — Hold queue (PENDING)

Both Bridge copies must be unavailable so Ethan's hold queues. Sarah checks LIB-CAT-102 out to herself (staff patron — `resolvePatronType` joins `hr_employees` first when `platform_students` misses).

```bash
# S3.A — Sarah checks out the second Bridge copy to herself (STAFF patron)
curl -s -X POST "$API/library/checkouts" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d "{\"barcode\":\"LIB-CAT-102\",\"patronId\":\"$PRINCIPAL_PID\"}"
# → status=ACTIVE, patronType=STAFF (30-day loan), dueDate=today+30d

# S3.B — Bridge availability after both copies out
curl -s "$API/library/catalogue/$ITEM_ID" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo'
# → totalCopies=2, availableCopies=0, activeHoldsCount=0

# S3.C — Principal places PENDING hold on Bridge for Ethan
HOLD_RESP=$(curl -s -X POST "$API/library/holds" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d "{\"catalogueItemId\":\"$ITEM_ID\",\"patronId\":\"$ETHAN_PID\"}")
HOLD_ID=$(echo "$HOLD_RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
# → status=PENDING, queuePosition=1, patronName="Ethan Rodriguez"

# S3.D — Bridge rollups now show 1 active hold
curl -s "$API/library/catalogue/$ITEM_ID" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo'
# → totalCopies=2, availableCopies=0, activeHoldsCount=1
```

**Verified live**: hold lands cleanly with queuePosition=1 + patronName resolved through the cross-schema join.

## Scenario 4 — Return + auto-fine + hold reassignment KEYSTONE

Backdate Maya's LIB-CAT-101 checkout to 2 days overdue, then return it. Inside one tenant tx the service stamps `returned_at + status='RETURNED'`, INSERTs the OVERDUE fine at `2 × $0.25 = $0.50`, walks the hold queue (Ethan's hold flips PENDING → READY with `notified_at=now()`), and walks the copy to `ON_HOLD_SHELF / is_available=false`. `lib.fine.issued` emits **after** the tx commits.

```bash
# S4.A — Backdate Maya's LIB-CAT-101 checkout to 2 days overdue
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "UPDATE tenant_demo.lib_checkouts SET checkout_date=CURRENT_DATE - 16, due_date=CURRENT_DATE - 2 WHERE id='$CHECKOUT_ID';"

# S4.B — Subscribe Kafka consumer for lib.fine.issued (background)
docker exec campusos-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic dev.lib.fine.issued \
  --max-messages 1 --timeout-ms 25000 > /tmp/cat-fine-envelope.json &

# S4.C — Principal returns the overdue copy
curl -s -X POST "$API/library/checkouts/$CHECKOUT_ID/return" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo'
# → status=RETURNED, returnedAt=2026-05-05T18:32:35+00

# S4.D — Auto-fine created
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT id, fine_type, amount, days_overdue, status FROM tenant_demo.lib_fines WHERE checkout_id='$CHECKOUT_ID';"
# → fine_type=OVERDUE, amount=0.50, days_overdue=2, status=OUTSTANDING

# S4.E — Ethan's hold flipped to READY
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT id, status, notified_at FROM tenant_demo.lib_holds WHERE id='$HOLD_ID';"
# → status=READY, notified_at populated

# S4.F — Returned copy walked to ON_HOLD_SHELF (is_available=false)
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT barcode, is_available, location_status FROM tenant_demo.lib_catalogue_copies WHERE id='$COPY1_ID';"
# → is_available=false, location_status=ON_HOLD_SHELF
```

**Wire envelope captured live on `dev.lib.fine.issued`** with full ADR-057 shape:

```json
{
  "event_id": "019df969-d249-7557-9dc2-001a3e762a06",
  "event_type": "lib.fine.issued",
  "event_version": 1,
  "occurred_at": "2026-05-05T18:32:35.145Z",
  "published_at": "2026-05-05T18:32:35.145Z",
  "tenant_id": "019dc92b-ea59-7bb7-aa7f-929729562010",
  "source_module": "library",
  "correlation_id": "019df969-d249-7557-9dc2-0bb3cf32589f",
  "payload": {
    "fineId": "019df969-d244-7557-9dc1-fa10f0b04d4a",
    "checkoutId": "019df966-3818-7557-9dc1-c0d07683a2b8",
    "patronId": "019dc92d-0885-7442-abf5-e91b3931585c",
    "fineType": "OVERDUE",
    "amount": 0.5,
    "daysOverdue": 2,
    "status": "OUTSTANDING",
    "sourceRefId": "019df969-d244-7557-9dc1-fa10f0b04d4a"
  }
}
```

The envelope's `sourceRefId === fineId` so a future Cycle 6 PaymentService consumer can use the standard `processWithIdempotency` claim-after-success pattern. **Cycle 6 payment integration is not wired today** — the emit lands cleanly with no consumer (the school-config `payment_integration_enabled` flag will turn it on in a later cycle).

## Scenario 5 — Renewal + limit enforcement

The STUDENT policy carries `renewals_allowed=2`. The renewal endpoint refuses past the limit.

```bash
# S5.A — Pick one of Maya's ACTIVE checkouts to renew (The Giver, renewal_count=0)
RENEW_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -t -A -c \
  "SELECT id FROM tenant_demo.lib_checkouts WHERE patron_id='$MAYA_PID' AND status='ACTIVE' ORDER BY checkout_date DESC LIMIT 1")

# S5.B — Renewal #1 (0 → 1)
curl -s -X POST "$API/library/checkouts/$RENEW_ID/renew" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo'
# → status=ACTIVE, renewalCount=1, dueDate=+14d

# S5.C — Renewal #2 (1 → 2)
curl -s -X POST "$API/library/checkouts/$RENEW_ID/renew" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo'
# → status=ACTIVE, renewalCount=2

# S5.D — Renewal #3 → 400 limit reached
curl -s -X POST "$API/library/checkouts/$RENEW_ID/renew" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo'
# → 400 "Renewal limit reached (2 for STUDENT patrons). The patron must return the book."
```

**Verified live**: renewals 1 and 2 succeed; renewal 3 refuses with the policy message.

## Scenario 6 — Reading programme auto-upsert KEYSTONE (second student-input surface)

Maya logs Bridge to Terabithia as completed today (128 pages, 5★). The `ReadingLogService.log()` runs the **programme-progress auto-upsert** inside one tenant tx — `INSERT ... ON CONFLICT (programme_id, student_id) DO UPDATE SET books_read = books_read + 1, pages_read = pages_read + EXCLUDED.pages_read, last_updated_at = now()` — for every active SCHOOL_WIDE / CLASS audience-matching programme, then recomputes `is_complete` against the programme thresholds.

```bash
# S6.A — Pre-state: Maya's Summer Reading Challenge progress
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT books_read, pages_read, is_complete FROM tenant_demo.lib_programme_progress WHERE student_id='$(docker exec campusos-postgres psql -U campusos -d campusos_dev -t -A -c "SELECT s.id FROM tenant_demo.sis_students s JOIN platform.platform_students ps ON ps.id=s.platform_student_id WHERE ps.person_id='$MAYA_PID'")';"
# → books_read=2, pages_read=313, is_complete=false (seeded)

# S6.B — Maya logs Bridge with completedDate (THE STUDENT-INPUT KEYSTONE)
LOG_RESP=$(curl -s -X POST "$API/library/reading-log" -H "Authorization: Bearer $HDR_STUDENT" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d "{
  \"catalogueItemId\":\"$ITEM_ID\",
  \"startedDate\":\"2026-04-25\",
  \"completedDate\":\"2026-05-05\",
  \"pagesRead\":128,
  \"rating\":5,
  \"reviewText\":\"Loved every chapter — the friendship is so real.\"
}")
# → logId=…, pagesRead=128, rating=5, completedDate=2026-05-05

# S6.C — Post-state: progress auto-upserted inside the same tx
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT books_read, pages_read, is_complete FROM tenant_demo.lib_programme_progress WHERE …;"
# → books_read=3, pages_read=441, is_complete=false (313 + 128 = 441; 3/10 books → not yet complete)
```

**Verified live**: `books_read 2 → 3, pages_read 313 → 441` — the auto-upsert keystone fires inside the log INSERT tx with the COALESCE-sentinel ON CONFLICT pattern.

## Scenario 7 — Student review + UNIQUE(item, student) catch

Maya 5-stars Bridge to Terabithia. The UNIQUE(item, student) keystone catches duplicate-review attempts with a friendly PATCH-redirect message.

```bash
# S7.A — Maya submits 5★ review
curl -s -X POST "$API/library/catalogue/$ITEM_ID/reviews" -H "Authorization: Bearer $HDR_STUDENT" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d '{"rating":5,"reviewText":"A beautiful story about friendship and imagination."}'
# → reviewId=…, rating=5, isApproved=true

# S7.B — Duplicate review attempt → 400 UNIQUE catch
curl -s -X POST "$API/library/catalogue/$ITEM_ID/reviews" -H "Authorization: Bearer $HDR_STUDENT" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d '{"rating":4,"reviewText":"Trying to review again."}'
# → 400 "You have already reviewed this book. PATCH /library/reviews/:id to edit your existing review."

# S7.C — Teacher can read reviews via the catalogue surface (lib-001:read)
curl -s "$API/library/catalogue/$ITEM_ID/reviews" -H "Authorization: Bearer $HDR_TEACHER" -H 'X-Tenant-Subdomain: demo'
# → 1 row: Maya Chen rated 5/5: "A beautiful story about friendship..."
```

**Verified live**: the controller uses `lib-001:read` (catalogue surface, not lib-003:read) so teachers — who hold lib-003:write but not lib-003:read — see reviews on the catalogue page.

## Scenario 8 — Reading list lifecycle + published_chk lockstep KEYSTONE

Teacher Rivera (lib-003:write) creates a "Grade 5 Adventure Reads" list as DRAFT, adds Bridge as REQUIRED, then publishes via the **multi-column `published_chk` lockstep keystone** — the service stamps `is_published=true AND published_at=now()` atomically inside one statement.

```bash
# S8.A — Teacher creates DRAFT list
LIST_RESP=$(curl -s -X POST "$API/library/reading-lists" -H "Authorization: Bearer $HDR_TEACHER" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d '{"name":"Grade 5 Adventure Reads","listType":"GENERAL","description":"Books that take you somewhere brave."}')
LIST_ID=$(echo "$LIST_RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
# → isPublished=false, publishedAt=null

# S8.B — Student GET /reading-lists (drafts hidden by default)
curl -s "$API/library/reading-lists" -H "Authorization: Bearer $HDR_STUDENT" -H 'X-Tenant-Subdomain: demo'
# → 1 row: ['Grade 5 Fiction Essentials'] (the seeded one); the new draft is not visible

# S8.C — Teacher adds Bridge as REQUIRED
curl -s -X POST "$API/library/reading-lists/$LIST_ID/items" -H "Authorization: Bearer $HDR_TEACHER" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d "{\"catalogueItemId\":\"$ITEM_ID\",\"itemType\":\"REQUIRED\",\"notes\":\"Read by week 3.\"}"
# → itemTitle="Bridge to Terabithia", itemType=REQUIRED, sortOrder=0

# S8.D — Teacher publishes (multi-column published_chk lockstep keystone)
curl -s -X PATCH "$API/library/reading-lists/$LIST_ID" -H "Authorization: Bearer $HDR_TEACHER" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d '{"isPublished":true}'
# → isPublished=true, publishedAt=2026-05-05T18:37:10+00 (both stamped in one UPDATE)

# S8.E — Student GET /reading-lists (now sees the new list)
curl -s "$API/library/reading-lists" -H "Authorization: Bearer $HDR_STUDENT" -H 'X-Tenant-Subdomain: demo'
# → 2 rows: ['Grade 5 Adventure Reads','Grade 5 Fiction Essentials']
```

**Verified live**: published_chk lockstep keeps `is_published` + `published_at` in sync atomically — the schema CHECK rejects any half-state UPDATE.

## Scenario 9 — Visibility model across 5 personas

The library backend uses controller-tier permission gates (`lib-001:read` / `lib-002:read` / `lib-002:write` / `lib-003:write`) **and** service-layer row scope. Reads on `/checkouts`, `/holds`, `/fines`, `/reading-log` are row-scoped to `actor.personId` for non-librarian patrons; the `?patronId=` query param is silently ignored for non-librarians.

```bash
# S9.A — Maya GETs /library/checkouts (own only)
curl -s "$API/library/checkouts" -H "Authorization: Bearer $HDR_STUDENT" -H 'X-Tenant-Subdomain: demo'
# → 6 rows, all with patronName="Maya Chen" (mixture of ACTIVE + RETURNED — seed + S2 + S4)

# S9.B — Maya GETs /library/holds (own only — none today)
curl -s "$API/library/holds" -H "Authorization: Bearer $HDR_STUDENT" -H 'X-Tenant-Subdomain: demo'
# → 0 rows

# S9.C — Maya GETs /library/fines (own only)
curl -s "$API/library/fines" -H "Authorization: Bearer $HDR_STUDENT" -H 'X-Tenant-Subdomain: demo'
# → 2 rows, both with patronName="Maya Chen" (seed Holes fine + new Bridge fine from S4)

# S9.D — Maya GETs /library/reading-log (own only)
curl -s "$API/library/reading-log" -H "Authorization: Bearer $HDR_STUDENT" -H 'X-Tenant-Subdomain: demo'
# → 3 rows, all with studentName="Maya Chen" (2 seeded + 1 new from S6)

# S9.E — Parent GETs /library/fines → 403 (no lib-002:read in the seed)
curl -s "$API/library/fines" -H "Authorization: Bearer $HDR_PARENT" -H 'X-Tenant-Subdomain: demo'
# → 403 INSUFFICIENT_PERMISSIONS, required=["lib-002:read"]

# S9.F — Parent POST /library/checkouts → 403
curl -s -X POST "$API/library/checkouts" -H "Authorization: Bearer $HDR_PARENT" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d "{\"barcode\":\"LIB-CAT-101\",\"patronId\":\"$ETHAN_PID\"}"
# → 403 INSUFFICIENT_PERMISSIONS, required=["lib-002:write"]

# S9.G — Teacher POST /library/checkouts → 403 (controller gate)
curl -s -X POST "$API/library/checkouts" -H "Authorization: Bearer $HDR_TEACHER" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d "{\"barcode\":\"LIB-CAT-101\",\"patronId\":\"$MAYA_PID\"}"
# → 403 INSUFFICIENT_PERMISSIONS, required=["lib-002:write"]

# S9.H — Student tries to query Ethan's checkouts via ?patronId — service silently scopes back to own
curl -s "$API/library/checkouts?patronId=$ETHAN_PID" -H "Authorization: Bearer $HDR_STUDENT" -H 'X-Tenant-Subdomain: demo'
# → 6 rows, all patronName="Maya Chen" — Ethan's are NOT leaked
```

**Verified live**: parent locked out at the lib-002:read gate; teacher locked out at the lib-002:write gate; student row-scope filter strips the `?patronId=` override silently.

## Scenario 10 — Fine management lifecycle

Librarian (lib-002:write) marks fines paid; school admin (`actor.isSchoolAdmin`) waives with reason. Status transitions are pinned by the service-layer lifecycle guard.

```bash
# S10.A — Find Maya's two OUTSTANDING fines
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT f.id, b.title, f.amount, f.status FROM tenant_demo.lib_fines f
   JOIN tenant_demo.lib_checkouts c ON c.id=f.checkout_id
   JOIN tenant_demo.lib_catalogue_copies cp ON cp.id=c.copy_id
   JOIN tenant_demo.lib_catalogue_items b ON b.id=cp.catalogue_item_id
   WHERE f.patron_id='$MAYA_PID' AND f.status='OUTSTANDING'
   ORDER BY f.created_at;"
# → Holes $0.50 OUTSTANDING (seed), Bridge to Terabithia $0.50 OUTSTANDING (new from S4)

FINE_NEW=…   # the Bridge fine
FINE_SEED=…  # the seeded Holes fine

# S10.B — Student PATCH pay → 403
curl -s -X PATCH "$API/library/fines/$FINE_NEW/pay" -H "Authorization: Bearer $HDR_STUDENT" -H 'X-Tenant-Subdomain: demo'
# → 403 INSUFFICIENT_PERMISSIONS, required=["lib-002:write"]

# S10.C — Principal marks Bridge fine PAID
curl -s -X PATCH "$API/library/fines/$FINE_NEW/pay" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo'
# → status=PAID, amount=0.5

# S10.D — School-admin waives the seeded Holes fine with reason (admin-only path)
curl -s -X PATCH "$API/library/fines/$FINE_SEED/waive" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo' -H 'Content-Type: application/json' -d '{"reason":"First-offence courtesy waiver — student returned promptly after notice."}'
# → status=WAIVED, amount=0.5

# S10.E — Re-pay attempt on PAID fine → 400 lifecycle guard
curl -s -X PATCH "$API/library/fines/$FINE_NEW/pay" -H "Authorization: Bearer $HDR_PRINCIPAL" -H 'X-Tenant-Subdomain: demo'
# → 400 "Cannot pay a fine in status PAID — only OUTSTANDING."
```

**Verified live**: pay + waive both transition cleanly; re-pay on a settled fine refuses with the lifecycle guard message.

## Cleanup (restore tenant_demo to post-Step-4 seed shape)

The CAT mutates a lot of state — new catalogue item + 2 copies + 4 checkouts + 1 hold + 1 fine + 1 review + 1 reading list + 1 reading log + the auto-upsert progress shift from 2/313 to 3/441. Cleanest path: wholesale truncate-and-reseed the lib\_\* tables.

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
DELETE FROM tenant_demo.lib_fines;
DELETE FROM tenant_demo.lib_holds;
DELETE FROM tenant_demo.lib_reading_logs;
DELETE FROM tenant_demo.lib_programme_completions;
DELETE FROM tenant_demo.lib_programme_progress;
DELETE FROM tenant_demo.lib_reading_list_items;
DELETE FROM tenant_demo.lib_reviews;
DELETE FROM tenant_demo.lib_reading_lists;
DELETE FROM tenant_demo.lib_reading_programmes;
DELETE FROM tenant_demo.lib_checkouts;
DELETE FROM tenant_demo.lib_catalogue_copies;
DELETE FROM tenant_demo.lib_catalogue_items;
DELETE FROM tenant_demo.lib_checkout_policies;
DELETE FROM tenant_demo.lib_locations;
"

pnpm --filter @campusos/database seed:library
```

Verify the post-cleanup shape matches Step 4 exactly:

```sql
SELECT 'locations' AS t, COUNT(*) FROM tenant_demo.lib_locations
UNION ALL SELECT 'items',     COUNT(*) FROM tenant_demo.lib_catalogue_items
UNION ALL SELECT 'copies',    COUNT(*) FROM tenant_demo.lib_catalogue_copies
UNION ALL SELECT 'checkouts', COUNT(*) FROM tenant_demo.lib_checkouts
UNION ALL SELECT 'holds',     COUNT(*) FROM tenant_demo.lib_holds
UNION ALL SELECT 'fines',     COUNT(*) FROM tenant_demo.lib_fines
UNION ALL SELECT 'progress',  COUNT(*) FROM tenant_demo.lib_programme_progress
UNION ALL SELECT 'logs',      COUNT(*) FROM tenant_demo.lib_reading_logs
UNION ALL SELECT 'lists',     COUNT(*) FROM tenant_demo.lib_reading_lists
UNION ALL SELECT 'list_items',COUNT(*) FROM tenant_demo.lib_reading_list_items
UNION ALL SELECT 'reviews',   COUNT(*) FROM tenant_demo.lib_reviews
ORDER BY 1;
-- expected: locations=3, items=5, copies=11, checkouts=3, holds=1, fines=1,
--           progress=1, logs=2, lists=1, list_items=3, reviews=1
```

## Reviewer attention items (non-blocking, Phase 2 polish)

These are documented gaps — the cycle is shipping clean and these can be addressed in follow-up cycles or pre-pilot hardening:

1. **`lib.fine.issued` has no consumer.** The emit lands cleanly with the full ADR-057 envelope but no Cycle 6 PaymentService consumer subscribes today. Wiring the school-config `payment_integration_enabled` flag + a `LibraryFineConsumer` that materialises a `pay_invoices` row would close the loop. Not blocking — the fine still tracks in `lib_fines` and the librarian collects manually.

2. **Librarian role is the school-admin tier today.** The `lib-001:write` and `lib-002:write` permissions are granted to the Staff role (which covers VPs, counsellors, admin assistants) plus admin tier via `everyFunction`. Real schools will want a dedicated Librarian role separate from the broader Staff tier — joins the Wave 2 Phase 2 punch list alongside the Counsellor / Nurse / Lead-counsellor splits from Cycles 9–11.

3. **Self-service hold placement** is gated on `lib-002:read` at the controller (not lib-002:write). Both controllers require `read` because students hold `read` but not `write`; the actual access boundary for cross-patron operations is the service-layer `hasLibrarianScope` check (mirrors Cycle 1 att-001:write self-service pattern). Documented in the Step 6 handoff.

4. **6 deferred ERD tables** — `lib_recommendations`, `lib_class_set_checkouts` (bulk teacher checkout flow), `lib_interlibrary_loans`, `lib_catalogue_import_jobs`, `lib_scan_sessions`, `lib_space_*` (study-room booking surface) — park as Cycle 12.1 / Wave 3.

5. **`lib.programme.completed` Kafka emit + completion certificate worker** — schema is ready (`lib_programme_completions`) but no service writes to it today. Programme completion is detected in `is_complete=true` flips during the Step 7 `ReadingLogService` auto-upsert; a future TaskWorker auto-task rule would generate the certificate S3 key.

6. **Parent visibility on `/children/[id]/library`** — parents currently hold only `lib-001:read` (catalogue browse). A child-checkout visibility surface where parents see their own children's checkouts/holds/fines is a polish item; the schema already supports it via the existing `sis_student_guardians` row-scope pattern from Cycle 9 + Cycle 10.

## Cycle 12 totals

- **14 lib\_\* base tables** across 3 schema migrations (043 catalogue + 044 circulation + 045 reading/reviews) — tenant logical base table count 175 → **189**
- **20 intra-tenant FKs** (2 + 3 + 15) distributed CASCADE × 12 / NO ACTION × 7 / SET NULL × 1
- **0 cross-schema FKs** per ADR-001/020
- **46 endpoints** across 10 services + 10 controllers — `/library/locations`, `/library/catalogue` (search + GIN), `/library/copies` (incl. barcode keystone), `/library/checkout-policies`, `/library/checkouts` (incl. return + renew + barcode lookup), `/library/holds`, `/library/fines` (pay + waive), `/library/reading-programmes` (incl. leaderboard), `/library/reading-log` (student-input keystone), `/library/reading-lists` (incl. items + publish), `/library/catalogue/:id/reviews` (incl. hide/unhide)
- **1 Kafka emit topic** (`lib.fine.issued`) — wire envelope captured live with full ADR-057 shape
- **11 web routes** across 5 catalogue/circulation pages + 5 reading/reviews/student pages + the `/library` persona-aware dashboard
- **~30 React Query hooks** in `apps/web/src/hooks/use-library.ts`
- **IAM catalogue stays at 450** (LIB-001..004 already in `permissions.json` from earlier drafts; LIB-004 reserved for the deferred Library Space module)
- **2 student-input keystone permissions** (LIB-003:read+write — the second student-input permission in CampusOS after Cycle 11.1 wellbeing's COU-004:read)

Cycle 12 ships clean to the post-cycle architecture review.
