'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { useReconciliations } from '@/hooks/use-finance';
import {
  RECON_STATUS_LABELS,
  RECON_STATUS_PILL,
  formatCurrency,
  formatDate,
} from '@/lib/finance-format';

export default function ReconciliationPage() {
  const recsQ = useReconciliations();
  const recs = recsQ.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Bank reconciliation"
        description="GL balance vs bank balance. Variances flagged automatically."
      />
      <Link href="/finance" className="text-sm text-campus-700 hover:underline">
        ← Back to finance
      </Link>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2 text-left">Account</th>
              <th className="px-4 py-2 text-left">Period</th>
              <th className="px-4 py-2 text-right">GL balance</th>
              <th className="px-4 py-2 text-right">Bank balance</th>
              <th className="px-4 py-2 text-right">Difference</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Reconciled</th>
            </tr>
          </thead>
          <tbody>
            {recs.map((r) => (
              <tr key={r.id} className="border-t border-gray-100">
                <td className="px-4 py-2 font-mono text-xs">
                  {r.accountCode} {r.accountName}
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">{r.periodName}</td>
                <td className="px-4 py-2 text-right font-mono">{formatCurrency(r.glBalance)}</td>
                <td className="px-4 py-2 text-right font-mono">{formatCurrency(r.bankBalance)}</td>
                <td className="px-4 py-2 text-right font-mono">
                  <span className={r.difference !== 0 ? 'text-rose-700' : 'text-emerald-700'}>
                    {formatCurrency(r.difference)}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <span
                    className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${RECON_STATUS_PILL[r.status]}`}
                  >
                    {RECON_STATUS_LABELS[r.status]}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">
                  {r.reconciledAt ? formatDate(r.reconciledAt) : '—'}
                </td>
              </tr>
            ))}
            {recs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-500">
                  No reconciliation runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-500">
        Start a reconciliation via <code>POST /api/v1/finance/reconciliation</code>. The service
        computes GL balance live and flags variance when GL ≠ bank. Outstanding items are tracked as
        JSONB notes.
      </p>
    </div>
  );
}
