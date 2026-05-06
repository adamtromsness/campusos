'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { useBudgets } from '@/hooks/use-finance';
import {
  BUDGET_STATUS_LABELS,
  BUDGET_STATUS_PILL,
  formatCurrency,
  variancePct,
} from '@/lib/finance-format';

export default function BudgetsPage() {
  const budgetsQ = useBudgets('FY2025-2026');
  const budgets = budgetsQ.data ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader title="Budgets" description="Budget vs actual variance per fund and account." />
      <Link href="/finance" className="text-sm text-campus-700 hover:underline">
        ← Back to finance
      </Link>

      {budgets.map((b) => (
        <section key={b.id} className="rounded-lg border border-gray-200 bg-white">
          <header className="flex items-center justify-between border-b border-gray-100 p-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">{b.name}</h3>
              <p className="text-xs text-gray-500">
                {b.fundCode} · {b.fiscalYear} · revenue {formatCurrency(b.totalRevenue)} · expense{' '}
                {formatCurrency(b.totalExpense)}
              </p>
            </div>
            <span
              className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${BUDGET_STATUS_PILL[b.status]}`}
            >
              {BUDGET_STATUS_LABELS[b.status]}
            </span>
          </header>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">Account</th>
                <th className="px-4 py-2 text-right">Budgeted</th>
                <th className="px-4 py-2 text-right">Actual</th>
                <th className="px-4 py-2 text-right">Encumbered</th>
                <th className="px-4 py-2 text-right">Remaining</th>
                <th className="px-4 py-2 text-right">% used</th>
              </tr>
            </thead>
            <tbody>
              {b.lines.map((l) => {
                const pct = variancePct(l.budgetedAmount, l.actualAmount + l.encumberedAmount);
                const tone =
                  pct > 100
                    ? 'text-rose-700 bg-rose-50'
                    : pct > 90
                      ? 'text-amber-800 bg-amber-50'
                      : 'text-gray-700';
                return (
                  <tr key={l.id} className="border-t border-gray-100">
                    <td className="px-4 py-2 font-mono text-xs">
                      {l.accountCode} {l.accountName}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">
                      {formatCurrency(l.budgetedAmount)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">
                      {formatCurrency(l.actualAmount)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">
                      {formatCurrency(l.encumberedAmount)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">
                      {formatCurrency(l.remainingAmount)}
                    </td>
                    <td className={`px-4 py-2 text-right font-mono ${tone}`}>{pct.toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}

      {budgets.length === 0 && (
        <p className="text-sm text-gray-500">No approved budgets for this fiscal year.</p>
      )}
    </div>
  );
}
