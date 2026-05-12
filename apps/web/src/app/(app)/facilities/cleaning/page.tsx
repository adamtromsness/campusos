'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useCleaningCompletions, useCleaningRoutes } from '@/hooks/use-facilities-advanced';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import type { CleaningCompletionStatus, CleaningRouteShift } from '@/lib/types';

const SHIFT_LABEL: Record<CleaningRouteShift, string> = {
  MORNING: 'Morning',
  AFTERNOON: 'Afternoon',
  EVENING: 'Evening',
  OVERNIGHT: 'Overnight',
};

const STATUS_PILL: Record<CleaningCompletionStatus, string> = {
  NOT_STARTED: 'bg-gray-100 text-gray-700',
  IN_PROGRESS: 'bg-sky-100 text-sky-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  PARTIAL: 'bg-amber-100 text-amber-700',
};

export default function CleaningRoutesPage() {
  const user = useAuthStore((s) => s.user);
  const canManage =
    !!user &&
    (hasAnyPermission(user, ['fac-003:admin']) || hasAnyPermission(user, ['sch-001:admin']));
  const routesQ = useCleaningRoutes(canManage);
  const completionsQ = useCleaningCompletions();

  return (
    <div>
      <PageHeader
        title="Cleaning routes"
        description="Custodial route definitions, assignments, and daily completion status."
        actions={
          <Link
            href="/facilities"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Facilities
          </Link>
        }
      />

      <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Routes</h2>
        {routesQ.isLoading ? (
          <LoadingSpinner />
        ) : routesQ.data && routesQ.data.length > 0 ? (
          <ul className="grid gap-3 lg:grid-cols-2">
            {routesQ.data.map((r) => (
              <li
                key={r.id}
                className="rounded-xl border border-gray-200 bg-gray-50 p-4"
                style={{ opacity: r.isActive ? 1 : 0.6 }}
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-base font-semibold text-gray-900">{r.name}</span>
                  <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-700">
                    {SHIFT_LABEL[r.shift]}
                  </span>
                </div>
                {r.zoneName && <p className="mt-1 text-xs text-gray-500">Zone: {r.zoneName}</p>}
                <p className="mt-2 text-sm text-gray-600">
                  {r.stops.length} stop{r.stops.length === 1 ? '' : 's'}
                  {r.estimatedDurationMinutes
                    ? ' · est ' + r.estimatedDurationMinutes + ' min'
                    : ''}
                </p>
                {!r.isActive && <p className="mt-1 text-xs text-gray-500 italic">Inactive</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">No cleaning routes defined yet.</p>
        )}
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Recent completions</h2>
        {completionsQ.isLoading ? (
          <LoadingSpinner />
        ) : completionsQ.data && completionsQ.data.length > 0 ? (
          <ul className="space-y-2">
            {completionsQ.data.slice(0, 20).map((c) => {
              const issueCount = c.stopCompletions.filter((s) => !!s.issuesNoted).length;
              const skippedCount = c.stopCompletions.filter((s) => s.status === 'SKIPPED').length;
              return (
                <li
                  key={c.id}
                  className="flex items-baseline justify-between rounded-lg border border-gray-100 px-3 py-2"
                >
                  <span className="text-sm text-gray-900">
                    {c.routeName} — {c.employeeName ?? 'Custodian'}
                  </span>
                  <span className="flex items-baseline gap-2 text-xs text-gray-500">
                    <span>{c.completionDate}</span>
                    {issueCount > 0 && (
                      <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-rose-700">
                        {issueCount} issue{issueCount === 1 ? '' : 's'}
                      </span>
                    )}
                    {skippedCount > 0 && (
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-amber-700">
                        {skippedCount} skipped
                      </span>
                    )}
                    <span className={'rounded-full px-1.5 py-0.5 ' + STATUS_PILL[c.overallStatus]}>
                      {c.overallStatus.toLowerCase().replace(/_/g, ' ')}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">No completions recorded yet.</p>
        )}
      </section>
    </div>
  );
}
