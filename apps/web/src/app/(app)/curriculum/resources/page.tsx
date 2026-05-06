'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { useCurMaps, useCurUnitsForMap } from '@/hooks/use-curriculum';
import { useState } from 'react';
import { useCurResources } from '@/hooks/use-curriculum';
import {
  CUR_RESOURCE_TYPE_LABELS,
  CUR_RESOURCE_TYPE_PILL,
  formatCurDate,
} from '@/lib/curriculum-format';

/**
 * Resource library — aggregated view of resources across maps + units.
 * The current API only has GET /units/:id/resources, so this page
 * iterates known map → unit → resources to build the catalogue.
 * Non-staff actors don't see is_teacher_only=true rows (server-side
 * filter at ResourceLinkService.listForUnit).
 */
export default function ResourceLibraryPage() {
  const maps = useCurMaps();
  const [activeMapId, setActiveMapId] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Resource library"
        description="Teaching materials across curriculum units. Teacher-only resources are filtered out for non-staff readers."
      />

      <section className="rounded-md border border-gray-200 bg-white p-4">
        <p className="mb-2 text-sm font-medium text-gray-700">Pick a curriculum map</p>
        <div className="flex flex-wrap gap-2">
          {maps.data?.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`rounded-full border px-3 py-1 text-xs ${
                activeMapId === m.id
                  ? 'border-campus-600 bg-campus-100 text-campus-800'
                  : 'border-gray-300 bg-white text-gray-700'
              }`}
              onClick={() => setActiveMapId(m.id)}
            >
              {m.title}
            </button>
          ))}
          {(maps.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-gray-500">No curriculum maps yet.</p>
          ) : null}
        </div>
      </section>

      {activeMapId ? <MapResources mapId={activeMapId} /> : null}
    </div>
  );
}

function MapResources({ mapId }: { mapId: string }) {
  const units = useCurUnitsForMap(mapId);
  return (
    <div className="space-y-4">
      {units.data?.map((u) => (
        <UnitResourceList key={u.id} unitId={u.id} unitTitle={u.title} />
      ))}
      {(units.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-gray-500">No units in this map.</p>
      ) : null}
    </div>
  );
}

function UnitResourceList({ unitId, unitTitle }: { unitId: string; unitTitle: string }) {
  const resources = useCurResources(unitId);
  if ((resources.data?.length ?? 0) === 0) return null;
  return (
    <section className="rounded-md border border-gray-200 bg-white p-4">
      <Link
        href={`/curriculum/units/${unitId}`}
        className="text-sm font-semibold text-campus-700 hover:underline"
      >
        {unitTitle}
      </Link>
      <ul className="mt-2 divide-y divide-gray-100 text-sm">
        {resources.data?.map((r) => (
          <li key={r.id} className="flex items-center justify-between py-2">
            <div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded px-2 py-0.5 text-xs ${CUR_RESOURCE_TYPE_PILL[r.resourceType]}`}
                >
                  {CUR_RESOURCE_TYPE_LABELS[r.resourceType]}
                </span>
                <p className="font-medium">{r.title}</p>
                {r.isTeacherOnly ? (
                  <span className="rounded bg-rose-100 px-2 py-0.5 text-xs text-rose-700">
                    🔒 Teacher only
                  </span>
                ) : null}
              </div>
              {r.description ? <p className="text-xs text-gray-500">{r.description}</p> : null}
              <p className="mt-1 text-xs text-gray-400">Added {formatCurDate(r.createdAt)}</p>
            </div>
            {r.url ? (
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-campus-700 hover:underline"
              >
                Open →
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
