'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { useClassPerformance } from '@/hooks/use-analytics';

export default function ClassPerformancePage() {
  const data = useClassPerformance();

  return (
    <div>
      <PageHeader
        title="Class performance"
        description="Per-class avg + median grade + grade distribution + completion rate."
        actions={
          <Link href="/analytics" className="text-sm text-campus-600 hover:underline">
            ← Analytics
          </Link>
        }
      />

      {data.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (data.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-500">
          No class performance summaries — run the Classroom worker.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {(data.data ?? []).map((c) => {
            const dist = c.gradeDistribution ?? {};
            const total = Object.values(dist).reduce((a, b) => a + Number(b), 0);
            return (
              <div
                key={c.id}
                className="rounded-card border border-gray-200 bg-white p-5 shadow-sm"
              >
                <div className="mb-1 text-base font-semibold text-gray-900">
                  {c.className ?? 'Class'}
                </div>
                <div className="text-sm text-gray-500">
                  {c.studentCount} students · avg {c.avgGrade?.toFixed(1) ?? '—'} · median{' '}
                  {c.medianGrade?.toFixed(1) ?? '—'} · completion{' '}
                  {c.assignmentCompletionRate
                    ? `${(c.assignmentCompletionRate * 100).toFixed(0)}%`
                    : '—'}
                </div>
                <div className="mt-3 space-y-1.5">
                  {(['A', 'B', 'C', 'D', 'F'] as const).map((letter) => {
                    const v = Number(dist[letter] ?? 0);
                    const pct = total > 0 ? (v / total) * 100 : 0;
                    return (
                      <div key={letter} className="flex items-center gap-2 text-xs">
                        <div className="w-4 font-mono font-semibold text-gray-700">{letter}</div>
                        <div className="flex-1 overflow-hidden rounded-full bg-gray-100">
                          <div
                            className={`h-2 ${
                              letter === 'A'
                                ? 'bg-emerald-500'
                                : letter === 'B'
                                  ? 'bg-sky-500'
                                  : letter === 'C'
                                    ? 'bg-amber-500'
                                    : letter === 'D'
                                      ? 'bg-orange-500'
                                      : 'bg-rose-500'
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="w-10 text-right tabular-nums">{v}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
