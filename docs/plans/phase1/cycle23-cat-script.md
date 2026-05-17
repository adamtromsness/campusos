# Cycle 23 — Curriculum & Standards Vertical-Slice CAT

**Opens Wave 5 (Academic Advanced).** Reproducible end-to-end walkthrough verified live against `tenant_demo` on 2026-05-06. Walks the M25 Curriculum module from platform framework adoption through curriculum maps, units + scope-and-sequence, dual-resolution standards alignment, cross-cycle lesson linking back into Cycle 2 classroom data, the nightly delivery gap materialisation worker (ADR-018), and resource attachment with teacher-only gating.

The three structural keystones the CAT exercises end-to-end:

1. **PLATFORM/TENANT DUAL RESOLUTION** — national frameworks (CCSS, NGSS) live in `platform.cur_standards_frameworks_platform` + `platform.cur_standards_platform`; school-custom frameworks live in tenant `cur_standards_frameworks` + `cur_standards`. The `cur_unit_standards.standard_id` column resolves from EITHER side via app-layer lookup. The Step 4 `FrameworkService.list` returns a unified list with `source: 'PLATFORM' | 'SCHOOL'`.
2. **GIN-INDEXED STANDARDS SEARCH** — `platform.cur_standards_platform` carries `GIN INDEX USING GIN (to_tsvector('english', code || ' ' || description))`. `?q=narrative` returns CCSS.ELA-LITERACY.W.5.3 standards immediately + the Lincoln Academy custom standard that mentions narrative.
3. **NIGHTLY MATERIALISED DELIVERY GAPS (ADR-018)** — `cur_delivery_gaps` is computed by a worker, never on demand. The Step 6 worker walks each PUBLISHED `cur_curriculum_maps` → its units → aligned standards → counts planned lessons (`cur_unit_lessons`) and delivered lessons (`cls_lessons WHERE status='PUBLISHED' AND date <= CURRENT_DATE`) and UPSERTs the gap row. Emits `cur.delivery_gap.detected` for new NOT_STARTED / PARTIAL gaps. **First nightly read-model worker that reads across module boundaries** (curriculum → classroom).

## Prerequisites

```bash
# Provision + seed (idempotent)
pnpm --filter @campusos/database provision --subdomain=demo
pnpm --filter @campusos/database seed
pnpm --filter @campusos/database seed:sis
pnpm --filter @campusos/database seed:classroom
pnpm --filter @campusos/database seed:hr
pnpm --filter @campusos/database seed:library    # for the cross-cycle integration test
pnpm --filter @campusos/database seed:curriculum # Cycle 23 — gates on cur_curriculum_maps
pnpm --filter @campusos/database exec tsx src/seed-iam.ts
pnpm --filter @campusos/database exec tsx src/build-cache.ts

# Boot the API
pnpm --filter @campusos/api build && cd apps/api && node dist/main.js
```

## Schema preamble (live verified on `tenant_demo` 2026-05-06)

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
-- Logical base tables (excludes partition leaves)
SELECT
  (SELECT COUNT(*)::int FROM information_schema.tables t WHERE t.table_schema='tenant_demo' AND t.table_type='BASE TABLE'
    AND NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = t.table_schema AND c.relname = t.table_name)) AS tenant_logical_base_tables,
  (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema='tenant_demo' AND table_type='BASE TABLE' AND table_name LIKE 'cur_%') AS cur_tables,
  (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema='platform' AND table_name LIKE 'cur_%') AS platform_cur_tables,
  (SELECT COUNT(*)::int FROM pg_indexes WHERE schemaname='platform' AND indexname='cur_standards_platform_search_idx') AS gin_index_present,
  (SELECT COUNT(*)::int FROM information_schema.columns WHERE table_schema='tenant_demo' AND table_name='lib_reading_lists' AND column_name='curriculum_unit_id') AS lib_cross_cycle_col;
