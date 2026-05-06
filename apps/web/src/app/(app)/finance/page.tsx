'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useAccounts,
  useBudgets,
  useJournalBatches,
  usePeriods,
  useReconciliations,
  useTrialBalance,
} from '@/hooks/use-finance';
import {
  formatCurrency,
  PERIOD_STATUS_LABELS,
  PERIOD_STATUS_PILL,
  RECON_STATUS_LABELS,
  RECON_STATUS_PILL,
} from '@/lib/finance-format';

export default function FinanceDashboardPage() {
  const { user } = useAuthStore();
  const canRead = hasAnyPermission(user, ['fin-005:read']);
  const accountsQ = useAccounts();
  const periodsQ = usePeriods('FY2025-2026');
  const tbQ = useTrialBalance();
  const batchesQ = useJournalBatches();
  const budgetsQ = useBudgets('FY2025-2026');
  const recsQ = useReconciliations();

  if (!canRead) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <PageHeader title="Finance" />
        <p className="text-sm text-gray-600">You don&apos;t have access to the finance module.</p>
      </div>
    );
  }

  const accounts = accountsQ.data ?? [];
  const periods = periodsQ.data ?? [];
  const tb = tbQ.data;
  const batches = batchesQ.data ?? [];
  const budgets = budgetsQ.data ?? [];
  const recs = recsQ.data ?? [];

  const cash = accounts.find((a) => a.accountCode === '1000');
  const openPeriods = periods.filter((p) => p.status === 'OPEN').length;
  const totalBudget = budgets.reduce((s, b) => s + b.totalRevenue, 0);
  const flaggedRecs = recs.filter((r) => r.status === 'VARIANCE_FLAGGED').length;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Finance"
        description="General ledger, chart of accounts, periods, budgets, AP, reconciliation, and board reports."
      />

      {/* Stat cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard
          label="Cash balance"
          value={formatCurrency(cash?.runningBalance ?? 0)}
          tone="emerald"
        />
        <StatCard label="Open periods" value={String(openPeriods)} tone="sky" />
        <StatCard label="Approved budget" value={formatCurrency(totalBudget)} tone="violet" />
        <StatCard
          label="Variance reconciliations"
          value={String(flaggedRecs)}
          tone={flaggedRecs > 0 ? 'rose' : 'gray'}
        />
      </div>

      {/* Quick nav */}
      <div className="flex flex-wrap gap-2 border-b border-gray-200 pb-4">
        <NavChip href="/finance/accounts">Chart of accounts</NavChip>
        <NavChip href="/finance/journals">GL journals</NavChip>
        <NavChip href="/finance/trial-balance">Trial balance</NavChip>
        <NavChip href="/finance/periods">Periods</NavChip>
        <NavChip href="/finance/budgets">Budgets</NavChip>
        <NavChip href="/finance/ap">Accounts payable</NavChip>
        <NavChip href="/finance/reconciliation">Reconciliation</NavChip>
        <NavChip href="/finance/board-reports">Board reports</NavChip>
        <NavChip href="/finance/grants">Grants</NavChip>
      </div>

      {/* Trial balance summary */}
      {tb && (
        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Trial balance summary</h3>
              <p className="text-xs text-gray-500">Across all POSTED batches.</p>
            </div>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tb.balanced ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'}`}
            >
              {tb.balanced ? 'Balanced' : 'Imbalanced'}
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500">Total debits</div>
              <div className="text-lg font-semibold text-gray-900">
                {formatCurrency(tb.totalDebit)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500">Total credits</div>
              <div className="text-lg font-semibold text-gray-900">
                {formatCurrency(tb.totalCredit)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Periods status */}
      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <h3 className="mb-3 text-sm font-semibold text-gray-900">Period status — FY2025-2026</h3>
        <div className="flex flex-wrap gap-2">
          {periods.map((p) => (
            <span
              key={p.id}
              className={`inline-flex items-center rounded px-2 py-1 text-xs font-medium ${PERIOD_STATUS_PILL[p.status]}`}
              title={`${p.startDate} → ${p.endDate}`}
            >
              {p.periodName}: {PERIOD_STATUS_LABELS[p.status]}
            </span>
          ))}
        </div>
      </div>

      {/* Recent batches */}
      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Recent journal batches</h3>
          <Link href="/finance/journals" className="text-sm text-campus-700 hover:underline">
            See all →
          </Link>
        </div>
        {batches.length === 0 ? (
          <p className="text-sm text-gray-500">No batches yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {batches.slice(0, 8).map((b) => (
              <li
                key={b.id}
                className="flex items-center justify-between border-b border-gray-100 pb-2 last:border-b-0"
              >
                <span>
                  <Link
                    href={`/finance/journals?batchId=${b.id}`}
                    className="font-medium text-campus-700 hover:underline"
                  >
                    {b.batchNumber}
                  </Link>{' '}
                  · <span className="text-gray-600">{b.description}</span>
                </span>
                <span className="text-gray-700">{formatCurrency(b.totalDebit)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Reconciliation alerts */}
      {flaggedRecs > 0 && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-5">
          <h3 className="mb-3 text-sm font-semibold text-rose-800">Reconciliation variances</h3>
          <ul className="space-y-2 text-sm">
            {recs
              .filter((r) => r.status === 'VARIANCE_FLAGGED')
              .map((r) => (
                <li key={r.id} className="flex items-center justify-between">
                  <span className="text-rose-900">
                    {r.accountCode} {r.accountName} · {r.periodName}
                  </span>
                  <span
                    className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${RECON_STATUS_PILL[r.status]}`}
                  >
                    {RECON_STATUS_LABELS[r.status]} · {formatCurrency(r.difference)}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'emerald' | 'sky' | 'violet' | 'rose' | 'gray';
}) {
  const tones: Record<typeof tone, string> = {
    emerald: 'border-emerald-200 bg-emerald-50',
    sky: 'border-sky-200 bg-sky-50',
    violet: 'border-violet-200 bg-violet-50',
    rose: 'border-rose-200 bg-rose-50',
    gray: 'border-gray-200 bg-gray-50',
  };
  return (
    <div className={`rounded-lg border p-4 ${tones[tone]}`}>
      <div className="text-xs uppercase tracking-wide text-gray-600">{label}</div>
      <div className="mt-1 text-xl font-semibold text-gray-900">{value}</div>
    </div>
  );
}

function NavChip({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center rounded-md bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200 hover:text-campus-700"
    >
      {children}
    </Link>
  );
}
