'use client';

import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useCancelRoomBooking,
  useCreateRoomBooking,
  useRoomBookings,
  useRooms,
} from '@/hooks/use-scheduling';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { bookingStatusLabel } from '@/lib/scheduling-format';
import type { CreateRoomBookingPayload, RoomBookingDto, RoomBookingStatus } from '@/lib/types';

function isoLocalToTimestamp(value: string): string {
  // The <input type="datetime-local"> emits values without timezone, e.g. "2026-05-01T18:00".
  // Append the browser's local offset so the API stores the intended wall-clock moment.
  if (!value) return value;
  const date = new Date(value);
  return date.toISOString();
}

function formatRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const dayKey = s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const tStart = s.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const tEnd = e.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${dayKey}, ${tStart}–${tEnd}`;
}

export default function RoomBookingsPage() {
  const user = useAuthStore((s) => s.user);
  const canBook = !!user && hasAnyPermission(user, ['sch-005:write']);

  const [statusFilter, setStatusFilter] = useState<RoomBookingStatus | ''>('CONFIRMED');
  const [roomFilter, setRoomFilter] = useState<string>('');
  const [fromDate, setFromDate] = useState<string>(() => new Date().toISOString().slice(0, 10));

  const rooms = useRooms({}, !!user);
  const bookings = useRoomBookings(
    {
      status: statusFilter || undefined,
      roomId: roomFilter || undefined,
      fromDate,
    },
    !!user,
  );
  const create = useCreateRoomBooking();
  const cancel = useCancelRoomBooking();
  const { toast } = useToast();

  const [showCreate, setShowCreate] = useState(false);
  const [bookingRoomId, setBookingRoomId] = useState<string>('');
  const [purpose, setPurpose] = useState('');
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');

  const grouped = useMemo(() => {
    const map = new Map<string, RoomBookingDto[]>();
    for (const b of bookings.data ?? []) {
      const day = new Date(b.startAt).toISOString().slice(0, 10);
      const arr = map.get(day);
      if (arr) arr.push(b);
      else map.set(day, [b]);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [bookings.data]);

  if (!user) return null;

  function resetForm() {
    setBookingRoomId('');
    setPurpose('');
    setStartAt('');
    setEndAt('');
  }

  async function onCreate() {
    if (!bookingRoomId || !purpose.trim() || !startAt || !endAt) {
      toast('All fields are required.', 'error');
      return;
    }
    if (new Date(startAt) >= new Date(endAt)) {
      toast('End time must be after start time.', 'error');
      return;
    }
    const payload: CreateRoomBookingPayload = {
      roomId: bookingRoomId,
      bookingPurpose: purpose.trim(),
      startAt: isoLocalToTimestamp(startAt),
      endAt: isoLocalToTimestamp(endAt),
    };
    try {
      await create.mutateAsync(payload);
      toast('Room booked', 'success');
      setShowCreate(false);
      resetForm();
    } catch (e: any) {
      toast(e?.message || 'Could not book this room', 'error');
    }
  }

  async function onCancel(b: RoomBookingDto) {
    if (b.status !== 'CONFIRMED') return;
    if (!window.confirm(`Cancel ${b.roomName} booking on ${new Date(b.startAt).toLocaleString()}?`)) {
      return;
    }
    try {
      await cancel.mutateAsync({ id: b.id });
      toast('Booking cancelled', 'success');
    } catch (e: any) {
      toast(e?.message || 'Could not cancel — only the owner or an admin may cancel', 'error');
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Room Bookings"
        description="Book a room for a one-off activity. Conflicts against the timetable and existing bookings are blocked."
        actions={
          canBook ? (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
            >
              New booking
            </button>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
        <label className="text-sm">
          <span className="mr-2 text-gray-700">From</span>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <select
          value={roomFilter}
          onChange={(e) => setRoomFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
        >
          <option value="">All rooms</option>
          {(rooms.data ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as RoomBookingStatus | '')}
          className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
        >
          <option value="CONFIRMED">Confirmed only</option>
          <option value="">All statuses</option>
          <option value="CANCELLED">Cancelled only</option>
        </select>
      </div>

      {bookings.isLoading ? (
        <div className="py-16 text-center">
          <LoadingSpinner />
        </div>
      ) : bookings.isError ? (
        <EmptyState
          title="Couldn't load bookings"
          description="Try refreshing the page."
        />
      ) : grouped.length === 0 ? (
        <EmptyState
          title="No bookings"
          description="No room bookings match the current filters."
        />
      ) : (
        <div className="space-y-5">
          {grouped.map(([day, items]) => (
            <section key={day} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                {new Date(day).toLocaleDateString(undefined, {
                  weekday: 'long',
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </h3>
              <ul className="mt-2 divide-y divide-gray-100">
                {items.map((b) => (
                  <li key={b.id} className="flex items-center justify-between py-2 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900">
                        {b.roomName} · {b.bookingPurpose}
                      </p>
                      <p className="text-xs text-gray-500">
                        {formatRange(b.startAt, b.endAt)}
                        {b.bookedByName && ` · ${b.bookedByName}`}
                      </p>
                      {b.status === 'CANCELLED' && b.cancelledReason && (
                        <p className="mt-1 text-xs italic text-gray-500">
                          Cancelled: {b.cancelledReason}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                          b.status === 'CONFIRMED'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-gray-200 text-gray-600',
                        )}
                      >
                        {bookingStatusLabel(b.status)}
                      </span>
                      {canBook && b.status === 'CONFIRMED' && (
                        <button
                          type="button"
                          onClick={() => onCancel(b)}
                          disabled={cancel.isPending}
                          className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Book a room"
        footer={
          <>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onCreate}
              disabled={create.isPending}
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
            >
              Book
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Room</span>
            <select
              value={bookingRoomId}
              onChange={(e) => setBookingRoomId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            >
              <option value="">— select —</option>
              {(rooms.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Purpose</span>
            <input
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="e.g. Faculty meeting"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="font-medium text-gray-700">Start</span>
              <input
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-gray-700">End</span>
              <input
                type="datetime-local"
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
            </label>
          </div>
        </div>
      </Modal>
    </div>
  );
}
