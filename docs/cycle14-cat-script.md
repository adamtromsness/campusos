# Cycle 14 Customer Acceptance Test (CAT) — Communications & Messaging

**Audience:** Architecture reviewers + future maintainers.
**Reference:** `docs/campusos-cycle14-implementation-plan.html`, `HANDOFF-CYCLE14.md`.
**Tagged commit:** `cycle14-complete` (after CI green).

This document is the reproducible end-to-end vertical slice test for Cycle 14 (Communications). Cycle 14 completes the M40 module that Cycle 3 substantially built — Cycle 3 already shipped threads, messages, attachments, message-reads, announcements, and the moderation policies + log. Cycle 14 adds:

1. `msg_thread_stats` (denormalised per-thread summary maintained by a new Kafka consumer on `msg.message.posted`)
2. `msg_emergency_alerts` + `msg_emergency_alert_deliveries` (the emergency alert head + multi-channel delivery + acknowledgement)
3. EmergencyAlertService + AlertTypeService + ModerationService (admin queue + review + policy CRUD)
4. The persistent dismiss-proof emergency alert banner and the admin moderation UI

Plus three column additions on `msg_announcements` (`is_recurring`, `recurrence_rule`, `parent_announcement_id`) for future recurring-announcement support.

---

## Schema preamble (6 checks)

Run against `tenant_demo` after `pnpm seed:emergency` has landed. All checks should pass.

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SELECT
  (SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema='tenant_demo' AND table_type='BASE TABLE'
    AND table_name NOT SIMILAR TO '%\_(p[0-9]|h[0-9]+|y[0-9]+|2024|2025|2026|2027|2028|2029|2030)%') AS base_tables,
  (SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema='tenant_demo' AND table_name IN ('msg_thread_stats','msg_emergency_alerts','msg_emergency_alert_deliveries')) AS new_tables,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema='tenant_demo' AND table_name='msg_announcements'
      AND column_name IN ('is_recurring','recurrence_rule','parent_announcement_id')) AS new_announcement_cols,
  (SELECT COUNT(*) FROM pg_constraint c
    WHERE c.connamespace='tenant_demo'::regnamespace AND c.contype='f'
    AND c.conname LIKE 'msg_emergency_alert%') AS emergency_fks;
"
```

Expected: **base_tables=206, new_tables=3, new_announcement_cols=3, emergency_fks=2**.

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo, platform, public;
SELECT
  (SELECT COUNT(*) FROM msg_thread_stats) AS thread_stats,
  (SELECT COUNT(*) FROM msg_alert_types WHERE name IN ('Severe Weather','Early Dismissal')) AS new_alert_types,
  (SELECT COUNT(*) FROM msg_emergency_alerts) AS emergency_alerts,
  (SELECT COUNT(*) FROM msg_emergency_alert_deliveries) AS deliveries;
"
```

Expected: **thread_stats=3, new_alert_types=2, emergency_alerts=1, deliveries=3**.

IAM seed audit:

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SELECT account_id, ARRAY(SELECT unnest(permission_codes) ORDER BY 1) AS codes
FROM platform.iam_effective_access_cache
WHERE account_id = (SELECT id FROM platform.platform_users WHERE email = 'principal@demo.campusos.dev')
  AND scope_id = (SELECT id FROM platform.iam_scope WHERE scope_ref_id = (SELECT id FROM platform.schools WHERE subdomain='demo'));
