'use client';

import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useMyServiceProgress } from '@/hooks/use-clubs';
import { useAuthStore } from '@/lib/auth-store';

export default function ServiceProgressPage() {
  const user = useAuthStore((s) => s.user);
  const progressQ = useMyServiceProgress(!!user);

  if (!user) return null;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="My service progress" description="Approved hours toward each programme" />
      {progressQ.isLoading ? (
        <div className="py-12 text-center">
          <LoadingSpinner />
        </div>
      ) : !progressQ.data || progressQ.data.length === 0 ? (
        <EmptyState
          title="No progress yet"
          description="Log your first service hours to start a programme."
        />
      ) : (
        <ul className="space-y-4">
          {progressQ.data.map((p) => {
            const target = p.targetHours ?? 0;
            const pct = target > 0 ? Math.min(100, (p.approvedHours / target) * 100) : 0;
            return (
              <li key={p.id} className="rounded-lg border border-gray-200 bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900">{p.programmeName}</h3>
                  {p.isComplete ? (
                    <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      ✓ Complete
                    </span>
                  ) : null}
                </div>
                <p className="text-sm text-gray-600">
                  {p.approvedHours} of {target} approved hours
                  {p.pendingHours > 0 ? ` (+ ${p.pendingHours} pending)` : ''}
                </p>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className={p.isComplete ? 'h-full bg-emerald-500' : 'h-full bg-campus-600'}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="mt-1 text-right text-xs text-gray-500">{Math.round(pct)}%</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
