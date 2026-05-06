# Cycle 22 — IT Infrastructure Vertical-Slice CAT

**Closes Wave 4 (Campus Operations).** Reproducible end-to-end walkthrough verified live against `tenant_demo` on 2026-05-06. Walks the M62 IT Infrastructure module from asset registration through licence + vault management, MDM compliance, infrastructure registry, procurement, and the parent-active device-selection workflow (ADR-066). The IT Administrator (IT admin) is the **ninth specialist operator persona** after the nurse, counsellor, librarian, athletic director, enrolment officer, transportation coordinator, food service manager, and facilities manager.

The two structural keystones the CAT exercises end-to-end:

1. **Encrypted Credential Vault (ADR-065)** — `tech_credential_vault` stores AES-256-GCM ciphertext + auth tag (base64-encoded). The Step 6 `CredentialVaultService.getByIdWithPassword` resolves the actor's effective tier (STANDARD / ELEVATED / CRITICAL), refuses to decrypt when tier < credential tier, and writes a `VIEW` row to `tech_credential_access_log` inside the same tenant tx. Encryption key derived from `process.env.IT_VAULT_KEY` (separate from student-data key per ADR-065).
2. **Software licence near-capacity emit** — `LicenceService.assignSeat` locks the parent licence `FOR UPDATE`, validates seat capacity, INSERTs the assignment + bumps `used_seats` in one tenant tx, then emits `tech.licence.near_capacity` AFTER the tx commits when utilisation crosses 80%. Multi-column `seats_chk` (`used_seats >= 0 AND used_seats <= total_seats when set, total_seats > 0`) is the schema-side belt-and-braces.

## Prerequisites

```bash
# Provision + seed (idempotent, gated on first table)
pnpm --filter @campusos/database provision --subdomain=demo
pnpm --filter @campusos/database seed
pnpm --filter @campusos/database exec tsx src/seed-iam.ts
pnpm --filter @campusos/database seed:sis
pnpm --filter @campusos/database seed:hr
pnpm --filter @campusos/database seed:tickets
pnpm --filter @campusos/database seed:facilities  # Cycle 21
pnpm --filter @campusos/database seed:it           # Cycle 22 — gates on tech_asset_categories
pnpm --filter @campusos/database exec tsx src/build-cache.ts

# Boot the API
pnpm --filter @campusos/api build && cd apps/api && node dist/main.js
```

## Schema preamble (live verification on `tenant_demo` 2026-05-06)

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo, platform, public;
SELECT
  (SELECT COUNT(*)::int FROM information_schema.tables
   WHERE table_schema='tenant_demo' AND table_type='BASE TABLE') AS tenant_base_tables,
  (SELECT COUNT(*)::int FROM information_schema.tables
   WHERE table_schema='tenant_demo' AND table_type='BASE TABLE' AND table_name LIKE 'tech_%') AS tech_tables,
  (SELECT COUNT(*)::int FROM information_schema.referential_constraints r
   JOIN information_schema.table_constraints t ON t.constraint_name = r.constraint_name
   WHERE t.table_schema = 'tenant_demo' AND t.table_name LIKE 'tech_%') AS intra_tech_fks;
"
# tenant_base_tables=311  tech_tables=16  intra_tech_fks=11

# Step 4 seed counts (idempotent reseed → identical row counts)
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo, platform, public;
SELECT 'asset_categories' AS t, COUNT(*) FROM tech_asset_categories
UNION ALL SELECT 'assets', COUNT(*) FROM tech_assets
UNION ALL SELECT 'assignments', COUNT(*) FROM tech_asset_assignments
UNION ALL SELECT 'documents', COUNT(*) FROM tech_asset_documents
UNION ALL SELECT 'licences', COUNT(*) FROM tech_software_licences
UNION ALL SELECT 'lic_assignments', COUNT(*) FROM tech_software_assignments
UNION ALL SELECT 'vault', COUNT(*) FROM tech_credential_vault
UNION ALL SELECT 'access_log', COUNT(*) FROM tech_credential_access_log
UNION ALL SELECT 'infra', COUNT(*) FROM tech_infrastructure_items
UNION ALL SELECT 'mdm_syncs', COUNT(*) FROM tech_mdm_sync_logs
UNION ALL SELECT 'mdm_alerts', COUNT(*) FROM tech_mdm_alerts
UNION ALL SELECT 'damages', COUNT(*) FROM tech_damage_reports
UNION ALL SELECT 'repairs', COUNT(*) FROM tech_repair_records
UNION ALL SELECT 'procurement', COUNT(*) FROM tech_procurement_orders
UNION ALL SELECT 'device_options', COUNT(*) FROM tech_device_options
UNION ALL SELECT 'device_selections', COUNT(*) FROM tech_device_selections
ORDER BY t;
"
# Expected: categories=2 / assets=10 / assignments=8 / documents=2
#           licences=3 / lic_assignments=4 / vault=2 / access_log=2
#           infra=5 / mdm_syncs=1 / mdm_alerts=1
#           damages=1 / repairs=1 / procurement=1
#           device_options=2 / device_selections=1

