'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  useRouteAssignments,
  useRouteChangeLog,
  useTransportRoute,
  useTransportRouteStops,
} from '@/hooks/use-transport';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  CHANGE_LOG_TYPE_LABEL,
  ROUTE_DIRECTION_LABEL,
  ROUTE_STATUS_PILL,
  formatTimeOfDay,
} from '@/lib/transport-format';

export default function TransportRouteDetailPage() {
  const params = useParams<{ id: string }>();
  const routeId = params?.id ?? null;
  const user = useAuthStore((s) => s.user);
  const isManager = !!user && hasAnyPermission(user, ['trn-001:write']);

  const routeQ = useTransportRoute(routeId);
  const stopsQ = useTransportRouteStops(routeId);
  const studentsQ = useRouteAssignments(routeId);
  const logQ = useRouteChangeLog(isManager ? routeId : null);

  if (!user) return <LoadingSpinner />;
  if (routeQ.isLoading || !routeQ.data) return <LoadingSpinner />;

  const r = routeQ.data;

  return (
    <div>
      <PageHeader
        title={r.name}
        description={`${ROUTE_DIRECTION_LABEL[r.direction]} · ${r.vehicleRegistration ?? 'No vehicle'} · ${r.driverName ?? 'No driver'}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/transport"
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              ← All routes
            </Link>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs ${ROUTE_STATUS_PILL[r.status]}`}>
          {r.status}
        </span>
        <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-700">
          {ROUTE_DIRECTION_LABEL[r.direction]}
        </span>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
          {r.stopCount} stops
        </span>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
          {r.studentCount} students
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-semibold text-gray-900">Stops</h2>
          {stopsQ.isLoading ? (
            <LoadingSpinner />
          ) : stopsQ.data && stopsQ.data.length > 0 ? (
            <ol className="mt-3 space-y-2">
              {stopsQ.data.map((s) => (
                <li
                  key={s.id}
                  className="flex items-start gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3"
                >
                  <div className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-campus-700 text-xs font-semibold text-white">
                    {s.sequenceOrder}
                  </div>
                  <div className="text-sm">
                    <div className="font-medium text-gray-900">{s.name}</div>
                    {s.address && <div className="text-gray-500">{s.address}</div>}
                    <div className="text-xs text-gray-500">
                      Scheduled: {formatTimeOfDay(s.scheduledTime)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-sm text-gray-500">No stops configured.</p>
          )}
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-semibold text-gray-900">Students</h2>
          {studentsQ.isLoading ? (
            <LoadingSpinner />
          ) : studentsQ.data && studentsQ.data.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {studentsQ.data.map((a) => (
                <li
                  key={a.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm"
                >
                  <div>
                    <div className="font-medium text-gray-900">{a.studentName ?? 'Student'}</div>
                    <div className="text-xs text-gray-500">
                      Stop #{a.stopSequence ?? '?'} · {a.stopName ?? '—'} · {a.direction}
                    </div>
                  </div>
                  {a.isOverride && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                      Override · {a.effectiveFrom}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-gray-500">No students assigned.</p>
          )}
        </section>
      </div>

      {isManager && (
        <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-semibold text-gray-900">Change log</h2>
          <p className="mt-1 text-xs text-gray-500">
            Immutable audit (no UPDATE / no DELETE). Every route mutation lands here.
          </p>
          {logQ.isLoading ? (
            <LoadingSpinner />
          ) : logQ.data && logQ.data.length > 0 ? (
            <ol className="mt-3 space-y-2">
              {logQ.data.map((entry) => (
                <li
                  key={entry.id}
                  className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm"
                >
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium text-gray-900">
                      {CHANGE_LOG_TYPE_LABEL[entry.changeType]}
                    </span>
                    <span className="text-xs text-gray-500">
                      {new Date(entry.changedAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-gray-500">
                    by {entry.changedByName ?? 'unknown'}
                    {entry.reason && <span> · {entry.reason}</span>}
                  </div>
                  {entry.newValue && (
                    <pre className="mt-1 overflow-x-auto rounded bg-white p-2 text-[11px] text-gray-700">
                      {JSON.stringify(entry.newValue, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-sm text-gray-500">No change log entries yet.</p>
          )}
        </section>
      )}
    </div>
  );
}
