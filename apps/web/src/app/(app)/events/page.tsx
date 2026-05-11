'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState, LoadingSpinner, PageHeader } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useEvents } from '@/hooks/use-events';
import {
  EVT_EVENT_STATUSES,
  EVT_EVENT_STATUS_LABELS,
  EVT_EVENT_STATUS_PILL,
  EVT_EVENT_TYPES,
  EVT_EVENT_TYPE_LABELS,
  EVT_EVENT_TYPE_PILL,
  formatCurrency,
  formatEventDate,
  formatEventTime,
  tierAvailabilityLabel,
  tierAvailabilityTone,
} from '@/lib/events-format';
import type { EvtEventStatus, EvtEventType } from '@/lib/types';

export default function EventsCalendarPage() {
  const user = useAuthStore((s) => s.user);
  const isManager = user ? hasAnyPermission(user, ['evt-001:write', 'sch-001:admin']) : false;

  const [eventType, setEventType] = useState<EvtEventType | ''>('');
  const [statusFilter, setStatusFilter] = useState<EvtEventStatus | ''>('');

  const today = new Date().toISOString().slice(0, 10);
  const eventsQ = useEvents({
    eventType: eventType || undefined,
    status: statusFilter || undefined,
    fromDate: today,
  });

  const events = useMemo(() => eventsQ.data ?? [], [eventsQ.data]);

  return (
    <div>
      <PageHeader
        title="Events"
        description={
          isManager
            ? 'Browse upcoming events, manage tickets, and run the gate scanner.'
            : 'Browse upcoming events and buy tickets.'
        }
        actions={
          isManager && (
            <div className="flex flex-wrap gap-2">
              <Link
                href="/events/gate"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
              >
                Gate scanner
              </Link>
              <Link
                href="/events/admin"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
              >
                Event admin
              </Link>
              <Link
                href="/events/admin/revenue"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
              >
                Revenue
              </Link>
              <Link
                href="/events/my-tickets"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
              >
                My tickets
              </Link>
            </div>
          )
        }
      />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <select
          value={eventType}
          onChange={(e) => setEventType(e.target.value as EvtEventType | '')}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
        >
          <option value="">All types</option>
          {EVT_EVENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {EVT_EVENT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        {isManager && (
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as EvtEventStatus | '')}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
          >
            <option value="">All statuses</option>
            {EVT_EVENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {EVT_EVENT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        )}
        {!isManager && (
          <Link
            href="/events/my-tickets"
            className="ml-auto text-sm font-medium text-blue-700 hover:underline"
          >
            My tickets →
          </Link>
        )}
      </div>

      <div className="mt-6">
        {eventsQ.isLoading ? (
          <LoadingSpinner />
        ) : events.length === 0 ? (
          <EmptyState title="No upcoming events" description="Check back soon for new events." />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {events.map((ev) => {
              const totalSold = (ev.tiers ?? []).reduce((acc, t) => acc + t.quantitySold, 0);
              const totalCap = (ev.tiers ?? []).reduce((acc, t) => acc + t.quantity, 0);
              const totalLeft = Math.max(totalCap - totalSold, 0);
              const minPrice = (ev.tiers ?? []).reduce(
                (acc, t) => (t.isActive ? Math.min(acc, t.price) : acc),
                Number.POSITIVE_INFINITY,
              );
              const isOnSale = ev.status === 'ON_SALE';
              return (
                <div
                  key={ev.id}
                  className="flex flex-col rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
                >
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div className="flex flex-1 flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          EVT_EVENT_TYPE_PILL[ev.eventType]
                        }`}
                      >
                        {EVT_EVENT_TYPE_LABELS[ev.eventType]}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          EVT_EVENT_STATUS_PILL[ev.status]
                        }`}
                      >
                        {EVT_EVENT_STATUS_LABELS[ev.status]}
                      </span>
                    </div>
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900">{ev.title}</h3>
                  <div className="mt-1 text-sm text-gray-600">
                    {formatEventDate(ev.eventDate)} · {formatEventTime(ev.startTime)}
                    {ev.endTime ? ` – ${formatEventTime(ev.endTime)}` : ''}
                  </div>
                  {ev.venueName && (
                    <div className="mt-1 text-sm text-gray-500">Venue: {ev.venueName}</div>
                  )}
                  {ev.description && (
                    <p className="mt-3 line-clamp-3 text-sm text-gray-700">{ev.description}</p>
                  )}
                  <div className="mt-4 flex flex-1 flex-col gap-1 border-t border-gray-100 pt-3 text-sm">
                    {(ev.tiers ?? []).length === 0 && (
                      <div className="text-gray-500">No tiers configured yet.</div>
                    )}
                    {(ev.tiers ?? []).map((t) => (
                      <div key={t.id} className="flex items-center justify-between">
                        <span className="text-gray-700">
                          {t.name} —{' '}
                          <span className="font-semibold">{formatCurrency(t.price)}</span>
                        </span>
                        <span
                          className={`text-xs font-medium ${tierAvailabilityTone(t.remaining, t.quantity)}`}
                        >
                          {tierAvailabilityLabel(t.remaining, t.quantity)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <div className="text-xs text-gray-500">
                      {totalCap > 0 && (
                        <span>
                          {totalLeft} of {totalCap} seats remaining
                          {minPrice !== Number.POSITIVE_INFINITY
                            ? ` · from ${formatCurrency(minPrice)}`
                            : ''}
                        </span>
                      )}
                    </div>
                    {isOnSale && totalLeft > 0 ? (
                      <Link
                        href={`/events/${ev.id}/buy`}
                        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                      >
                        Buy tickets
                      </Link>
                    ) : (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          EVT_EVENT_STATUS_PILL[ev.status]
                        }`}
                      >
                        {EVT_EVENT_STATUS_LABELS[ev.status]}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
