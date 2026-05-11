'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState, LoadingSpinner, Modal, PageHeader } from '@/components/ui';
import { useToast } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useCreateEvent, useEvents } from '@/hooks/use-events';
import {
  EVT_EVENT_STATUSES,
  EVT_EVENT_STATUS_LABELS,
  EVT_EVENT_STATUS_PILL,
  EVT_EVENT_TYPES,
  EVT_EVENT_TYPE_LABELS,
  formatEventDate,
  formatEventTime,
} from '@/lib/events-format';
import type { CreateEvtEventPayload, EvtEventStatus, EvtEventType } from '@/lib/types';
import { ApiError } from '@/lib/api-client';

export default function EventsAdminPage() {
  const user = useAuthStore((s) => s.user);
  const isManager = user ? hasAnyPermission(user, ['evt-001:write', 'sch-001:admin']) : false;

  const [statusFilter, setStatusFilter] = useState<EvtEventStatus | ''>('');
  const eventsQ = useEvents({ status: statusFilter || undefined });
  const create = useCreateEvent();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  if (!isManager) {
    return (
      <div>
        <PageHeader title="Event admin" description="" />
        <p className="text-sm text-gray-600">Event admin requires evt-001:write.</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Event admin"
        description="Create events, manage tiers, comp lists, volunteers, and revenue."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/events"
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
            >
              Public calendar
            </Link>
            <Link
              href="/events/gate"
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
            >
              Gate scanner
            </Link>
            <Link
              href="/events/admin/revenue"
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
            >
              Revenue
            </Link>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              New event
            </button>
          </div>
        }
      />

      <div className="mt-4">
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
      </div>

      <div className="mt-6">
        {eventsQ.isLoading ? (
          <LoadingSpinner />
        ) : (eventsQ.data ?? []).length === 0 ? (
          <EmptyState title="No events" description="Create one to get started." />
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Event
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Type
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Date
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Status
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Tiers
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Sold / cap
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-gray-500" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(eventsQ.data ?? []).map((ev) => {
                  const sold = (ev.tiers ?? []).reduce((acc, t) => acc + t.quantitySold, 0);
                  const cap = (ev.tiers ?? []).reduce((acc, t) => acc + t.quantity, 0);
                  return (
                    <tr key={ev.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-medium text-gray-900">{ev.title}</td>
                      <td className="px-3 py-2 text-gray-700">
                        {EVT_EVENT_TYPE_LABELS[ev.eventType]}
                      </td>
                      <td className="px-3 py-2 text-gray-700">
                        {formatEventDate(ev.eventDate)} {formatEventTime(ev.startTime)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                            EVT_EVENT_STATUS_PILL[ev.status]
                          }`}
                        >
                          {EVT_EVENT_STATUS_LABELS[ev.status]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-700">{(ev.tiers ?? []).length}</td>
                      <td className="px-3 py-2 text-gray-700">
                        {sold} / {cap}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          href={`/events/admin/${ev.id}`}
                          className="text-blue-700 hover:underline"
                        >
                          Manage →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <NewEventModal
        open={open}
        onClose={() => setOpen(false)}
        onSubmit={async (body) => {
          try {
            await create.mutateAsync(body);
            toast('Event created as DRAFT.', 'success');
            setOpen(false);
          } catch (err) {
            const msg = err instanceof ApiError ? err.message : String(err);
            toast(`Create failed: ${msg}`, 'error');
          }
        }}
      />
    </div>
  );
}

function NewEventModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (body: CreateEvtEventPayload) => void;
}) {
  const [title, setTitle] = useState('');
  const [eventType, setEventType] = useState<EvtEventType>('PERFORMANCE');
  const [eventDate, setEventDate] = useState('');
  const [startTime, setStartTime] = useState('19:00');
  const [endTime, setEndTime] = useState('');
  const [venueName, setVenueName] = useState('');
  const [totalCapacity, setTotalCapacity] = useState<number | ''>('');
  const [description, setDescription] = useState('');

  function reset() {
    setTitle('');
    setEventType('PERFORMANCE');
    setEventDate('');
    setStartTime('19:00');
    setEndTime('');
    setVenueName('');
    setTotalCapacity('');
    setDescription('');
  }

  function submit() {
    if (!title.trim() || !eventDate || !startTime) return;
    const body: CreateEvtEventPayload = {
      title: title.trim(),
      eventType,
      eventDate,
      startTime,
    };
    if (endTime) body.endTime = endTime;
    if (venueName) body.venueName = venueName;
    if (typeof totalCapacity === 'number' && totalCapacity > 0) body.totalCapacity = totalCapacity;
    if (description) body.description = description;
    onSubmit(body);
    reset();
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="New event"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              onClose();
              reset();
            }}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!title.trim() || !eventDate || !startTime}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:bg-gray-300"
          >
            Create as DRAFT
          </button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Title" className="sm:col-span-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </Field>
        <Field label="Type">
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value as EvtEventType)}
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          >
            {EVT_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {EVT_EVENT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input
            type="date"
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </Field>
        <Field label="Start time">
          <input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </Field>
        <Field label="End time (optional)">
          <input
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </Field>
        <Field label="Venue" className="sm:col-span-2">
          <input
            value={venueName}
            onChange={(e) => setVenueName(e.target.value)}
            placeholder="Auditorium, Gymnasium…"
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </Field>
        <Field label="Capacity (optional)" className="sm:col-span-2">
          <input
            type="number"
            min={1}
            value={totalCapacity}
            onChange={(e) => setTotalCapacity(e.target.value === '' ? '' : Number(e.target.value))}
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </Field>
      </div>
    </Modal>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ''}`}>
      <span className="text-xs font-medium text-gray-600">{label}</span>
      {children}
    </label>
  );
}
