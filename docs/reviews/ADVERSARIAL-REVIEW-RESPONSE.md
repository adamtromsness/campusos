# Response to ADVERSARIAL-REVIEW-FINAL.md

**Response date:** 2026-05-07
**Codebase state at response:** post-`cycle32-approved` + Round-1 fixes (commit `96f82bd`)
**Verification method:** direct read of current `main` branch source for each contested claim

---

## Executive summary

The adversarial reviewer flagged **7 net-new MAJORs** plus several MINORs / OBSERVATIONS, and concluded **NOT PILOT-READY**. After verifying each finding against the actual current code on `main`:

- **4 of 7 MAJOR-NEW findings are STALE** — they describe a previous version of the code that no longer matches `main`. The reviewer's self-imposed limitation (no `git clone`, raw GitHub reads only) appears to have hit older snapshots or different files than they intended to read. **Each disputed claim is verified against the live source below.**
- **3 of 7 MAJOR-NEW findings are VALID** and have been fixed in this response: DLQ write-failure now fail-closed; envelope validation now enforces topic/event_type pairing; AllergyAlertConsumer now DLQs malformed payloads.
- The reviewer's confirmed disputed findings on Claude (DLQ replay race fixed, POS allergen race fixed, HIPAA access log fixed) match my own Round-2 verification — agreement on those.
- Remaining accepted findings (Staff role split, outbox pattern, unit test scaffolding) match the Phase 2 punch list already documented in CLAUDE.md.

After this response: **Round 3 verdict APPROVED FOR PILOT WITH CONDITIONS** matches Round 2; the 3 multi-day Phase 2 items remain as documented engineering work before real-school cutover.

---

## Stale findings — current code does not match what the reviewer described

### MAJOR-NEW-1 — "Current GLConsumer maps payment receipts to Tuition Revenue"

**Status:** STALE.

**Reviewer's claim:** `pay.payment.received` maps to `DR Cash / CR Tuition Revenue`, double-recognizing revenue and leaving AR uncleared.

**Live source (`apps/api/src/finance/gl.consumer.ts:197-221`):**

```ts
// ACCRUAL MODEL (REVIEW-CYCLE26 BLOCKING 1) — payment.received
// is DR Cash / CR AR. Revenue was already recognised when the
// invoice landed (pay.invoice.created → DR AR / CR Tuition).
// The earlier mapping double-credited Tuition Revenue and left
// AR un-cleared; now Cash goes up and AR clears in lockstep.
entries = [
  { accountId: cashAccount, ..., debit: amt, credit: 0, description: 'Cash received from family' },
  { accountId: arAccount,   ..., debit: 0,   credit: amt, description: 'Accounts receivable cleared' },
];
```

`pay.invoice.created` correctly maps to `DR AR / CR Tuition` (lines 222-252), and `pay.refund.issued` to `DR AR / CR Cash` (lines 253-294). The accrual model has been in place since REVIEW-CYCLE26 BLOCKING 1 (commit `5498c61`, 2026-05-06).

**Action:** none required. Reviewer was reading stale source.

---

### MAJOR-NEW-2 — "GLConsumer drops finance events on missing config or missing synthetic actor"

**Status:** STALE.

**Reviewer's claim:** missing canonical accounts or missing synthetic CFO actor are logged with "drop event" and return successfully under `processWithIdempotency`, claiming the event as processed.

**Live source (`apps/api/src/finance/gl.consumer.ts:156-176`):**

```ts
const accounts = await this.loadAccountMapping();
if (!accounts) {
  throw new Error(
    `[${CONSUMER_GROUP}] cannot resolve canonical accounts ... — finance configuration must be completed before payment events can land`,
  );
}
...
const cfo = await this.resolveSyntheticActor();
if (!cfo) {
  throw new Error(
    `[${CONSUMER_GROUP}] no ACTIVE hr_employees row available ... must exist before payment events can post to the GL`,
  );
}
```

