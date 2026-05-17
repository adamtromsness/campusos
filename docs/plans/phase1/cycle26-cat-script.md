# Cycle 26 — Customer Acceptance Test (Step 10)

**Module:** M83 Finance & Accounting (Wave 6 opener).
**Verified live on:** `tenant_demo` 2026-05-06.
**Reproducibility:** every command in the script is shell-pasteable. Cleanup at the end restores `tenant_demo` to the post-Step-4 seed shape.

## Schema preamble

10 checks confirming the tenant schema landed correctly:

```sh
# Check 1 — 14 fin_* tables present
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='tenant_demo' AND table_name LIKE 'fin_%'"
# Expect: 14

# Check 2 — list every table by name
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT table_name FROM information_schema.tables WHERE table_schema='tenant_demo' AND table_name LIKE 'fin_%' ORDER BY table_name"
# Expect: fin_accounting_periods, fin_ap_payments, fin_ap_vouchers, fin_board_report_snapshots,
#         fin_budget_lines, fin_budgets, fin_chart_of_accounts, fin_funds, fin_gl_entries,
#         fin_grants, fin_journal_batches, fin_reconciliation_runs, fin_supplier_contacts, fin_suppliers

# Check 3 — FK delete actions per Cycle 26 plan: NO ACTION on financial-audit
#           edges (chart, funds, periods, suppliers); CASCADE on subordinate
#           audit (gl_entries to batch, supplier_contacts to supplier,
#           budget_lines to budget, ap_payments to voucher).
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT cl.relname AS tbl, conname, confdeltype FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='tenant_demo' AND cl.relname LIKE 'fin_%' AND contype='f' ORDER BY cl.relname, conname"
# Expect 13 rows. CASCADE marker 'c' on:
#   fin_ap_payments_voucher_fk, fin_gl_batch_fk, fin_supplier_contacts_supplier_fk, fin_budget_lines_budget_fk
# NO ACTION 'a' on:
#   fin_accounts_fund_fk, fin_accounts_parent_fk, fin_ap_account_fk, fin_ap_fund_fk, fin_ap_supplier_fk,
#   fin_ap_payments_batch_fk, fin_batches_period_fk, fin_budget_lines_account_fk,
#   fin_gl_account_fk, fin_gl_fund_fk, fin_grants_fund_fk, fin_recon_account_fk, fin_recon_period_fk,
#   fin_budgets_fund_fk

# Check 4 — partial UNIQUE source_event_id (Kafka idempotency)
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='tenant_demo' AND indexname='fin_batches_source_event_uq'"
# Expect: indexdef contains 'WHERE (source_event_id IS NOT NULL)'

# Check 5 — IAM grants for Staff: FIN-005..008 read+write
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT p.code FROM platform.role_permission rp JOIN platform.roles r ON r.id=rp.role_id JOIN platform.permissions p ON p.id=rp.permission_id WHERE r.name='Staff' AND p.code LIKE 'fin-00%' ORDER BY p.code"
# Expect: fin-005:read, fin-005:write, fin-006:read, fin-006:write,
#         fin-007:read, fin-007:write, fin-008:read, fin-008:write

# Check 6 — School Admin holds admin tier on FIN-005..008
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT p.code FROM platform.role_permission rp JOIN platform.roles r ON r.id=rp.role_id JOIN platform.permissions p ON p.id=rp.permission_id WHERE r.name='School Admin' AND p.code LIKE 'fin-00%:admin' ORDER BY p.code"
# Expect: fin-005:admin, fin-006:admin, fin-007:admin, fin-008:admin

# Check 7 — Step 4 seed shape: 3 funds, 15 accounts, 12 periods (1 LOCKED + 2 CLOSED + 7 OPEN + 2 FUTURE),
#           2 POSTED batches with 4 balanced GL entries
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT 'funds' AS k, count(*) FROM tenant_demo.fin_funds UNION ALL SELECT 'accounts', count(*) FROM tenant_demo.fin_chart_of_accounts UNION ALL SELECT 'periods', count(*) FROM tenant_demo.fin_accounting_periods UNION ALL SELECT 'batches_posted', count(*) FROM tenant_demo.fin_journal_batches WHERE status='POSTED' UNION ALL SELECT 'gl_entries', count(*) FROM tenant_demo.fin_gl_entries UNION ALL SELECT 'budget_lines', count(*) FROM tenant_demo.fin_budget_lines UNION ALL SELECT 'ap_vouchers', count(*) FROM tenant_demo.fin_ap_vouchers UNION ALL SELECT 'recons', count(*) FROM tenant_demo.fin_reconciliation_runs UNION ALL SELECT 'board_reports', count(*) FROM tenant_demo.fin_board_report_snapshots UNION ALL SELECT 'grants', count(*) FROM tenant_demo.fin_grants ORDER BY 1"
# Expect: accounts=15, ap_vouchers=1, batches_posted=2, board_reports=1, budget_lines=10,
#         funds=3, gl_entries=4, grants=1, periods=12, recons=1

# Check 8 — both seeded batches are balanced
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT b.batch_number, b.status, SUM(e.debit) AS total_debit, SUM(e.credit) AS total_credit FROM tenant_demo.fin_journal_batches b JOIN tenant_demo.fin_gl_entries e ON e.batch_id=b.id GROUP BY b.id, b.batch_number, b.status ORDER BY b.batch_number"
# Expect: JB-2025-001 POSTED 3500/3500, JB-2025-002 POSTED 1200/1200

# Check 9 — Cash account + 1000 system flag
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT account_code, account_name, account_type, normal_balance, is_system FROM tenant_demo.fin_chart_of_accounts WHERE is_system=true ORDER BY account_code"
# Expect: 1000 Cash ASSET DEBIT t, 1100 Accounts Receivable ASSET DEBIT t, 2000 Accounts Payable LIABILITY CREDIT t

# Check 10 — July 2025 is LOCKED
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "SELECT period_name, status, locked_at IS NOT NULL AS is_locked, locked_by IS NOT NULL AS has_locker FROM tenant_demo.fin_accounting_periods WHERE period_number=1 AND fiscal_year='FY2025-2026'"
# Expect: July 2025 LOCKED t t
```

