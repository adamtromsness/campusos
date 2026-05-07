'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui';
import { useRetentionPolicies } from '@/hooks/use-governance';
import { formatDate } from '@/lib/governance-format';

export default function RetentionPoliciesPage() {
  const [dueOnly, setDueOnly] = useState(false);
  const policies = useRetentionPolicies({ dueOnly });

  return (
    <div>
      <PageHeader
        title="Retention policies"
        description="Per-data-category retention windows + legal basis. Policies due for review surface as amber rows."
      />

      <div className="mb-4 flex items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={dueOnly}
            onChange={(e) => setDueOnly(e.target.checked)}
            className="rounded border-gray-300"
          />
          <span>Due for review only</span>
        </label>
        <Link href="/governance" className="ml-auto text-sm text-gray-500 hover:text-campus-700">
          ← Back to compliance dashboard
        </Link>
      </div>

      {policies.isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !policies.data || policies.data.length === 0 ? (
        <p className="text-sm text-gray-500">
          {dueOnly ? 'No policies due for review.' : 'No retention policies recorded yet.'}
        </p>
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600">
              <tr>
                <th className="px-4 py-2">Data category</th>
                <th className="px-4 py-2">Retention period</th>
                <th className="px-4 py-2">Legal basis</th>
                <th className="px-4 py-2">Review frequency</th>
                <th className="px-4 py-2">Next review</th>
              </tr>
            </thead>
            <tbody>
              {policies.data.map((p) => (
                <tr
                  key={p.id}
                  className={`border-b border-gray-100 last:border-0 ${
                    p.reviewDue ? 'bg-amber-50' : ''
                  }`}
                >
                  <td className="px-4 py-3">
                    <div className="font-semibold text-gray-900">{p.dataCategory}</div>
                    {p.linksToArchiveTier && (
                      <div className="mt-0.5 text-xs text-gray-500">
                        Archive: {p.linksToArchiveTier}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">{p.retentionPeriod}</td>
                  <td className="px-4 py-3 text-xs text-gray-600">{p.legalBasisForRetention}</td>
                  <td className="px-4 py-3 text-xs text-gray-700">{p.reviewFrequency}</td>
                  <td className="px-4 py-3 text-xs text-gray-700">
                    {formatDate(p.nextReviewDate)}
                    {p.reviewDue && (
                      <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                        Review due
                      </span>
                    )}
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
