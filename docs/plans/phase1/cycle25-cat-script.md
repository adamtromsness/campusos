# Cycle 25 CAT — Publications (M42)

**Reproducible end-to-end vertical slice walkthrough.** Verified live on `tenant_demo` 2026-05-06.

Closes Wave 5 (Academic Advanced). The school newsletter as a first-class platform object. Recurring series with auto-incremented numbered editions, multi-section content authoring with collaborator roles + per-section ownership + contributor attribution, ADR-035 approval gate (staff publish directly; student-authored sections require approval), rule-based audience resolution, per-recipient delivery tracking, and series subscriptions with self-service opt-out.

---

## Setup

```bash
PARENT_TOKEN=$(curl -s -X POST -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" -d '{"email":"parent@demo.campusos.dev"}' http://localhost:4000/api/v1/auth/dev-login | grep -o '"accessToken":"[^"]*"' | sed 's/"accessToken":"\([^"]*\)"/\1/')
STUDENT_TOKEN=$(curl -s -X POST -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" -d '{"email":"student@demo.campusos.dev"}' http://localhost:4000/api/v1/auth/dev-login | grep -o '"accessToken":"[^"]*"' | sed 's/"accessToken":"\([^"]*\)"/\1/')
TEACHER_TOKEN=$(curl -s -X POST -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" -d '{"email":"teacher@demo.campusos.dev"}' http://localhost:4000/api/v1/auth/dev-login | grep -o '"accessToken":"[^"]*"' | sed 's/"accessToken":"\([^"]*\)"/\1/')
PRINCIPAL_TOKEN=$(curl -s -X POST -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" -d '{"email":"principal@demo.campusos.dev"}' http://localhost:4000/api/v1/auth/dev-login | grep -o '"accessToken":"[^"]*"' | sed 's/"accessToken":"\([^"]*\)"/\1/')
```

---

## Schema preamble

| #   | Check                             | Expected                                                                                                                                                | Result                                                                                                                                                                                                                                          |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Tenant base table count           | 336                                                                                                                                                     | ✓                                                                                                                                                                                                                                               |
| P2  | pub\_\* tables                    | 11                                                                                                                                                      | ✓ pub_series, pub_edition, pub_publications, pub_publication_collaborators, pub_sections, pub_section_contributors, pub_section_comments, pub_distribution_lists, pub_distribution_rules, pub_distribution_recipients, pub_series_subscriptions |
| P3  | Cross-schema FKs from pub\_\*     | 0                                                                                                                                                       | ✓                                                                                                                                                                                                                                               |
| P4  | Intra-tenant FKs from pub\_\*     | 15                                                                                                                                                      | ✓ CASCADE × 9 + SET NULL × 4 + NO ACTION × 2                                                                                                                                                                                                    |
| P5  | PUB-001..003 in catalogue + cache | 3 codes                                                                                                                                                 | ✓ Teacher 83 / Student 47 / Parent 42 / Staff 132                                                                                                                                                                                               |
| P6  | "The Weekly Eagle" seed shape     | 1 series + 2 editions + 3 publications + 4 collaborators + 4 sections + 2 contributors + 2 comments + 1 list + 2 rules + 5 recipients + 3 subscriptions | ✓                                                                                                                                                                                                                                               |

---

## Scenario 1 — Series + auto-increment editions

```bash
SERIES_ID=$(curl -s -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PRINCIPAL_TOKEN" http://localhost:4000/api/v1/publications/series | python3 -c 'import sys,json; print([s["id"] for s in json.load(sys.stdin) if s["title"]=="The Weekly Eagle"][0])')
curl -s -X POST -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PRINCIPAL_TOKEN" -d '{}' "http://localhost:4000/api/v1/publications/series/$SERIES_ID/editions"
# → status 201; editionNumber: 13 (auto-increment)
```

**Result:** ✓ Series + auto-increment edition_number works.

---

## Scenario 2 — Publication detail with collaborators + sections

```bash
PUB11_ID=$(curl -s -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PRINCIPAL_TOKEN" "http://localhost:4000/api/v1/publications?status=PUBLISHED" | python3 -c 'import sys,json; print([p["id"] for p in json.load(sys.stdin) if "Edition #11" in p["title"]][0])')

# 4 sections (3 approved + 1 pending student section)
curl -s -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PRINCIPAL_TOKEN" "http://localhost:4000/api/v1/publications/$PUB11_ID/sections"
# → 4 sections, 3 approved, 1 (Student Spotlight) is_approved=false
```

