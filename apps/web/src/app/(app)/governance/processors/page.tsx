'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui';
import { useProcessors } from '@/hooks/use-governance';
import {
  DPA_STATUS_LABELS,
  DPA_STATUS_PILL,
  PROCESSOR_TYPE_LABELS,
  TRANSFER_MECHANISM_LABELS,
  formatDate,
} from '@/lib/governance-format';

export default function ProcessorsPage() {
  const [gapsOnly, setGapsOnly] = useState(false);
  const processors = useProcessors({ gapsOnly });

  return (
    <div>
      <PageHeader
        title="Third-party processors & DPAs"
        description="Article 28 processor register. Each processor must have an active DPA. Rows with no DPA or expired status surface in red."
      />

      <div className="mb-4 flex items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={gapsOnly}
            onChange={(e) => setGapsOnly(e.target.checked)}
            className="rounded border-gray-300"
          />
          <span>DPA gaps only</span>
        </label>
        <Link href="/governance" className="ml-auto text-sm text-gray-500 hover:text-campus-700">
          ← Back to compliance dashboard
        </Link>
      </div>

      {processors.isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !processors.data || processors.data.length === 0 ? (
        <p className="text-sm text-gray-500">
          {gapsOnly
            ? 'No DPA gaps — every processor has an active DPA.'
            : 'No processors recorded yet.'}
        </p>
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600">
              <tr>
                <th className="px-4 py-2">Processor</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Country</th>
                <th className="px-4 py-2">Transfer mechanism</th>
                <th className="px-4 py-2">DPA status</th>
                <th className="px-4 py-2">Next review</th>
              </tr>
            </thead>
            <tbody>
              {processors.data.map((p) => (
                <tr
                  key={p.id}
                  className={`border-b border-gray-100 last:border-0 ${
                    p.hasDpaGap ? 'bg-rose-50' : ''
                  }`}
                >
                  <td className="px-4 py-3">
                    <div className="font-semibold text-gray-900">{p.processorName}</div>
                    <div className="mt-0.5 text-xs text-gray-600">
                      {p.dataCategoriesProcessed.slice(0, 2).join(', ')}
                      {p.dataCategoriesProcessed.length > 2 &&
                        ` +${p.dataCategoriesProcessed.length - 2}`}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700">
                    {PROCESSOR_TYPE_LABELS[p.processorType] ?? p.processorType}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700">{p.registeredCountry}</td>
                  <td className="px-4 py-3 text-xs text-gray-700">
                    {p.adequacyDecisionApplicable
                      ? 'Adequacy decision'
                      : p.transferMechanism
                        ? (TRANSFER_MECHANISM_LABELS[p.transferMechanism] ?? p.transferMechanism)
                        : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {!p.dpaInPlace ? (
                      <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
                        No DPA
                      </span>
                    ) : (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          p.dpaStatus
                            ? (DPA_STATUS_PILL[p.dpaStatus] ?? 'bg-gray-100 text-gray-700')
                            : 'bg-emerald-100 text-emerald-700'
                        }`}
                      >
                        {p.dpaStatus ? (DPA_STATUS_LABELS[p.dpaStatus] ?? p.dpaStatus) : 'Active'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700">
                    {formatDate(p.nextReviewDate)}
                    {p.reviewDue && (
                      <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                        Due
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