## Token helper

```sh
get_token() {
  curl -sS -X POST http://localhost:4000/api/v1/auth/dev-login \
    -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" \
    -d "{\"email\":\"$1\"}" | python3 -c "import sys, json; print(json.load(sys.stdin)['accessToken'])"
}
ADMIN=$(get_token "principal@demo.campusos.dev")
TEACHER=$(get_token "teacher@demo.campusos.dev")
PARENT=$(get_token "parent@demo.campusos.dev")
STUDENT=$(get_token "student@demo.campusos.dev")
COUNSELLOR=$(get_token "counsellor@demo.campusos.dev")  # Staff role
H="X-Tenant-Subdomain: demo"
```

## Plan scenarios (verified live 2026-05-06)

### S1 — Chart of accounts + funds + hierarchy

```sh
curl -sS -H "Authorization: Bearer $ADMIN" -H "$H" \
  http://localhost:4000/api/v1/finance/funds | jq '. | length'   # → 3
curl -sS -H "Authorization: Bearer $ADMIN" -H "$H" \
  http://localhost:4000/api/v1/finance/accounts | jq '. | length' # → 15
# is_system protection — admin attempts to deactivate Cash:
ACCT_1000=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA \
  -c "SELECT id FROM tenant_demo.fin_chart_of_accounts WHERE account_code='1000'")
curl -sS -X PATCH -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -H "$H" \
  http://localhost:4000/api/v1/finance/accounts/$ACCT_1000 \
  -d '{"isActive":false}' | jq -r '.message'
# → "System accounts (Cash, AR, AP) cannot be deactivated…"
```

### S2 — Period lifecycle (FUTURE → OPEN → CLOSED → LOCKED is permanent)

```sh
PERIOD_5=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA \
  -c "SELECT id FROM tenant_demo.fin_accounting_periods WHERE period_number=5 AND fiscal_year='FY2025-2026'")
PERIOD_1=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA \
  -c "SELECT id FROM tenant_demo.fin_accounting_periods WHERE period_number=1 AND fiscal_year='FY2025-2026'")
# Period 5 (Nov 2025) is OPEN; admin closes it
curl -sS -X PATCH -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -H "$H" \
  http://localhost:4000/api/v1/finance/periods/$PERIOD_5/status -d '{"status":"CLOSED"}' \
  | jq -r '"\(.periodName) \(.status) closedBy=\(.closedBy)"'
# → "November 2025 CLOSED closedBy=<employee uuid>"

# July 2025 is LOCKED — attempt to revert (irreversible)
curl -sS -X PATCH -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -H "$H" \
  http://localhost:4000/api/v1/finance/periods/$PERIOD_1/status -d '{"status":"OPEN"}' \
  | jq -r '.message'
# → "LOCKED periods are permanent and cannot transition to any other status…"

# restore Nov 2025 to OPEN for downstream scenarios
curl -sS -X PATCH -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -H "$H" \
  http://localhost:4000/api/v1/finance/periods/$PERIOD_5/status -d '{"status":"OPEN"}' >/dev/null
```