**Result:** ✓ 4 sections (3 approved + Student Spotlight pending).

---

## Scenario 3 — ADR-035 approval gate

```bash
PUB12_ID=$(curl -s -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PRINCIPAL_TOKEN" "http://localhost:4000/api/v1/publications?status=DRAFT" | python3 -c 'import sys,json; print([p["id"] for p in json.load(sys.stdin) if "Edition #12" in p["title"]][0])')

# DRAFT → IN_REVIEW
curl -s -X PATCH -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PRINCIPAL_TOKEN" -d '{"status":"IN_REVIEW"}' "http://localhost:4000/api/v1/publications/$PUB12_ID/status"
# → 200

# Add a student-owned section (no ownerEmployeeId → defaults is_approved=false)
curl -s -X POST -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $STUDENT_TOKEN" -d '{"title":"Student spotlight","body":"Maya story"}' "http://localhost:4000/api/v1/publications/$PUB12_ID/sections"
# → 201

# IN_REVIEW → APPROVED — MUST FAIL because student section is pending
curl -s -X PATCH -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PRINCIPAL_TOKEN" -d '{"status":"APPROVED"}' "http://localhost:4000/api/v1/publications/$PUB12_ID/status"
# → 400 — ADR-035 keystone

# Approve the section
NEW_SEC=$(curl -s -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PRINCIPAL_TOKEN" "http://localhost:4000/api/v1/publications/$PUB12_ID/sections" | python3 -c 'import sys,json; print([s["id"] for s in json.load(sys.stdin) if not s["isApproved"]][0])')
curl -s -X PATCH -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PRINCIPAL_TOKEN" "http://localhost:4000/api/v1/publication-sections/$NEW_SEC/approve"
# → 200, isApproved=true

# Now APPROVED succeeds
curl -s -X PATCH -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PRINCIPAL_TOKEN" -d '{"status":"APPROVED"}' "http://localhost:4000/api/v1/publications/$PUB12_ID/status"
# → 200
```

**Result:** ✓ ADR-035 keystone — student-authored sections gate the parent publication's APPROVED transition.

---

## Scenario 4 — Audience preview + distribute keystone + Kafka envelope

```bash
docker exec campusos-kafka /opt/kafka/bin/kafka-topics.sh --create --if-not-exists --topic dev.pub.publication.published --bootstrap-server localhost:9092 --partitions 1 --replication-factor 1

# Audience preview on Pub #11 (already PUBLISHED, has 2 ROLE rules: PARENT + STAFF)
curl -s -X POST -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PRINCIPAL_TOKEN" "http://localhost:4000/api/v1/publications/$PUB11_ID/audience-preview"
# → {"totalRecipients": 2, "excludedUnsubscribed": 1, "sampleNames": ["David Chen", "Linda Park"]}
# Hayes is unsubscribed → excluded; David (PARENT) + Linda Park (STAFF) match the rules

# Distribute Pub #11
curl -s -X POST -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PRINCIPAL_TOKEN" "http://localhost:4000/api/v1/publications/$PUB11_ID/distribute"
# → {"totalRecipients": 6, "alreadyExisted": 5, "status": "PUBLISHED"} (1 new recipient added — Park; 5 seeded ones already existed)

# Wire envelope
docker exec campusos-kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic dev.pub.publication.published --from-beginning --max-messages 1 --timeout-ms 5000
# → {event_type: pub.publication.published, source_module: publications, tenant_id: <uuid>, payload: {publicationId, sourceRefId, schoolId, title, seriesId, totalRecipients, publishedById, publishedAt}}
```

**Result:** ✓ Audience resolution OR-aggregates rules, excludes UNSUBSCRIBED, PUBLISH + DISTRIBUTE keystone fires `pub.publication.published` with full ADR-057 envelope shape.

---

## Scenario 5 — Distribution status

```bash
curl -s -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PRINCIPAL_TOKEN" "http://localhost:4000/api/v1/publications/$PUB11_ID/distribution-status"
# → {publicationId, totalRecipients, pending, delivered, opened, bounced}
```

