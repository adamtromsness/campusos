# Cycle 30 — Customer Acceptance Test (Step 10)

**Module:** M120 DPO Compliance Suite (Wave 7 closing cycle — closes Wave 7 Analytics & Governance, ADR-052).
**Verified live on:** `tenant_demo` 2026-05-07.
**Reproducibility:** every command is shell-pasteable. Step 10 walks the 10 plan scenarios end-to-end against the running API + Kafka broker.

---

## Schema preamble

10 checks confirming the tenant schema landed correctly.

```sh
# 1 — 12 dpo_* tables present
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='tenant_demo' AND table_name LIKE 'dpo_%'"
# Expect: 12

# 2 — list every table
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT table_name FROM information_schema.tables WHERE table_schema='tenant_demo' AND table_name LIKE 'dpo_%' ORDER BY table_name"
# Expect: dpo_compliance_dashboard_config, dpo_data_breach_records, dpo_data_processing_agreements,
#         dpo_dpias, dpo_erasure_requests, dpo_privacy_notices, dpo_processing_activities,
#         dpo_processing_consent_records, dpo_pseudonymisation_log, dpo_retention_policies,
#         dpo_subject_access_requests, dpo_third_party_processors

# 3 — multi-column resolved_chk on breach records (lockstep keystone)
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='dpo_breach_resolved_chk'"
# Expect: CHECK ((status = 'RESOLVED' AND is_resolved = true AND resolved_at IS NOT NULL)
#               OR (status <> 'RESOLVED' AND is_resolved = false AND resolved_at IS NULL))

# 4 — partial index on breach records pending notification (72h countdown query)
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT indexdef FROM pg_indexes WHERE schemaname='tenant_demo' AND indexname='dpo_breach_pending_notification_idx'"

# 5 — partial index on processing activities DPIA gap rule
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT indexdef FROM pg_indexes WHERE schemaname='tenant_demo' AND indexname='dpo_pa_high_risk_no_dpia_idx'"

# 6 — multi-column completed_chk on SARs and erasures
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('dpo_sar_completed_chk','dpo_erasure_completed_chk')"

# 7 — 5 new DPO permissions in catalogue (DPO-001..005 × 3 tiers = 15)
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT code FROM platform.permissions WHERE code LIKE 'dpo-%' ORDER BY code"
# Expect: 15 rows

# 8 — Parent gets DPO-004:read+write only (SAR self-service)
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT p.code FROM platform.role_permission rp JOIN platform.roles r ON r.id=rp.role_id JOIN platform.permissions p ON p.id=rp.permission_id WHERE r.name='Parent' AND p.code LIKE 'dpo-%' ORDER BY p.code"
# Expect: dpo-004:read, dpo-004:write

# 9 — Staff (DPO stand-in) gets DPO-001..005 read+write
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT count(*) FROM platform.role_permission rp JOIN platform.roles r ON r.id=rp.role_id JOIN platform.permissions p ON p.id=rp.permission_id WHERE r.name='Staff' AND p.code LIKE 'dpo-%'"
# Expect: 10

# 10 — Step 4 seed shape
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
  SET search_path TO tenant_demo;
  SELECT 'pa' AS k, count(*) FROM dpo_processing_activities
  UNION ALL SELECT 'rp', count(*) FROM dpo_retention_policies
  UNION ALL SELECT 'dpia', count(*) FROM dpo_dpias
  UNION ALL SELECT 'proc', count(*) FROM dpo_third_party_processors
  UNION ALL SELECT 'dpa', count(*) FROM dpo_data_processing_agreements
  UNION ALL SELECT 'breach', count(*) FROM dpo_data_breach_records
  UNION ALL SELECT 'sar', count(*) FROM dpo_subject_access_requests
  UNION ALL SELECT 'erasure', count(*) FROM dpo_erasure_requests
  UNION ALL SELECT 'pseudo', count(*) FROM dpo_pseudonymisation_log
  UNION ALL SELECT 'consent', count(*) FROM dpo_processing_consent_records
  UNION ALL SELECT 'notice', count(*) FROM dpo_privacy_notices
  UNION ALL SELECT 'config', count(*) FROM dpo_compliance_dashboard_config
  ORDER BY 1"
# Expect: pa=5, rp=3, dpia=1, proc=4, dpa=2, breach=1, sar=1, erasure=1, pseudo=1, consent=3,
#         notice=1, config=1
```

