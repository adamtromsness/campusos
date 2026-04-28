'use client';

import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useCalendarEvents,
  useCreateCalendarEvent,
  useDayOverrides,
  useDeleteCalendarEvent,
  useUpdateCalendarEvent,
} from '@/hooks/use-scheduling';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  CALENDAR_EVENT_TYPES,
  calendarEventChipClasses,
  calendarEventTypeLabel,
  formatTime,
} from '@/lib/scheduling-format';
import type {
  CalendarEventDto,
  CalendarEventType,
  CreateCalendarEventPayload,
  DayOverrideDto,
} from '@/lib/types';

interface MonthCell {
  iso: string;
  day: number;
  inMonth: boolean;
  isWeekend: boolean;
  isToday: boolean;
}

function buildMonthGrid(year: number, month: number): MonthCell[] {
  const todayIso = new Date().toISOString().slice(0, 10);
  const first = new Date(Date.UTC(year, month, 1));
  const firstDow = (first.getUTCDay() + 6) % 7; // shift so Mon=0
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - firstDow);
  const cells: MonthCell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const dow = (d.getUTCDay() + 6) % 7;
    cells.push({
      iso,
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() === month,
      isWeekend: dow >= 5,
      isToday: iso === todayIso,
    });
  }
  return cells;
}

function eventsOnDate(events: CalendarEventDto[], iso: string): CalendarEventDto[] {
  return events.filter((e) => iso >= e.startDate && iso <= e.endDate);
}

