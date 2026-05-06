'use client';

import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useMyEventRsvps, useMyGroups } from '@/hooks/use-groups';
import { useAuthStore } from '@/lib/auth-store';
import { EVENT_TYPE_LABEL, EVENT_TYPE_PILL, formatDateTime } from '@/lib/groups-format';

export default function FeedPage() {
  const user = useAuthStore((s) => s.user);
  const myGroups = useMyGroups(!!user);
  const myRsvps = useMyEventRsvps(!!user);
  if (!user) return null;
  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/groups" className="mb-2 inline-block text-sm text-gray-500 hover:underline">
        ← Back to groups
      </Link>
      <PageHeader title="My feed" description="Upcoming events from groups you're a member of." />

      <h2 className="mb-3 text-sm font-semibold text-gray-700">
        Upcoming events I&apos;ve RSVP&apos;d to
      </h2>
      {myRsvps.isLoading ? (
        <LoadingSpinner />
      ) : myRsvps.data && myRsvps.data.length > 0 ? (
        <ul className="mb-6 space-y-2">
          {myRsvps.data.map((ev) => (
            <li
              key={ev.id}
              className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-3 text-sm"
            >
              <div>
                <p className="font-medium text-gray-900">{ev.title}</p>
                <p className="text-xs text-gray-500">
                  {formatDateTime(ev.startsAt)}
                  {ev.location ? ` · ${ev.location}` : ''}
                </p>
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${EVENT_TYPE_PILL[ev.eventType]}`}
              >
                {EVENT_TYPE_LABEL[ev.eventType]}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No upcoming RSVPs" />
      )}

      <h2 className="mb-3 mt-8 text-sm font-semibold text-gray-700">Quick navigation</h2>
      {myGroups.data && myGroups.data.length > 0 ? (
        <ul className="grid gap-2 md:grid-cols-2">
          {myGroups.data.map((g) => (
            <li key={g.id}>
              <Link
                href={`/groups/${g.id}`}
                className="block rounded-md border border-gray-200 bg-white p-3 text-sm font-medium text-gray-900 hover:border-campus-300 hover:bg-campus-50"
              >
                {g.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