All 10 checks pass live (verified 2026-05-07).

---

## Setup — token harness

```sh
TOKEN=$(curl -s -X POST -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/auth/dev-login \
  -d '{"email":"principal@demo.campusos.dev"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])")

TOKEN_PARENT=$(curl -s -X POST -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/auth/dev-login \
  -d '{"email":"parent@demo.campusos.dev"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])")

TOKEN_TEACHER=$(curl -s -X POST -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/auth/dev-login \
  -d '{"email":"teacher@demo.campusos.dev"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])")

TOKEN_STUDENT=$(curl -s -X POST -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/auth/dev-login \
  -d '{"email":"student@demo.campusos.dev"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])")
```

---

## S1 — Permission denials

The DPO surface is highly restricted. Six denial paths verify the gate.

```sh
# 403 — teacher /governance/dashboard (no DPO-001:read)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN_TEACHER" \
  -H "X-Tenant-Subdomain: demo" http://localhost:4000/api/v1/governance/dashboard
# 403 — student /governance/processors
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN_STUDENT" \
  -H "X-Tenant-Subdomain: demo" http://localhost:4000/api/v1/governance/processors
# 403 — parent /governance/breaches
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN_PARENT" \
  -H "X-Tenant-Subdomain: demo" http://localhost:4000/api/v1/governance/breaches
# 403 — parent /governance/erasures (parent has DPO-004:write but service tightens to STAFF only)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN_PARENT" \
  -H "X-Tenant-Subdomain: demo" http://localhost:4000/api/v1/governance/erasures
# 200 — principal /governance/dashboard
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-Subdomain: demo" http://localhost:4000/api/v1/governance/dashboard
# 200 — parent /governance/sars (own SARs only — row scope at service layer)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN_PARENT" \
  -H "X-Tenant-Subdomain: demo" http://localhost:4000/api/v1/governance/sars
```

**Live output (2026-05-07):**

```
teacher /dashboard:  403
student /processors: 403
parent /breaches:    403
parent /erasures:    403
principal:           200
parent /sars:        200
```

---

## S2 — SAR row scope (parent + principal)

```sh
# Parent (David Chen) sees only SARs they submitted OR for their own children
curl -s -H "Authorization: Bearer $TOKEN_PARENT" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/governance/sars \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'Parent count: {len(d)}')"
# Expect: 1 (David Chen → Maya seeded request)

# Principal sees every SAR in tenant
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/governance/sars \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'Principal count: {len(d)}')"
# Expect: 1
```

---

## S3 — Compliance dashboard rollup

The single endpoint that the DPO checks daily.

```sh
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/governance/dashboard | python3 -m json.tool
```

**Expected (live 2026-05-07):**

```json
{
  "ropaCount": 5,
  "highRiskActivities": 2,
  "dpiaGaps": 1,
  "retentionPolicies": 3,
  "retentionReviewsDue": 0,
  "processors": 4,
  "dpaGaps": 2,
  "dpaReviewsDue": 0,
  "activeBreaches": 1,
  "breachesAwaitingNotification": 1,
  "breachOverdueCount": 0,
  "pendingSars": 1,
  "overdueSars": 0,
  "pendingErasures": 1,
  "pseudonymisationsLast30Days": 1,
  "activeConsents": 2,
  "withdrawnConsents": 1,
  "currentPrivacyNoticeVersion": "v2.1"
}
```

---

## S4 — ROPA gap query (DPIA gap rule)

```sh
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/governance/processing-activities?gapsOnly=true" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);
[print(f'  - {r[\"activityName\"]} hasDpiaGap={r[\"hasDpiaGap\"]}') for r in d]"
# Expect:
#   - AI-Driven Tutor Recommendations hasDpiaGap=True
```