Both paths throw, the error propagates through `processWithIdempotency` (which leaves the event unclaimed), the consumer retry chain fires up to MAX_HANDLER_ATTEMPTS, then DLQ. This was REVIEW-CYCLE26 BLOCKING 3, also fixed in commit `5498c61`.

**Action:** none required. Reviewer was reading stale source.

---

### MAJOR-NEW-3 — "Refunds do not recompute invoice status"

**Status:** STALE.

**Reviewer's claim:** `RefundService.issue()` flips payment to `REFUNDED` but doesn't update parent invoice; a fully refunded payment leaves the invoice stuck `PAID`, so a re-pay is rejected.

**Live source (`apps/api/src/payments/refund.service.ts:226-265`):**

```ts
// REVIEW-CYCLE6 fix 7: recompute the parent invoice's status using
// the same refund-aware paid formula as the read path. After a
// partial refund a previously PAID invoice should drop back to
// PARTIAL; after a refund that nets the invoice back to zero
// collected the status should drop to SENT.
var invStatusRows = (await tx.$queryRawUnsafe(
  'SELECT id, total_amount::text, status, ' +
    "(COALESCE((SELECT SUM(p.amount) FROM pay_payments p WHERE p.invoice_id = pay_invoices.id AND p.status IN ('COMPLETED','REFUNDED')), 0) " +
    "- COALESCE((SELECT SUM(r.amount) FROM pay_refunds r JOIN pay_payments p2 ON p2.id = r.payment_id WHERE p2.invoice_id = pay_invoices.id AND r.status = 'COMPLETED'), 0))::text AS amount_paid " +
    'FROM pay_invoices WHERE id = $1::uuid',
  invoiceIdForRefund,
)) as ...;
if (invStatusRows.length > 0) {
  ...
  if (netPaid >= totalAmount - 0.001) nextStatus = 'PAID';
  else if (netPaid > 0.001) nextStatus = 'PARTIAL';
  else nextStatus = 'SENT';
  if (nextStatus !== inv.status) {
    await tx.$executeRawUnsafe('UPDATE pay_invoices SET status = $1, ...', nextStatus, ...);
  }
}
```

This recomputes net paid (completed payments minus completed refunds) and flips invoice status. The full `$400 PAY → PAID → $50 REFUND → PARTIAL → $50 PAY → PAID` round trip was verified live in REVIEW-CYCLE6 fix 7 (CAT script `docs/cycle6-cat-script.md` scenario S11).

**Action:** none required. Reviewer was reading stale source.

---

### MAJOR-NEW-4 — "Invoice cancellation no longer reverses outstanding ledger balance"

**Status:** STALE.

**Reviewer's claim:** current `cancel()` only flips status to `CANCELLED` and the ledger CHARGE entry is not reversed, leaving the family balance inflated.

**Live source (`apps/api/src/payments/invoice.service.ts:343-366`):**

```ts
// Compensate the ledger for non-DRAFT invoices that already
// landed a CHARGE entry. The outstanding balance to neutralise
// is `total - SUM(completed payments)` — a partially-paid invoice
// only needs to back out the unpaid remainder.
if (inv.status !== 'DRAFT') {
  ...
  var outstanding = Number((totalAmount - completed).toFixed(2));
  if (outstanding > 0.001) {
    await this.ledger.recordEntry(tx, {
      familyAccountId: inv.family_account_id,
      entryType: 'ADJUSTMENT',
      amount: -outstanding,
      referenceId: id,
      description: 'ADJUSTMENT: invoice cancelled — reversing outstanding $' + outstanding.toFixed(2),
      createdBy: actor.accountId,
    });
  }
}
```

Compensating ADJUSTMENT entry is written for non-DRAFT cancellations. This was REVIEW-CYCLE6 fix 6, verified live in CAT script scenario S6.

**Action:** none required. Reviewer was reading stale source.

---

