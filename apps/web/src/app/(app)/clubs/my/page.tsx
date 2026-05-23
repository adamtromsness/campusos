'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useElections, useMyActivities, useMyServiceProgress } from '@/hooks/use-clubs';
import { useAuthStore } from '@/lib/auth-store';

const ROLE_PILL: Record<string, string> = {
  MEMBER: 'bg-gray-100 text-gray-700',
  OFFICER: 'bg-sky-100 text-sky-700',
  PRESIDENT: 'bg-emerald-100 text-emerald-700',
  SECRETARY: 'bg-violet-100 text-violet-700',
};

export default function StudentClubsPortalPage() {
  const user = useAuthStore((s) => s.user);
  const isStudent = user?.activePersona?.type === 'STUDENT';
  const myActivitiesQ = useMyActivities(!!user && isStudent);
  const electionsQ = useElections(!!user && isStudent);
  const progressQ = useMyServiceProgress(!!user && isStudent);

  if (!user) return null;
  if (!isStudent) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="My clubs" description="Student portal" />
        <p className="text-sm text-gray-500">This portal is for students.</p>
      </div>
    );
  }

  const openElections = (electionsQ.data ?? []).filter((e) => e.status === 'OPEN');

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="My clubs & student life" />

      {/* My clubs */}
      <section className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">My clubs</h2>
        {myActivitiesQ.isLoading ? (
          <LoadingSpinner />
        ) : !myActivitiesQ.data || myActivitiesQ.data.length === 0 ? (
          <p className="text-sm text-gray-500">
            You have not joined any clubs yet.{' '}
            <Link href="/clubs" className="text-campus-700 hover:underline">
              Browse activities →
            </Link>
          </p>
        ) : (
          <ul className="space-y-2">
            {myActivitiesQ.data.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between rounded border border-gray-100 bg-gray-50 px-3 py-2 text-sm"
              >
                <span>
                  <Link
                    href={`/clubs/activities/${m.activityId}`}
                    className="font-medium text-gray-900 hover:underline"
                  >
                    {m.studentName ?? '—'}
                  </Link>{' '}
                  · joined {m.joinedAt}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${
                    ROLE_PILL[m.role] ?? 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {m.role}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Open elections */}
      {openElections.length > 0 ? (
        <section className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="mb-3 text-sm font-semibold text-amber-900">Active elections</h2>
          <ul className="space-y-2">
            {openElections.map((e) => (
              <li key={e.id} className="flex items-center justify-between text-sm">
                <span className="font-medium text-amber-900">{e.title}</span>
                <Link
                  href={`/clubs/elections/${e.id}/vote`}
                  className="rounded bg-campus-700 px-3 py-1 text-xs font-medium text-white hover:bg-campus-600"
                >
                  Vote →
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Service progress */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">Service progress</h2>
        {progressQ.isLoading ? (
          <LoadingSpinner />
        ) : !progressQ.data || progressQ.data.length === 0 ? (
          <p className="text-sm text-gray-500">
            No service hours logged.{' '}
            <Link href="/clubs/service-hours" className="text-campus-700 hover:underline">
              Log hours →
            </Link>
          </p>
        ) : (
          <>
            <ul className="space-y-3">
              {progressQ.data.map((p) => {
                const target = p.targetHours ?? 0;
                const pct = target > 0 ? Math.min(100, (p.approvedHours / target) * 100) : 0;
                return (
                  <li key={p.id}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium text-gray-900">{p.programmeName}</span>
                      <span className="text-gray-600">
                        {p.approvedHours} / {target} hr
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
                      <div
                        className={p.isComplete ? 'h-full bg-emerald-500' : 'h-full bg-campus-600'}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
            <Link
              href="/clubs/service-progress"
              className="mt-3 inline-block text-xs font-medium text-campus-700 hover:underline"
            >
              See all programmes →
            </Link>
          </>
        )}
      </section>
    </div>
  );
}
