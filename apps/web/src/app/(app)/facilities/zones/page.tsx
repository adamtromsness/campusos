'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useFacZones } from '@/hooks/use-facilities';
import { FAC_SHIFT_LABEL, formatDateOnly } from '@/lib/facilities-format';

export default function ZonesPage() {
  const zonesQ = useFacZones();

  return (
    <div>
      <PageHeader
        title="Custodial zones"
        description="Where custodians work — paired with HR (Cycle 4) for when they work, per ADR-034"
        actions={
          <Link
            href="/facilities"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Facilities
          </Link>
        }
      />

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        {zonesQ.isLoading ? (
          <LoadingSpinner />
        ) : zonesQ.data && zonesQ.data.length > 0 ? (
          <ul className="grid gap-3 lg:grid-cols-2">
            {zonesQ.data.map((z) => (
              <li
                key={z.id}
                className="rounded-xl border border-gray-200 bg-gray-50 p-4"
                style={{ borderLeftColor: z.color ?? '#3d7ab5', borderLeftWidth: 6 }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-base font-semibold text-gray-900">{z.name}</span>
                </div>
                {z.description && <p className="mt-1 text-sm text-gray-600">{z.description}</p>}
                <div className="mt-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Assignments
                  </h4>
                  {z.assignments.length === 0 ? (
                    <p className="mt-1 text-xs text-gray-500">No active assignments</p>
                  ) : (
                    <ul className="mt-1 space-y-1 text-sm">
                      {z.assignments.map((a) => (
                        <li
                          key={a.id}
                          className="flex items-baseline justify-between rounded border border-gray-100 bg-white px-2 py-1"
                        >
                          <span className="text-gray-900">{a.employeeName ?? 'Employee'}</span>
                          <span className="flex items-baseline gap-2 text-xs text-gray-500">
                            <span className="rounded-full bg-gray-100 px-1.5 py-0.5">
                              {FAC_SHIFT_LABEL[a.shift]}
                            </span>
                            <span>since {formatDateOnly(a.effectiveFrom)}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">No zones defined yet.</p>
        )}
      </section>
    </div>
  );
}