The seeded ROPA has 5 entries; only AI Tutor is high-risk WITHOUT a DPIA. Surfaces as a red row on the Step 8 ROPA UI.

---

## S5 — Processor DPA gap query

```sh
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/governance/processors?gapsOnly=true" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);
[print(f'  - {r[\"processorName\"]} dpaInPlace={r[\"dpaInPlace\"]}') for r in d]"
# Expect (2 rows):
#   - Google Workspace for Education dpaInPlace=False  (DPA expired)
#   - OpenAI LLC dpaInPlace=False                       (no DPA negotiated yet)
```

---

## S6 — Breach 72-hour countdown (read path)

```sh
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/governance/breaches \
  | python3 -c "import json,sys;d=json.load(sys.stdin);
[print(f'  {r[\"breachTitle\"]} status={r[\"status\"]} hours-since={r[\"hoursSinceDiscovery\"]} hrs-remaining={r[\"hoursRemainingTo72\"]} overdue={r[\"isOverdue\"]}') for r in d]"
# Expect (seeded breach 18h ago, 53h remaining):
#   Stolen staff laptop containing student records  status=UNDER_INVESTIGATION
#   hours-since=18 hrs-remaining=53 overdue=False
```

---

## S7 — KEYSTONE: breach create + `dpo.breach.discovered` envelope

```sh
NOW_ISO=$(python3 -c "from datetime import datetime,timezone;print(datetime.now(timezone.utc).isoformat())")

# Create breach (supervisoryAuthorityNotificationRequired=true)
RESP=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  http://localhost:4000/api/v1/governance/breaches \
  -d "{\"breachTitle\":\"CAT smoke breach\",\"breachType\":\"UNAUTHORISED_ACCESS\",\"discoveryDate\":\"$NOW_ISO\",\"personalDataCategoriesInvolved\":[\"Names\"],\"riskLevel\":\"MEDIUM\",\"riskToIndividuals\":\"POSSIBLE\",\"supervisoryAuthorityNotificationRequired\":true,\"breachCause\":\"CAT smoke\",\"remediationActions\":\"CAT smoke\"}")
echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);
print(f'Created id={d[\"id\"][:8]}... hours-remaining={d[\"hoursRemainingTo72\"]}')"
SMOKE_ID=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Read envelope from dev.dpo.breach.discovered
sleep 2
docker exec campusos-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic dev.dpo.breach.discovered \
  --from-beginning --max-messages 5 --timeout-ms 4000 2>/dev/null \
  | python3 -c "
import json, sys
last=None
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: last=json.loads(line)
    except: pass
if last:
    p = last.get('payload', {})
    print(f'event_type={last[\"event_type\"]} source_module={last[\"source_module\"]}')
    print(f'payload.breachTitle={p[\"breachTitle\"]}')
    print(f'payload.notificationDeadline={p[\"notificationDeadline\"][:19]} (= discovery + 72h)')
"
```

**Live envelope (2026-05-07):**

```
event_type=dpo.breach.discovered source_module=governance
payload.breachTitle=CAT smoke breach
payload.notificationDeadline=2026-05-10T12:31:35 (= discovery + 72h)
```

ADR-057 envelope shape verified: `event_id` (UUIDv7), `event_type=dpo.breach.discovered`, `event_version=1`, `source_module=governance`, `tenant_id` populated, `correlation_id` populated, payload includes `breachId`, `schoolId`, `breachTitle`, `breachType`, `discoveryDate`, `notificationDeadline`, `riskLevel`, `riskToIndividuals`, `estimatedAffectedIndividuals`, `reportedByAccountId`, `sourceRefId`. The Cycle 7 TaskWorker subscribes to this topic and creates an URGENT 72-hour escalating task — the `dpo_compliance_dashboard_config.breach_escalation_hours=70` gives the operator a 2-hour buffer before the regulatory deadline.

---

## S8 — Notify supervisory authority (stop the countdown)

