'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader, useToast } from '@/components/ui';
import { useAttendanceSummary, useRunWorkers } from '@/hooks/use-analytics';
import { attendanceTone, formatPercent, formatRelativeAgo } from '@/lib/analytics-format';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';

export default function AttendanceDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const isManager = hasAnyPermission(user, ['rpt-002:write']);
  const { toast } = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const [fromDate, setFromDate] = useState(thirtyDaysAgo);
  const [toDate, setToDate] = useState(today);
  const data = useAttendanceSummary({ fromDate, toDate });
  const runWorkers = useRunWorkers();

  const onMaterialise = async () => {
    try {
      const summaries = await runWorkers.mutateAsync({ worker: 'sis' });
      const sis = summaries[0];
      toast(
        `SIS worker ${sis?.status === 'OK' ? 'OK' : 'FAILED'} — ${sis?.rowsWritten ?? 0} rows`,
        sis?.status === 'OK' ? 'success' : 'error',
      );
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Failed', 'error');
    }
  };

  const totalPresent = (data.data ?? []).reduce((acc, r) => acc + r.presentCount, 0);
  const totalAbsent = (data.data ?? []).reduce((acc, r) => acc + r.absentCount, 0);
  const totalLate = (data.data ?? []).reduce((acc, r) => acc + r.lateCount, 0);
  const totalEnrolled = (data.data ?? []).reduce((acc, r) => acc + r.totalEnrolled, 0);
  const overallRate = totalEnrolled > 0 ? (totalPresent + totalLate) / totalEnrolled : null;

  return (
    <div>
      <PageHeader
        title="Attendance dashboard"
        description="Per-class daily attendance summary materialised by the SIS worker."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/analytics" className="text-sm text-campus-600 hover:underline">
              ← Analytics
            </Link>
            {isManager && (
              <button
                onClick={onMaterialise}
                disabled={runWorkers.isPending}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
              >
                Re-materialise
              </button>
            )}
          </div>
        }
      />

      <section className="mb-6 grid gap-3 sm:grid-cols-4">
        <Stat label="Present (period)" value={totalPresent.toLocaleString()} />
        <Stat
          label="Absent"
          value={totalAbsent.toLocaleString()}
          tone="bg-rose-100 text-rose-800"
        />
        <Stat label="Late" value={totalLate.toLocaleString()} tone="bg-amber-100 text-amber-800" />
        <Stat
          label="Overall rate"
          value={formatPercent(overallRate)}
          tone={attendanceTone(overallRate)}
        />
      </section>

      <section className="mb-4 flex flex-wrap items-end gap-3 text-sm">
        <label>
          <div className="mb-1 font-medium text-gray-700">From</div>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-1.5"
          />
        </label>
        <label>
          <div className="mb-1 font-medium text-gray-700">To</div>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-1.5"
          />
        </label>
      </section>

      {data.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (data.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-500">
          No attendance summary rows in this date range.
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>Date</Th>
                <Th>Class</Th>
                <Th className="text-right">Present</Th>
                <Th className="text-right">Absent</Th>
                <Th className="text-right">Late</Th>
                <Th className="text-right">Enrolled</Th>
                <Th>Rate</Th>
                <Th>Generated</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(data.data ?? []).map((r) => (
                <tr key={r.id}>
                  <Td>{r.summaryDate}</Td>
                  <Td>{r.className ?? '—'}</Td>
                  <Td className="text-right">{r.presentCount}</Td>
                  <Td className="text-right">{r.absentCount}</Td>
                  <Td className="text-right">{r.lateCount}</Td>
                  <Td className="text-right">{r.totalEnrolled}</Td>
                  <Td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${attendanceTone(r.attendanceRate)}`}
                    >
                      {formatPercent(r.attendanceRate)}
                    </span>
                  </Td>
                  <Td className="text-xs text-gray-500">{formatRelativeAgo(r.generatedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-card border border-gray-200 bg-white p-3 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-600">{label}</div>
      <div
        className={`mt-1 inline-block rounded-md px-2 py-0.5 text-xl font-bold ${tone ?? 'text-gray-900'}`}
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