## Valid findings — fixed in this response

### MAJOR-NEW-5 — DLQ write failure swallowed

**Status:** VALID. Fixed.

**Live source confirmation:** `KafkaConsumerService.dlq()` previously caught DLQ insert failures, logged them, and returned (line 286 of pre-fix source said "Best-effort: if the DLQ insert itself fails, log and swallow"). Under platform-DB outage, a poison message would be lost from BOTH Kafka retry AND DLQ.

**Fix applied:** `dlq()` now throws a new `DlqWriteFailureError` when the platform insert fails. The throw propagates through `eachMessage`, kafkajs retains the offset, and the partition blocks until the platform DB recovers. The trade-off — one blocked partition per affected consumer group during platform-DB outages — is correct for a financial / safety system: operators see partition lag in metrics; silent message loss is undetectable until a downstream invariant fails much later.

**File:** `apps/api/src/kafka/kafka-consumer.service.ts:288-365` (rewritten dlq + new exported `DlqWriteFailureError` class).

---

### MAJOR-NEW-6 — Envelope validation does not enforce topic/event_type pairing

**Status:** VALID. Fixed.

**Live source confirmation:** `KafkaConsumerService.subscribe` called `assertValidEnvelope(payload)` without passing the expected event type, even though the validator function signature accepts `expectedEventType`. A wrong-topic envelope passed validation.

**Fix applied:** the wire topic is now run through `unprefixTopic()` to derive the logical event type, which is passed to `assertValidEnvelope`. Mismatch → DLQ via the existing envelope-validation park path.

**File:** `apps/api/src/kafka/kafka-consumer.service.ts:204-216` (updated `assertValidEnvelope` call to pass `expectedEventType = unprefixTopic(params.topic)`).

---

### MAJOR-NEW-7 — AllergyAlertConsumer drops semantically malformed payloads without DLQ

**Status:** VALID. Fixed.

This was ironic — it's in the F10 code I shipped in the prior response. The consumer logged a warning + returned on `isValidPayload === false`, which under `processWithIdempotency` silently claimed the event. For a SAFETY-critical read model that gates the POS allergen cross-check, a malformed Health emit could leave the read model stale.

**Fix applied:** the validity check is moved INSIDE the `processWithIdempotency` callback. A malformed payload now throws a new `MalformedAllergyAlertPayloadError`, which propagates through the standard retry/DLQ chain and parks to `platform_dlq_messages` with `error_class=MalformedAllergyAlertPayloadError`. The DLQ row surfaces the bad emit for operator action.

**File:** `apps/api/src/food-service/allergy-alert.consumer.ts:60-119` (validity check moved inside the idempotency wrapper; new `MalformedAllergyAlertPayloadError` class).

---

## Disputed disagreements

### Disagreement 1 — Overall verdict

**Reviewer:** NOT PILOT-READY because of finance regressions + event-handling gaps.
**My response:** The 4 finance regressions cited do NOT exist on current `main`. They were fixed in REVIEW-CYCLE6 (April 2026) and REVIEW-CYCLE26 (May 6, 2026). The 3 remaining MAJOR-NEWs (event-handling gaps) are now fixed in this response. Reverting to APPROVED FOR PILOT WITH CONDITIONS, matching the Round-2 verdict.

### Disagreement 2 — Severity of safety-critical paths

**Reviewer:** SHI escalation, breach notification, emergency alert fan-out should be MAJOR pre-pilot blockers because they're safety/compliance controls.
**My response:** I agree on severity classification — these ARE safety controls — but the architectural fix (transactional outbox) is correctly scoped as a 3-5 day Phase 2 project per Round-1's effort estimate, not a half-day fix. CLAUDE.md Phase 2 punch list item 4 already tracks this as the canonical pre-pilot work. Marking these as MAJOR vs MINOR doesn't change what gets built before pilot.

### Disagreement 3 — Specialist role split severity

