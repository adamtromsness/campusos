'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useVehicles } from '@/hooks/use-transport';
import {
  VEHICLE_STATUS_LABEL,
  VEHICLE_STATUS_PILL,
  VEHICLE_TYPE_LABEL,
} from '@/lib/transport-format';

export default function FleetPage() {
  const vehiclesQ = useVehicles({});

  return (
    <div>
      <PageHeader
        title="Fleet"
        description="Vehicles, documents, and inspection status"
        actions={
          <Link
            href="/transport"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Transportation
          </Link>
        }
      />

      {vehiclesQ.isLoading ? (
        <LoadingSpinner />
      ) : vehiclesQ.data && vehiclesQ.data.length > 0 ? (
        <ul className="grid gap-3 lg:grid-cols-2">
          {vehiclesQ.data.map((v) => (
            <li key={v.id} className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-semibold text-gray-900">{v.registration}</div>
                  <div className="text-xs text-gray-500">
                    {VEHICLE_TYPE_LABEL[v.vehicleType]} · capacity {v.capacity}
                    {v.make && v.model && (
                      <>
                        {' '}
                        · {v.make} {v.model} {v.year ?? ''}
                      </>
                    )}
                  </div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${VEHICLE_STATUS_PILL[v.status]}`}
                >
                  {VEHICLE_STATUS_LABEL[v.status]}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div className="rounded-lg bg-emerald-50 p-2 text-emerald-800">
                  <div className="font-medium">Current</div>
                  <div className="text-base font-semibold">{v.documentSummary.current}</div>
                </div>
                <div className="rounded-lg bg-amber-50 p-2 text-amber-800">
                  <div className="font-medium">Expiring</div>
                  <div className="text-base font-semibold">{v.documentSummary.expiringSoon}</div>
                </div>
                <div className="rounded-lg bg-rose-50 p-2 text-rose-800">
                  <div className="font-medium">Expired</div>
                  <div className="text-base font-semibold">{v.documentSummary.expired}</div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500">No vehicles in the fleet.</p>
      )}
    </div>
  );
}
