'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { useCurMaps } from '@/hooks/use-curriculum';
import {
  CUR_GAP_TYPE_PILL,
  CUR_MAP_STATUS_LABELS,
  CUR_MAP_STATUS_PILL,
} from '@/lib/curriculum-format';

/**
 * Teacher / Curriculum Coordinator personalised view. The maps
 * endpoint already row-scopes published-only for non-staff
 * personas; teachers + admins see DRAFT + PUBLISHED + ARCHIVED.
 */
export default function MyCurriculumPage() {
  const maps = useCurMaps();

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="My curriculum"
        description="Curriculum maps for the subjects you teach + their gap status"
      />
      {(maps.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-gray-500">No curriculum maps available.</p>
      ) : (
        <ul className="space-y-3">
          {maps.data?.map((m) => (
            <li key={m.id} className="rounded-md border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <Link
                  href={`/curriculum/maps/${m.id}`}
                  className="text-base font-semibold text-campus-700 hover:underline"
                >
                  {m.title}
                </Link>
                <span className={`rounded px-2 py-0.5 text-xs ${CUR_MAP_STATUS_PILL[m.status]}`}>
                  {CUR_MAP_STATUS_LABELS[m.status]}
                </span>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {m.subject} · Grade {m.gradeLevel} · {m.academicYearName}
                {m.frameworkName ? ` · ${m.frameworkName}` : ''}
              </p>
              <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
                <div className="rounded bg-gray-50 p-2">
                  <p className="text-gray-500">Units</p>
                  <p className="text-base font-semibold">{m.unitCount}</p>
                </div>
                <div className="rounded bg-gray-50 p-2">
                  <p className="text-gray-500">Standards</p>
                  <p className="text-base font-semibold">{m.totalStandards}</p>
                </div>
                <div className={`rounded p-2 ${CUR_GAP_TYPE_PILL.COMPLETE}`}>
                  <p>Complete</p>
                  <p className="text-base font-semibold">{m.gapSummary.complete}</p>
                </div>
                <div className={`rounded p-2 ${CUR_GAP_TYPE_PILL.NOT_STARTED}`}>
                  <p>Not started</p>
                  <p className="text-base font-semibold">{m.gapSummary.notStarted}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
