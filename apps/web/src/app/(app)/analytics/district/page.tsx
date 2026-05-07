'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { useDistrictComparison, useDistrictSummary } from '@/hooks/use-analytics';
import { attendanceTone, formatGpa, formatPercent, gpaTone } from '@/lib/analytics-format';

export default function DistrictComparisonPage() {
  const summary = useDistrictSummary();
  const comparison = useDistrictComparison();

  return (
    <div>
      <PageHeader
        title="District comparison"
        description="Per-school rankings within the district. Materialised nightly at 03:00 UTC by the DistrictAnalyticsWorker."
        actions={
          <Link href="/analytics" className="text-sm text-campus-600 hover:underline">
            ← Analytics
          </Link>
        }
      />

      {summary.data && (
        <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Schools" value={summary.data.schoolCount.toLocaleString()} />
          <Stat label="Enrolled" value={summary.data.totalEnrolled.toLocaleString()} />
          <Stat label="Staff" value={summary.data.totalStaff.toLocaleString()} />
          <Stat
            label="Avg attendance"
            value={formatPercent(summary.data.avgAttendanceRate)}
            tone={attendanceTone(summary.data.avgAttendanceRate)}
          />
          <Stat
            label="Avg GPA"
            value={formatGpa(summary.data.avgGpa)}
            tone={gpaTone(summary.data.avgGpa)}
          />
        </section>
      )}

      {comparison.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (comparison.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-500">
          No school comparison rows. Run the District worker.
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th className="text-right">Att rank</Th>
                <Th className="text-right">Perf rank</Th>
                <Th>School</Th>
                <Th>Attendance</Th>
                <Th>Avg GPA</Th>
                <Th className="text-right">At-risk</Th>
                <Th className="text-right">Incidents</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(comparison.data ?? []).map((c) => {
                const m = c.metrics ?? {};
                const att = (m.attendance_rate as number | null) ?? null;
                const gpa = (m.avg_gpa as number | null) ?? null;
                const atRisk = Number(m.at_risk_count ?? 0);
                const incidents = Number(m.incident_count ?? 0);
                return (
                  <tr key={c.id}>
                    <Td className="text-right">{c.rankByAttendance ?? '—'}</Td>
                    <Td className="text-right">{c.rankByPerformance ?? '—'}</Td>
                    <Td>{c.schoolName ?? c.schoolId.slice(0, 8)}</Td>
                    <Td>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${attendanceTone(att)}`}
                      >
                        {formatPercent(att)}
                      </span>
                    </Td>
                    <Td>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${gpaTone(gpa)}`}
                      >
                        {formatGpa(gpa)}
                      </span>
                    </Td>
                    <Td className="text-right">{atRisk}</Td>
                    <Td className="text-right">{incidents}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-600">{label}</div>
      <div
        className={`mt-1 inline-block rounded-md px-2 py-0.5 text-2xl font-bold ${tone ?? 'text-gray-900'}`}
      >
        {value}
      </div>
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