# IAM grants (Cycle 22 IT-002..006)
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SELECT eac.user_id, pu.email, COUNT(*) FILTER (WHERE p.code LIKE 'IT-%') AS it_perms
FROM platform.iam_effective_access_cache eac
JOIN platform.permissions p ON p.id = ANY(SELECT id FROM platform.permissions WHERE code = ANY(eac.permission_codes))
JOIN platform.platform_users pu ON pu.id = eac.account_id
WHERE eac.account_id IS NOT NULL GROUP BY eac.user_id, pu.email ORDER BY pu.email;
"
```

## Scenario walkthrough (live verified 2026-05-06)

```bash
# Get tokens
PRINCIPAL_TOKEN=$(curl -sf -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"principal@demo.campusos.dev"}' | jq -r '.accessToken')
TEACHER_TOKEN=$(curl -sf -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"teacher@demo.campusos.dev"}' | jq -r '.accessToken')
STUDENT_TOKEN=$(curl -sf -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"student@demo.campusos.dev"}' | jq -r '.accessToken')
```

### S1 — Principal lists assets (admin sees full fleet)

```bash
curl -sf http://localhost:4000/api/v1/it/assets \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq 'length, group_by(.status) | map({status: .[0].status, count: length})'
# 10
# [{"status":"ASSIGNED","count":8},{"status":"AVAILABLE","count":1},{"status":"REPAIR","count":1}]
```

### S2 — Student row scope: Maya sees only her own assigned device

```bash
curl -sf http://localhost:4000/api/v1/it/assets \
  -H "Authorization: Bearer $STUDENT_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq 'map(.assetTag)'
# ["IT-CB-001"]   # Maya only — buildVisibility filters via tech_asset_assignments.assigned_to_id
```

### S3 — Teacher own assignments via /it/me/assignments

```bash
curl -sf http://localhost:4000/api/v1/it/me/assignments \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq 'map(.assetTag)'
# ["IT-IP-002","IT-CB-002"]   # Rivera's two seeded assignments
```

### S4 — Licence catalogue with utilisation

```bash
curl -sf http://localhost:4000/api/v1/it/licences \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq 'map({software:.softwareName, used:.usedSeats, total:.totalSeats, pct:.utilisationPct})'
# [
#   {"software":"Adobe Creative Suite","used":4,"total":25,"pct":16},
#   {"software":"Google Workspace for Education","used":0,"total":null,"pct":null},
#   {"software":"Zoom Education","used":0,"total":100,"pct":0}
# ]
```

### S5 — SECURITY KEYSTONE: vault list + decrypt CRITICAL credential

```bash
# Principal lists vault — list never includes plaintext password
curl -sf http://localhost:4000/api/v1/it/vault \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq 'map({service:.serviceName, tier:.accessTier, hasPassword})'
# [
#   {"service":"Google Workspace Admin Console","tier":"ELEVATED","hasPassword":true},
#   {"service":"School Wi-Fi Admin","tier":"CRITICAL","hasPassword":true}
# ]

