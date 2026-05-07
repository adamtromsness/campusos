'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui';
import { useSars } from '@/hooks/use-governance';
import { SAR_STATUS_LABELS, SAR_STATUS_PILL, formatDate } from '@/lib/governance-format';

export default function SarsPage() {
  const [status, setStatus] = useState<string | undefined>(undefined);
  const sars = useSars({ status });

  return (
    <div>
      <PageHeader
        title="Subject Access Requests"
        description="GDPR Article 15 SARs. Each request carries a 30-day deadline (45 if FERPA-controlled). Overdue rows surface in red."
      />

      <div className="mb-4 flex items-center gap-2 text-sm">
        {[undefined, 'RECEIVED', 'IN_PROGRESS', 'EXTENSION_REQUESTED', 'COMPLETED', 'DENIED'].map(
          (s, idx) => (
            <button
              key={idx}
              onClick={() => setStatus(s)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                status === s
                  ? 'border-campus-400 bg-campus-50 text-campus-700'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-campus-300'
              }`}
            >
              {s ? SAR_STATUS_LABELS[s] : 'All'}
            </button>
          ),
        )}
        <Link href="/governance" className="ml-auto text-sm text-gray-500 hover:text-campus-700">
          ← Back to compliance dashboard
        </Link>
      </div>

      {sars.isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !sars.data || sars.data.length === 0 ? (
        <p className="text-sm text-gray-500">No subject access requests in this view.</p>
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600">
              <tr>
                <th className="px-4 py-2">Data subject</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Submitted by</th>
                <th className="px-4 py-2">Deadline</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {sars.data.map((s) => (
                <tr
                  key={s.id}
                  className={`border-b border-gray-100 last:border-0 ${
                    s.isOverdue ? 'bg-rose-50' : ''
                  }`}
                >
                  <td className="px-4 py-3 text-sm">
                    <Link
                      href={`/governance/sars/${s.id}`}
                      className="font-semibold text-gray-900 hover:text-campus-700"
                    >
                      {s.dataSubjectName ?? s.dataSubjectId.slice(0, 8) + '…'}
                    </Link>
                    {s.requestDetails && (
                      <div className="mt-0.5 text-xs text-gray-600 line-clamp-2">
                        {s.requestDetails}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700">{s.requestType}</td>
                  <td className="px-4 py-3 text-xs text-gray-700">{s.requestedByName ?? '—'}</td>
                  <td className="px-4 py-3 text-xs">
                    <div>{formatDate(s.deadlineDate)}</div>
                    <div
                      className={`mt-0.5 ${
                        s.isOverdue ? 'text-rose-700 font-semibold' : 'text-gray-500'
                      }`}
                    >
                      {s.isOverdue
                        ? `Overdue ${Math.abs(s.daysUntilDeadline)} days`
                        : `${s.daysUntilDeadline} days`}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        SAR_STATUS_PILL[s.status] ?? 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {SAR_STATUS_LABELS[s.status] ?? s.status}
                    </span>
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