### S3 — Manual GL posting + balance validation (KEYSTONE)

```sh
SUPPLIES=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA \
  -c "SELECT id FROM tenant_demo.fin_chart_of_accounts WHERE account_code='5000'")
CASH=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA \
  -c "SELECT id FROM tenant_demo.fin_chart_of_accounts WHERE account_code='1000'")
FUND=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA \
  -c "SELECT id FROM tenant_demo.fin_funds WHERE fund_code='GENERAL'")
OCT=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA \
  -c "SELECT id FROM tenant_demo.fin_accounting_periods WHERE period_number=4 AND fiscal_year='FY2025-2026'")

# Create DRAFT batch (balanced)
DRAFT=$(curl -sS -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -H "$H" \
  http://localhost:4000/api/v1/finance/journal-batches \
  -d "{\"batchNumber\":\"K1-MANUAL-$(date +%s)\",\"description\":\"K1 manual smoke\",\"batchType\":\"MANUAL\",\"accountingPeriodId\":\"$OCT\",\"entries\":[{\"accountId\":\"$SUPPLIES\",\"fundId\":\"$FUND\",\"debit\":500,\"credit\":0,\"description\":\"Supplies\"},{\"accountId\":\"$CASH\",\"fundId\":\"$FUND\",\"debit\":0,\"credit\":500,\"description\":\"Cash\"}]}" | jq -r '.id')

# POST it — keystone balance validation runs inside same tx as status flip
curl -sS -X POST -H "Authorization: Bearer $ADMIN" -H "$H" \
  http://localhost:4000/api/v1/finance/journal-batches/$DRAFT/post \
  | jq -r '"status=\(.status) dr=\(.totalDebit) cr=\(.totalCredit) postedBy=\(.postedByName)"'
# → "status=POSTED dr=500 cr=500 postedBy=Sarah Mitchell"

# Attempt unbalanced batch — pre-flight rejects 400
curl -sS -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -H "$H" \
  -o /dev/null -w "HTTP %{http_code}\n" \
  http://localhost:4000/api/v1/finance/journal-batches \
  -d "{\"batchNumber\":\"K3-BAD-$(date +%s)\",\"description\":\"unbalanced\",\"batchType\":\"MANUAL\",\"accountingPeriodId\":\"$OCT\",\"entries\":[{\"accountId\":\"$SUPPLIES\",\"fundId\":\"$FUND\",\"debit\":500,\"credit\":0},{\"accountId\":\"$CASH\",\"fundId\":\"$FUND\",\"debit\":0,\"credit\":400}]}"
# → HTTP 400
```

### S4 — Period LOCK refuses posting

```sh
LOCKED_DRAFT=$(curl -sS -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -H "$H" \
  http://localhost:4000/api/v1/finance/journal-batches \
  -d "{\"batchNumber\":\"K4-LOCKED-$(date +%s)\",\"description\":\"locked test\",\"batchType\":\"MANUAL\",\"accountingPeriodId\":\"$PERIOD_1\",\"entries\":[{\"accountId\":\"$SUPPLIES\",\"fundId\":\"$FUND\",\"debit\":10,\"credit\":0},{\"accountId\":\"$CASH\",\"fundId\":\"$FUND\",\"debit\":0,\"credit\":10}]}" | jq -r '.id')

curl -sS -X POST -H "Authorization: Bearer $ADMIN" -H "$H" \
  http://localhost:4000/api/v1/finance/journal-batches/$LOCKED_DRAFT/post \
  | jq -r '.message'
# → "Cannot post to a LOCKED period. Reopen the period or create a batch against an OPEN period."
```

### S5 — KAFKA GL CONSUMER (cross-cycle keystone with Cycle 6)

Requires `dev.pay.*` topics pre-created on the broker (Kafka auto-create race documented in `CLAUDE.md`):

