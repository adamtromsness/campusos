# Kafka Operations Runbook

**Operator handbook for the CampusOS event bus.** P2-H3 Step 5 deliverable.
Covers consumer retry policy, DLQ handling, alert thresholds, replay
procedures, poison-message quarantine, financial / safety SLAs, and schema
compatibility rules.

Related:

- `docs/kafka-topic-registry.md` — canonical inventory of every topic
- `apps/api/src/kafka/event-envelope.ts` — ADR-057 envelope shape
- `apps/api/src/kafka/outbox.service.ts` + `outbox-publisher.worker.ts` — durable producer
- `apps/api/src/kafka/idempotency.service.ts` — claim-after-success consumer pattern
- `platform.platform_dlq_messages` — dead-letter table
- `apps/api/src/finance/gl-reconciliation.worker.ts` — financial integrity audit (P2-H3 Step 3)

## 1. Consumer Retry Policy by Event Class

The four event classes (COMMAND / NOTIFICATION / OBSERVABLE / FUTURE — see
`kafka-topic-registry.md`) drive different retry budgets in
`KafkaConsumerService`. The shared base helper is `processWithIdempotency`
which claims after success — a redelivery is silently dropped if the
`(consumer_group, event_id)` row already lives in
`platform.platform_event_consumer_idempotency`.

| Class                                                                                | Max handler attempts | Backoff                   | DLQ on exhaustion                               | Operator action                                                                     |
| ------------------------------------------------------------------------------------ | -------------------- | ------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| COMMAND                                                                              | 5                    | exponential 1s → 5s → 25s | Always park to `platform.platform_dlq_messages` | Investigate within 1h. Financial / safety topics: 15 min.                           |
| NOTIFICATION (safety: SHI, banned-person, breach, sent-home, fire-drill, monitoring) | 5                    | exponential               | Park to DLQ. PAGE SRE.                          | Investigate within 15 min.                                                          |
| NOTIFICATION (routine)                                                               | 3                    | exponential               | Park to DLQ, INFO-class alarm only.             | Daily review.                                                                       |
| OBSERVABLE                                                                           | 2                    | linear 1s                 | Drop with WARN log. No DLQ.                     | Reconcile via daily batch jobs (analytics) or `GlReconciliationWorker` (financial). |
| FUTURE                                                                               | n/a                  | n/a                       | n/a — no producer                               | n/a                                                                                 |

### Implementation notes

- `MAX_HANDLER_ATTEMPTS` is an in-memory counter keyed on
  `(group, topic, partition, offset)`. A pod restart resets the counter;
  combined with claim-after-success this is acceptable — a redelivered
  successful event short-circuits via the idempotency claim, and a
  truly-failing event will hit MAX again and re-park.
- Backoff between attempts is achieved by `await sleep(2 ** attempt * 1000)`
  inside the consumer base helper. KafkaJS itself does not back off;
  pausing is application-level.
- Malformed JSON or envelope-validation failures (`assertValidEnvelope`)
  bypass the retry loop and park directly with `error_class =
EnvelopeValidationError`.

## 2. DLQ Topic Naming

CampusOS does not use Kafka DLQ topics. Failed messages park to the
**platform-schema row table** `platform.platform_dlq_messages` (Cycle 3 Step 3
schema, REVIEW-CYCLE3 BLOCKING 1 fix). Each row carries:

| Column             | Value                                                      |
| ------------------ | ---------------------------------------------------------- |
| `id`               | UUIDv7, generated at park time                             |
| `consumer_group`   | e.g. `gl-consumer`                                         |
| `topic`            | wire topic (env-prefixed, e.g. `dev.pay.payment.received`) |
| `partition`        | int                                                        |
| `kafka_offset`     | int                                                        |
| `payload`          | JSONB — the full envelope as received                      |
| `headers`          | JSONB — KafkaJS headers                                    |
| `event_id`         | UUID extracted from envelope, if available                 |
| `tenant_id`        | UUID extracted from envelope, if available                 |
| `error_class`      | constructor name of the thrown error                       |
| `error_message`    | TEXT                                                       |
| `retry_count`      | int — attempts before parking                              |
| `parked_at`        | TIMESTAMPTZ                                                |
| `resolved_at`      | TIMESTAMPTZ NULL — set on manual replay or discard         |
| `resolution_notes` | TEXT NULL — operator's audit trail                         |

