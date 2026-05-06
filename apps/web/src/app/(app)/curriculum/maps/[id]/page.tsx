'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import { useCurMap, useCurUnitsForMap, useUpdateCurMap } from '@/hooks/use-curriculum';
import {
  CUR_GAP_TYPE_PILL,
  CUR_MAP_STATUS_LABELS,
  CUR_MAP_STATUS_PILL,
  formatCurDate,
} from '@/lib/curriculum-format';

export default function CurriculumMapDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const user = useAuthStore((s) => s.user);
  const isWriter = hasAnyPermission(user, ['tch-008:write']);
  const { toast } = useToast();

  const map = useCurMap(id);
  const units = useCurUnitsForMap(id);
  const updateMap = useUpdateCurMap(id);

  async function transition(target: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED') {
    try {
      await updateMap.mutateAsync({ status: target });
      toast(`Status set to ${target}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  if (map.isLoading) {
    return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  }
  if (!map.data) {
    return <div className="p-6 text-sm text-rose-700">Map not found.</div>;
  }
  const m = map.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title={m.title}
        description={`${m.subject} · Grade ${m.gradeLevel} · ${m.academicYearName}`}
      />

      <div className="rounded-md border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-xs ${CUR_MAP_STATUS_PILL[m.status]}`}>
            {CUR_MAP_STATUS_LABELS[m.status]}
          </span>
          {m.frameworkName ? (
            <span className="rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-700">
              {m.frameworkName} ({m.frameworkSource})
            </span>
          ) : null}
          <span className="text-xs text-gray-500">
            {m.unitCount} unit{m.unitCount === 1 ? '' : 's'} · {m.totalStandards} aligned standards
          </span>
        </div>
        {m.description ? (
          <p className="mt-3 whitespace-pre-wrap text-sm text-gray-700">{m.description}</p>
        ) : null}
        {m.publishedAt ? (
          <p className="mt-2 text-xs text-gray-500">Published {formatCurDate(m.publishedAt)}</p>
        ) : null}
        {m.archivedAt ? (
          <p className="text-xs text-gray-500">Archived {formatCurDate(m.archivedAt)}</p>
        ) : null}

        {isWriter ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {m.status !== 'PUBLISHED' ? (
              <button
                type="button"
                onClick={() => transition('PUBLISHED')}
                className="rounded-md bg-emerald-600 px-3 py-1 text-sm text-white hover:bg-emerald-700"
              >
                Publish
              </button>
            ) : null}
            {m.status !== 'DRAFT' ? (
              <button
                type="button"
                onClick={() => transition('DRAFT')}
                className="rounded-md border border-gray-300 bg-white px-3 py-1 text-sm hover:bg-gray-50"
              >
                Back to draft
              </button>
            ) : null}
            {m.status !== 'ARCHIVED' ? (
              <button
                type="button"
                onClick={() => transition('ARCHIVED')}
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1 text-sm text-amber-800 hover:bg-amber-100"
              >
                Archive
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">
          Scope & sequence ({units.data?.length ?? 0} units)
        </h2>
        {(units.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">No units yet.</p>
        ) : (
          <ol className="space-y-2">
            {units.data?.map((u) => (
              <li key={u.id} className="rounded-md border border-gray-200 bg-white p-3">
                <div className="flex items-center justify-between">
                  <Link
                    href={`/curriculum/units/${u.id}`}
                    className="font-medium text-campus-700 hover:underline"
                  >
                    {u.sequenceOrder}. {u.title}
                  </Link>
                  <div className="flex gap-1 text-xs">
                    {u.gapSummary.complete > 0 ? (
                      <span className={`rounded px-2 py-0.5 ${CUR_GAP_TYPE_PILL.COMPLETE}`}>
                        ✓ {u.gapSummary.complete}
                      </span>
                    ) : null}
                    {u.gapSummary.partial > 0 ? (
                      <span className={`rounded px-2 py-0.5 ${CUR_GAP_TYPE_PILL.PARTIAL}`}>
                        ◐ {u.gapSummary.partial}
                      </span>
                    ) : null}
                    {u.gapSummary.notStarted > 0 ? (
                      <span className={`rounded px-2 py-0.5 ${CUR_GAP_TYPE_PILL.NOT_STARTED}`}>
                        ○ {u.gapSummary.notStarted}
                      </span>
                    ) : null}
                  </div>
                </div>
                {u.description ? (
                  <p className="mt-1 text-xs text-gray-500 line-clamp-2">{u.description}</p>
                ) : null}
                <p className="mt-1 text-xs text-gray-400">
                  {u.estimatedWeeks
                    ? `${u.estimatedWeeks} week${u.estimatedWeeks === 1 ? '' : 's'} · `
                    : ''}
                  {u.standardCount} standard{u.standardCount === 1 ? '' : 's'} · {u.lessonCount}{' '}
                  lesson{u.lessonCount === 1 ? '' : 's'} · {u.resourceCount} resource
                  {u.resourceCount === 1 ? '' : 's'}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