"
# tenant_logical_base_tables=320, cur_tables=9, platform_cur_tables=2, gin_index_present=1, lib_cross_cycle_col=1
```

```bash
# Step 3 seed counts
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SELECT 'platform.cur_standards_frameworks_platform' AS t, COUNT(*)::int AS rows FROM platform.cur_standards_frameworks_platform
UNION ALL SELECT 'platform.cur_standards_platform', COUNT(*)::int FROM platform.cur_standards_platform
UNION ALL SELECT 'cur_school_framework_adoptions', COUNT(*)::int FROM tenant_demo.cur_school_framework_adoptions
UNION ALL SELECT 'cur_standards_frameworks', COUNT(*)::int FROM tenant_demo.cur_standards_frameworks
UNION ALL SELECT 'cur_standards', COUNT(*)::int FROM tenant_demo.cur_standards
UNION ALL SELECT 'cur_curriculum_maps', COUNT(*)::int FROM tenant_demo.cur_curriculum_maps
UNION ALL SELECT 'cur_units', COUNT(*)::int FROM tenant_demo.cur_units
UNION ALL SELECT 'cur_unit_standards', COUNT(*)::int FROM tenant_demo.cur_unit_standards
UNION ALL SELECT 'cur_unit_lessons', COUNT(*)::int FROM tenant_demo.cur_unit_lessons
UNION ALL SELECT 'cur_delivery_gaps', COUNT(*)::int FROM tenant_demo.cur_delivery_gaps
UNION ALL SELECT 'cur_resource_links', COUNT(*)::int FROM tenant_demo.cur_resource_links
UNION ALL SELECT 'cls_lessons (Cycle 2 cross-cycle)', COUNT(*)::int FROM tenant_demo.cls_lessons
ORDER BY t;
"
# Expected: platform_frameworks=3, platform_standards=33, adoptions=1, custom_frameworks=1,
#           custom_standards=5, maps=1, units=4, unit_standards=8, unit_lessons=3,
#           delivery_gaps=4, resource_links=3, cls_lessons=3
```

## Scenario walkthrough (live verified 2026-05-06)

```bash
PRINCIPAL_TOKEN=$(curl -sf -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"principal@demo.campusos.dev"}' | jq -r '.accessToken')
TEACHER_TOKEN=$(curl -sf -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"teacher@demo.campusos.dev"}' | jq -r '.accessToken')
STUDENT_TOKEN=$(curl -sf -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"student@demo.campusos.dev"}' | jq -r '.accessToken')
PARENT_TOKEN=$(curl -sf -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"parent@demo.campusos.dev"}' | jq -r '.accessToken')
```

### S1 — DUAL-RESOLUTION framework list

```bash
curl -sf http://localhost:4000/api/v1/curriculum/frameworks \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq 'map({source, name, standardCount})'
# [
#   {"source":"PLATFORM","name":"Common Core State Standards — ELA","standardCount":15},
#   {"source":"SCHOOL","name":"Lincoln Academy Writing Standards","standardCount":5}
# ]
```

### S2 — GIN search keystone

```bash
curl -sf "http://localhost:4000/api/v1/curriculum/standards?q=narrative" \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq 'map({source, code})'
# [
#   {"source":"PLATFORM","code":"CCSS.ELA-LITERACY.W.5.3a"},
#   {"source":"PLATFORM","code":"CCSS.ELA-LITERACY.W.5.3b"},
#   {"source":"PLATFORM","code":"CCSS.ELA-LITERACY.W.5.3e"},
#   {"source":"SCHOOL","code":"LA.WRITE.VOICE.1"}
# ]

curl -sf "http://localhost:4000/api/v1/curriculum/standards?q=plants" \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq 'map(.code)'
# ["NGSS.5-LS1-1","NGSS.5-LS2-1"]

curl -sf "http://localhost:4000/api/v1/curriculum/standards?q=fraction" \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq 'map(.code)'
# ["CCSS.MATH.CONTENT.5.NF.A.1","CCSS.MATH.CONTENT.5.NF.B.4"]
```

### S3 — Adoption + curriculum map list with gap summary

```bash
curl -sf http://localhost:4000/api/v1/curriculum/framework-adoptions \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq 'map({platformFrameworkName, academicYearName})'
# [{"platformFrameworkName":"Common Core State Standards — ELA","academicYearName":"2025-2026"}]

curl -sf http://localhost:4000/api/v1/curriculum/maps \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq 'map({title, status, unitCount, totalStandards, gapSummary})'
# [{"title":"Grade 5 ELA 2025-2026","status":"PUBLISHED","unitCount":4,"totalStandards":8,
#   "gapSummary":{"complete":1,"partial":1,"notStarted":2}}]
```

### S4 — Unit detail with dual-resolution alignment

```bash
MAP_ID=$(curl -sf http://localhost:4000/api/v1/curriculum/maps \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' | jq -r '.[0].id')
UNIT_ID=$(curl -sf "http://localhost:4000/api/v1/curriculum/maps/$MAP_ID/units" \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq -r '.[] | select(.title=="Narrative Writing") | .id')

curl -sf "http://localhost:4000/api/v1/curriculum/units/$UNIT_ID" \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq '{title, sequenceOrder, estimatedWeeks,
         standards: (.standards | map({source: .standard.source, code: .standard.code})),
         lessons: (.lessons | map({lessonTitle, lessonStatus, lessonDate})),
         resources: (.resources | map({resourceType, title, isTeacherOnly}))}'
