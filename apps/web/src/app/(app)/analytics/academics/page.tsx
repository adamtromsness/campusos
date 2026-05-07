'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui';
import { useAcademicSummary } from '@/hooks/use-analytics';
import { attendanceTone, formatGpa, formatPercent, gpaTone } from '@/lib/analytics-format';

export default function AcademicSummaryPage() {
  const [gradeLevel, setGradeLevel] = useState('');
  const [atRiskOnly, setAtRiskOnly] = useState(false);
  const data = useAcademicSummary({ gradeLevel: gradeLevel || undefined, atRiskOnly });

  const flagged = (data.data ?? []).filter(
    (r) => r.atRiskFlags && Object.keys(r.atRiskFlags).length > 0,
  ).length;

  return (
    <div>
      <PageHeader
        title="Academic summary"
        description="Per-student GPA + attendance rate + at-risk flags. Materialised by SISReadModelWorker."
        actions={
          <Link href="/analytics" className="text-sm text-campus-600 hover:underline">
            ← Analytics
          </Link>
        }
      />

      <section className="mb-4 flex flex-wrap items-end gap-3 text-sm">
        <label>
          <div className="mb-1 font-medium text-gray-700">Grade level</div>
          <input
            type="text"
            placeholder="e.g. 5"
            value={gradeLevel}
            onChange={(e) => setGradeLevel(e.target.value)}
            className="w-24 rounded-md border border-gray-300 px-3 py-1.5"
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={atRiskOnly}
            onChange={(e) => setAtRiskOnly(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-rose-600"
          />
          <span className="text-gray-700">At-risk only</span>
        </label>
        <div className="ml-auto text-sm text-gray-500">
          {(data.data ?? []).length} students · {flagged} flagged
        </div>
      </section>

      {data.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (data.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-500">
          No academic summary rows. Run the SIS worker on /analytics/attendance to materialise.
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>Student</Th>
                <Th>Grade</Th>
                <Th>GPA</Th>
                <Th>Attendance</Th>
                <Th className="text-right">Assignments</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(data.data ?? []).map((r) => (
                <tr
                  key={r.id}
                  className={
                    Object.keys(r.atRiskFlags).length > 0 ? 'bg-rose-50' : 'hover:bg-gray-50'
                  }
                >
                  <Td>{r.studentName ?? '—'}</Td>
                  <Td>{r.gradeLevel ?? '—'}</Td>
                  <Td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${gpaTone(r.currentGpa)}`}
                    >
                      {formatGpa(r.currentGpa)}
                    </span>
                  </Td>
                  <Td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${attendanceTone(r.attendanceRate)}`}
                    >
                      {formatPercent(r.attendanceRate)}
                    </span>
                  </Td>
                  <Td className="text-right">
                    {r.completedAssignments} / {r.totalAssignments}
                  </Td>
                  <Td>
                    {Object.keys(r.atRiskFlags).length > 0 ? (
                      <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800">
                        At-risk: {Object.keys(r.atRiskFlags).join(', ')}
                      </span>
                    ) : (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                        OK
                      </span>
                    )}
                  </Td>
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
