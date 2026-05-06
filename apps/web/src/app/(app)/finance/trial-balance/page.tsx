'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { useTrialBalance } from '@/hooks/use-finance';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_PILL, formatCurrency } from '@/lib/finance-format';

export default function TrialBalancePage() {
  const tbQ = useTrialBalance();
  const tb = tbQ.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Trial balance"
        description="Sum of debits and credits across every account, all POSTED batches."
      />
      <Link href="/finance" className="text-sm text-campus-700 hover:underline">
        ← Back to finance
      </Link>

      {tb && (
        <div className="rounded-lg border border-gray-200 bg-white">
          <header className="flex items-center justify-between border-b border-gray-100 p-4">
            <div className="grid grid-cols-2 gap-x-8 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500">Total debits</div>
                <div className="font-mono text-lg font-semibold">
                  {formatCurrency(tb.totalDebit)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500">Total credits</div>
                <div className="font-mono text-lg font-semibold">
                  {formatCurrency(tb.totalCredit)}
                </div>
              </div>
            </div>
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${tb.balanced ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'}`}
            >
              {tb.balanced ? 'Balanced ✓' : 'Imbalanced ✗'}
            </span>
          </header>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">Code</th>
                <th className="px-4 py-2 text-left">Account</th>
                <th className="px-4 py-2 text-left">Type</th>
                <th className="px-4 py-2 text-right">Debit</th>
                <th className="px-4 py-2 text-right">Credit</th>
                <th className="px-4 py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {tb.lines.map((l) => (
                <tr key={l.accountId} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-mono text-xs">{l.accountCode}</td>
                  <td className="px-4 py-2">{l.accountName}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs ${ACCOUNT_TYPE_PILL[l.accountType]}`}
                    >
                      {ACCOUNT_TYPE_LABELS[l.accountType]}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {l.debitTotal > 0 ? formatCurrency(l.debitTotal) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {l.creditTotal > 0 ? formatCurrency(l.creditTotal) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono font-medium">
                    {formatCurrency(l.balance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
