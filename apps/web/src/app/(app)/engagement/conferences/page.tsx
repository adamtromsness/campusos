'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState, PageHeader } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useConferenceEvents,
  useCreateConferenceEvent,
  useMyBookings,
  useUpdateConferenceEvent,
} from '@/hooks/use-engagement';
import type {
  EngConferenceEventDto,
  EngConferenceEventStatus,
  CreateEngConferenceEventPayload,
} from '@/lib/types';
import {
  CONFERENCE_EVENT_STATUS_LABEL,
  CONFERENCE_EVENT_STATUS_PILL,
  daysUntil,
  formatDateOnly,
  formatDateTime,
  isBookingWindowOpen,
} from '@/lib/engagement-format';

const STATUS_FILTERS: Array<{ key: 'all' | 'live' | 'completed'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Open / In progress' },
  { key: 'completed', label: 'Completed' },
];

export default function ConferenceBookingPortalPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user?.personType === 'STAFF' || isAdmin;
  const isParent = user?.personType === 'GUARDIAN';
  const canManageEvents = isAdmin || hasAnyPermission(user, ['mtg-002:write', 'mtg-002:admin']);

  const [filter, setFilter] = useState<'all' | 'live' | 'completed'>('all');
  const [showCreate, setShowCreate] = useState(false);

  const eventsQ = useConferenceEvents();
  const myBookingsQ = useMyBookings(isParent);

  const filteredEvents = useMemo(() => {
    const rows = eventsQ.data ?? [];
    if (filter === 'live')
      return rows.filter((r) => r.status === 'BOOKING_OPEN' || r.status === 'IN_PROGRESS');
    if (filter === 'completed') return rows.filter((r) => r.status === 'COMPLETED');
    return rows;
  }, [eventsQ.data, filter]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Parent-Teacher Conferences"
        description={
          isParent
            ? 'Book a time with your child’s teacher. View and cancel your bookings.'
            : 'Schedule conference events, publish availability, and document outcomes.'
        }
      />

      {/* Quick stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total events" value={eventsQ.data?.length ?? 0} />
        <StatCard
          label="Open for booking"
          value={(eventsQ.data ?? []).filter((e) => e.status === 'BOOKING_OPEN').length}
        />
        <StatCard
          label="In progress"
          value={(eventsQ.data ?? []).filter((e) => e.status === 'IN_PROGRESS').length}
        />
        {isParent ? (
          <StatCard label="My bookings" value={myBookingsQ.data?.length ?? 0} tone="sky" />
        ) : (
          <StatCard
            label="Completed"
            value={(eventsQ.data ?? []).filter((e) => e.status === 'COMPLETED').length}
            tone="gray"
          />
        )}
      </div>

      {/* Module nav strip */}
      {isStaff ? (
        <nav className="flex flex-wrap gap-2 text-sm">
          <Link
            href="/engagement/dashboard"
            className="rounded-full bg-campus-50 px-3 py-1 font-medium text-campus-700 hover:bg-campus-100"
          >
            Engagement dashboard →
          </Link>
          <Link
            href="/engagement/surveys"
            className="rounded-full bg-campus-50 px-3 py-1 font-medium text-campus-700 hover:bg-campus-100"
          >
            Surveys →
          </Link>
        </nav>
      ) : null}

      {/* Parent: my bookings panel */}
      {isParent && (myBookingsQ.data?.length ?? 0) > 0 ? (
        <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">My bookings</h2>
            <span className="text-xs text-gray-500">{myBookingsQ.data!.length} total</span>
          </div>
          <ul className="mt-3 space-y-2">
            {(myBookingsQ.data ?? [])
              .filter((b) => !b.cancelledAt)
              .slice(0, 6)
              .map((b) => (
                <li
                  key={b.id}
                  className="flex items-center justify-between rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-sm"
                >
                  <div>
                    <div className="font-medium text-gray-800">
                      Booking · {formatDateTime(b.bookedAt)}
                    </div>
                    <div className="text-xs text-gray-500">
                      Student id: {b.studentId.slice(0, 8)}…
                    </div>
                  </div>
                  {b.attended === true ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                      Attended
                    </span>
                  ) : b.cancelledAt ? (
                    <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-rose-200">
                      Cancelled
                    </span>
                  ) : (
                    <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-sky-200">
                      Upcoming
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      {/* Filter + New event */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={
                'rounded-full px-3 py-1 text-xs font-medium ring-1 ' +
                (filter === f.key
                  ? 'bg-campus-600 text-white ring-campus-600'
                  : 'bg-white text-gray-700 ring-gray-200 hover:bg-gray-50')
              }
            >
              {f.label}
            </button>
          ))}
        </div>
        {canManageEvents ? (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            + New conference
          </button>
        ) : null}
      </div>

      {/* Events list */}
      {filteredEvents.length === 0 ? (
        <EmptyState
          title="No conference events"
          description={
            canManageEvents
              ? 'Create the first conference week to start scheduling availability.'
              : 'There are no parent-teacher conferences scheduled yet.'
          }
        />
      ) : (
        <ul className="space-y-3">
          {filteredEvents.map((evt) => (
            <ConferenceRow key={evt.id} event={evt} canManage={canManageEvents} />
          ))}
        </ul>
      )}

      {showCreate ? <CreateConferenceModal onClose={() => setShowCreate(false)} /> : null}
    </div>
  );
}

function ConferenceRow({ event, canManage }: { event: EngConferenceEventDto; canManage: boolean }) {
  const updateMut = useUpdateConferenceEvent();
  const open = isBookingWindowOpen(event.bookingOpensAt, event.bookingClosesAt);
  const daysToOpen = daysUntil(event.bookingOpensAt) ?? 0;
  const daysToClose = daysUntil(event.bookingClosesAt) ?? 0;

  function handleAdvance(next: EngConferenceEventStatus): void {
    updateMut.mutate({ id: event.id, body: { status: next } });
  }

  return (
    <li className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href={`/engagement/conferences/${event.id}`}
              className="text-lg font-semibold text-campus-700 hover:underline"
            >
              {event.title}
            </Link>
            <span
              className={
                'rounded-full px-2 py-0.5 text-xs font-medium ' +
                CONFERENCE_EVENT_STATUS_PILL[event.status]
              }
            >
              {CONFERENCE_EVENT_STATUS_LABEL[event.status]}
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {formatDateOnly(event.startDate)} → {formatDateOnly(event.endDate)} ·{' '}
            {event.defaultSlotDurationMinutes}-min slots
          </p>
          {event.description ? (
            <p className="mt-1 text-sm text-gray-700">{event.description}</p>
          ) : null}
        </div>
        <div className="text-right text-xs text-gray-500">
          {open ? (
            <span className="font-semibold text-emerald-700">
              Booking open — closes {daysToClose === 0 ? 'today' : `in ${daysToClose}d`}
            </span>
          ) : event.status === 'DRAFT' ? (
            <span>
              Opens {daysToOpen >= 0 ? `in ${daysToOpen}d` : `${Math.abs(daysToOpen)}d ago`}
            </span>
          ) : event.status === 'COMPLETED' ? (
            <span className="text-gray-500">Ended {formatDateOnly(event.endDate)}</span>
          ) : (
            <span>Window: {formatDateTime(event.bookingOpensAt)}</span>
          )}
        </div>
      </div>

      {canManage ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {event.status === 'DRAFT' ? (
            <button
              type="button"
              onClick={() => handleAdvance('BOOKING_OPEN')}
              disabled={updateMut.isPending}
              className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Open booking
            </button>
          ) : null}
          {event.status === 'BOOKING_OPEN' ? (
            <button
              type="button"
              onClick={() => handleAdvance('IN_PROGRESS')}
              disabled={updateMut.isPending}
              className="rounded-md bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
            >
              Mark in progress
            </button>
          ) : null}
          {event.status === 'BOOKING_OPEN' || event.status === 'IN_PROGRESS' ? (
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Mark this conference as completed?'))
                  handleAdvance('COMPLETED');
              }}
              disabled={updateMut.isPending}
              className="rounded-md bg-gray-700 px-3 py-1 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              Mark completed
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'amber' | 'rose' | 'sky' | 'gray';
}) {
  const valueClass =
    tone === 'rose' && value > 0
      ? 'text-rose-700'
      : tone === 'amber' && value > 0
        ? 'text-amber-700'
        : tone === 'sky' && value > 0
          ? 'text-sky-700'
          : 'text-gray-900';
  return (
    <div className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={'mt-1 text-2xl font-semibold ' + valueClass}>{value}</div>
    </div>
  );
}

function CreateConferenceModal({ onClose }: { onClose: () => void }) {
  const mut = useCreateConferenceEvent();
  const [form, setForm] = useState<CreateEngConferenceEventPayload>({
    title: '',
    description: '',
    startDate: '',
    endDate: '',
    bookingOpensAt: '',
    bookingClosesAt: '',
    defaultSlotDurationMinutes: 10,
    defaultBreakMinutes: 5,
  });
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await mut.mutateAsync({
        ...form,
        description: form.description?.trim() || undefined,
        bookingOpensAt: new Date(form.bookingOpensAt).toISOString(),
        bookingClosesAt: new Date(form.bookingClosesAt).toISOString(),
      });
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form onSubmit={submit} className="w-full max-w-lg rounded-card bg-white p-5 shadow-lg">
        <h2 className="text-lg font-semibold text-gray-900">New conference event</h2>
        <p className="mt-1 text-sm text-gray-500">
          Conferences start as DRAFT. Open booking once availability is published.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600">Title</label>
            <input
              type="text"
              required
              maxLength={200}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">
              Description (optional)
            </label>
            <textarea
              rows={2}
              maxLength={2000}
              value={form.description ?? ''}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600">Start date</label>
              <input
                type="date"
                required
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">End date</label>
              <input
                type="date"
                required
                value={form.endDate}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600">Booking opens at</label>
              <input
                type="datetime-local"
                required
                value={form.bookingOpensAt}
                onChange={(e) => setForm({ ...form, bookingOpensAt: e.target.value })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">Booking closes at</label>
              <input
                type="datetime-local"
                required
                value={form.bookingClosesAt}
                onChange={(e) => setForm({ ...form, bookingClosesAt: e.target.value })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600">Slot duration (min)</label>
              <input
                type="number"
                min={1}
                max={240}
                value={form.defaultSlotDurationMinutes ?? 10}
                onChange={(e) =>
                  setForm({ ...form, defaultSlotDurationMinutes: Number(e.target.value) })
                }
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">Break (min)</label>
              <input
                type="number"
                min={0}
                value={form.defaultBreakMinutes ?? 5}
                onChange={(e) => setForm({ ...form, defaultBreakMinutes: Number(e.target.value) })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
          </div>
        </div>

        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mut.isPending}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            {mut.isPending ? 'Creating…' : 'Create draft'}
          </button>
        </div>
      </form>
    </div>
  );
}
