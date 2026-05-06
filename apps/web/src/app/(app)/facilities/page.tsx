'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  useFacActiveViolations,
  useFacBuildings,
  useFacClosures,
  useFacWorkOrders,
} from '@/hooks/use-facilities';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  FAC_VIOL_SEVERITY_LABEL,
  FAC_VIOL_SEVERITY_PILL,
  FAC_WO_PRIORITY_PILL,
  formatRelativeDue,
} from '@/lib/facilities-format';

export default function FacilitiesLandingPage() {
  const user = useAuthStore((s) => s.user);
  // FM scope = fac-001:admin (Cycle 21 BLOCKING 1 split). Teachers carry
  // fac-001:read+write — they can view the dashboard, browse buildings,
  // and book spaces, but they do NOT see the FM management actions.
  const isManager = !!user && hasAnyPermission(user, ['fac-001:admin']);

  const buildingsQ = useFacBuildings();
  const openWosQ = useFacWorkOrders({ status: 'OPEN' });
  const inProgWosQ = useFacWorkOrders({ status: 'IN_PROGRESS' });
  const violationsQ = useFacActiveViolations();
  const closuresQ = useFacClosures(true);

  if (!user) return <LoadingSpinner />;

  const buildings = buildingsQ.data ?? [];
  const openCount = openWosQ.data?.length ?? 0;
  const inProgCount = inProgWosQ.data?.length ?? 0;
  const violations = violationsQ.data ?? [];
  const closures = closuresQ.data ?? [];

  return (
    <div>
      <PageHeader
        title="Facilities"
        description={
          isManager
            ? 'Buildings, work orders, PM, inspections, zones, supply'
            : 'Browse buildings and book a space'
        }
        actions={
          isManager ? (
            <div className="flex flex-wrap gap-2">
              <Link
                href="/facilities/work-orders"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Work orders
              </Link>
              <Link
                href="/facilities/pm"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                PM
              </Link>
              <Link
                href="/facilities/inspections"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Inspections
              </Link>
              <Link
                href="/facilities/zones"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Zones
              </Link>
              <Link
                href="/facilities/supply"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Supply
              </Link>
              <Link
                href="/facilities/bookings"
                className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
              >
                Bookings →
              </Link>
            </div>
          ) : (
            <Link
              href="/facilities/bookings"
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
            >
              Book a space →
            </Link>
          )
        }
      />

      {isManager && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Buildings" value={buildings.length} />
          <Stat label="Open WOs" value={openCount} tone={openCount > 0 ? 'amber' : 'green'} />
          <Stat label="In progress" value={inProgCount} />
          <Stat
            label="Active violations"
            value={violations.length}
            tone={violations.length > 0 ? 'rose' : 'green'}
          />
          <Stat
            label="Active closures"
            value={closures.length}
            tone={closures.length > 0 ? 'amber' : 'green'}
          />
        </div>
      )}

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Buildings</h2>
        {buildingsQ.isLoading ? (
          <LoadingSpinner />
        ) : buildings.length > 0 ? (
          <ul className="mt-3 grid gap-3 lg:grid-cols-2">
            {buildings.map((b) => (
              <li key={b.id} className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <Link
                    href={`/facilities/buildings/${b.id}`}
                    className="text-base font-semibold text-campus-700 hover:underline"
                  >
                    {b.name}
                  </Link>
                  <span className="text-xs text-gray-500">
                    {b.spaceCount} spaces · {b.openWorkOrders} open WOs
                  </span>
                </div>
                {b.address && <p className="mt-1 text-sm text-gray-600">{b.address}</p>}
                <p className="mt-1 text-xs text-gray-500">
                  {b.totalFloors ? `${b.totalFloors} floors` : 'Single floor'} ·{' '}
                  {b.yearBuilt ? `Built ${b.yearBuilt}` : 'No build year'}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No buildings registered yet.</p>
        )}
      </section>

      {isManager && violations.length > 0 && (
        <section className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-5">
          <h2 className="text-base font-semibold text-rose-900">
            Active violations ({violations.length})
          </h2>
          <ul className="mt-3 space-y-1 text-sm">
            {violations.slice(0, 5).map((v) => (
              <li key={v.id} className="flex items-baseline gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${FAC_VIOL_SEVERITY_PILL[v.severity]}`}
                >
                  {FAC_VIOL_SEVERITY_LABEL[v.severity]}
                </span>
                <span className="text-rose-900">{v.description}</span>
                <span className="text-xs text-rose-700">— {formatRelativeDue(v.dueDate)}</span>
              </li>
            ))}
          </ul>
          <Link
            href="/facilities/violations"
            className="mt-3 inline-block text-sm text-rose-700 underline underline-offset-4"
          >
            See all violations →
          </Link>
        </section>
      )}

      {isManager && (
        <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-semibold text-gray-900">Recent open work orders</h2>
          {openWosQ.isLoading ? (
            <LoadingSpinner />
          ) : openWosQ.data && openWosQ.data.length > 0 ? (
            <ul className="mt-3 space-y-1 text-sm">
              {openWosQ.data.slice(0, 5).map((w) => (
                <li
                  key={w.id}
                  className="flex items-baseline justify-between gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${FAC_WO_PRIORITY_PILL[w.priority]}`}
                    >
                      {w.priority}
                    </span>
                    <span className="text-gray-900">{w.description ?? w.workOrderType}</span>
                  </div>
                  <span className="text-xs text-gray-500">{w.spaceName ?? '—'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-gray-500">No open work orders. Quiet day!</p>
          )}
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
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
