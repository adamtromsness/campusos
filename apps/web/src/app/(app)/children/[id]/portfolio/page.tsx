'use client';

import Link from 'next/link';
import { PageHeader, EmptyState } from '@/components/ui';
import { usePortfolioForStudent, useStudentAchievements } from '@/hooks/use-portfolio';
import {
  ACHIEVEMENT_TYPE_LABELS,
  ACHIEVEMENT_TYPE_PILL,
  ITEM_TYPE_LABELS,
  ITEM_TYPE_PILL,
  VISIBILITY_LABELS,
  VISIBILITY_PILL,
  formatDate,
} from '@/lib/portfolio-format';

export default function ChildPortfolioPage({ params }: { params: { id: string } }) {
  const portfolio = usePortfolioForStudent(params.id);
  const achievements = useStudentAchievements(params.id);

  if (portfolio.isError && (portfolio.error as { status?: number })?.status === 404) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <PageHeader title="Portfolio" description="" />
        <EmptyState
          title="No portfolio shared"
          description="Your child hasn’t made their portfolio visible to parents yet."
        />
      </div>
    );
  }
  if (!portfolio.data) {
    return <p className="p-6 text-sm text-gray-500">Loading…</p>;
  }

  const featured = portfolio.data.items.filter((i) => i.isFeatured);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader
        title={portfolio.data.title}
        description={`${portfolio.data.studentName ?? 'Your child'}'s portfolio`}
      />
      <div className="flex items-center gap-2">
        <span
          className={`rounded px-2 py-0.5 text-xs ${VISIBILITY_PILL[portfolio.data.visibility]}`}
        >
          {VISIBILITY_LABELS[portfolio.data.visibility]}
        </span>
        <Link href="/children" className="text-sm text-campus-700 hover:underline">
          ← Back to my children
        </Link>
      </div>

      {portfolio.data.description && (
        <p className="text-sm text-gray-700">{portfolio.data.description}</p>
      )}

      {featured.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-amber-700">
            ★ Featured
          </h2>
          <ul className="space-y-2">
            {featured.map((it) => (
              <li key={it.id} className="rounded-md border border-amber-200 bg-amber-50/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-gray-900">{it.title}</p>
                  <span className={`rounded px-2 py-0.5 text-xs ${ITEM_TYPE_PILL[it.itemType]}`}>
                    {ITEM_TYPE_LABELS[it.itemType]}
                  </span>
                </div>
                {it.sourceTitle && <p className="text-xs text-gray-500">From: {it.sourceTitle}</p>}
                {it.description && <p className="mt-1 text-sm text-gray-700">{it.description}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Items</h2>
        {portfolio.data.items.length === 0 ? (
          <p className="text-sm text-gray-500">No items yet.</p>
        ) : (
          <ul className="space-y-2">
            {portfolio.data.items.map((it) => (
              <li key={it.id} className="rounded-md border border-gray-200 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900">{it.title}</p>
                    {it.sourceTitle && <p className="text-xs text-gray-500">{it.sourceTitle}</p>}
                    {it.description && (
                      <p className="mt-1 text-sm text-gray-700">{it.description}</p>
                    )}
                    <p className="mt-1 text-xs text-gray-400">{formatDate(it.addedAt)}</p>
                  </div>
                  <span className={`rounded px-2 py-0.5 text-xs ${ITEM_TYPE_PILL[it.itemType]}`}>
                    {ITEM_TYPE_LABELS[it.itemType]}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Achievements
        </h2>
        {(achievements.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">No achievements yet.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {achievements.data!.map((a) => (
              <li key={a.id} className="rounded-md border border-gray-200 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-gray-900">{a.title}</p>
                    <p className="text-xs text-gray-500">{formatDate(a.awardedAt)}</p>
                  </div>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${ACHIEVEMENT_TYPE_PILL[a.achievementType]}`}
                  >
                    {ACHIEVEMENT_TYPE_LABELS[a.achievementType]}
                  </span>
                </div>
                {a.description && <p className="mt-2 text-sm text-gray-700">{a.description}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
