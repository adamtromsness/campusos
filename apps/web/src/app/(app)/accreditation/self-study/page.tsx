'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader, EmptyState } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useAccSelfStudy, useAccSelfStudySummary } from '@/hooks/use-accreditation';
import {
  ACC_RATING_LABEL,
  ACC_RATING_PILL,
  currentCycleId,
  formatRelative,
} from '@/lib/accreditation-format';
import type { AccSelfStudyRating } from '@/lib/types';

function exportCsv(
  cycleId: string,
  rows: { standardId: string; rating: string; rationale: string; ratedAt: string }[],
) {
  const header = ['cycle_id', 'standard_id', 'rating', 'rationale', 'rated_at'];
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [
    header.join(','),
    ...rows.map((r) =>
      [cycleId, r.standardId, r.rating, r.rationale, r.ratedAt].map((v) => escape(v)).join(','),
    ),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `self-study-${cycleId}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function SelfStudyReportPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user?.activePersona?.type === 'STAFF';
  const showStaffSurfaces = isStaff || isAdmin;

  const [cycleId, setCycleId] = useState(currentCycleId());
  const ratingsQ = useAccSelfStudy(cycleId);
  const summaryQ = useAccSelfStudySummary(cycleId);

  if (!showStaffSurfaces) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <PageHeader title="Self-Study Report" />
        <EmptyState
          title="Not available"
          description="Self-study data is restricted to staff and administrators."
        />
      </div>
    );
  }

  const rows = ratingsQ.data ?? [];
  const summary = summaryQ.data;
  const totalRated = summary?.totalRated ?? 0;
  const denom = totalRated || 1;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Self-Study Report"
        description="Cycle-level rating distribution + per-domain breakdown. Export for submission to the accrediting body."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/accreditation"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          ← Dashboard
        </Link>
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium text-gray-700">Cycle</span>
          <input
            type="text"
            value={cycleId}
            onChange={(e) => setCycleId(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm"
            placeholder="2025-2026"
          />
        </label>
        <button
          type="button"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
          onClick={() => exportCsv(cycleId, rows)}
          disabled={rows.length === 0}
        >
          Export CSV
        </button>
      </div>

      {/* Rating distribution */}
      {summary && summary.totalRated > 0 ? (
        <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900">Rating distribution</h2>
          <p className="mt-1 text-xs text-gray-500">
            {summary.totalRated} standard{summary.totalRated === 1 ? '' : 's'} rated
          </p>
          <div className="mt-3 space-y-2">
            {(['EXEMPLARY', 'ACCOMPLISHED', 'DEVELOPING', 'NOT_MET'] as const).map((r) => {
              const n = summary.totals[r];
              const pct = Math.round((n / denom) * 100);
              return (
                <div key={r}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-gray-700">{ACC_RATING_LABEL[r]}</span>
                    <span>
                      {n} ({pct}%)
                    </span>
                  </div>
                  <div className="mt-1 h-3 w-full overflow-hidden rounded-full bg-gray-100">
                    <div
                      className={
                        'h-full ' +
                        (r === 'EXEMPLARY'
                          ? 'bg-emerald-500'
                          : r === 'ACCOMPLISHED'
                            ? 'bg-sky-500'
                            : r === 'DEVELOPING'
                              ? 'bg-amber-500'
                              : 'bg-rose-500')
                      }
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* By-domain table */}
      {summary && summary.byDomain.length > 0 && (
        <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900">By domain</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="py-2 pr-4">Domain</th>
                  <th className="py-2 pr-4">Exemplary</th>
                  <th className="py-2 pr-4">Accomplished</th>
                  <th className="py-2 pr-4">Developing</th>
                  <th className="py-2 pr-4">Not Met</th>
                </tr>
              </thead>
              <tbody>
                {summary.byDomain.map((row) => (
                  <tr key={row.domain} className="border-b border-gray-100">
                    <td className="py-2 pr-4 font-medium text-gray-700">{row.domain}</td>
                    <td className="py-2 pr-4 text-emerald-700">{row.EXEMPLARY}</td>
                    <td className="py-2 pr-4 text-sky-700">{row.ACCOMPLISHED}</td>
                    <td className="py-2 pr-4 text-amber-700">{row.DEVELOPING}</td>
                    <td className="py-2 pr-4 text-rose-700">{row.NOT_MET}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Per-rating list */}
      <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900">All ratings ({rows.length})</h2>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">
            No ratings logged for this cycle yet. Visit Standards to rate each adopted standard.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100">
            {rows.map((r) => (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={
                      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
                      ACC_RATING_PILL[r.rating as AccSelfStudyRating]
                    }
                  >
                    {ACC_RATING_LABEL[r.rating as AccSelfStudyRating]}
                  </span>
                  <span className="font-mono text-xs text-gray-500">
                    {r.standardId.slice(0, 8)}…
                  </span>
                  <span className="text-xs text-gray-500">{formatRelative(r.ratedAt)}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">{r.rationale}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
