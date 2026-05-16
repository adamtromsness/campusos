/* P2-H2 - Tenant schema drift fixes plus DB-level IMMUTABLE triggers.
 *
 * Step 1.2 - fin_gl_entries gains period_start DATE NOT NULL with a
 *   default backfilled from created_at. Anchors the future ANNUAL
 *   RANGE partitioning Phase 3 ops will land once the table grows
 *   past 50M rows.
 *
 * Step 3 - DB-level IMMUTABLE triggers on the 12 tables documented
 *   by ADR-010. The shared raise_immutable_violation function lives
 *   in public schema. Platform Prisma migration creates it. Each
 *   tenant attaches a BEFORE UPDATE OR DELETE trigger per table
 *   calling that function. ON UPDATE or ON DELETE attempts raise
 *   SQLSTATE 23001 with a clear message.
 *
 *   pay_ledger_entries is monthly RANGE-partitioned. Postgres 11+
 *   propagates BEFORE ROW triggers on declarative partitioned tables
 *   to every existing AND future leaf via the partition-of mechanism,
 *   so attaching to the parent is sufficient.
 */

ALTER TABLE fin_gl_entries ADD COLUMN IF NOT EXISTS period_start DATE NOT NULL DEFAULT CURRENT_DATE;

UPDATE fin_gl_entries SET period_start = (created_at AT TIME ZONE 'UTC')::date WHERE period_start = CURRENT_DATE AND created_at IS NOT NULL AND (created_at AT TIME ZONE 'UTC')::date <> CURRENT_DATE;

CREATE INDEX IF NOT EXISTS fin_gl_entries_period_start_idx ON fin_gl_entries (period_start);

COMMENT ON COLUMN fin_gl_entries.period_start IS 'P2-H2 Step 1.2 - first day of the fiscal period this entry posts against. Anchors future ANNUAL RANGE partitioning per ADR-059 FIX 1.';

DROP TRIGGER IF EXISTS prevent_mutation ON fin_gl_entries;
CREATE TRIGGER prevent_mutation BEFORE UPDATE OR DELETE ON fin_gl_entries FOR EACH ROW EXECUTE FUNCTION public.raise_immutable_violation();

DROP TRIGGER IF EXISTS prevent_mutation ON pay_credit_notes;
CREATE TRIGGER prevent_mutation BEFORE UPDATE OR DELETE ON pay_credit_notes FOR EACH ROW EXECUTE FUNCTION public.raise_immutable_violation();

DROP TRIGGER IF EXISTS prevent_mutation ON pay_payment_reversals;
CREATE TRIGGER prevent_mutation BEFORE UPDATE OR DELETE ON pay_payment_reversals FOR EACH ROW EXECUTE FUNCTION public.raise_immutable_violation();

DROP TRIGGER IF EXISTS prevent_mutation ON pay_lunch_account_balance_transfers;
CREATE TRIGGER prevent_mutation BEFORE UPDATE OR DELETE ON pay_lunch_account_balance_transfers FOR EACH ROW EXECUTE FUNCTION public.raise_immutable_violation();

DROP TRIGGER IF EXISTS prevent_mutation ON pay_ledger_entries;
CREATE TRIGGER prevent_mutation BEFORE UPDATE OR DELETE ON pay_ledger_entries FOR EACH ROW EXECUTE FUNCTION public.raise_immutable_violation();

DROP TRIGGER IF EXISTS prevent_mutation ON fds_inventory_transactions;
CREATE TRIGGER prevent_mutation BEFORE UPDATE OR DELETE ON fds_inventory_transactions FOR EACH ROW EXECUTE FUNCTION public.raise_immutable_violation();

DROP TRIGGER IF EXISTS prevent_mutation ON pub_publication_versions;
CREATE TRIGGER prevent_mutation BEFORE UPDATE OR DELETE ON pub_publication_versions FOR EACH ROW EXECUTE FUNCTION public.raise_immutable_violation();

DROP TRIGGER IF EXISTS prevent_mutation ON svc_referral_activity;
CREATE TRIGGER prevent_mutation BEFORE UPDATE OR DELETE ON svc_referral_activity FOR EACH ROW EXECUTE FUNCTION public.raise_immutable_violation();

DROP TRIGGER IF EXISTS prevent_mutation ON tkt_ticket_activity;
CREATE TRIGGER prevent_mutation BEFORE UPDATE OR DELETE ON tkt_ticket_activity FOR EACH ROW EXECUTE FUNCTION public.raise_immutable_violation();

DROP TRIGGER IF EXISTS prevent_mutation ON hlth_health_access_log;
CREATE TRIGGER prevent_mutation BEFORE UPDATE OR DELETE ON hlth_health_access_log FOR EACH ROW EXECUTE FUNCTION public.raise_immutable_violation();

DROP TRIGGER IF EXISTS prevent_mutation ON inc_incident_timeline;
CREATE TRIGGER prevent_mutation BEFORE UPDATE OR DELETE ON inc_incident_timeline FOR EACH ROW EXECUTE FUNCTION public.raise_immutable_violation();

DROP TRIGGER IF EXISTS prevent_mutation ON dpo_pseudonymisation_log;
CREATE TRIGGER prevent_mutation BEFORE UPDATE OR DELETE ON dpo_pseudonymisation_log FOR EACH ROW EXECUTE FUNCTION public.raise_immutable_violation();