```sh
for t in payment.received invoice.created refund.issued credit_note.issued debt.written_off; do
  docker exec campusos-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
    --create --if-not-exists --topic "dev.pay.$t" --partitions 1 --replication-factor 1
done
```

The seeded periods cover 2025-07 → 2026-06 with May 2026 in FUTURE. For the live demo where today is 2026-05-06, open May 2026 first so an OPEN period covers today:

```sh
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "UPDATE tenant_demo.fin_accounting_periods SET status='OPEN' WHERE period_number=11 AND fiscal_year='FY2025-2026'"
```

Drive the keystone:

```sh
INV=$(curl -sS -H "Authorization: Bearer $PARENT" -H "$H" \
  http://localhost:4000/api/v1/invoices | python3 -c "import sys, json; print([x['id'] for x in json.load(sys.stdin) if x['balanceDue'] > 0][0])")

# Parent pays $30 — Cycle 6 emits pay.payment.received → GLConsumer auto-posts
curl -sS -X POST -H "Authorization: Bearer $PARENT" -H "Content-Type: application/json" -H "$H" \
  http://localhost:4000/api/v1/invoices/$INV/pay -d '{"amount":30,"paymentMethod":"CARD"}' \
  | jq -r '"paymentId=\(.id[0:8]) status=\(.status) amount=\(.amount)"'
# → "paymentId=019dff45 status=COMPLETED amount=30"

sleep 5

# Inspect the auto-posted batch
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT b.batch_number, b.batch_type, b.status, b.source_module, e.total_debit, e.total_credit FROM tenant_demo.fin_journal_batches b JOIN (SELECT batch_id, SUM(debit) AS total_debit, SUM(credit) AS total_credit FROM tenant_demo.fin_gl_entries GROUP BY batch_id) e ON e.batch_id = b.id WHERE b.source_module = 'payments' ORDER BY b.created_at DESC LIMIT 1"
# Expect: AUTO-019DFF45  AUTO_PAYMENT  POSTED  payments  30.00  30.00

# Verify GLConsumer log line
grep "GLConsumer.*posted batch" /tmp/api.log | tail -1
# Expect: "[gl-consumer] posted batch AUTO-019DFF45 (019dff45) from pay.payment.received eventId=019dff45"
```

### S6 — Trial balance after the keystone

```sh
curl -sS -H "Authorization: Bearer $ADMIN" -H "$H" \
  http://localhost:4000/api/v1/finance/trial-balance \
  | jq -r '"totalDebit=\(.totalDebit) totalCredit=\(.totalCredit) balanced=\(.balanced)"'
# Seeded 4700/4700 + S3 manual 500 + S5 auto 30 = 5230/5230 balanced=true
```

### S7 — Budget variance reflects the manual posting

```sh
curl -sS -H "Authorization: Bearer $ADMIN" -H "$H" \
  http://localhost:4000/api/v1/finance/budgets?fiscalYear=FY2025-2026 \
  | jq '.[0].lines[] | select(.accountCode=="5000") | {accountCode, budgeted: .budgetedAmount, actual: .actualAmount, remaining: .remainingAmount}'
# Expect actual to have moved by +$500 from the seed baseline
# (PostingService.post updates fin_budget_lines.actual_amount inside the same tx).
```

### S8 — AP voucher lifecycle + GL post

```sh
# Resolve seed AP voucher
VOUCHER=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA \
  -c "SELECT id FROM tenant_demo.fin_ap_vouchers LIMIT 1")
# Already PAID per seed — list payments to confirm the GL link
curl -sS -H "Authorization: Bearer $ADMIN" -H "$H" \
  http://localhost:4000/api/v1/finance/ap-vouchers/$VOUCHER/payments \
  | jq '.[] | {paymentMethod, amount, journalBatchId, paidByName}'
# Expect: CHECK 1200 <batchId> Sarah Mitchell
```

### S9 — Bank reconciliation

```sh
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT account_id, period_id, gl_balance, bank_balance, difference, status FROM tenant_demo.fin_reconciliation_runs"
# Expect: 125000 / 124850 / 150 / VARIANCE_FLAGGED (October Cash, outstanding check)
```

### S10 — Visibility / 6 permission denial paths