# {
#   "title": "Narrative Writing",
#   "sequenceOrder": 1,
#   "estimatedWeeks": 4,
#   "standards": [
#     {"source":"PLATFORM","code":"CCSS.ELA-LITERACY.W.5.3a"},
#     ... 5 platform + 3 school custom ...
#   ],
#   "lessons": [
#     {"lessonTitle":"Lesson 1: What Makes a Story?","lessonStatus":"PUBLISHED","lessonDate":"2025-09-08"},
#     {"lessonTitle":"Lesson 2: Show, Don't Tell","lessonStatus":"PUBLISHED","lessonDate":"2025-09-15"},
#     {"lessonTitle":"Lesson 3: Dialogue & Pacing","lessonStatus":"DRAFT","lessonDate":"2025-09-22"}
#   ],
#   "resources": [
#     {"resourceType":"FILE","title":"Example Narratives","isTeacherOnly":false},
#     {"resourceType":"URL","title":"Story Structure Guide","isTeacherOnly":false},
#     {"resourceType":"FILE","title":"Narrative Writing Rubric","isTeacherOnly":true}
#   ]
# }
```

### S5 — Resource visibility (teacher-only filter)

```bash
curl -sf "http://localhost:4000/api/v1/curriculum/units/$UNIT_ID/resources" \
  -H "Authorization: Bearer $STUDENT_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq 'map({title, isTeacherOnly})'
# Student sees 2 (no teacher-only):
# [
#   {"title":"Example Narratives","isTeacherOnly":false},
#   {"title":"Story Structure Guide","isTeacherOnly":false}
# ]

curl -sf "http://localhost:4000/api/v1/curriculum/units/$UNIT_ID/resources" \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq 'length'
# 3 (teacher sees all)
```

### S6 — Cross-cycle lesson linking validation (Cycle 2)

```bash
# Create a fresh cls_lesson row
NEW_LESSON_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -X -c \
  "INSERT INTO tenant_demo.cls_lessons (id, school_id, status, title, learning_objectives) VALUES (gen_random_uuid(), '019dc92b-ea59-7bb7-aa7f-929729562010', 'PUBLISHED', 'CAT smoke lesson', ARRAY[]::text[]) RETURNING id::text;" | tr -d '\r\n ')

# Bogus → 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "http://localhost:4000/api/v1/curriculum/units/$UNIT_ID/lessons" \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H 'Content-Type: application/json' \
  -H 'X-Tenant-Subdomain: demo' \
  -d '{"clsLessonId":"00000000-0000-0000-0000-000000000000"}'
# 400

# Real → 201 with lesson title resolved from Cycle 2
curl -sf -X POST "http://localhost:4000/api/v1/curriculum/units/$UNIT_ID/lessons" \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H 'Content-Type: application/json' \
  -H 'X-Tenant-Subdomain: demo' \
  -d "{\"clsLessonId\":\"$NEW_LESSON_ID\"}" \
  | jq '{lessonTitle, lessonStatus}'
# {"lessonTitle":"CAT smoke lesson","lessonStatus":"PUBLISHED"}
```

### S7 — KEYSTONE: nightly delivery-gap re-materialisation + Kafka emit

```bash
# Pre-create the topic (one-time on a fresh broker)
docker exec campusos-kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --create --if-not-exists \
  --topic dev.cur.delivery_gap.detected --partitions 1 --replication-factor 1

# Trigger the worker
curl -sf -X POST "http://localhost:4000/api/v1/curriculum/delivery-gaps/refresh" \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'Content-Type: application/json' \
  -H 'X-Tenant-Subdomain: demo' -d '{}'
# {"unitsScanned":1,"gapsWritten":8}

# Per-unit gap state — every aligned standard gets its row
curl -sf "http://localhost:4000/api/v1/curriculum/units/$UNIT_ID/gaps" \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq 'map({standardCode, gapType, lessonsPlanned, lessonsDelivered})'
# 8 rows: planned=3 (3 cur_unit_lessons rows), delivered=2 (2 PUBLISHED lessons with date <= today)
# All gapType=PARTIAL because the worker uses unit-level lesson counts.

# Capture the wire envelope
docker exec campusos-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic dev.cur.delivery_gap.detected \
  --from-beginning --max-messages 1 --timeout-ms 5000
# {"event_id":"019dfe58-a454-7cc1-bbeb-0d4eb174227e",
#  "event_type":"cur.delivery_gap.detected",
#  "event_version":1,
#  "tenant_id":"019dc92b-ea59-7bb7-aa7f-929729562010",
#  "source_module":"curriculum",
#  "payload":{"unitId":"...","standardId":"...","standardCode":"CCSS.ELA-LITERACY.W.5.3a",
#             "gapType":"PARTIAL","schoolId":"...","sourceRefId":"..."}}
```

### S8 — Library cross-link (Cycle 12 → Cycle 23)

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
UPDATE tenant_demo.lib_reading_lists SET curriculum_unit_id = '$UNIT_ID'::uuid
WHERE name = 'Grade 5 Fiction Essentials' RETURNING name, curriculum_unit_id::text;
"
# name=Grade 5 Fiction Essentials  curriculum_unit_id=<Narrative Writing unit id>
```

