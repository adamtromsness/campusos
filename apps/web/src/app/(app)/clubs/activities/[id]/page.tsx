'use client';

import Link from 'next/link';
import { use } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useActivity, useJoinActivity, useMyActivities } from '@/hooks/use-clubs';
import { useAuthStore } from '@/lib/auth-store';

const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ROLE_PILL: Record<string, string> = {
  MEMBER: 'bg-gray-100 text-gray-700',
  OFFICER: 'bg-sky-100 text-sky-700',
  PRESIDENT: 'bg-emerald-100 text-emerald-700',
  SECRETARY: 'bg-violet-100 text-violet-700',
};

export default function ActivityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const user = useAuthStore((s) => s.user);
  const isStudent = user?.personType === 'STUDENT';
  const activityQ = useActivity(id, !!user);
  const myMembershipsQ = useMyActivities(!!user && isStudent);
  const join = useJoinActivity(id);
  const { toast } = useToast();

  if (!user) return null;
  if (activityQ.isLoading) {
    return (
      <div className="py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (!activityQ.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Activity not found" />
        <EmptyState
          title="Couldn't load activity"
          action={
            <Link href="/clubs" className="rounded bg-campus-700 px-3 py-1.5 text-sm text-white">
              Back to clubs
            </Link>
          }
        />
      </div>
    );
  }
  const activity = activityQ.data;
  const isAlreadyMember = (myMembershipsQ.data ?? []).some(
    (m) => m.activityId === id && m.isActive,
  );
  const isFull =
    activity.maxParticipants !== null && activity.memberCount >= activity.maxParticipants;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={activity.name} description={activity.activityTypeName ?? undefined} />

      <section className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-500">Status</dt>
            <dd className="mt-1 font-medium text-gray-900">{activity.status}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-500">Members</dt>
            <dd className="mt-1 font-medium text-gray-900">
              {activity.memberCount}
              {activity.maxParticipants !== null ? ` / ${activity.maxParticipants}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-500">Advisor</dt>
            <dd className="mt-1 font-medium text-gray-900">{activity.advisorName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-500">Location</dt>
            <dd className="mt-1 font-medium text-gray-900">{activity.meetingLocation ?? '—'}</dd>
          </div>
        </dl>
        {activity.description ? (
          <p className="mt-3 whitespace-pre-wrap text-sm text-gray-700">{activity.description}</p>
        ) : null}
        {isStudent && activity.status === 'ACTIVE' ? (
          <div className="mt-4 flex items-center gap-2">
            {isAlreadyMember ? (
              <span className="rounded bg-emerald-100 px-3 py-1.5 text-xs font-medium text-emerald-700">
                You are already a member
              </span>
            ) : isFull ? (
              <span className="rounded bg-rose-100 px-3 py-1.5 text-xs font-medium text-rose-700">
                Full ({activity.maxParticipants} member cap reached)
              </span>
            ) : (
              <button
                type="button"
                disabled={join.isPending}
                onClick={async () => {
                  try {
                    await join.mutateAsync({});
                    toast('Joined ' + activity.name, 'success');
                  } catch (err) {
                    toast((err as { message?: string })?.message ?? 'Failed to join', 'error');
                  }
                }}
                className="rounded bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-600 disabled:opacity-50"
              >
                {join.isPending ? 'Joining…' : 'Join this club'}
              </button>
            )}
          </div>
        ) : null}
      </section>

      <section className="mb-6 rounded-lg border border-gray-200 bg-white">
        <h2 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900">
          Members ({activity.members?.length ?? 0})
        </h2>
        {!activity.members || activity.members.length === 0 ? (
          <p className="px-4 py-3 text-sm text-gray-500">No members yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {activity.members.map((m) => (
              <li key={m.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span>{m.studentName ?? '—'}</span>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
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

      <section className="rounded-lg border border-gray-200 bg-white">
        <h2 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900">
          Schedule
        </h2>
        {!activity.schedule || activity.schedule.length === 0 ? (
          <p className="px-4 py-3 text-sm text-gray-500">No recurring schedule yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {activity.schedule.map((s) => (
              <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span>
                  {DAY_LABEL[s.dayOfWeek] ?? '?'} · {s.startTime} – {s.endTime}
                </span>
                <span className="text-gray-500">{s.location ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
