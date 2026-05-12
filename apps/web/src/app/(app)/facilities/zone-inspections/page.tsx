'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useZoneInspections } from '@/hooks/use-facilities-advanced';
import type { ZoneInspectionRating } from '@/lib/types';

const RATING_PILL: Record<ZoneInspectionRating, string> = {
  PASS: 'bg-emerald-100 text-emerald-700',
  NEEDS_IMPROVEMENT: 'bg-amber-100 text-amber-700',
  FAIL: 'bg-rose-100 text-rose-700',
};

const RATING_LABEL: Record<ZoneInspectionRating, string> = {
  PASS: 'Pass',
  NEEDS_IMPROVEMENT: 'Needs improvement',
  FAIL: 'Fail',
};

export default function ZoneInspectionsPage() {
  const inspectionsQ = useZoneInspections();

  return (
    <div>
      <PageHeader
        title="Zone inspections"
        description="Supervisor spot checks. FAIL outcomes auto-create a follow-up work order."
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
        {inspectionsQ.isLoading ? (
          <LoadingSpinner />
        ) : inspectionsQ.data && inspectionsQ.data.length > 0 ? (
          <ul className="space-y-2">
            {inspectionsQ.data.map((i) => (
              <li
                key={i.id}
                className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2"
                style={{
                  borderLeftWidth: 4,
                  borderLeftColor:
                    i.overallRating === 'FAIL'
                      ? '#dc2626'
                      : i.overallRating === 'NEEDS_IMPROVEMENT'
                        ? '#f59e0b'
                        : '#10b981',
                }}
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-semibold text-gray-900">
                    {i.zoneName ?? 'Zone'}
                  </span>
                  <span className="flex items-baseline gap-2 text-xs text-gray-500">
                    <span>{i.inspectionDate}</span>
                    <span className={'rounded-full px-1.5 py-0.5 ' + RATING_PILL[i.overallRating]}>
                      {RATING_LABEL[i.overallRating]}
                    </span>
                  </span>
                </div>
                {i.notes && <p className="mt-1 text-xs text-gray-600">{i.notes}</p>}
                <p className="mt-1 text-xs text-gray-500">
                  Inspector: {i.inspectorName ?? 'Staff'}
                </p>
                {i.followUpWorkOrderId && (
                  <p className="mt-1 text-xs text-rose-700">
                    Follow-up work order linked: {i.followUpWorkOrderId.slice(0, 8)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">No zone inspections recorded yet.</p>
        )}
      </section>
    </div>
  );
}