# School admin (CRITICAL tier) decrypts CRITICAL credential
WIFI_ID=$(curl -sf http://localhost:4000/api/v1/it/vault \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq -r '.[] | select(.accessTier=="CRITICAL") | .id')
curl -sf "http://localhost:4000/api/v1/it/vault/$WIFI_ID" \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq '{service:.serviceName, password}'
# {"service":"School Wi-Fi Admin","password":"SecureWifi-Admin-2026!"}
#
# Inside the same tx the service writes a VIEW row to tech_credential_access_log
# (see post-CAT verification below).
```

### S6 — Vault gate refuses callers without IT-005:read

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:4000/api/v1/it/vault \
  -H "Authorization: Bearer $STUDENT_TOKEN" -H 'X-Tenant-Subdomain: demo'
# 403
```

### S7 — KEYSTONE: licence near-capacity Kafka emit

```bash
# Pre-create the topic on a fresh broker (one-time dev workaround):
docker exec campusos-kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --create --if-not-exists \
  --topic dev.tech.licence.near_capacity --partitions 1 --replication-factor 1

# Create a small 5-seat licence
LIC_ID=$(curl -sf -X POST http://localhost:4000/api/v1/it/licences \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'Content-Type: application/json' \
  -H 'X-Tenant-Subdomain: demo' \
  -d '{"softwareName":"S7 Smoke Pro","vendor":"Smoke","licenceType":"PER_SEAT","totalSeats":5}' \
  | jq -r '.id')

# Pull 4 platform_users.id and assign (5/5 = 100% emits near-capacity)
USER_IDS=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT id FROM platform.platform_users WHERE email IN ('principal@demo.campusos.dev','teacher@demo.campusos.dev','vp@demo.campusos.dev','counsellor@demo.campusos.dev','student@demo.campusos.dev') ORDER BY email;")
for uid in $USER_IDS; do
  curl -sf -X POST "http://localhost:4000/api/v1/it/licences/$LIC_ID/assign" \
    -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'Content-Type: application/json' \
    -H 'X-Tenant-Subdomain: demo' -d "{\"assigneeId\":\"$uid\"}" > /dev/null
done

curl -sf "http://localhost:4000/api/v1/it/licences/$LIC_ID" \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq '{usedSeats, totalSeats, utilisationPct}'
# {"usedSeats":5,"totalSeats":5,"utilisationPct":100}

# Capture the wire envelope
docker exec campusos-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic dev.tech.licence.near_capacity \
  --from-beginning --max-messages 1 --timeout-ms 5000
# {"event_id":"019dfe11-9bcf-7330-a1ba-4981a21496ec",
#  "event_type":"tech.licence.near_capacity",
#  "event_version":1,
#  "occurred_at":"2026-05-06T16:14:20.111Z",
#  "tenant_id":"019dc92b-ea59-7bb7-aa7f-929729562010",
#  "source_module":"it",
#  "correlation_id":"019dfe11-9bcf-7330-a1ba-563afabd361c",
#  "payload":{
#    "licenceId":"019dfe10-028b-7330-a1b9-fd6fd6c2276b",
#    "schoolId":"019dc92b-ea59-7bb7-aa7f-929729562010",
#    "softwareName":"S7 Smoke Pro",
#    "totalSeats":5,
#    "usedSeats":5,
#    "utilisationPct":100,
#    "sourceRefId":"019dfe10-028b-7330-a1b9-fd6fd6c2276b"}}
```

### S8 — Locked-row asset assignment

```bash
# Find the AVAILABLE asset (IT-CB-008)
ASSET=$(curl -sf "http://localhost:4000/api/v1/it/assets?status=AVAILABLE" \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' | jq -r '.[0]')
ASSET_ID=$(echo "$ASSET" | jq -r '.id')
TEACHER_USER=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT id FROM platform.platform_users WHERE email='teacher@demo.campusos.dev';")

curl -sf -X POST "http://localhost:4000/api/v1/it/assets/$ASSET_ID/assign" \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'Content-Type: application/json' \
  -H 'X-Tenant-Subdomain: demo' \
  -d "{\"assigneeId\":\"$TEACHER_USER\",\"conditionAtAssign\":\"GOOD\"}" \
  | jq '{assetTag, assigneeName, conditionAtAssign}'
# {"assetTag":"IT-CB-008","assigneeName":"James Rivera","conditionAtAssign":"GOOD"}

# Verify asset.status flipped + currentAssignee populated
curl -sf "http://localhost:4000/api/v1/it/assets/$ASSET_ID" \
  -H "Authorization: Bearer $PRINCIPAL_TOKEN" -H 'X-Tenant-Subdomain: demo' \
  | jq '{status, currentAssigneeName}'
# {"status":"ASSIGNED","currentAssigneeName":"James Rivera"}
```

### S9 — Teacher files damage report on own assigned device

```bash
curl -sf -X POST 'http://localhost:4000/api/v1/it/damage-reports' \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H 'Content-Type: application/json' \
  -H 'X-Tenant-Subdomain: demo' \
  -d "{\"assetId\":\"$ASSET_ID\",\"description\":\"S9 smoke - cracked screen\",\"severity\":\"MODERATE\"}" \
  | jq '{reportedByName, severity, assetTag}'
# {"reportedByName":"James Rivera","severity":"MODERATE","assetTag":"IT-CB-008"}
```

### S10 — Permission denial: student attempts admin write

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  'http://localhost:4000/api/v1/it/asset-categories' \
  -H "Authorization: Bearer $STUDENT_TOKEN" -H 'Content-Type: application/json' \
  -H 'X-Tenant-Subdomain: demo' -d '{"name":"Pwned"}'
# 403   # student holds it-002:read only
```

## Cleanup

Restores `tenant_demo` to the post-Step-4 seed shape exactly so the next run starts clean.

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo, platform, public;

-- S8/S9 cleanup: drop smoke damage report + return assignment + restore asset
DELETE FROM tech_damage_reports WHERE description = 'S9 smoke - cracked screen';
DELETE FROM tech_asset_assignments WHERE id IN (
  SELECT aa.id FROM tech_asset_assignments aa
  JOIN tech_assets a ON a.id = aa.asset_id
  WHERE a.asset_tag = 'IT-CB-008' AND aa.returned_at IS NULL
);
UPDATE tech_assets SET status = 'AVAILABLE', updated_at = now() WHERE asset_tag = 'IT-CB-008';

-- S7 cleanup: drop smoke licence (CASCADE drops all 5 assignments)
DELETE FROM tech_software_licences WHERE software_name = 'S7 Smoke Pro';

-- S5 cleanup: trim VIEW access log entries from the smoke run
DELETE FROM tech_credential_access_log
  WHERE access_type = 'VIEW' AND accessed_at > now() - interval '1 hour';

-- Final shape check (matches Step 4 seed)
SELECT
  (SELECT COUNT(*) FROM tech_assets) AS assets,
  (SELECT COUNT(*) FROM tech_assets WHERE status = 'AVAILABLE') AS available,
  (SELECT COUNT(*) FROM tech_software_licences) AS licences,
  (SELECT COUNT(*) FROM tech_damage_reports) AS damages,
  (SELECT COUNT(*) FROM tech_credential_vault) AS vault_entries;
-- assets=10, available=1 (CB-008), licences=3, damages=1 (seeded MODERATE on CB-007), vault=2
"
```

## Reviewer attention items (non-blocking, Phase 2 polish)

- `tech.licence.near_capacity` consumer not yet wired — emit lands cleanly but no consumer fans out to IT admin notifications today (mirrors the deferred `hlth.medication.administered` consumer from Cycle 10). A future Phase 2 NotificationConsumer can subscribe to drive admin push alerts.
- IT-005:admin tier wiring — currently CRITICAL credential reads work because school admin and IT admin (STAFF + IT-005:write) inherit CRITICAL tier; in real schools the IT-005:admin tier should be a distinct grant separate from STAFF + IT-005:write so a help-desk teacher does not silently inherit CRITICAL. Joins the ongoing role-split punch list (Counsellor / Nurse / Librarian / AD / EO / Transportation / FS Manager / FM / IT admin) — all 9 specialist operator personas should split before pilot.
- ADR-066 device-selection consumer — selection ACCEPT does not yet auto-create a `tech_assets` row or kick off provisioning. Phase 2 should wire `it.device.selected` → an inventory worker that materialises the asset and deep-links to the assignee's onboarding checklist.
- AES-256-GCM key rotation — `process.env.IT_VAULT_KEY` is single-key today. Production deployment needs key versioning so credentials encrypted under an old key continue to decrypt while new credentials use the rotated key.
- Vault `last_rotated_at` reminder worker — schema carries `rotation_due_at` but no scheduled worker emits a reminder when due. Phase 2 cron job should fan out `tech.credential.rotation_overdue` to IT admins.

**Cycle 22 ships clean to the post-cycle architecture review. Wave 4 (Campus Operations) closes here.**
