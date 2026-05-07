'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui';
import { useProcessingActivities } from '@/hooks/use-governance';
import { LEGAL_BASIS_LABELS, formatDate } from '@/lib/governance-format';

/**
 * Cycle 30 ROPA list — GDPR Article 30 Register of Processing Activities.
 *
 * Surfaces the DPIA gap rule (high_risk_processing=true AND dpia_id IS
 * NULL) as red rows. The toggle filters to gap rows only — the
 * primary thing the DPO checks daily.
 */
export default function ProcessingActivitiesPage() {
  const [gapsOnly, setGapsOnly] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const activities = useProcessingActivities({ gapsOnly, includeInactive });

  return (
    <div>
      <PageHeader
        title="Records of Processing"
        description="Article 30 ROPA. Each row documents a processing operation: purpose, legal basis, data categories, data subjects, transfers, and DPIA linkage."
      />

      <div className="mb-4 flex items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={gapsOnly}
            onChange={(e) => setGapsOnly(e.target.checked)}
            className="rounded border-gray-300"
          />
          <span>DPIA gaps only</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="rounded border-gray-300"
          />
          <span>Show inactive</span>
        </label>
        <Link href="/governance" className="ml-auto text-sm text-gray-500 hover:text-campus-700">
          ← Back to compliance dashboard
        </Link>
      </div>

      {activities.isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !activities.data || activities.data.length === 0 ? (
        <p className="text-sm text-gray-500">
          {gapsOnly
            ? 'No DPIA gaps — every high-risk activity has a DPIA.'
            : 'No processing activities recorded yet.'}
        </p>
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600">
              <tr>
                <th className="px-4 py-2">Activity</th>
                <th className="px-4 py-2">Legal basis</th>
                <th className="px-4 py-2">Data categories</th>
                <th className="px-4 py-2">Last reviewed</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {activities.data.map((a) => (
                <tr
                  key={a.id}
                  className={`border-b border-gray-100 last:border-0 ${
                    a.hasDpiaGap ? 'bg-rose-50' : ''
                  }`}
                >
                  <td className="px-4 py-3">
                    <div className="font-semibold text-gray-900">
                      <Link
                        href={`/governance/processing-activities/${a.id}`}
                        className="hover:text-campus-700"
                      >
                        {a.activityName}
                      </Link>
                    </div>
                    <div className="mt-0.5 text-xs text-gray-600">{a.purpose}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {a.highRiskProcessing && (
                        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
                          High risk
                        </span>
                      )}
                      {a.profiling && (
                        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
                          Profiling
                        </span>
                      )}
                      {a.transfersOutsideUkEea && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                          Cross-border transfer
                        </span>
                      )}
                      {!a.isActive && (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                          Inactive
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700">
                    {LEGAL_BASIS_LABELS[a.legalBasis] ?? a.legalBasis}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700">
                    {a.dataCategories.slice(0, 3).join(', ')}
                    {a.dataCategories.length > 3 && ` +${a.dataCategories.length - 3}`}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {formatDate(a.lastReviewedAt)}
                  </td>
                  <td className="px-4 py-3">
                    {a.hasDpiaGap ? (
                      <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
                        DPIA gap
                      </span>
                    ) : a.dpiaId ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                        DPIA in place
                      </span>
                    ) : (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                        No DPIA needed
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