function overrideOnDate(overrides: DayOverrideDto[], iso: string): DayOverrideDto | null {
  return overrides.find((o) => o.overrideDate === iso) ?? null;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export default function CalendarPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sch-003:admin', 'sch-001:admin']);

  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getUTCFullYear());
  const [viewMonth, setViewMonth] = useState(today.getUTCMonth());
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEventDto | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // Range covers ±6 weeks around the current view so cells outside the month
  // (the leading / trailing greyed-out days) still surface their events.
  const rangeStart = useMemo(() => {
    const d = new Date(Date.UTC(viewYear, viewMonth - 1, 1));
    return d.toISOString().slice(0, 10);
  }, [viewYear, viewMonth]);
  const rangeEnd = useMemo(() => {
    const d = new Date(Date.UTC(viewYear, viewMonth + 2, 0));
    return d.toISOString().slice(0, 10);
  }, [viewYear, viewMonth]);

  const events = useCalendarEvents(
    {
      fromDate: rangeStart,
      toDate: rangeEnd,
      includeDrafts: isAdmin && includeDrafts,
    },
    !!user,
  );
  const overrides = useDayOverrides({ fromDate: rangeStart, toDate: rangeEnd }, !!user);
  const create = useCreateCalendarEvent();
  const { toast } = useToast();

  const cells = useMemo(() => buildMonthGrid(viewYear, viewMonth), [viewYear, viewMonth]);

  function shiftMonth(delta: number) {
    let m = viewMonth + delta;
    let y = viewYear;
    while (m < 0) {
      m += 12;
      y -= 1;
    }
    while (m > 11) {
      m -= 12;
      y += 1;
    }
    setViewMonth(m);
    setViewYear(y);
  }

  function onCreated(payload: CreateCalendarEventPayload) {
    create
      .mutateAsync(payload)
      .then(() => {
        toast(payload.isPublished ? 'Event published' : 'Draft saved', 'success');
        setShowCreate(false);
      })
      .catch((e: any) => {
        toast(e?.message || 'Could not create event', 'error');
      });
  }

  if (!user) return null;

  const eventList = events.data ?? [];
  const overrideList = overrides.data ?? [];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="School Calendar"
        description="Holidays, PD days, exams, and events at a glance."
        actions={
          isAdmin ? (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
            >
              New event
            </button>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            aria-label="Previous month"
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm hover:bg-gray-100"
          >
            ←
          </button>
          <h2 className="min-w-[180px] text-center text-base font-semibold text-gray-900">
            {MONTH_NAMES[viewMonth]} {viewYear}
          </h2>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            aria-label="Next month"
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm hover:bg-gray-100"
          >
            →
          </button>
          <button
            type="button"
            onClick={() => {
              setViewYear(today.getUTCFullYear());
              setViewMonth(today.getUTCMonth());
            }}
            className="ml-2 rounded-lg border border-gray-300 px-2 py-1 text-sm hover:bg-gray-100"
          >
            Today
          </button>
        </div>

        {isAdmin && (
          <label className="inline-flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={includeDrafts}
              onChange={(e) => setIncludeDrafts(e.target.checked)}
              className="rounded border-gray-300 text-campus-600 focus:ring-campus-500"
            />
            Show drafts
          </label>
        )}
      </div>

      {events.isLoading ? (
        <div className="py-16 text-center">
          <LoadingSpinner />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50 text-center text-xs font-medium uppercase tracking-wide text-gray-500">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
              <div key={d} className="py-2">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((cell) => {
              const todays = eventsOnDate(eventList, cell.iso);
              const override = overrideOnDate(overrideList, cell.iso);
              return (
                <div
                  key={cell.iso}
                  className={cn(
                    'min-h-[100px] border-b border-l border-gray-100 px-2 py-1 align-top',
                    cell.inMonth ? 'bg-white' : 'bg-gray-50',
                    cell.isWeekend && cell.inMonth && 'bg-gray-50/60',
                  )}
                >
                  <div className="flex items-baseline justify-between">
                    <span
                      className={cn(
                        'inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium',
                        cell.isToday
                          ? 'bg-campus-700 text-white'
                          : cell.inMonth
                            ? 'text-gray-700'
                            : 'text-gray-400',
                      )}
                    >
                      {cell.day}
                    </span>
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {override && override.isSchoolDay === false && (
                      <div className="truncate rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-600">
                        Closed{override.reason ? ` · ${override.reason}` : ''}
                      </div>
                    )}
                    {todays.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => setSelectedEvent(e)}
                        className={cn(
                          'block w-full truncate rounded border px-1.5 py-0.5 text-left text-[11px] font-medium',
                          calendarEventChipClasses(e.eventType),
                          !e.isPublished && 'border-dashed opacity-70',
                        )}
                        title={`${e.title}${!e.isPublished ? ' (draft)' : ''}`}
                      >
                        {!e.allDay && e.startTime ? (
                          <span className="mr-1 font-mono">{formatTime(e.startTime)}</span>
                        ) : null}
                        {e.title}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {eventList.length === 0 && !events.isLoading && (
        <div className="mt-4">
          <EmptyState
            title="No events this month"
            description={
              isAdmin
                ? 'Click “New event” to publish a holiday, PD day, or assembly.'
                : 'When the school publishes calendar events, they’ll appear here.'
            }
          />
        </div>
      )}

      <EventDetailModal
        event={selectedEvent}
        isAdmin={isAdmin}
        onClose={() => setSelectedEvent(null)}
      />

      {isAdmin && (
        <CreateEventModal
          open={showCreate}
          submitting={create.isPending}
          onClose={() => setShowCreate(false)}
          onSubmit={onCreated}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────

function EventDetailModal({
  event,
  isAdmin,
  onClose,
}: {
  event: CalendarEventDto | null;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const update = useUpdateCalendarEvent(event?.id ?? '');
  const del = useDeleteCalendarEvent();
  const { toast } = useToast();

  if (!event) return null;

  async function publish() {
    try {
      await update.mutateAsync({ isPublished: true });
      toast('Event published', 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not publish', 'error');
    }
  }

  async function onDelete() {
    if (!window.confirm(`Delete "${event!.title}"?`)) return;
    try {
      await del.mutateAsync(event!.id);
      toast('Event deleted', 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not delete', 'error');
    }
  }

  return (
    <Modal open={true} onClose={onClose} title={event.title} size="lg">
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <span
            className={cn(
              'inline-flex rounded-full border px-2 py-0.5 text-xs font-medium',
              calendarEventChipClasses(event.eventType),
            )}
          >
            {calendarEventTypeLabel(event.eventType)}
          </span>
          {!event.isPublished && (
            <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
              Draft
            </span>
          )}
          {event.affectsAttendance && (
            <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              Affects attendance
            </span>
          )}
          {event.bellScheduleName && (
            <span className="inline-flex rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">
              {event.bellScheduleName}
            </span>
          )}
        </div>
        <p className="text-gray-700">
          <strong>When:</strong>{' '}
          {event.startDate}
          {event.endDate !== event.startDate && ` → ${event.endDate}`}
          {!event.allDay && event.startTime && (
            <>
              {' · '}
              {formatTime(event.startTime)}
              {event.endTime && `–${formatTime(event.endTime)}`}
            </>
          )}
        </p>
        {event.description && (
          <p className="whitespace-pre-wrap text-gray-700">{event.description}</p>
        )}
        {event.createdByName && (
          <p className="text-xs text-gray-500">Author: {event.createdByName}</p>
        )}
        {isAdmin && (
          <div className="flex items-center gap-2 border-t border-gray-100 pt-3">
            {!event.isPublished && (
              <button
                type="button"
                onClick={publish}
                disabled={update.isPending}
                className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
              >
                Publish now
              </button>
            )}
            <button
              type="button"
              onClick={onDelete}
              disabled={del.isPending}
              className="ml-auto rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────

function CreateEventModal({
  open,
  submitting,
  onClose,
  onSubmit,
}: {
  open: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (payload: CreateCalendarEventPayload) => void;
}) {
  const [title, setTitle] = useState('');
  const [eventType, setEventType] = useState<CalendarEventType>('CUSTOM');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [allDay, setAllDay] = useState(true);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [affectsAttendance, setAffectsAttendance] = useState(false);

  function reset() {
    setTitle('');
    setEventType('CUSTOM');
    setDescription('');
    setAllDay(true);
    setAffectsAttendance(false);
  }

  function emit(isPublished: boolean) {
    if (!title.trim()) return;
    if (endDate < startDate) return;
    if (!allDay && startTime >= endTime) return;
    const payload: CreateCalendarEventPayload = {
      title: title.trim(),
      eventType,
      startDate,
      endDate,
      allDay,
      affectsAttendance,
      isPublished,
    };
    if (description.trim()) payload.description = description.trim();
    if (!allDay) {
      payload.startTime = startTime;
      payload.endTime = endTime;
    }
    onSubmit(payload);
    reset();
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="New calendar event"
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => emit(false)}
            disabled={submitting || !title.trim()}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Save draft
          </button>
          <button
            type="button"
            onClick={() => emit(true)}
            disabled={submitting || !title.trim()}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
          >
            Publish now
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Spring Break"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Type</span>
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value as CalendarEventType)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          >
            {CALENDAR_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {calendarEventTypeLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Start date</span>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">End date</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
        </div>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => setAllDay(e.target.checked)}
            className="rounded border-gray-300 text-campus-600 focus:ring-campus-500"
          />
          <span className="text-gray-700">All day</span>
        </label>
        {!allDay && (
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="font-medium text-gray-700">Start time</span>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-gray-700">End time</span>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </label>
          </div>
        )}
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Description (optional)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={affectsAttendance}
            onChange={(e) => setAffectsAttendance(e.target.checked)}
            className="rounded border-gray-300 text-campus-600 focus:ring-campus-500"
          />
          <span className="text-gray-700">Affects attendance (skips pre-population)</span>
        </label>
      </div>
    </Modal>
  );
}
