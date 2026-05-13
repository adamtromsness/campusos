'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { EmptyState, PageHeader } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useMyChildren } from '@/hooks/use-children';
import {
  useBookSlot,
  useBookings,
  useCancelBooking,
  useConferenceEvent,
  useConferenceSlots,
  useGenerateSlots,
  useUpdateBooking,
} from '@/hooks/use-engagement';
import type {
  EngConferenceBookingDto,
  EngConferenceFollowUpAction,
  EngConferenceSlotDto,
  GenerateEngSlotsPayload,
} from '@/lib/types';
import {
  CONFERENCE_EVENT_STATUS_LABEL,
  CONFERENCE_EVENT_STATUS_PILL,
  CONFERENCE_SLOT_STATUS_LABEL,
  CONFERENCE_SLOT_STATUS_PILL,
  formatDateOnly,
  formatDateTime,
  formatTimeRange,
  isBookingWindowOpen,
} from '@/lib/engagement-format';

export default function ConferenceDetailPage() {
  const params = useParams<{ id: string }>();
  const eventId = params.id;
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user?.personType === 'STAFF' || isAdmin;
  const isParent = user?.personType === 'GUARDIAN';
  const canManage = isAdmin || hasAnyPermission(user, ['mtg-002:write', 'mtg-002:admin']);

  const [teacherFilter, setTeacherFilter] = useState<string>('');
  const [availableOnly, setAvailableOnly] = useState<boolean>(true);
  const [showGenerate, setShowGenerate] = useState(false);

  const eventQ = useConferenceEvent(eventId);
  const slotsQ = useConferenceSlots(eventId, {
    teacherId: teacherFilter || undefined,
    availableOnly: isParent ? true : availableOnly,
  });
  const allBookingsQ = useBookings({}, isStaff);

  // Build teachers dropdown from the slot list (admin/staff view)
  const teachers = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of slotsQ.data ?? []) {
      if (s.teacherId) {
        map.set(s.teacherId, s.teacherName ?? s.teacherId.slice(0, 8));
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [slotsQ.data]);

  // Group slots by teacher for cleaner rendering
  const slotsByTeacher = useMemo(() => {
    const groups = new Map<string, { teacherName: string; slots: EngConferenceSlotDto[] }>();
    for (const s of slotsQ.data ?? []) {
      const key = s.teacherId;
      const name = s.teacherName ?? 'Unknown teacher';
      const cur = groups.get(key);
      if (!cur) {
        groups.set(key, { teacherName: name, slots: [s] });
      } else {
        cur.slots.push(s);
      }
    }
    return groups;
  }, [slotsQ.data]);

  // Cross-reference bookings to slots for the staff outcome panel
  const bookingsBySlot = useMemo(() => {
    const map = new Map<string, EngConferenceBookingDto[]>();
    for (const b of allBookingsQ.data ?? []) {
      if (!map.has(b.slotId)) map.set(b.slotId, []);
      map.get(b.slotId)!.push(b);
    }
    return map;
  }, [allBookingsQ.data]);

  if (eventQ.isLoading) {
    return <div className="mx-auto max-w-6xl p-6 text-sm text-gray-500">Loading conference…</div>;
  }
  if (!eventQ.data) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <PageHeader title="Conference not found" />
        <EmptyState
          title="Not found"
          description="The conference event you’re looking for is not available."
          action={
            <Link
              href="/engagement/conferences"
              className="text-sm font-medium text-campus-600 hover:text-campus-700"
            >
              ← Back to conferences
            </Link>
          }
        />
      </div>
    );
  }
  const evt = eventQ.data;
  const windowOpen = isBookingWindowOpen(evt.bookingOpensAt, evt.bookingClosesAt);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <Link
          href="/engagement/conferences"
          className="text-sm text-campus-600 hover:text-campus-700"
        >
          ← Back to conferences
        </Link>
      </div>
      <PageHeader title={evt.title} description={evt.description ?? undefined} />

      {/* Header strip */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={
            'rounded-full px-3 py-1 text-xs font-medium ' + CONFERENCE_EVENT_STATUS_PILL[evt.status]
          }
        >
          {CONFERENCE_EVENT_STATUS_LABEL[evt.status]}
        </span>
        <span className="text-sm text-gray-500">
          {formatDateOnly(evt.startDate)} → {formatDateOnly(evt.endDate)}
        </span>
        <span className="text-sm text-gray-500">·</span>
        <span className="text-sm text-gray-500">
          {evt.defaultSlotDurationMinutes}-min slots, {evt.defaultBreakMinutes}-min break
        </span>
      </div>

      {/* Booking window status */}
      <div
        className={
          'rounded-md border px-4 py-3 text-sm ' +
          (windowOpen
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : 'border-amber-200 bg-amber-50 text-amber-800')
        }
      >
        {windowOpen ? (
          <span>
            <strong>Booking is open.</strong> Window closes {formatDateTime(evt.bookingClosesAt)}.
          </span>
        ) : (
          <span>
            <strong>Booking window:</strong> {formatDateTime(evt.bookingOpensAt)} →{' '}
            {formatDateTime(evt.bookingClosesAt)}.
            {isParent ? ' Bookings will reopen at the window start.' : ''}
          </span>
        )}
      </div>

      {/* Filter strip + Generate slots */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {teachers.length > 0 ? (
            <select
              value={teacherFilter}
              onChange={(e) => setTeacherFilter(e.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="">All teachers</option>
              {teachers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          ) : null}
          {!isParent ? (
            <label className="flex items-center gap-1.5 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={availableOnly}
                onChange={(e) => setAvailableOnly(e.target.checked)}
              />
              Available only
            </label>
          ) : null}
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={() => setShowGenerate(true)}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            Generate slots
          </button>
        ) : null}
      </div>

      {/* Slots grouped by teacher */}
      {slotsByTeacher.size === 0 ? (
        <EmptyState
          title={isParent ? 'No available slots' : 'No slots yet'}
          description={
            canManage
              ? 'Generate availability for the conference week — pick a teacher, date, and window.'
              : 'No availability has been published. Check back once the conference opens.'
          }
        />
      ) : (
        <div className="space-y-4">
          {Array.from(slotsByTeacher.entries()).map(([teacherId, group]) => (
            <TeacherSlotsCard
              key={teacherId}
              teacherName={group.teacherName}
              slots={group.slots}
              eventId={eventId}
              canBook={isParent && windowOpen && evt.status === 'BOOKING_OPEN'}
              isStaff={isStaff}
              bookingsBySlot={bookingsBySlot}
            />
          ))}
        </div>
      )}

      {showGenerate ? (
        <GenerateSlotsModal
          eventId={eventId}
          defaultDuration={evt.defaultSlotDurationMinutes}
          defaultBreak={evt.defaultBreakMinutes}
          onClose={() => setShowGenerate(false)}
        />
      ) : null}
    </div>
  );
}

function TeacherSlotsCard({
  teacherName,
  slots,
  eventId: _eventId,
  canBook,
  isStaff,
  bookingsBySlot,
}: {
  teacherName: string;
  slots: EngConferenceSlotDto[];
  eventId: string;
  canBook: boolean;
  isStaff: boolean;
  bookingsBySlot: Map<string, EngConferenceBookingDto[]>;
}) {
  const sorted = useMemo(
    () =>
      [...slots].sort((a, b) => {
        if (a.slotDate !== b.slotDate) return a.slotDate.localeCompare(b.slotDate);
        return a.startTime.localeCompare(b.startTime);
      }),
    [slots],
  );
  const byDay = useMemo(() => {
    const map = new Map<string, EngConferenceSlotDto[]>();
    for (const s of sorted) {
      if (!map.has(s.slotDate)) map.set(s.slotDate, []);
      map.get(s.slotDate)!.push(s);
    }
    return map;
  }, [sorted]);

  return (
    <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900">{teacherName}</h3>
        <span className="text-xs text-gray-500">{sorted.length} slots</span>
      </div>
      <div className="mt-3 space-y-3">
        {Array.from(byDay.entries()).map(([date, daySlots]) => (
          <div key={date}>
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
              {formatDateOnly(date)}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {daySlots.map((slot) => (
                <SlotChip
                  key={slot.id}
                  slot={slot}
                  canBook={canBook}
                  isStaff={isStaff}
                  bookings={bookingsBySlot.get(slot.id) ?? []}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SlotChip({
  slot,
  canBook,
  isStaff,
  bookings,
}: {
  slot: EngConferenceSlotDto;
  canBook: boolean;
  isStaff: boolean;
  bookings: EngConferenceBookingDto[];
}) {
  const [showBook, setShowBook] = useState(false);
  const [showOutcome, setShowOutcome] = useState(false);

  return (
    <>
      <div
        className={
          'group inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs ' +
          (slot.status === 'AVAILABLE'
            ? 'border-emerald-200 bg-emerald-50'
            : slot.status === 'BOOKED'
              ? 'border-amber-200 bg-amber-50'
              : 'border-rose-200 bg-rose-50')
        }
      >
        <span className="font-medium text-gray-800">
          {formatTimeRange(slot.startTime, slot.endTime)}
        </span>
        <span
          className={'rounded-full px-2 py-0.5 text-xs ' + CONFERENCE_SLOT_STATUS_PILL[slot.status]}
        >
          {CONFERENCE_SLOT_STATUS_LABEL[slot.status]}
        </span>
        {slot.maxBookings > 1 ? (
          <span className="text-gray-500">
            {slot.currentBookings}/{slot.maxBookings}
          </span>
        ) : null}
        {canBook && slot.status === 'AVAILABLE' ? (
          <button
            type="button"
            onClick={() => setShowBook(true)}
            className="rounded bg-campus-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-campus-700"
          >
            Book
          </button>
        ) : null}
        {isStaff && slot.status === 'BOOKED' && bookings.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowOutcome(true)}
            className="rounded border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-50"
          >
            Document outcome
          </button>
        ) : null}
      </div>
      {showBook ? <BookSlotModal slot={slot} onClose={() => setShowBook(false)} /> : null}
      {showOutcome && bookings.length > 0 ? (
        <DocumentOutcomeModal booking={bookings[0]!} onClose={() => setShowOutcome(false)} />
      ) : null}
    </>
  );
}

function BookSlotModal({ slot, onClose }: { slot: EngConferenceSlotDto; onClose: () => void }) {
  const childrenQ = useMyChildren();
  const bookMut = useBookSlot();
  const [studentId, setStudentId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!studentId) {
      setError('Pick a child for this booking.');
      return;
    }
    try {
      await bookMut.mutateAsync({ slotId: slot.id, body: { studentId } });
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-card bg-white p-5 shadow-lg">
        <h2 className="text-lg font-semibold text-gray-900">Confirm booking</h2>
        <p className="mt-1 text-sm text-gray-500">
          {formatDateOnly(slot.slotDate)} · {formatTimeRange(slot.startTime, slot.endTime)} ·{' '}
          {slot.teacherName ?? 'Teacher'}
        </p>
        {slot.location ? (
          <p className="mt-1 text-xs text-gray-500">Location: {slot.location}</p>
        ) : null}

        <div className="mt-4">
          <label className="block text-xs font-medium text-gray-600">Child</label>
          <select
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            required
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          >
            <option value="">Select a child…</option>
            {(childrenQ.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.fullName}
                {c.gradeLevel ? ` (Grade ${c.gradeLevel})` : ''}
              </option>
            ))}
          </select>
        </div>

        {error ? (
          <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        ) : null}

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
            disabled={bookMut.isPending}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            {bookMut.isPending ? 'Booking…' : 'Confirm booking'}
          </button>
        </div>
      </form>
    </div>
  );
}

function DocumentOutcomeModal({
  booking,
  onClose,
}: {
  booking: EngConferenceBookingDto;
  onClose: () => void;
}) {
  const updateMut = useUpdateBooking();
  const cancelMut = useCancelBooking();
  const [attended, setAttended] = useState<boolean>(booking.attended ?? true);
  const [notes, setNotes] = useState<string>(booking.conferenceNotes ?? '');
  const [actions, setActions] = useState<EngConferenceFollowUpAction[]>(
    booking.followUpActions ?? [],
  );
  const [error, setError] = useState<string | null>(null);

  function addAction(): void {
    setActions((cur) => [
      ...cur,
      {
        description: '',
        due_date: new Date(Date.now() + 28 * 86400 * 1000).toISOString().slice(0, 10),
        status: 'PENDING' as const,
      },
    ]);
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await updateMut.mutateAsync({
        id: booking.id,
        body: {
          attended,
          conferenceNotes: notes.trim() || undefined,
          followUpActions:
            actions.filter((a) => a.description.trim()).length > 0 ? actions : undefined,
        },
      });
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  }

  async function handleCancel(): Promise<void> {
    if (!window.confirm('Cancel this booking? The slot will return to AVAILABLE.')) return;
    try {
      await cancelMut.mutateAsync({ id: booking.id, body: { reason: 'Cancelled by staff' } });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form onSubmit={submit} className="w-full max-w-2xl rounded-card bg-white p-5 shadow-lg">
        <h2 className="text-lg font-semibold text-gray-900">Document conference outcome</h2>
        <p className="mt-1 text-sm text-gray-500">
          Booked {formatDateTime(booking.bookedAt)} · Student id {booking.studentId.slice(0, 8)}…
        </p>

        <div className="mt-4 space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={attended}
              onChange={(e) => setAttended(e.target.checked)}
            />
            <span>Family attended</span>
          </label>

          <div>
            <label className="block text-xs font-medium text-gray-600">Conference notes</label>
            <textarea
              rows={4}
              maxLength={5000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Academic progress, areas to develop, agreed actions…"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium text-gray-600">Follow-up actions</label>
              <button
                type="button"
                onClick={addAction}
                className="rounded-md border border-campus-300 px-2 py-0.5 text-xs font-medium text-campus-700 hover:bg-campus-50"
              >
                + Add action
              </button>
            </div>
            <div className="mt-2 space-y-2">
              {actions.length === 0 ? (
                <p className="text-xs text-gray-500">No follow-up actions yet.</p>
              ) : (
                actions.map((a, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 rounded-md border border-gray-200 bg-gray-50 p-2"
                  >
                    <input
                      type="text"
                      value={a.description}
                      onChange={(e) => {
                        const next = [...actions];
                        next[i] = { ...a, description: e.target.value };
                        setActions(next);
                      }}
                      placeholder="Action description"
                      className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm"
                    />
                    <input
                      type="date"
                      value={a.due_date}
                      onChange={(e) => {
                        const next = [...actions];
                        next[i] = { ...a, due_date: e.target.value };
                        setActions(next);
                      }}
                      className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                    />
                    <select
                      value={a.status}
                      onChange={(e) => {
                        const next = [...actions];
                        next[i] = { ...a, status: e.target.value as 'PENDING' | 'COMPLETED' };
                        setActions(next);
                      }}
                      className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                    >
                      <option value="PENDING">Pending</option>
                      <option value="COMPLETED">Completed</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => setActions(actions.filter((_, j) => j !== i))}
                      className="text-xs text-rose-700 hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {error ? (
          <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-between gap-2">
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelMut.isPending}
            className="rounded-md border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            Cancel booking
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={updateMut.isPending}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
            >
              {updateMut.isPending ? 'Saving…' : 'Save outcome'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function GenerateSlotsModal({
  eventId,
  defaultDuration,
  defaultBreak,
  onClose,
}: {
  eventId: string;
  defaultDuration: number;
  defaultBreak: number;
  onClose: () => void;
}) {
  const mut = useGenerateSlots();
  const [form, setForm] = useState<GenerateEngSlotsPayload>({
    teacherId: '',
    slotDate: '',
    startTime: '16:00',
    endTime: '19:00',
    slotDurationMinutes: defaultDuration,
    breakMinutes: defaultBreak,
    location: '',
    meetingUrl: '',
  });
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await mut.mutateAsync({
        eventId,
        body: {
          ...form,
          location: form.location?.trim() || undefined,
          meetingUrl: form.meetingUrl?.trim() || undefined,
        },
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form onSubmit={submit} className="w-full max-w-lg rounded-card bg-white p-5 shadow-lg">
        <h2 className="text-lg font-semibold text-gray-900">Generate availability</h2>
        <p className="mt-1 text-sm text-gray-500">
          Auto-creates slots in (duration + break) increments across the window. Idempotent —
          rerunning skips existing slots.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600">Teacher employee id</label>
            <input
              type="text"
              required
              value={form.teacherId}
              onChange={(e) => setForm({ ...form, teacherId: e.target.value })}
              placeholder="hr_employees.id"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">Date</label>
            <input
              type="date"
              required
              value={form.slotDate}
              onChange={(e) => setForm({ ...form, slotDate: e.target.value })}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600">Start time</label>
              <input
                type="time"
                required
                value={form.startTime}
                onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">End time</label>
              <input
                type="time"
                required
                value={form.endTime}
                onChange={(e) => setForm({ ...form, endTime: e.target.value })}
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
                value={form.slotDurationMinutes ?? defaultDuration}
                onChange={(e) => setForm({ ...form, slotDurationMinutes: Number(e.target.value) })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">Break (min)</label>
              <input
                type="number"
                min={0}
                value={form.breakMinutes ?? defaultBreak}
                onChange={(e) => setForm({ ...form, breakMinutes: Number(e.target.value) })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">Location (optional)</label>
            <input
              type="text"
              maxLength={200}
              value={form.location ?? ''}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              placeholder="Room 12 / Main hall / Online"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">
              Meeting URL (optional)
            </label>
            <input
              type="url"
              maxLength={500}
              value={form.meetingUrl ?? ''}
              onChange={(e) => setForm({ ...form, meetingUrl: e.target.value })}
              placeholder="https://meet.example.com/…"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
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
            {mut.isPending ? 'Generating…' : 'Generate slots'}
          </button>
        </div>
      </form>
    </div>
  );
}
