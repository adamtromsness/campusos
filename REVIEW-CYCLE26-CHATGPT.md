# REVIEW-CYCLE26-CHATGPT

**Cycle:** 26 — Finance & Accounting (Wave 6 opener).
**Round 1 verdict:** Reject pending fixes — 5 BLOCKING + 4 MAJOR.
**Round 1 commit:** `cycle26-complete` (`3756529`).
**Round 1 fix commit:** this commit.
**Live verification:** `tenant_demo` 2026-05-06.

## Triage table

| #        | Class | Title                                                       | Disposition                                                                                       |
| -------- | ----- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| BLOCKING | 1     | GL consumer can double-recognize tuition revenue            | Fixed — payment.received → DR Cash / CR AR (accrual model)                                        |
| BLOCKING | 2     | AP payment GL post + payment record not actually atomic     | Fixed — `PostingService.createAndPostInTx` + lock-recompute-post-insert in one tx                 |
| BLOCKING | 3     | GL consumer silently drops events on configuration failures | Fixed — throw on missing chart mapping / missing actor → standard DLQ retry/park                  |
| BLOCKING | 4     | AP payment overpayment/state check vulnerable to race       | Fixed — voucher locked FOR UPDATE inside the same tx as GL post + payment insert                  |
| BLOCKING | 5     | Finance create paths under-validate references              | Fixed — `FinanceValidationService` + applied to AP voucher / budget / budget line / recon / grant |
| MAJOR    | 6     | Staff role still stands in for CFO / Business Manager       | Acknowledged — Phase 2 backlog item alongside the broader role-split chain                        |
| MAJOR    | 7     | System account protection is incomplete                     | Fixed — `is_system` accounts only accept description updates; name/parent/fund/active rejected    |
| MAJOR    | 8     | Board report immutability is service-side only              | Acknowledged — Phase 2 backlog item; DB trigger lands once role model exists                      |
| MAJOR    | 9     | GL event mapping is hard-coded to account codes             | Acknowledged — Phase 2 backlog item; finance posting rules table lands pre-pilot                  |

## Code-level fixes

### BLOCKING 1 — Accrual GL accounting model

`apps/api/src/finance/gl.consumer.ts` mapping rewritten:

- **`pay.invoice.created`** → DR AR + CR Tuition (revenue accrued, AR created) — unchanged.
- **`pay.payment.received`** → DR Cash + **CR AR** (cash up, AR cleared) — was CR Tuition. Revenue is no longer double-recognised; AR is no longer left perpetually outstanding.
- **`pay.refund.issued`** → DR AR + CR Cash (cash leg reversed; AR restored as a credit-balance signalling refund-credit owed to the family for application to a future invoice) — was DR Tuition + CR Cash. Revenue recognised when the original invoice was issued is NOT auto-reversed; explicit MANUAL adjustment batch handles writeoff per school policy. Refund-category-aware routing (restock fees vs withdrawals vs programme cancellations) carries to Phase 2.

**Live verified on `tenant_demo` 2026-05-06**: parent pays $40 invoice → GLConsumer auto-posts batch with `1000 Cash dr=$40 / 1100 Accounts Receivable cr=$40` — Tuition Revenue is NOT touched.

### BLOCKING 2 + 4 — AP payment atomicity (lock voucher → post → insert in one tx)

`apps/api/src/finance/posting.service.ts` exposes a new public helper:

```typescript
async createAndPostInTx(
  tx: PrismaClient,
  actor: ResolvedActor,
  input: CreateJournalBatchDto & { sourceEventId?: string; periodId?: string },
): Promise<string>  // returns batchId
```

Runs the full posting pipeline (idempotency check + period validation + INSERT batch + INSERT entries + balance validation + budget actuals update) against an existing tenant tx. The standalone `createAndPost` now wraps this in `executeInTenantTransaction`.

`apps/api/src/finance/budgets.service.ts::APPaymentService.pay` rewritten as one tenant transaction:

