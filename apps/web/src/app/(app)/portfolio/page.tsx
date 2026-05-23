'use client';

import Link from 'next/link';
import { PageHeader, EmptyState } from '@/components/ui';
import { useAuthStore } from '@/lib/auth-store';
import { useMyPortfolio, useAchievements, useCreatePortfolio } from '@/hooks/use-portfolio';
import {
  ACHIEVEMENT_TYPE_PILL,
  ACHIEVEMENT_TYPE_LABELS,
  ITEM_TYPE_LABELS,
  ITEM_TYPE_PILL,
  VISIBILITY_LABELS,
  VISIBILITY_PILL,
  formatDate,
} from '@/lib/portfolio-format';

export default function PortfolioPage() {
  const { user } = useAuthStore();
  const isStudent = user?.activePersona?.type === 'STUDENT';

  if (isStudent) {
    return <StudentPortfolioLanding />;
  }
  return <NonStudentLanding />;
}

function StudentPortfolioLanding() {
  const my = useMyPortfolio();
  const achievements = useAchievements();
  const create = useCreatePortfolio();

  if (my.isError && (my.error as { status?: number })?.status === 404) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <PageHeader
          title="Your portfolio"
          description="Curate your academic journey — submissions, grades, achievements, and reflections you’re proud of."
        />
        <EmptyState
          title="You don’t have a portfolio yet"
          description="Create one to start building your academic story. You control who sees it."
          action={
            <button
              type="button"
              onClick={() =>
                create.mutate({
                  title: 'My Academic Journey',
                  visibility: 'PRIVATE',
                })
              }
              className="rounded-md bg-campus-700 px-4 py-2 text-sm font-medium text-white hover:bg-campus-800"
            >
              {create.isPending ? 'Creating…' : 'Create my portfolio'}
            </button>
          }
        />
      </div>
    );
  }

  if (!my.data) {
    return <p className="p-6 text-sm text-gray-500">Loading your portfolio…</p>;
  }

  const featured = my.data.items.filter((i) => i.isFeatured);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title={my.data.title}
        description={my.data.description ?? 'Your academic journey'}
      />

      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${VISIBILITY_PILL[my.data.visibility]}`}
        >
          {VISIBILITY_LABELS[my.data.visibility]}
        </span>
        <Link
          href="/portfolio/edit"
          className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
        >
          Edit portfolio
        </Link>
        <Link
          href="/portfolio/achievements"
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Achievement gallery
        </Link>
        <Link
          href="/portfolio/readiness"
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Readiness pathway
        </Link>
        <Link
          href="/portfolio/college"
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          College applications
        </Link>
        <Link
          href="/portfolio/resume"
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Resume builder
        </Link>
      </div>

      <section className="grid grid-cols-3 gap-3">
        <Stat label="Items" value={my.data.itemCount} />
        <Stat label="Achievements" value={my.data.achievementCount} />
        <Stat label="Featured" value={featured.length} />
      </section>

      {featured.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Featured
          </h2>
          <ul className="space-y-2">
            {featured.map((it) => (
              <li key={it.id} className="rounded-md border border-amber-200 bg-amber-50/50 p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium text-gray-900">{it.title}</p>
                  <span className={`rounded px-2 py-0.5 text-xs ${ITEM_TYPE_PILL[it.itemType]}`}>
                    {ITEM_TYPE_LABELS[it.itemType]}
                  </span>
                </div>
                {it.sourceTitle && (
                  <p className="mt-1 text-xs text-gray-500">From: {it.sourceTitle}</p>
                )}
                {it.description && <p className="mt-1 text-sm text-gray-700">{it.description}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          All items
        </h2>
        {my.data.items.length === 0 ? (
          <p className="text-sm text-gray-500">No items yet. Open the editor to add your work.</p>
        ) : (
          <ul className="space-y-2">
            {my.data.items.map((it) => (
              <li key={it.id} className="rounded-md border border-gray-200 bg-white p-3">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-gray-900">{it.title}</p>
                  <span className={`rounded px-2 py-0.5 text-xs ${ITEM_TYPE_PILL[it.itemType]}`}>
                    {ITEM_TYPE_LABELS[it.itemType]}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500">{formatDate(it.addedAt)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Recent achievements
        </h2>
        {(achievements.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">No achievements yet.</p>
        ) : (
          <ul className="space-y-2">
            {achievements.data!.slice(0, 5).map((a) => (
              <li key={a.id} className="rounded-md border border-gray-200 bg-white p-3">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-gray-900">{a.title}</p>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${ACHIEVEMENT_TYPE_PILL[a.achievementType]}`}
                  >
                    {ACHIEVEMENT_TYPE_LABELS[a.achievementType]}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {formatDate(a.awardedAt)}
                  {a.sourceModule ? ` · from ${a.sourceModule}` : ''}
                  {a.awardedByName ? ` · awarded by ${a.awardedByName}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function NonStudentLanding() {
  const achievements = useAchievements();
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Achievements"
        description="Recently awarded student achievements across the school."
      />
      {(achievements.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-gray-500">No achievements yet.</p>
      ) : (
        <ul className="space-y-2">
          {achievements.data!.map((a) => (
            <li key={a.id} className="rounded-md border border-gray-200 bg-white p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-gray-900">{a.title}</p>
                  <p className="text-xs text-gray-500">
                    {a.studentName ?? 'Student'} · {formatDate(a.awardedAt)}
                  </p>
                </div>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${ACHIEVEMENT_TYPE_PILL[a.achievementType]}`}
                >
                  {ACHIEVEMENT_TYPE_LABELS[a.achievementType]}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4 text-center">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    </div>
  );
}
