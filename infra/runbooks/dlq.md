# Runbook: DLQ Message Age

**Alert:** `DlqMessageOlderThan15Min` (PAGE)
**Owner:** campusos-platform on-call

## What it means

A message has been in `platform.platform_dlq_messages` for more than 15 minutes without being replayed or discarded.

## Triage steps

1. List unresolved DLQ messages:
   ```
   curl -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "X-Tenant-Subdomain: demo" \
        "https://api.campusos.dev/api/v1/admin/dlq?status=PENDING&limit=50"
   ```
2. Inspect the offender:
   ```
   curl -H "Authorization: Bearer $ADMIN_TOKEN" \
        https://api.campusos.dev/api/v1/admin/dlq/<id>
   ```
3. Decide based on the `error_class`:
   - `ENVELOPE_INVALID` — never replayable. Discard with a reason. Almost always a bug in the producer; file a ticket.
   - `MAX_RETRIES_EXCEEDED` — handler bug. Read `error_message` + payload, fix the handler, then `POST /admin/dlq/:id/replay`.
   - Anything from a permission gate (`Forbidden`) — tenant misconfiguration; do not replay until the upstream tenant config is fixed.

## Replay

`POST /api/v1/admin/dlq/:id/replay` re-emits the original envelope verbatim (`emitRaw`). The original `event_id` + `correlation_id` + `tenant_id` are preserved so downstream `processWithIdempotency` claims behave correctly.

## Discard

`POST /api/v1/admin/dlq/:id/discard { "reason": "..." }` marks the row `DISCARDED` so it's hidden from the default queue but kept for audit.

## Escalation

Page wakes on-call. If the same `error_class` appears repeatedly across multiple DLQ entries, investigate at the producer rather than the consumer.