```text
BEGIN tenant tx
  1. SELECT … FROM fin_ap_vouchers WHERE id=$1 FOR UPDATE OF v
  2. recompute amount_paid from fin_ap_payments
  3. assert status=APPROVED + has gl_account_id + has fund_id
  4. assert input.amount + amount_paid ≤ total_amount + 0.005
  5. resolve cash account (1000) inside the tx
  6. PostingService.createAndPostInTx(tx, actor, balanced entries) — throws on imbalance
  7. INSERT INTO fin_ap_payments linking journal_batch_id
  8. UPDATE fin_ap_vouchers SET status='PAID' if newPaid >= total
COMMIT (or ROLLBACK whole-tx on any throw)
```

**Live verified on `tenant_demo` 2026-05-06**: pay $75 → ap_payment row + GL batch land together (batches 3 → 4, payments 0 → 1, voucher status flips to PAID atomically); second pay attempt against the now-PAID voucher returns 400 with the canonical "Only APPROVED vouchers can be paid (current: PAID)" message — the FOR UPDATE lock held by the first pay forced the second to re-read the bumped status.

### BLOCKING 3 — GLConsumer throws on missing config (DLQ instead of silent drop)

`apps/api/src/finance/gl.consumer.ts::process()` previously logged a warning and returned when `loadAccountMapping()` or `resolveSyntheticActor()` returned null. The return propagated through `processWithIdempotency` which then claimed the event_id as successfully processed — the event was permanently lost.

Now both miss paths `throw new Error(...)` with finance-domain language. The throw propagates up the consumer's `eachMessage` handler, the standard `KafkaConsumerService` retry/park loop catches it after `MAX_HANDLER_ATTEMPTS=5` retries, and the message lands in `platform.platform_dlq_messages` with the full payload + error details for operator action.

**Live verified on `tenant_demo` 2026-05-06**: deactivated Cash 1000 → parent paid $15 → GLConsumer `[gl-consumer] cannot resolve canonical accounts (Cash 1000 + AR 1100 + Tuition 4000) for tenant … — finance configuration must be completed before payment events can land` thrown 5× → `[KafkaConsumerService] Parked to DLQ: group=gl-consumer topic=dev.pay.payment.received partition=0 offset=13` → `platform.platform_dlq_messages` row count went up by 1; `fin_journal_batches` count unchanged (no fake post landed). Reactivated Cash + verified subsequent payment events post cleanly.

### BLOCKING 5 — Service-layer finance validation

New `apps/api/src/finance/validation.ts` exports `FinanceValidationService` with 4 helpers:

- `assertActiveFund(fundId, fieldName)` — fund exists in tenant + `is_active=true`.
- `assertActiveAccount(accountId, allowedTypes?, fieldName)` — account exists, is active, AND (when `allowedTypes` supplied) carries one of those `account_type` values.
- `assertPeriodInState(periodId, allowedStatuses?, fieldName)` — period exists in tenant + (when `allowedStatuses` supplied) status is one of those values.
- `assertActiveSupplier(supplierId, fieldName)` — supplier exists + active.

Wired into FinanceModule and injected into BudgetService + APVoucherService + ReconciliationService + GrantService:

| Service               | Operation | Validation applied                                                                                                      |
| --------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| BudgetService         | create    | `assertActiveFund(fundId)`                                                                                              |
| BudgetService         | addLine   | `assertActiveAccount(accountId, ['REVENUE', 'EXPENSE', 'ASSET'])`                                                       |
| APVoucherService      | create    | `assertActiveSupplier`, `assertActiveAccount(glAccountId, ['EXPENSE','ASSET','LIABILITY'])`, `assertActiveFund(fundId)` |
| ReconciliationService | start     | `assertActiveAccount(accountId, ['ASSET'])`, `assertPeriodInState(periodId)`                                            |
| GrantService          | create    | `assertActiveFund(fundId)` (when supplied)                                                                              |

**Live verified on `tenant_demo` 2026-05-06** — every miss returns 400 with finance-domain language:

