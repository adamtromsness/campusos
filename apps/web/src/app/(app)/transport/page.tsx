'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  useMyBusPass,
  useMyTransportRoute,
  useNoShowAlerts,
  useTransportRoutes,
  useVehicles,
} from '@/hooks/use-transport';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { ROUTE_DIRECTION_LABEL, ROUTE_STATUS_PILL } from '@/lib/transport-format';

export default function TransportLandingPage() {
  const user = useAuthStore((s) => s.user);
  const isManager = !!user && hasAnyPermission(user, ['trn-001:write']);
  const isStudentOrParent = user?.personType === 'STUDENT' || user?.personType === 'GUARDIAN';

  const routesQ = useTransportRoutes({ status: 'ACTIVE' });
  const vehiclesQ = useVehicles({ status: 'ACTIVE' });
  const noShowsQ = useNoShowAlerts({ resolved: false });
  const myRouteQ = useMyTransportRoute();
  const myBusPassQ = useMyBusPass();

  if (!user) return <LoadingSpinner />;

  if (isStudentOrParent && !isManager) {
    return (
      <div>
        <PageHeader title="Transportation" description="Your route and bus pass" />
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-semibold text-gray-900">My route</h2>
            {myRouteQ.isLoading ? (
              <LoadingSpinner />
            ) : myRouteQ.data && myRouteQ.data.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {myRouteQ.data.map((a) => (
                  <li
                    key={a.id}
                    className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm"
                  >
                    <div className="font-medium text-gray-900">
                      {a.studentName ?? 'Student'} — {a.direction} ({ROUTE_DIRECTION_LABEL.AM})
                    </div>
                    <div className="mt-1 text-gray-600">
                      Stop #{a.stopSequence ?? '?'}: {a.stopName ?? '—'}
                    </div>
                    {a.isOverride && (
                      <span className="mt-1 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                        One-day override • {a.effectiveFrom}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-gray-500">No active route assignment.</p>
            )}
          </section>
          <section className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-semibold text-gray-900">My bus pass</h2>
            {myBusPassQ.isLoading ? (
              <LoadingSpinner />
            ) : myBusPassQ.data && myBusPassQ.data.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {myBusPassQ.data.map((p) => (
                  <li
                    key={p.id}
                    className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm"
                  >
                    <div className="font-mono text-base text-gray-900">{p.qrCodeToken}</div>
                    <div className="mt-1 text-gray-600">
                      {p.passType} pass · valid {p.validFrom} → {p.validTo}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-gray-500">No active bus pass.</p>
            )}
          </section>
        </div>
        {user.personType === 'GUARDIAN' && (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm">
            <div className="font-medium text-amber-900">Need a one-day change?</div>
            <p className="mt-1 text-amber-800">
              Use the per-child portal to submit a route-change request (different stop, skip the
              bus, or different route).
            </p>
            <Link
              href="/children"
              className="mt-2 inline-block text-amber-900 underline underline-offset-4"
            >
              Go to my children →
            </Link>
          </div>
        )}
      </div>
    );
  }

  const totalActive = routesQ.data?.length ?? 0;
  const totalVehicles = vehiclesQ.data?.length ?? 0;
  const expiringDocs =
    vehiclesQ.data?.reduce(
      (sum, v) => sum + v.documentSummary.expiringSoon + v.documentSummary.expired,
      0,
    ) ?? 0;
  const openNoShows = noShowsQ.data?.length ?? 0;

  return (
    <div>
      <PageHeader
        title="Transportation"
        description="Routes, fleet, drivers, and today's operations"
        actions={
          isManager ? (
            <div className="flex flex-wrap gap-2">
              <Link
                href="/transport/fleet"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Fleet
              </Link>
              <Link
                href="/transport/drivers"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Drivers
              </Link>
              <Link
                href="/transport/scan"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Ridership scanner
              </Link>
              <Link
                href="/transport/no-shows"
                className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-100"
              >
                No-shows{openNoShows > 0 ? ` (${openNoShows})` : ''}
              </Link>
              <Link
                href="/transport/inspections/new"
                className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
              >
                Pre-trip inspection →
              </Link>
            </div>
          ) : null
        }
      />

      {/* Stats */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active routes" value={totalActive} />
        <Stat label="Vehicles" value={totalVehicles} />
        <Stat label="Doc alerts" value={expiringDocs} tone={expiringDocs > 0 ? 'amber' : 'green'} />
        <Stat
          label="No-shows today"
          value={openNoShows}
          tone={openNoShows > 0 ? 'rose' : 'green'}
        />
      </div>

      {/* Routes */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Active routes</h2>
        {routesQ.isLoading ? (
          <LoadingSpinner />
        ) : routesQ.data && routesQ.data.length > 0 ? (
          <ul className="mt-3 grid gap-3 lg:grid-cols-2">
            {routesQ.data.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/transport/routes/${r.id}`}
                  className="block rounded-xl border border-gray-200 p-4 hover:border-campus-400 hover:bg-campus-50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium text-gray-900">{r.name}</div>
                      <div className="mt-0.5 text-xs text-gray-500">
                        {ROUTE_DIRECTION_LABEL[r.direction]} ·{' '}
                        {r.vehicleRegistration ?? 'No vehicle'} · {r.driverName ?? 'No driver'}
                      </div>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${ROUTE_STATUS_PILL[r.status]}`}
                    >
                      {r.status}
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-gray-500">
                    {r.stopCount} stops · {r.studentCount} students
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No active routes.</p>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'green' | 'amber' | 'rose';
}) {
  const toneClass =
    tone === 'rose'
      ? 'text-rose-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : tone === 'green'
          ? 'text-emerald-700'
          : 'text-gray-900';
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}
