'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { useCurUnit, useCurResources } from '@/hooks/use-curriculum';
import {
  CUR_FRAMEWORK_SOURCE_PILL,
  CUR_FRAMEWORK_SOURCE_LABELS,
  CUR_GAP_TYPE_LABELS,
  CUR_GAP_TYPE_PILL,
  CUR_RESOURCE_TYPE_LABELS,
  CUR_RESOURCE_TYPE_PILL,
  formatCurDate,
} from '@/lib/curriculum-format';

export default function UnitDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const unit = useCurUnit(id);
  const resources = useCurResources(id);

  if (unit.isLoading) {
    return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  }
  if (!unit.data) {
    return <div className="p-6 text-sm text-rose-700">Unit not found.</div>;
  }
  const u = unit.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <Link
        href={`/curriculum/maps/${u.curriculumMapId}`}
        className="text-sm text-campus-700 hover:underline"
      >
        ← Back to map
      </Link>
      <PageHeader title={u.title} description={`Unit ${u.sequenceOrder}`} />

      <div className="rounded-md border border-gray-200 bg-white p-4">
        {u.description ? <p className="text-sm text-gray-700">{u.description}</p> : null}
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div>
            <p className="text-xs uppercase text-gray-500">Weeks</p>
            <p className="font-medium">{u.estimatedWeeks ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-gray-500">Start</p>
            <p className="font-medium">{formatCurDate(u.startDate)}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-gray-500">End</p>
            <p className="font-medium">{formatCurDate(u.endDate)}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-gray-500">Aligned standards</p>
            <p className="font-medium">{u.standardCount}</p>
          </div>
        </div>
        {u.essentialQuestions.length > 0 ? (
          <div className="mt-3">
            <p className="text-xs uppercase text-gray-500">Essential questions</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-gray-700">
              {u.essentialQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <section className="rounded-md border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">
          Aligned standards ({u.standards.length})
        </h2>
        {u.standards.length === 0 ? (
          <p className="text-sm text-gray-500">No standards aligned yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {u.standards.map((s) => {
              const gap = u.gaps.find((g) => g.standardId === s.standardId);
              return (
                <li key={s.id} className="py-2">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="rounded bg-gray-50 px-1 py-0.5 text-xs">
                        {s.standard.code}
                      </code>
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${CUR_FRAMEWORK_SOURCE_PILL[s.standard.source]}`}
                      >
                        {CUR_FRAMEWORK_SOURCE_LABELS[s.standard.source]}
                      </span>
                    </div>
                    {gap ? (
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${CUR_GAP_TYPE_PILL[gap.gapType]}`}
                      >
                        {CUR_GAP_TYPE_LABELS[gap.gapType]} · {gap.lessonsDelivered}/
                        {gap.lessonsPlanned}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-gray-700">{s.standard.description}</p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-md border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">
          Linked lessons ({u.lessons.length}) — Cycle 2 cross-cycle
        </h2>
        {u.lessons.length === 0 ? (
          <p className="text-sm text-gray-500">No lessons linked yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {u.lessons.map((l) => (
              <li key={l.id} className="flex items-center justify-between py-2">
                <div>
                  <p className="font-medium">{l.lessonTitle}</p>
                  <p className="text-xs text-gray-500">
                    {formatCurDate(l.lessonDate)} · {l.lessonStatus}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-md border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">
          Resources ({resources.data?.length ?? 0})
        </h2>
        {(resources.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">No resources yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
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
        )}
      </section>
    </div>
  );
}