```sh
# Parent + student + teacher all 403 on every finance endpoint
for u in PARENT STUDENT TEACHER; do
  TOK=$(eval echo \$$u)
  for p in /finance/funds /finance/accounts /finance/journal-batches /finance/budgets \
           /finance/ap-vouchers /finance/board-reports; do
    echo -n "$u $p: "
    curl -sS -o /dev/null -w "HTTP %{http_code}\n" -H "Authorization: Bearer $TOK" -H "$H" \
      http://localhost:4000/api/v1$p
  done
done
# Expect: every line HTTP 403

# Counsellor (Staff role) holds FIN-005..008 read+write
curl -sS -o /dev/null -w "HTTP %{http_code}\n" -H "Authorization: Bearer $COUNSELLOR" -H "$H" \
  http://localhost:4000/api/v1/finance/funds
# Expect: HTTP 200
```

## Cleanup

```sh
docker exec campusos-postgres psql -U campusos -d campusos_dev <<SQL
DELETE FROM tenant_demo.fin_journal_batches WHERE batch_number LIKE 'K%' OR batch_number LIKE 'AUTO-%';
UPDATE tenant_demo.fin_accounting_periods SET status='FUTURE', closed_at=NULL, closed_by=NULL WHERE period_number=11 AND fiscal_year='FY2025-2026';
UPDATE tenant_demo.fin_accounting_periods SET status='OPEN', closed_at=NULL, closed_by=NULL WHERE period_number=5 AND fiscal_year='FY2025-2026';
SELECT count(*) AS batches_after_cleanup FROM tenant_demo.fin_journal_batches;
SQL
# Expect batches_after_cleanup = 2 (back to seed shape)
```

## Reviewer attention (non-blocking, deferred)

- **MAJOR — `validate_batch_balance` lives in the service layer, not as a DB stored function.** The plan called for an ADR-059 PL/pgSQL stored procedure. The naive `provision-tenant.ts` splitter splits on every `;`-character without understanding dollar-quoting, so a CREATE FUNCTION block whose body contains statement terminators would be cut mid-body. The validation runs in `PostingService` inside the same `executeInTenantTransaction` callback as the status flip — the integrity guarantee (whole-tx rollback on imbalance) is identical. Pre-pilot work: extend the splitter to be dollar-quote-aware, then move the validation back into a DB function for defence in depth.

- **MAJOR — GLConsumer error path lacks DLQ alerting.** Posting failures (e.g. "Target period not found" when no OPEN period covers today) currently park the message into `platform.platform_dlq_messages` via the standard consumer retry/park pattern, but no operator alert fires. Joins the broader DLQ-row dashboard work on the Phase 2 punch list (item 8 from CLAUDE.md).

- **MAJOR — CFO role split.** Cycle 26 grants `FIN-005..008:read+write` to the generic Staff role as a CFO stand-in. Joins items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / 33 / 34 / 35 / 36 / 37 / 38 / 39 / 40 in the broader role-split work for a dedicated CFO role before pilot.

- **MAJOR — Seed period coverage vs runtime "today".** The Cycle 26 seed sets May 2026 as FUTURE because the standard fiscal-year template ships unopened. In a dev environment where today is 2026-05-06, the GLConsumer needs an OPEN period covering today, so May 2026 must be opened manually before automated postings can land. Pre-pilot fix: an opening-the-current-period nightly cron OR a service-side fallback to "most recent OPEN period if none covers today."

- **MAJOR — Dual finance permission families.** `FIN-001..004` ship from Wave 1 as the M84 Family Billing codes (Cycle 6 grants `FIN-001:read+write` to parents). Cycle 26 ships new `FIN-005..008` for the M83 General Ledger surface so the GL is invisible to parents at the gate. The naming overlap is awkward — pre-pilot rename to `BIL-001..004` (Family Billing) and `FIN-001..004` (Finance & Accounting) is the cleaner long-term layout. Joins the PUB-003 catalogue rename punch list from Cycle 25.

## Verdict gate

Cycle 26 ships all 14 fin\_\* tables, the `validateBatchBalance` keystone (in service layer per the migration trade-off note), the GLConsumer cross-cycle integration with Cycle 6, the period LOCK invariant, balanced batches via DB CHECK + service validation, and the full Finance UI tile + 10 routes. **Wave 6 (Finance & Commerce) opens here.** Tagging `cycle26-complete` after the closeout commit; `cycle26-approved` after the post-cycle review verdict.