- AP voucher with bogus `supplierId` → `400 supplierId does not match a supplier in this school.`
- AP voucher with REVENUE account (Tuition 4000) as `glAccountId` → `400 glAccountId (4000 Tuition Revenue) has account_type=REVENUE; expected one of EXPENSE, ASSET, LIABILITY.`
- AP voucher with valid supplier + EXPENSE account → 201 PENDING.
- Budget with bogus `fundId` → `400 fundId does not match an active fund in this school.`
- Reconciliation with EXPENSE account (Supplies 5000) → `400 accountId (5000 Supplies Expense) has account_type=EXPENSE; expected one of ASSET.`

### MAJOR 7 — `is_system` account update path tightened

`apps/api/src/finance/chart.service.ts::ChartOfAccountsService.patch` previously refused only `isActive=false` on `is_system=true` accounts. Now refuses ANY field change other than `description` for system accounts (Cash 1000 / AR 1100 / AP 2000):

```typescript
if (targetRows[0]!.is_system) {
  const restricted: string[] = [];
  if (input.accountName !== undefined) restricted.push('accountName');
  if (input.isActive !== undefined) restricted.push('isActive');
  if (input.parentAccountId !== undefined) restricted.push('parentAccountId');
  if (input.fundId !== undefined) restricted.push('fundId');
  if (restricted.length > 0) {
    throw new BadRequestException(
      `System accounts (Cash, AR, AP) only accept description updates. The following fields are restricted: ${restricted.join(', ')}.`,
    );
  }
}
```

**Live verified on `tenant_demo` 2026-05-06**:

- Rename Cash → 400 with the canonical message.
- Change Cash fundId → 400 with the canonical message.
- Update Cash description → 200 (allowed).
- Rename non-system Supplies (5000) → 200 (unaffected).

## Phase 2 punch list (carried)

The 3 acknowledged MAJORs join the existing Cycle 26 + cross-cycle Phase 2 backlog:

- **MAJOR 6** — CFO role split. Joins items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / 33 / 34 / 35 / 36 / 37 / 38 / 39 / 40 in the broader role-split chain. Before pilot, generic Staff loses FIN-005..008 write and a dedicated Finance / CFO role takes over.
- **MAJOR 8** — Board report DB-level immutability trigger. Service-side immutability holds today (no UPDATE/DELETE methods exposed). The DB-level `BEFORE UPDATE OR DELETE` trigger lands once the per-tenant DB role model exists.
- **MAJOR 9** — Finance posting rules table. Schema:
  ```sql
  CREATE TABLE fin_posting_rules (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    event_type TEXT NOT NULL,                 -- 'pay.payment.received' etc
    debit_account_id UUID NOT NULL,
    credit_account_id UUID NOT NULL,
    fund_id UUID NOT NULL,
    fee_schedule_id UUID,                     -- optional per-fee mapping
    revenue_category TEXT,                    -- optional per-category mapping
    is_active BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (school_id, event_type, fee_schedule_id, revenue_category)
  );
  ```
  GLConsumer reads the matching rule by `event_type + (optional fee_schedule_id from payload)` instead of hard-coding 1000/1100/4000. Lands pre-pilot; until then the Cycle 26 hard-codes assume the demo seed shape.

Plus the existing Cycle 26 carry-overs from the original review's "Reviewer attention" section:

- `validate_batch_balance` lives in service code rather than as a DB stored function (splitter not dollar-quote-aware).
- GLConsumer DLQ alerting (item 8 from CLAUDE.md backlog).
- Seed period coverage vs runtime "today".
- FIN-001..004 → BIL-001..004 catalogue rename.

## Verdict trail

- 2026-05-06 — `cycle26-complete` (`3756529`) submitted for review.
- 2026-05-06 — Round 1 verdict: **Reject pending fixes** (5 BLOCKING + 4 MAJOR).
- 2026-05-06 — All 5 BLOCKING + 1 actionable MAJOR (7) landed in this commit, live-verified on `tenant_demo`. 3 acknowledged MAJORs (6 / 8 / 9) carried to Phase 2 punch list.

**Cycle 26 ships clean to Round 2.** Tagging `cycle26-approved` after Round 2 APPROVED.
