'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useActivities, useMyActivities } from '@/hooks/use-clubs';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { ACTIVITY_CATEGORIES, type ActivityCategory } from '@/lib/types';

const CATEGORY_LABEL: Record<ActivityCategory, string> = {
  SPORT: 'Sport',
  ARTS: 'Arts',
  ACADEMIC: 'Academic',
  LEADERSHIP: 'Leadership',
  COMMUNITY: 'Community',
  OTHER: 'Other',
};
const CATEGORY_PILL: Record<ActivityCategory, string> = {
  SPORT: 'bg-emerald-100 text-emerald-700',
  ARTS: 'bg-violet-100 text-violet-700',
  ACADEMIC: 'bg-sky-100 text-sky-700',
  LEADERSHIP: 'bg-amber-100 text-amber-700',
  COMMUNITY: 'bg-rose-100 text-rose-700',
  OTHER: 'bg-gray-100 text-gray-700',
};

export default function ClubsDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const isStaff = !!user && hasAnyPermission(user, ['clb-001:write']);
  const isStudent = user?.personType === 'STUDENT';
  const [category, setCategory] = useState<ActivityCategory | 'ALL'>('ALL');
  const activitiesQ = useActivities(
    { status: 'ACTIVE', category: category === 'ALL' ? undefined : category },
    !!user,
  );
  const myActivitiesQ = useMyActivities(!!user && isStudent);

  if (!user) return null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Clubs & activities"
        description={
          isStaff
            ? 'Activities and clubs at the school'
            : isStudent
              ? 'Browse clubs and join'
              : 'Clubs at the school'
        }
      />

      {isStudent && myActivitiesQ.data && myActivitiesQ.data.length > 0 ? (
        <section className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <h2 className="mb-2 text-sm font-semibold text-emerald-800">My clubs</h2>
          <ul className="space-y-1 text-sm">
            {myActivitiesQ.data.map((m) => (
              <li key={m.id} className="flex items-center gap-2">
                <span className="rounded bg-emerald-700 px-1.5 py-0.5 text-xs text-white">
                  {m.role}
                </span>
                {m.studentName ?? '—'}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-500">Category:</span>
        <button
          type="button"
          onClick={() => setCategory('ALL')}
          className={`rounded px-2 py-1 text-xs ${
            category === 'ALL' ? 'bg-campus-700 text-white' : 'bg-gray-100 text-gray-700'
          }`}
        >
          All
        </button>
        {ACTIVITY_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            className={`rounded px-2 py-1 text-xs ${
              category === c ? 'bg-campus-700 text-white' : 'bg-gray-100 text-gray-700'
            }`}
          >
            {CATEGORY_LABEL[c]}
          </button>
        ))}
        <span className="ml-auto flex gap-2">
          {isStaff ? (
            <Link
              href="/clubs/field-trips"
              className="rounded bg-campus-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-campus-600"
            >
              Field trips
            </Link>
          ) : null}
          {isStudent ? (
            <Link
              href="/clubs/my"
              className="rounded bg-campus-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-campus-600"
            >
              My portal
            </Link>
          ) : null}
        </span>
      </div>

      {activitiesQ.isLoading ? (
        <div className="py-12 text-center">
          <LoadingSpinner />
        </div>
      ) : activitiesQ.data && activitiesQ.data.length === 0 ? (
        <EmptyState title="No activities" description="No active clubs match your filter." />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(activitiesQ.data ?? []).map((a) => (
            <li
              key={a.id}
              className="rounded-lg border border-gray-200 bg-white p-4 transition-colors hover:border-campus-300"
            >
              <Link href={`/clubs/activities/${a.id}`} className="block">
                <div className="mb-2 flex items-center justify-between">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      CATEGORY_PILL[a.activityTypeCategory ?? 'OTHER'] ??
                      'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {a.activityTypeName ?? '—'}
                  </span>
                  <span className="text-xs text-gray-500">
                    {a.memberCount}
                    {a.maxParticipants !== null ? `/${a.maxParticipants}` : ''} members
                  </span>
                </div>
                <h3 className="text-base font-semibold text-gray-900">{a.name}</h3>
                {a.description ? (
                  <p className="mt-1 line-clamp-2 text-sm text-gray-600">{a.description}</p>
                ) : null}
                <p className="mt-2 text-xs text-gray-500">
                  Advisor: {a.advisorName ?? 'Unassigned'}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