```sh
# Status flips UNDER_INVESTIGATION → NOTIFIED. supervisoryAuthorityNotifiedAt
# is stamped, which removes the row from the dashboard's awaiting-notification
# stat card.
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  http://localhost:4000/api/v1/governance/breaches/$SMOKE_ID/notify-supervisory-authority \
  -d '{"supervisoryAuthorityReference":"ICO-CAT-SMOKE-001"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);
print(f'status={d[\"status\"]} notifiedAt={d[\"supervisoryAuthorityNotifiedAt\"][:19]} ref={d[\"supervisoryAuthorityReference\"]}')"
# Expect: status=NOTIFIED notifiedAt=<iso> ref=ICO-CAT-SMOKE-001
```

---

## S9 — Parent self-service SAR submission (with age-18 keystone)

```sh
# Parent submits a PORTABILITY SAR for their child Maya.
# (Synthetic dataSubjectId fails — guardian-link gate fires.)
MAYA_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c "
  SELECT ip.id FROM tenant_demo.sis_students s
    JOIN platform.platform_students ps ON ps.id=s.platform_student_id
    JOIN platform.iam_person ip ON ip.id=ps.person_id
   WHERE ip.first_name='Maya' AND ip.last_name='Chen' LIMIT 1")

# 403 — bogus dataSubjectId (parent isn't a guardian of that person)
curl -s -X POST -H "Authorization: Bearer $TOKEN_PARENT" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  http://localhost:4000/api/v1/governance/sars \
  -d '{"dataSubjectId":"00000000-0000-0000-0000-000000000001","requestType":"ACCESS"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'{d.get(\"statusCode\")}: {d.get(\"message\")}')"
# Expect: 403: Only a linked guardian can submit a SAR on behalf of a child.

# 201 — Parent → Maya for PORTABILITY succeeds
SAR=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_PARENT" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  http://localhost:4000/api/v1/governance/sars \
  -d "{\"dataSubjectId\":\"$MAYA_ID\",\"requestType\":\"PORTABILITY\",\"requestDetails\":\"CAT smoke port\"}")
SAR_ID=$(echo "$SAR" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Created SAR: $SAR_ID"

# Parent now sees 2 SARs (the seeded one + this new one)
curl -s -H "Authorization: Bearer $TOKEN_PARENT" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/governance/sars \
  | python3 -c "import json,sys;print(f'Parent count: {len(json.load(sys.stdin))}')"
# Expect: 2
```

**Age-18 keystone documentation:** when `platform_students.data_subject_is_self=true` flips for Maya (the future scheduled job), the parent path returns 403 `"This student is the data subject for their own data (age 18+). Only the student or a DPO administrator can submit a SAR for their data."`. The seeded Maya has `data_subject_is_self=false` so the parent path remains live for the Cycle 30 demo.

---

## S10 — KEYSTONE: audit log pseudonymisation

The IMMUTABLE pseudonymisation log writes one row per (target_table, target_field), records the opaque token, and increments the dashboard's `pseudonymisationsLast30Days` counter.

```sh
# Use the seeded PARTIALLY_COMPLETED erasure
ERASURE_ID=$(curl -s -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/governance/erasures \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d[0]['id'])")

# Pseudonymise platform_audit_log.metadata for the synthetic data subject
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  http://localhost:4000/api/v1/governance/erasures/$ERASURE_ID/pseudonymise \
  -d '{"targetTable":"platform_audit_log","targetField":"metadata"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);
print(f'rows={d[\"rowsPseudonymised\"]} token={d[\"pseudonymisationToken\"]}')"
# Expect: rows=<n> token=psd_<16hex>
# (Synthetic data subject has 0 audit rows in the demo seed; the IMMUTABLE
#  log row is still written so the audit chain is preserved.)
```

The `dpo_pseudonymisation_log` table has **NO UPDATE / NO DELETE** methods exposed at the service layer — service-side discipline matches Cycle 8 `tkt_ticket_activity` and Cycle 10 `hlth_health_access_log`. The `dpo_pseudonymisation_log_erasure_request_id_fkey` is `ON DELETE NO ACTION` so the audit chain survives even if the erasure request itself is later removed (which it cannot be via the API; only via direct SQL).

---

## Cleanup