Naming uses table-row keys not topic suffixes, so all DLQ messages across
all tenants live in one queryable table.

## 3. Alert Thresholds + Dashboards

The audit's stated alert thresholds:

| Signal                                                                                                    | Threshold                  | Alarm class | On-call response                                                  |
| --------------------------------------------------------------------------------------------------------- | -------------------------- | ----------- | ----------------------------------------------------------------- |
| `platform_dlq_messages.parked_at` > now() - 15 min AND `event_class = COMMAND` (financial / safety)       | any row                    | PAGE        | 15 min ack, 1h resolution.                                        |
| `platform_dlq_messages.parked_at` > now() - 1h AND any class                                              | > 10 rows / 5 min          | PAGE        | 30 min ack.                                                       |
| `platform_dlq_messages.parked_at` > now() - 24h                                                           | > 100 rows / day           | WARN        | Same-business-day.                                                |
| `rpt_gl_reconciliation.status = 'DISCREPANCIES_FOUND'`                                                    | any row in last 24h        | PAGE        | 15 min ack, 4h resolution. Financial integrity violation.         |
| `rpt_gl_reconciliation.status = 'FAILED'`                                                                 | any row in last 24h        | PAGE        | 1h ack. Reconciliation worker hit an error on a source query.     |
| `platform_outbox` rows where `published_at IS NULL AND created_at < now() - 5 min`                        | > 10 rows                  | WARN        | OutboxPublisherWorker is lagging. Check broker health.            |
| `platform_outbox` rows where `published_at IS NULL AND failed_at IS NOT NULL AND attempt_count >= 5`      | any                        | PAGE        | Outbox row stuck. Operator decides: retry / discard / fix source. |
| Consumer lag (Kafka native, by group)                                                                     | > 1000 messages for 10 min | WARN        | Consumer is slow.                                                 |
| Consumer lag (financial groups: `gl-consumer`, `journal-batch-posted-consumer`, `payment-account-worker`) | > 100 messages for 5 min   | PAGE        | 30 min ack.                                                       |

Dashboards live in Grafana / Prometheus. Per the Phase 2 punch list, a
DLQ dashboard / alert is still pending — query the table directly until
that ships:

```sql
SELECT topic, error_class, COUNT(*) AS rows, MAX(parked_at) AS latest
FROM platform.platform_dlq_messages
WHERE resolved_at IS NULL
GROUP BY topic, error_class
ORDER BY latest DESC;
```

## 4. Replay Procedure

A row parked in `platform_dlq_messages` is replayed by re-publishing its
payload to the original topic. Use the dev console (or a short script —
production has no UI for this yet).

### Manual replay (development)

```sql
-- 1. Inspect
SELECT id, topic, partition, kafka_offset, event_id, tenant_id, error_class, error_message, retry_count
FROM platform.platform_dlq_messages
WHERE id = 'THE_ID';
```

```bash
# 2. Replay (operator script, requires KAFKA_BROKERS env)
node tools/kafka/replay-dlq.js --id THE_ID
```

