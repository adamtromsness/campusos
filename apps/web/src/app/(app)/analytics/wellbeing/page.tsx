'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { useWellbeingTrends } from '@/hooks/use-analytics';

export default function WellbeingTrendsPage() {
  const data = useWellbeingTrends();

  return (
    <div>
      <PageHeader
        title="Wellbeing trends"
        description="Aggregated per (school, grade, period). NO individual student identifiers."
        actions={
          <Link href="/analytics" className="text-sm text-campus-600 hover:underline">
            ← Analytics
          </Link>
        }
      />

      <div className="mb-4 rounded-md bg-violet-50 p-3 text-xs text-violet-800">
        Privacy note: this surface aggregates Cycle 11.1 wellbeing check-in data. No row contains
        student-level identifiers — only counts per grade per period. Counsellors investigate
        individual trends inside the Counselling app, not here.
      </div>

      {data.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (data.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-500">
          No wellbeing trends materialised yet. Run the Wellbeing worker on /analytics.
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>Grade</Th>
                <Th>Period</Th>
                <Th className="text-right">Avg score</Th>
                <Th className="text-right">Responses</Th>
                <Th className="text-right">Wants to talk</Th>
                <Th className="text-right">Flagged</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(data.data ?? []).map((r) => (
                <tr key={r.id}>
                  <Td>{r.gradeLevel}</Td>
                  <Td>
                    {r.periodStart} → {r.periodEnd}
                  </Td>
                  <Td className="text-right">{r.avgWellbeingScore?.toFixed(1) ?? '—'}</Td>
                  <Td className="text-right">{r.responseCount}</Td>
                  <Td className="text-right text-amber-700">{r.wantsToTalkCount}</Td>
                  <Td className="text-right text-rose-700">{r.flaggedCount}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <td className={`whitespace-nowrap px-4 py-2.5 text-sm text-gray-700 ${className}`}>
      {children}
    </td>
  );
}
