'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { useConferences, useMeetings, useMyActionItems } from '@/hooks/use-meetings';
import { useAuthStore } from '@/lib/auth-store';
import type { ConferenceEventDto, MeetingDto } from '@/lib/types';

const STATUS_PILL: Record<string, string> = {
  SCHEDULED: 'bg-sky-100 text-sky-800',
  IN_PROGRESS: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-gray-100 text-gray-700',
  ACTIVE: 'bg-amber-100 text-amber-800',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function MeetingsDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const meetingsQ = useMeetings({});
  const conferencesQ = useConferences();
  const myActionsQ = useMyActionItems('OPEN');

  const upcomingMeetings: MeetingDto[] = (meetingsQ.data ?? [])
    .filter((m) => m.status === 'SCHEDULED' || m.status === 'IN_PROGRESS')
    .slice(0, 8);
  const upcomingConferences: ConferenceEventDto[] = (conferencesQ.data ?? []).filter(
    (c) => c.status === 'SCHEDULED' || c.status === 'ACTIVE',
  );
  const openActions = myActionsQ.data ?? [];

  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader
        title="Meetings"
        description={
          user?.personType === 'GUARDIAN'
            ? 'Upcoming conferences, your appointments, and action items.'
            : 'Conferences, meetings, action items, and IEP records.'
        }
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/meetings/action-items"
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              My action items
              {openActions.length > 0 && (
                <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-100 px-1.5 text-xs font-bold text-rose-800">
                  {openActions.length}
                </span>
              )}
            </Link>
          </div>
        }
      />

      {upcomingConferences.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3 text-lg font-semibold text-gray-900">Upcoming conferences</h2>
          <div className="space-y-3">
            {upcomingConferences.map((c) => (
              <Link
                key={c.id}
                href={'/meetings/conferences/' + c.id}
                className="block rounded-lg border border-gray-200 bg-white p-4 shadow-sm hover:border-campus-700"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-gray-900">{c.title}</h3>
                      <span
                        className={
                          'rounded-full px-2 py-0.5 text-xs font-semibold ' +
                          (STATUS_PILL[c.status] ?? 'bg-gray-100 text-gray-700')
                        }
                      >
                        {c.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      {c.conferenceType.replace(/_/g, ' ')} · {formatDate(c.startDate)} —{' '}
                      {formatDate(c.endDate)}
                    </p>
                    <p className="mt-2 text-xs text-gray-700">
                      {c.bookedSlots ?? 0} of {c.totalSlots ?? 0} slots booked
                      {c.meetingCount ? ' · ' + c.meetingCount + ' meetings' : ''}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-campus-700">View →</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Upcoming meetings</h2>
        {upcomingMeetings.length === 0 ? (
          <EmptyState
            title="No upcoming meetings"
            description="Meetings you organise or attend will appear here."
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Title
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Type
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                    When
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {upcomingMeetings.map((m) => (
                  <tr key={m.id}>
                    <td className="px-4 py-3">
                      <Link
                        href={'/meetings/' + m.id}
                        className="font-medium text-campus-700 hover:underline"
                      >
                        {m.title}
                      </Link>
                      <div className="text-xs text-gray-500">
                        {m.organiserName ? 'Organised by ' + m.organiserName : ''}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700">{m.meetingTypeName ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-700">
                      {formatDateTime(m.scheduledAt)} · {m.durationMinutes} min
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          'rounded-full px-2 py-0.5 text-xs font-semibold ' +
                          (STATUS_PILL[m.status] ?? 'bg-gray-100 text-gray-700')
                        }
                      >
                        {m.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