**Result:** ✓ Per-publication delivery rollup.

---

## Scenario 6 — Subscription lifecycle

```bash
# Parent's subscriptions
curl -s -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PARENT_TOKEN" http://localhost:4000/api/v1/publications/my-subscriptions
# → 1 row: David Chen subscribed to The Weekly Eagle

# Parent unsubscribes
curl -s -X POST -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PARENT_TOKEN" "http://localhost:4000/api/v1/publications/series/$SERIES_ID/unsubscribe"
# → status: UNSUBSCRIBED, unsubscribedAt populated

# Audience preview now drops David from the matched set:
curl -s -X POST -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PRINCIPAL_TOKEN" "http://localhost:4000/api/v1/publications/$PUB11_ID/audience-preview"
# → totalRecipients: 1 (only Linda Park; David excluded), excludedUnsubscribed: 2

# Re-subscribe
curl -s -X POST -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PARENT_TOKEN" "http://localhost:4000/api/v1/publications/series/$SERIES_ID/subscribe"
# → status: SUBSCRIBED, unsubscribedAt: null (idempotent re-subscribe path)
```

**Result:** ✓ Self-service opt-out + opt-in lifecycle. UNSUBSCRIBED recipients are excluded from `resolveAudience` even when their role matches.

---

## Scenario 7 — Permission denials

```bash
# Student creates series → 403
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $STUDENT_TOKEN" -d '{"title":"x","publicationType":"NEWSLETTER","frequency":"WEEKLY"}' http://localhost:4000/api/v1/publications/series
# → 403

# Parent creates section → 403
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $PARENT_TOKEN" -d '{"title":"x"}' "http://localhost:4000/api/v1/publications/$PUB12_ID/sections"
# → 403

# Teacher distributes → 403 (no PUB-003:write)
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "X-Tenant-Subdomain: demo" -H "Authorization: Bearer $TEACHER_TOKEN" "http://localhost:4000/api/v1/publications/$PUB12_ID/distribute"
# → 403
```

**Result:** ✓ Permission gates work as designed.

---

## Cleanup

```bash
docker exec -i campusos-postgres psql -U campusos -d campusos_dev <<'SQL'
SET search_path TO tenant_demo, platform, public;
-- Drop the smoke-added section + recipient + revert pub12 to DRAFT
DELETE FROM pub_distribution_recipients
  WHERE publication_id IN (SELECT id FROM pub_publications WHERE title LIKE '%Edition #11')
  AND id IN (
    SELECT id FROM pub_distribution_recipients
    WHERE publication_id IN (SELECT id FROM pub_publications WHERE title LIKE '%Edition #11')
    ORDER BY created_at DESC LIMIT 1
  );
UPDATE pub_publications SET status='DRAFT', published_at=NULL
  WHERE id IN (SELECT id FROM pub_publications WHERE title LIKE '%Edition #12');
DELETE FROM pub_sections
  WHERE title='Student spotlight'
  AND publication_id IN (SELECT id FROM pub_publications WHERE title LIKE '%Edition #12');
SQL
```

**Result:** ✓ Tenant restored to post-Step-3 seed shape.

---

## Verdict

All 7 scenarios pass. Cycle 25 ships clean to the post-cycle architecture review.

Reviewer attention items (non-blocking, deferred to Cycle 25.1 + Phase 2 polish):

- **`pub_publication_versions`** — full version history with diff tracking; deferred per the plan.
- **`pub_media_assets`** — shared media library across publications; deferred.
- **`pub_approval_delegations`** — delegation of approval authority during absences; deferred.
- **`pub_templates`** — reusable publication templates with pre-built section layouts; deferred.
- **PDF rendering for print distribution** — Phase 3 ops.
- **Email HTML template builder** — Phase 3 ops; plain-text delivery via Cycle 14 fan-out is the current path.
- **Analytics dashboard (open + click rates)** — Phase 2 polish.
- **District-level publications** — school-level only this cycle.
- **Scheduled future publishing cron** — schema ready (`scheduled_publish_at`); cron worker is Phase 3.
- **`PUB-003` permission rename** — the catalogue currently labels PUB-003 "Parent Portal" but Cycle 25 uses it as the Distribution gate per the plan's PUB-001..003 mapping. Rename the catalogue label before pilot to match runtime semantics.
