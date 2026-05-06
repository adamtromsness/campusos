'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { useGrants } from '@/hooks/use-finance';
import {
  GRANT_STATUS_LABELS,
  GRANT_STATUS_PILL,
  formatCurrency,
  formatDate,
} from '@/lib/finance-format';

export default function GrantsPage() {
  const grantsQ = useGrants();
  const grants = grantsQ.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader title="Grants" description="External funding awards with drawdown tracking." />
      <Link href="/finance" className="text-sm text-campus-700 hover:underline">
        ← Back to finance
      </Link>

      <div className="space-y-3">
        {grants.map((g) => {
          const pct = g.awardAmount > 0 ? Math.round((g.drawnAmount / g.awardAmount) * 100) : 0;
          return (
            <div key={g.id} className="rounded-lg border border-gray-200 bg-white p-5">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">{g.grantName}</h3>
                  <p className="text-xs text-gray-500">
                    {g.grantor} {g.grantNumber && `· ${g.grantNumber}`} · {formatDate(g.startDate)}{' '}
                    → {formatDate(g.endDate)}
                  </p>
                  {g.fundCode && <p className="mt-1 text-xs text-gray-500">Fund: {g.fundCode}</p>}
                </div>
                <span
                  className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${GRANT_STATUS_PILL[g.status]}`}
                >
                  {GRANT_STATUS_LABELS[g.status]}
                </span>
              </div>
              <div className="mt-4">
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-gray-600">
                    {formatCurrency(g.drawnAmount)} drawn of {formatCurrency(g.awardAmount)}
                  </span>
                  <span className="font-medium text-gray-700">{pct}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full bg-emerald-500"
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  Remaining: {formatCurrency(g.remainingAmount)}
                </p>
              </div>
              {g.notes && <p className="mt-3 text-sm text-gray-700">{g.notes}</p>}
            </div>
          );
        })}
        {grants.length === 0 && <p className="text-sm text-gray-500">No grants tracked yet.</p>}
      </div>
    </div>
  );
}