The script reads the row, calls `KafkaProducerService.emit({ topic, key,
payload, ... })` with the **original envelope** (preserving `event_id` so
the consumer's idempotency claim catches the redelivery cleanly), and
stamps `resolved_at = now()`, `resolution_notes = 'manual replay'` on
success.

> ⚠️ Never modify the envelope `event_id` during a replay. The consumer
> assumes the event_id is the dedup key — a fresh id makes the replay
> indistinguishable from a brand-new event and the side effects fire
> twice.

### Bulk replay (rare)

If a consumer bug parked dozens of rows and the fix has shipped, mass
replay is acceptable — but only for the same `consumer_group` and only
after confirming the new build is running on every consumer pod:

```bash
node tools/kafka/replay-dlq.js --group gl-consumer --since '2026-05-16 14:00'
```

### Discard

Operator decision when the payload is no longer relevant (e.g. a stale
attendance event that has already been corrected by a follow-up). Stamp
`resolved_at = now()`, `resolution_notes = 'discarded: <reason>'` and
leave the row in place for audit.

## 5. Poison-Message Quarantine

A "poison message" is a payload that consistently fails parsing or
processing on every retry — e.g. malformed JSON, an envelope without
`tenant_id`, or a foreign-key reference to a row that has since been
hard-deleted.

The consumer base helper recognises three classes of error as
**permanent** (DLQ immediately, do not retry):

- `SyntaxError` from `JSON.parse`
- `EnvelopeValidationError` from `assertValidEnvelope`
- Any error class listed in the consumer's `permanentErrors` set
  (e.g. `MalformedAllergyAlertPayloadError` from
  `AllergyAlertConsumer`)

Transient errors (DB outage, broker disconnect, downstream timeout) are
retried up to MAX_HANDLER_ATTEMPTS before parking.

When SRE acks a PAGE for a poison message:

1. Quote the DLQ row id in the incident report.
2. Inspect `payload` and `error_class` — these are the canonical evidence.
3. If the producer is in-house, file a fix on the producer.
4. If the producer is external (e.g. third-party webhook) and we cannot
   change the format, add the new error class to the consumer's
   `permanentErrors` set so future occurrences park immediately rather
   than burning retry budget.

## 6. Financial Event Escalation SLAs

These topics are subject to the strictest SRE SLAs because a missed
event = silent financial loss or compliance violation:

| Topic                               | Owner               | Ack SLA | Resolution SLA |
| ----------------------------------- | ------------------- | ------- | -------------- |
| `pay.invoice.created`               | Finance / SRE       | 15 min  | 4 h            |
| `pay.payment.received`              | Finance / SRE       | 15 min  | 4 h            |
| `pay.refund.issued`                 | Finance / SRE       | 15 min  | 4 h            |
| `pay.debt.written_off`              | Finance / SRE       | 15 min  | 4 h            |
| `pay.credit_note.issued`            | Finance / SRE       | 15 min  | 4 h            |
| `pay.payment.reversed`              | Finance / SRE       | 15 min  | 4 h            |
| `fin.journal_batch.posted`          | Finance / SRE       | 15 min  | 4 h            |
| `fin.gl_reconciliation.discrepancy` | Finance / SRE / DPO | 15 min  | 4 h            |
| `hr.payroll.processed`              | HR / Finance / SRE  | 15 min  | 4 h            |
| `evt.event.completed`               | Finance / SRE       | 30 min  | 8 h            |
| `evt.refund.issued`                 | Finance / SRE       | 30 min  | 8 h            |

These topics ALL use the durable outbox (`OutboxService.enqueueInTx`)
rather than best-effort `KafkaProducerService.emit`. A failed publish
leaves the `platform_outbox` row with `failed_at` populated and
`OutboxPublisherWorker` retries on the next poll until
`MAX_OUTBOX_ATTEMPTS`.

## 7. Safety Event Escalation SLAs

| Topic                                               | Owner                                     | Ack SLA                                      | Resolution SLA                                      |
| --------------------------------------------------- | ----------------------------------------- | -------------------------------------------- | --------------------------------------------------- |
| `dpo.breach.discovered`                             | DPO / SRE / CEO                           | 15 min                                       | 1 h (regulatory 72h notification clock starts here) |
| `svc.wellbeing.alert.created` (SELF_HARM_INDICATOR) | Counsellor / Principal                    | 15 min                                       | 1 h                                                 |
| `vis.banned_person.detected`                        | Safeguarding / Principal                  | 15 min                                       | 1 h                                                 |
| `hlth.nurse_visit.sent_home`                        | Health Office / Parent (via notification) | 30 min                                       | 4 h                                                 |
| `trn.driver.hours_approaching_limit`                | Transportation / SRE                      | 30 min                                       | Same shift                                          |
| `fac.fire_drill.overdue`                            | Facilities / Safety                       | 1 h                                          | 1 day                                               |
| `fac.inspection.failed`                             | Facilities / Safety                       | 1 h                                          | Same business day                                   |
| `tech.monitoring.alert`                             | IT / SRE                                  | depends on `tech_monitoring_alerts.severity` | depends                                             |

## 8. GL Reconciliation (P2-H3 Step 3)

The `GlReconciliationWorker` is the financial integrity audit. Five
checks per tenant per day:

- INVOICE_AR — every non-DRAFT non-CANCELLED `pay_invoice` has a matching
  GL row with `reference_type = 'pay_invoices'`
- PAYMENT_CASH — every COMPLETED/REFUNDED `pay_payment` has a matching
  GL row with `reference_type = 'pay_payments'`
- REFUND_REVERSAL — every COMPLETED `pay_refund` has a matching GL row
  with `reference_type = 'pay_refunds'`
- CREDIT_NOTE — every `pay_credit_note` has a matching GL row with
  `reference_type = 'pay_credit_notes'`
- PAYMENT_REVERSAL — every `pay_payment_reversal` has a matching GL row
  with `reference_type = 'pay_payment_reversals'`

A non-zero `discrepancy_count` emits `fin.gl_reconciliation.discrepancy`
via the durable outbox — SRE pages on receipt.

### Manually triggering a reconciliation run

```bash
# Phase 3 ops will wire this to a cron container. For now, invoke from
# a Nest application context:
node -e "
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./apps/api/dist/app.module');
const { GlReconciliationWorker } = require('./apps/api/dist/finance/gl-reconciliation.worker');
(async () => {
  const app = await NestFactory.createApplicationContext(AppModule);
  const worker = app.get(GlReconciliationWorker);
  console.log('rows written:', await worker.runOnce());
  await app.close();
})();
"
```

### Investigating a discrepancy

```sql
SELECT check_type, discrepancies
FROM tenant_<subdomain>.rpt_gl_reconciliation
WHERE status = 'DISCREPANCIES_FOUND'
ORDER BY run_at DESC
LIMIT 5;
```

The `discrepancies` JSONB array carries `{ sourceId, sourceTable, issue }`
tuples — pivot to the source table by `sourceId` to confirm whether the
GL trail is truly missing or whether the worker query is broken.

## 9. Schema Compatibility

Event payloads are versioned via `event_version` on the envelope (ADR-057).
Compatibility rules:

- Adding a new optional field is **always backward-compatible** — bump
  the version when the new field becomes meaningful but consumers MUST
  default unknown fields to undefined / null.
- Removing a field requires a `event_version` bump AND coordinated
  consumer + producer deploys.
- Renaming a field is forbidden — add the new field, dual-emit for one
  release, then remove the old field with another version bump.
- Changing a field's type is forbidden — add a new field with a new
  name.

### Versioning today

All events emitted by services in `apps/api/src` carry `event_version: 1`
by default. No versioned consumers exist yet — when the second version of
any topic ships, the consumer must branch on `envelope.event_version`.

## 10. Outbox Reconciliation

`OutboxPublisherWorker` polls `platform.platform_outbox` every 5 seconds
(configurable via `OUTBOX_POLL_INTERVAL_MS`). Per row:

- `published_at IS NULL` AND `failed_at IS NULL` → publish, set `published_at = now()`.
- `published_at IS NULL` AND `failed_at IS NOT NULL` AND `attempt_count < MAX_OUTBOX_ATTEMPTS` → retry, increment.
- `attempt_count >= MAX_OUTBOX_ATTEMPTS` → leave the row; SRE pages on the alert thresholds above.

### Manually rescuing a stuck outbox row

```sql
-- Inspect
SELECT id, topic, attempt_count, failed_at, last_error
FROM platform.platform_outbox
WHERE attempt_count >= 5 AND published_at IS NULL
ORDER BY created_at;

-- Reset attempt counter so the worker retries
UPDATE platform.platform_outbox
SET attempt_count = 0, failed_at = NULL, last_error = NULL
WHERE id = 'THE_ID';

-- Or: discard (operator decision)
UPDATE platform.platform_outbox
SET published_at = now(), last_error = 'manual discard: <reason>'
WHERE id = 'THE_ID';
```

## 11. Phase 3 Carry-over

The following operational items remain for Phase 3 ops cycles:

- DLQ dashboard wired into Grafana with the alert thresholds above.
- `GlReconciliationWorker` cron container or Kubernetes CronJob (daily 03:00 UTC).
- Replay script `tools/kafka/replay-dlq.js`.
- Alertmanager → PagerDuty wiring for the financial / safety event SLAs.
- `event_class` denormalisation on `platform_dlq_messages` so the
  PAGE-vs-WARN classification can be a single column query rather than a
  topic-lookup join.