" 2>&1 | grep -E "com-00[34]"
```

Expected: every persona except parent + student holds `com-003:read`. Staff + Admin additionally hold `com-003:write` + `com-004:read+write`. Parent + Student hold only `com-003:read`. Teacher holds `com-003:read` only.

---

## Plan scenarios

The 10 plan scenarios from the Cycle 14 plan map onto the live `tenant_demo` walk-through below. Variables — set these once at the top of your shell:

```bash
export API="http://localhost:4000/api/v1"
export TENANT_HEADER="X-Tenant-Subdomain: demo"
# Login each persona via /auth/dev-login to capture bearer tokens
ADMIN_TOKEN=$(curl -sX POST "$API/auth/dev-login" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{"email":"principal@demo.campusos.dev"}' | jq -r .accessToken)
TEACHER_TOKEN=$(curl -sX POST "$API/auth/dev-login" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{"email":"teacher@demo.campusos.dev"}' | jq -r .accessToken)
PARENT_TOKEN=$(curl -sX POST "$API/auth/dev-login" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{"email":"parent@demo.campusos.dev"}' | jq -r .accessToken)
STUDENT_TOKEN=$(curl -sX POST "$API/auth/dev-login" -H "$TENANT_HEADER" -H 'Content-Type: application/json' -d '{"email":"student@demo.campusos.dev"}' | jq -r .accessToken)
```

### S1 — Thread creation + message send + ThreadStatsConsumer

Cycle 3 already handles this on the existing `/threads` + `/threads/:id/messages` surface. The Cycle 14 addition is `msg_thread_stats` maintenance via the new `ThreadStatsConsumer` on `msg.message.posted`.

```bash
# Teacher Rivera posts a new message into the existing seeded TEACHER_PARENT thread
THREAD_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c "SELECT id FROM tenant_demo.msg_threads WHERE subject = 'Maya progress check-in' LIMIT 1;")

curl -sX POST "$API/threads/$THREAD_ID/messages" \
  -H "Authorization: Bearer $TEACHER_TOKEN" \
  -H "$TENANT_HEADER" \
  -H 'Content-Type: application/json' \
  -d '{"body":"S1 CAT — quick update on Maya."}'

# Within ~2 seconds the ThreadStatsConsumer fires
sleep 3
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo;
SELECT message_count, last_message_preview FROM msg_thread_stats WHERE thread_id = '$THREAD_ID';
"
```

Expected: `message_count` increments by 1, `last_message_preview` shows "S1 CAT — quick update on Maya." (≤100 chars).

### S2 — Content moderation pipeline (existing Cycle 3)

```bash
# Send a message containing a PLATFORM-tier blocked keyword (the seeded profanity)
curl -sX POST "$API/threads/$THREAD_ID/messages" \
  -H "Authorization: Bearer $TEACHER_TOKEN" \
  -H "$TENANT_HEADER" \
  -H 'Content-Type: application/json' \
  -d '{"body":"This contains the word shit and should be blocked."}'
```

Expected: `422` response + body `"This message was not sent because it contains content that violates school policy."` and a new `msg_moderation_log` row with `flag_type=BLOCKED`, `severity=URGENT`, `matched_keywords={shit}`.

```bash
# Send a message containing a BUILDING-tier flagged keyword (mental health policy)
curl -sX POST "$API/threads/$THREAD_ID/messages" \
  -H "Authorization: Bearer $TEACHER_TOKEN" \
  -H "$TENANT_HEADER" \
  -H 'Content-Type: application/json' \
  -d '{"body":"I have been thinking about suicide lately."}'
```

Expected: `201` response with `moderationStatus=ESCALATED` AND a `msg_moderation_log` row with `flag_type=ESCALATED_TO_COUNSELLOR` (per the BUILDING policy seeded by Cycle 3).

### S3 — Read receipts + unread count (existing Cycle 3)

David Chen reads the thread.

```bash
curl -sX POST "$API/threads/$THREAD_ID/read" \
  -H "Authorization: Bearer $PARENT_TOKEN" \
  -H "$TENANT_HEADER"
```

Expected: response `{ marked: <N>, unreadCount: 0 }`.

### S4 — Parent reply + msg_thread_stats update

```bash
curl -sX POST "$API/threads/$THREAD_ID/messages" \
  -H "Authorization: Bearer $PARENT_TOKEN" \
  -H "$TENANT_HEADER" \
  -H 'Content-Type: application/json' \
  -d '{"body":"Thanks Mr. Rivera, will follow up with Maya tonight."}'

sleep 3
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo;
SELECT last_message_preview, last_sender_id FROM msg_thread_stats WHERE thread_id = '$THREAD_ID';
"
```

Expected: `last_message_preview` reflects David's reply, `last_sender_id` is David's account.

### S5 — Announcement audience pre-compute (existing Cycle 3)

```bash
curl -sX POST "$API/announcements" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "$TENANT_HEADER" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Spring Concert Friday","body":"All students perform Friday at 6pm in the gym.","audienceType":"ALL_SCHOOL","isPublished":true}'
```

Expected: `201` with the announcement id. Within ~1 second the existing AudienceFanOutWorker pre-computes audience rows for every active user. Mark read as David, then verify.

### S6 — Emergency alert lifecycle KEYSTONE

The keystone Cycle 14 surface. Issue an EMERGENCY alert + verify multi-channel delivery fan-out + ack from Rivera + admin status read + admin resolves.

```bash
# Look up the Severe Weather alert type id
ALERT_TYPE_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c "SELECT id FROM tenant_demo.msg_alert_types WHERE name='Severe Weather' LIMIT 1;")

# Admin issues a new alert
ALERT_ID=$(curl -sX POST "$API/messaging/emergency-alerts" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "$TENANT_HEADER" \
  -H 'Content-Type: application/json' \
  -d "{\"alertTypeId\":\"$ALERT_TYPE_ID\",\"title\":\"Shelter in Place\",\"body\":\"Severe weather drill — shelter in place per safety plan.\"}" \
  | jq -r .id)

# Verify delivery fan-out (one row per recipient × channel from default_channels=[PUSH,APP])
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo;
SELECT COUNT(*) AS deliveries, COUNT(DISTINCT recipient_id) AS recipients,
  ARRAY(SELECT DISTINCT channel FROM msg_emergency_alert_deliveries WHERE alert_id = '$ALERT_ID') AS channels
FROM msg_emergency_alert_deliveries WHERE alert_id = '$ALERT_ID';
"
```

Expected: deliveries = recipients × 2 (one row per channel for PUSH + APP), channels = `{PUSH, APP}`.

```bash
# Rivera acknowledges his APP delivery
RIVERA_DELIV_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c "
SET search_path TO tenant_demo;
SELECT d.id FROM msg_emergency_alert_deliveries d
JOIN platform.platform_users pu ON pu.id = d.recipient_id
WHERE pu.email = 'teacher@demo.campusos.dev' AND d.alert_id = '$ALERT_ID' AND d.channel = 'APP'
LIMIT 1;
")

curl -sX POST "$API/messaging/emergency-alert-deliveries/$RIVERA_DELIV_ID/acknowledge" \
  -H "Authorization: Bearer $TEACHER_TOKEN" \
  -H "$TENANT_HEADER"

# Admin reads delivery + acknowledgement stats
curl -s "$API/messaging/emergency-alerts/$ALERT_ID/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "$TENANT_HEADER" | jq .
```

Expected: `acknowledgedCount >= 1`.

```bash
# Resolve the alert
curl -sX PATCH "$API/messaging/emergency-alerts/$ALERT_ID/resolve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "$TENANT_HEADER"

# Verify resolved_chk lockstep
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo;
SELECT status, resolved_at IS NOT NULL AS has_at, resolved_by IS NOT NULL AS has_by
FROM msg_emergency_alerts WHERE id = '$ALERT_ID';
"
```

Expected: `status=RESOLVED, has_at=t, has_by=t` — the multi-column `resolved_chk` keystone enforces all-three-set on RESOLVED.

### S7 — Banner: dismiss-proof until acknowledged

Open the web app at `http://localhost:3000` as Maya (student@demo.campusos.dev). The seeded ACTIVE alert "Severe Weather Drill" has Maya's APP delivery in PENDING with `acknowledged_at=NULL`. The persistent rose-tinted banner renders at the top of every page with title + body + Acknowledge button. Click Acknowledge — the banner disappears. The 30-second poll plus the `useAcknowledgeDelivery` invalidation clear it immediately for the current session.

### S8 — Moderation admin review

```bash
# Admin sees the queue (the FLAGGED+ESCALATED messages from S2 should appear)
curl -s "$API/messaging/moderation/queue" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "$TENANT_HEADER" | jq 'length'

# Pick the ESCALATED log id and release it
LOG_ID=$(curl -s "$API/messaging/moderation/queue" -H "Authorization: Bearer $ADMIN_TOKEN" -H "$TENANT_HEADER" | jq -r '.[] | select(.flagType=="ESCALATED_TO_COUNSELLOR") | .logId' | head -1)

curl -sX PATCH "$API/messaging/moderation/log/$LOG_ID/review" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "$TENANT_HEADER" \
  -H 'Content-Type: application/json' \
  -d '{"outcome":"RELEASED","notes":"Reviewed — supportive conversation, no further action."}'

# Verify the parent message flipped back to APPROVED
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo;
SELECT m.moderation_status, l.review_outcome, l.reviewed_at IS NOT NULL AS reviewed
FROM msg_moderation_log l JOIN msg_messages m ON m.id = l.message_id
WHERE l.id = '$LOG_ID';
"
```

Expected: `moderation_status=APPROVED, review_outcome=RELEASED, reviewed=t`.

### S9 — Permission denials

```bash
# Parent cannot issue alerts (no com-003:write)
curl -sX POST "$API/messaging/emergency-alerts" \
  -H "Authorization: Bearer $PARENT_TOKEN" \
  -H "$TENANT_HEADER" \
  -H 'Content-Type: application/json' \
  -d "{\"alertTypeId\":\"$ALERT_TYPE_ID\",\"title\":\"x\",\"body\":\"x\"}" \
  -w '\nstatus=%{http_code}\n'
```

Expected: `status=403` with INSUFFICIENT_PERMISSIONS.

```bash
# Teacher cannot read moderation queue (no com-004:read)
curl -s "$API/messaging/moderation/queue" -H "Authorization: Bearer $TEACHER_TOKEN" -H "$TENANT_HEADER" -w '\nstatus=%{http_code}\n'
```

Expected: `status=403`.

```bash
# Student cannot ack someone else's delivery (row-scope 404 don't-leak-existence)
DAVID_DELIV_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c "
SET search_path TO tenant_demo;
SELECT d.id FROM msg_emergency_alert_deliveries d
JOIN platform.platform_users pu ON pu.id = d.recipient_id
WHERE pu.email = 'parent@demo.campusos.dev' AND d.alert_id = '$ALERT_ID'
LIMIT 1;
")
curl -sX POST "$API/messaging/emergency-alert-deliveries/$DAVID_DELIV_ID/acknowledge" \
  -H "Authorization: Bearer $STUDENT_TOKEN" \
  -H "$TENANT_HEADER" \
  -w '\nstatus=%{http_code}\n'
```

Expected: `status=404` (don't leak existence).

### S10 — Moderation policy CRUD

```bash
# Admin creates a building-tier policy
curl -sX POST "$API/messaging/moderation/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "$TENANT_HEADER" \
  -H 'Content-Type: application/json' \
  -d '{"name":"S10 CAT — Local","keywords":["smoke test"],"keywordAction":"FLAG_FOR_REVIEW"}'

# Listing policies includes the new building-tier row alongside platform/district
curl -s "$API/messaging/moderation/policies" -H "Authorization: Bearer $ADMIN_TOKEN" -H "$TENANT_HEADER" | jq '.[] | {scope, name, keywordAction, isEditable}'
```

Expected: every PLATFORM row has `isEditable=false`. The new BUILDING row has `isEditable=true` and matches the supplied keywords + action.

```bash
# Admin cannot edit a PLATFORM-tier row even when one exists
PLATFORM_POLICY_ID=$(curl -s "$API/messaging/moderation/policies" -H "Authorization: Bearer $ADMIN_TOKEN" -H "$TENANT_HEADER" | jq -r '.[] | select(.scope=="PLATFORM") | .id' | head -1)

curl -sX PATCH "$API/messaging/moderation/policies/$PLATFORM_POLICY_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "$TENANT_HEADER" \
  -H 'Content-Type: application/json' \
  -d '{"isActive":false}' \
  -w '\nstatus=%{http_code}\n'
```

Expected: `status=403` with the message "Only BUILDING-tier policies are editable. PLATFORM and DISTRICT policies are seed-only."

---

## Cleanup

The CAT leaves `tenant_demo` in a slightly extended state (the new alert + smoke messages + the smoke building-tier policy). Cleanup runs in reverse dependency order:

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo;
DELETE FROM msg_moderation_log WHERE created_at > now() - interval '1 hour';
DELETE FROM msg_messages WHERE body LIKE 'S1 CAT%' OR body LIKE 'Thanks Mr. Rivera%' OR body ILIKE '%shit%' OR body LIKE 'I have been thinking%';
DELETE FROM msg_emergency_alerts WHERE title = 'Shelter in Place';
DELETE FROM msg_moderation_policies WHERE name = 'S10 CAT — Local';
DELETE FROM msg_announcements WHERE title = 'Spring Concert Friday';
"
```

After cleanup, re-running the schema preamble checks should return to the post-`seed:emergency` baseline.

---

**Cycle 14 ships clean to the post-cycle architecture review. Wave 3 (Communications & Community) is open.**
