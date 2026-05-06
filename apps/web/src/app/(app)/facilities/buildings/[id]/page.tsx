'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useFacBuilding, useFacClosures, useFacSpaces } from '@/hooks/use-facilities';
import { FAC_SPACE_TYPE_LABEL, FAC_SPACE_TYPE_PILL } from '@/lib/facilities-format';

export default function BuildingDetailPage() {
  const params = useParams<{ id: string }>();
  const buildingId = params?.id ?? '';
  const buildingQ = useFacBuilding(buildingId);
  const spacesQ = useFacSpaces(buildingId);
  const closuresQ = useFacClosures(true);

  if (buildingQ.isLoading) return <LoadingSpinner />;
  if (!buildingQ.data) return <p className="text-sm text-gray-500">Building not found.</p>;

  const b = buildingQ.data;
  const spaces = spacesQ.data ?? [];
  const closuresBySpace = new Map<string, number>();
  for (const c of closuresQ.data ?? []) {
    closuresBySpace.set(c.spaceId, (closuresBySpace.get(c.spaceId) ?? 0) + 1);
  }

  return (
    <div>
      <PageHeader
        title={b.name}
        description={
          (b.address ?? '') +
          (b.totalFloors ? ` · ${b.totalFloors} floors` : '') +
          (b.yearBuilt ? ` · Built ${b.yearBuilt}` : '')
        }
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
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-gray-900">Spaces ({spaces.length})</h2>
          <span className="text-xs text-gray-500">
            {spaces.filter((s) => s.schRoomId).length} cross-linked to scheduling
          </span>
        </div>
        {spacesQ.isLoading ? (
          <LoadingSpinner />
        ) : spaces.length > 0 ? (
          <ul className="mt-3 grid gap-2 lg:grid-cols-2">
            {spaces.map((s) => {
              const closureCount = closuresBySpace.get(s.id) ?? 0;
              return (
                <li
                  key={s.id}
                  className={`rounded-lg border p-3 ${
                    closureCount > 0 ? 'border-amber-300 bg-amber-50' : 'border-gray-100 bg-gray-50'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-gray-900">{s.name}</span>
                    <span className="text-xs text-gray-500">
                      Floor {s.floor ?? '—'}
                      {s.areaSqft ? ` · ${s.areaSqft} sqft` : ''}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${FAC_SPACE_TYPE_PILL[s.spaceType]}`}
                    >
                      {FAC_SPACE_TYPE_LABEL[s.spaceType]}
                    </span>
                    {s.schRoomName && (
                      <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-700">
                        ↔ {s.schRoomName}
                      </span>
                    )}
                    {closureCount > 0 && (
                      <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs text-amber-900">
                        Closed
                      </span>
                    )}
                    {!s.isActive && (
                      <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-700">
                        Inactive
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No spaces in this building.</p>
        )}
      </section>
    </div>
  );
}