```sh
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
  DELETE FROM tenant_demo.dpo_data_breach_records WHERE id='$SMOKE_ID'::uuid;
  DELETE FROM tenant_demo.dpo_subject_access_requests WHERE id='$SAR_ID'::uuid;
  -- The IMMUTABLE pseudonymisation log row from S10 stays (no DELETE method)
"
```

After cleanup, dashboard rollup matches the post-Step-4 seed shape exactly (the S10 pseudonymisation count goes from 1 → 2 because the new immutable row stays — that's the contract).

---

## Wave 7 close

Cycle 30 closes Wave 7 (Analytics & Governance):

- **Cycle 29** opened Wave 7 with M110 Analytics & Reporting (16 `rpt_*` tables).
- **Cycle 30** closes Wave 7 with M120 DPO Compliance Suite (12 `dpo_*` tables).
- Total Wave 7 surface: 28 read/governance tables, 5 new permission codes (RPT-001..004 already in catalogue from earlier waves; DPO-001..005 added in Cycle 30 Step 4 — 165 functions × 3 tiers = **495 permissions**).

The platform is now pilot-ready for schools operating under GDPR, UK GDPR, FERPA, and COPPA simultaneously. The 72-hour breach notification countdown is the highest-urgency automated escalation in CampusOS, and the AUDIT LOG FIELD-LEVEL PSEUDONYMISATION keystone (ADR-052) is the first surface in the platform that mutates `platform.platform_audit_log` from a tenant-scoped service.

**Reviewer attention items** (non-blocking, deferred to pre-pilot hardening):

1. **DPO role split.** `Staff` currently grants `DPO-001..005:read+write` as a stand-in for the dedicated DPO persona. A real DPO is org-scoped (single DPO across all schools in an organisation). Pre-pilot: introduce a dedicated `DPO` role at `iam_scope_type='ORGANISATION'` and remove the DPO-\* grants from generic Staff. Joins items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / 33 / 34 / 35 / 36 / 37 / 38 / 39 / 40 / 41 in the broader role-split chain.
2. **Audit log pseudonymisation scope.** Step 7's `pseudonymiseAuditLog` only handles `platform_audit_log.metadata`. Phase 2 should generalise to per-domain pseudonymisation paths (e.g. `cls_progress_notes.body`, `svc_session_notes.body`), each with its own `target_table` + `target_field` config + service-layer pseudonymisation routine. Schema is ready — `dpo_pseudonymisation_log` accepts any `(target_table, target_field)` pair.
3. **Age-18 transfer scheduled job.** Cycle 30 ships the read path (SarService refuses GUARDIAN-submitted requests when `platform_students.data_subject_is_self=true`). The actual flip is a future scheduled job that runs on each student's 18th birthday. Pre-pilot: schedule the cron + emit `iam.student.data_subject_self` so downstream consumers refresh their guardian-relationship caches.
4. **DPIA review reminder worker.** `dpo_compliance_dashboard_config.dpia_review_reminder_days` (default 90) and `dpa_review_reminder_days` (default 60) are present but no worker enforces them yet. Pre-pilot: add a daily worker that surfaces upcoming reviews via a notification fan-out.
5. **Privacy notice consent re-acceptance.** When the DPO publishes a new privacy notice version, every active consent record technically lapses — the data subject implicitly consented to the prior version. Schema captures `consent_given_at` so the application of a "re-consent prompt on next login" gate is straightforward but not implemented this cycle.
6. **Cross-school SAR aggregation.** District / multi-school operators submitting SARs against a child enrolled in multiple schools is not handled — each school must process the SAR independently. Pre-pilot: org-scoped SAR aggregation across the schools the data subject has projections in.
7. **Breach DLQ + dashboard alerting.** `dpo.breach.discovered` is a best-effort emit. If the Cycle 7 TaskWorker fails to claim the event, the 72-hour task is silently lost. Joins item 4 (outbox priority list) — this is the single highest-priority emit in CampusOS to migrate to outbox semantics.

**Cycle 30 ships clean to the post-cycle architecture review.** Tagged `cycle30-complete` after CI green; awaits external review verdict before tagging `cycle30-approved`.