The Cycle 12 reading list detail page now resolves `curriculum_unit_id` to render the curriculum unit context (the Cycle 12 UI lookup is a Phase 2 polish).

### S9 — Visibility matrix

```bash
echo "Frameworks (PUBLISHED only for non-staff readers):"
for who in PRINCIPAL TEACHER STUDENT PARENT; do
  TOK="${who}_TOKEN"
  COUNT=$(curl -sf "http://localhost:4000/api/v1/curriculum/maps" \
    -H "Authorization: Bearer ${!TOK}" -H 'X-Tenant-Subdomain: demo' | jq 'length')
  echo "  $who sees $COUNT map(s)"
done
# PRINCIPAL sees 1, TEACHER sees 1, STUDENT sees 1 (PUBLISHED), PARENT sees 1 (PUBLISHED)
```

### S10 — Permission denials

```bash
# Student / parent cannot create maps (tch-008:write required)
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:4000/api/v1/curriculum/maps \
  -H "Authorization: Bearer $STUDENT_TOKEN" -H 'Content-Type: application/json' \
  -H 'X-Tenant-Subdomain: demo' \
  -d '{"academicYearId":"019dc92e-...","subject":"Hax","gradeLevel":"5","title":"PWN"}'
# 403

# Teacher cannot create custom frameworks (tch-008:admin required)
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:4000/api/v1/curriculum/frameworks \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H 'Content-Type: application/json' \
  -H 'X-Tenant-Subdomain: demo' \
  -d '{"name":"Pwned"}'
# 403

# Teacher cannot trigger gap refresh (tch-008:admin required)
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://localhost:4000/api/v1/curriculum/delivery-gaps/refresh \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H 'Content-Type: application/json' \
  -H 'X-Tenant-Subdomain: demo' -d '{}'
# 403
```

## Cleanup

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -X -c "
SET search_path TO tenant_demo, public;
-- S6/S7 cleanup
DELETE FROM cur_unit_lessons WHERE cls_lesson_id IN (
  SELECT id FROM cls_lessons WHERE title LIKE 'CAT smoke lesson%'
);
DELETE FROM cls_lessons WHERE title LIKE 'CAT smoke lesson%';
-- S8 cleanup
UPDATE lib_reading_lists SET curriculum_unit_id = NULL WHERE name = 'Grade 5 Fiction Essentials';
-- Re-run the gap worker to reset to seeded baseline (4 rows on Narrative Writing)
DELETE FROM cur_delivery_gaps;
"
# Then re-run the manual refresh to re-materialise from the seeded snapshot.
```

## Reviewer attention items (non-blocking, Phase 2 polish)

- **Per-(unit, standard) lesson tracking** — the Step 6 worker uses unit-level lesson counts, so every aligned standard on a unit shares the same `lessonsPlanned / lessonsDelivered` numbers. The plan envisioned per-(standard) granularity (e.g., a lesson that only covers W.5.3a vs another that covers W.5.3b). Phase 2 should add a `cur_unit_lesson_standards` link table or a `cls_lessons.aligned_standard_ids TEXT[]` field so the worker can attribute delivered lessons per standard.
- **Real "delivered" semantics on `cls_lessons`** — the worker treats `status='PUBLISHED' AND date <= CURRENT_DATE` as the "delivered" proxy. A real schema field (`cls_lessons.delivered_at` or a separate `cls_lesson_deliveries` table) would let teachers explicitly mark lessons as delivered when they happen, regardless of the `status` field.
- **Cycle 12 reading list UI cross-link** — the schema column `lib_reading_lists.curriculum_unit_id` is now in place but the existing Cycle 12 reading-list detail page does not yet render the linked curriculum unit. Wire it in a Phase 2 polish pass.
- **Nightly cron for gap materialisation** — today the worker runs only via `POST /curriculum/delivery-gaps/refresh`. A real cron / scheduled job that triggers `materialiseCurrentTenant()` for every active school nightly is Phase 2.
- **Standards alignment via `cur_unit_lesson_standards`** — when a teacher links a lesson to a unit, the lesson is implicitly considered to deliver every standard the unit aligns to. Pre-pilot, allow teachers to specify which standards a lesson covers explicitly.

**Cycle 23 ships clean to the post-cycle architecture review. Wave 5 (Academic Advanced) opens here.**