**Reviewer:** Pre-pilot mandatory.
**My response:** Agree — this is in the Round-1 review's "blocking" category and matches CLAUDE.md Phase 2 punch list items 9, 11, 13, 14, 16, 22, 25, 26, 30, 31, 32. No new work, just confirmation that this is pre-real-school-cutover blocking.

---

## Acknowledged minor + observation findings

- **MINOR-NEW-1 (public metrics ACL)** — already documented in `infra/runbooks/oncall.md` per CLAUDE.md "REVIEW-CYCLE31 MAJOR 7" — endpoint is intentionally public + tenant-exempt; production deployments must restrict network access to the Prometheus scraper. Carried as Phase 2 ops polish.
- **MINOR-NEW-2 (gl.consumer.ts comments)** — confirmed not applicable: comments and code are aligned. The reviewer's claim that "comments document the wrong mapping" was stale alongside their other GLConsumer findings.
- **OBSERVATION (`platform_reference_health`)** — agreed; not yet shipped, on Phase 2 punch list as the soft-FK orphan-detection worker.

---

## CI parity verification

All 5 CI gates green for this response's 3 fixes:

```
$ pnpm --filter @campusos/api build              ✓ clean
$ pnpm --filter @campusos/api exec tsc --noEmit  ✓ clean
$ pnpm format:check                              ✓ All matched files use Prettier code style
$ pnpm lint:logs                                 ✓ 508 files clean
$ pnpm test                                      ✓ 7/7 tests pass
```

---

## Updated risk register

After this response:

| Rank       | Risk                                                   | Round 1 | Round 2 | Round 3 (this)             |
| ---------- | ------------------------------------------------------ | ------- | ------- | -------------------------- |
| 1          | Specialist-role over-grant                             | open    | open    | open (Phase 2)             |
| 2          | DLQ replay race                                        | open    | CLOSED  | CLOSED                     |
| 3          | 72-hour breach Kafka emit silent failure               | open    | open    | open (Phase 2 outbox)      |
| 4          | SHI auto-escalation Kafka emit silent failure          | open    | open    | open (Phase 2 outbox)      |
| 5          | HIPAA access log INSERT failure post-read              | open    | CLOSED  | CLOSED                     |
| 6          | Food Service reads Health module directly              | open    | CLOSED  | CLOSED                     |
| 7          | Zero unit test coverage                                | open    | open    | open (Phase 2)             |
| 8          | Soft FK orphans accumulate undetected                  | open    | open    | open (Phase 2)             |
| 9          | POS allergen race                                      | open    | CLOSED  | CLOSED                     |
| 10         | Encumbered budget drift silent clamp                   | open    | CLOSED  | CLOSED                     |
| **NEW 11** | DLQ write failure silently loses poison messages       | n/a     | n/a     | **CLOSED (this response)** |
| **NEW 12** | Envelope topic/event_type mismatch reaches handler     | n/a     | n/a     | **CLOSED (this response)** |
| **NEW 13** | AllergyAlertConsumer drops malformed payloads silently | n/a     | n/a     | **CLOSED (this response)** |

**Total closed:** 8 of 13 risks (62%). Remaining 5 are the documented Phase 2 punch list items.

---

## Final verdict

**APPROVED FOR PILOT WITH CONDITIONS** (unchanged from Round 2; reviewer's NOT PILOT-READY downgrade was based on stale source claims that don't match `main`).

**Pre-pilot blocking work** (matches Round 1 + Round 2):

1. Specialist role split (3-5 days)
2. Transactional outbox for safety-critical events (3-5 days)
3. Unit-test scaffolding for high-risk state machines (5-8 days)

The adversarial review's value is in **validating the 3 net-new MAJOR findings** that closed the remaining event-handling gap. The 4 stale findings should be a reminder to use `git clone` rather than raw GitHub reads when reviewing — the codebase moves quickly and snapshot reads can lag behind the canonical source.
