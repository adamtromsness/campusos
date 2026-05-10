'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  useTourBookings,
  useTourSlots,
  useCreateTourSlot,
  useUpdateTourSlot,
  useUpdateTourBooking,
  useLinkTourBookingApplication,
} from '@/hooks/use-enrolment-advanced';
import {
  BOOKING_STATUS_LABEL,
  BOOKING_STATUS_PILL,
  TOUR_TYPE_LABEL,
  TOUR_TYPES,
  formatDate,
  formatTime,
} from '@/lib/enrolment-advanced-format';
import type { TourBookingResponseDto, TourSlotResponseDto, TourType } from '@/lib/types';

/**
 * Tour Manager — admin slot calendar + create form + bookings.
 *
 * Public booking surface lives at /enrolment/tours/public (outside
 * the auth-gated (app) layout).
 */
export default function TourManagerPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = hasAnyPermission(user, ['stu-003:read', 'stu-003:write', 'stu-003:admin']);
  const canAdmin = hasAnyPermission(user, ['stu-003:admin', 'sch-001:admin']);
  const slots = useTourSlots(canRead);
  const bookings = useTourBookings(canRead);
  const [showCreate, setShowCreate] = useState(false);

  if (!canRead) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold">Tours</h1>
        <p className="mt-2 text-slate-600">Tour scheduling is restricted to admissions staff.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Campus tours</h1>
          <p className="text-sm text-slate-500">
            Schedule slots, publish to the public booking page, and track bookings + guests.
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <Link
            className="text-sky-700 hover:underline"
            href="/enrolment/tours/public"
            target="_blank"
          >
            Open public booking ↗
          </Link>
          {canAdmin ? (
            <button
              className="rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
              onClick={() => setShowCreate(true)}
            >
              New slot
            </button>
          ) : null}
        </div>
      </div>

      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-base font-semibold">Slots</h2>
        <table className="mt-3 min-w-full text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr className="text-left">
              <th className="py-2">Date</th>
              <th>Time</th>
              <th>Type</th>
              <th>Capacity</th>
              <th>Booked</th>
              <th>State</th>
              <th>Meeting point</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(slots.data ?? []).map((s) => (
              <SlotRow key={s.id} slot={s} canAdmin={canAdmin} />
            ))}
            {slots.data && slots.data.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-4 text-slate-500">
                  No slots yet. Use New slot to add one.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-base font-semibold">Bookings</h2>
        <table className="mt-3 min-w-full text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr className="text-left">
              <th className="py-2">Family</th>
              <th>Email</th>
              <th>Status</th>
              <th>Guests</th>
              <th>Linked application</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(bookings.data ?? []).map((b) => (
              <BookingRow key={b.id} booking={b} canAdmin={canAdmin} />
            ))}
            {bookings.data && bookings.data.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-4 text-slate-500">
                  No bookings yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {showCreate ? <CreateSlotModal onClose={() => setShowCreate(false)} /> : null}
    </div>
  );
}

function SlotRow({ slot, canAdmin }: { slot: TourSlotResponseDto; canAdmin: boolean }) {
  const update = useUpdateTourSlot(slot.id);
  const { toast } = useToast();
  return (
    <tr>
      <td className="py-2">{formatDate(slot.tourDate)}</td>
      <td>
        {formatTime(slot.startTime)}–{formatTime(slot.endTime)}
      </td>
      <td>{TOUR_TYPE_LABEL[slot.tourType]}</td>
      <td>{slot.maxBookings}</td>
      <td>
        {slot.currentBookings} / {slot.maxBookings}
      </td>
      <td>
        {slot.isCancelled ? (
          <span className="rounded bg-rose-100 px-2 py-0.5 text-xs text-rose-800">Cancelled</span>
        ) : slot.isPublished ? (
          <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">
            Published
          </span>
        ) : (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">Draft</span>
        )}
      </td>
      <td className="text-slate-500">{slot.meetingPoint ?? '—'}</td>
      <td className="space-x-2 text-right text-xs">
        {canAdmin && !slot.isCancelled ? (
          slot.isPublished ? (
            <button
              className="text-slate-600 hover:underline"
              onClick={async () => {
                try {
                  await update.mutateAsync({ isPublished: false });
                  toast('Slot unpublished');
                } catch (e) {
                  toast(`Failed: ${(e as Error).message}`, 'error');
                }
              }}
            >
              Unpublish
            </button>
          ) : (
            <button
              className="text-emerald-700 hover:underline"
              onClick={async () => {
                try {
                  await update.mutateAsync({ isPublished: true });
                  toast('Slot published');
                } catch (e) {
                  toast(`Failed: ${(e as Error).message}`, 'error');
                }
              }}
            >
              Publish
            </button>
          )
        ) : null}
        {canAdmin && !slot.isCancelled ? (
          <button
            className="text-rose-700 hover:underline"
            onClick={async () => {
              if (
                !window.confirm(
                  'Cancel this slot? Existing bookings will not be affected automatically.',
                )
              )
                return;
              try {
                await update.mutateAsync({ isCancelled: true, isPublished: false });
                toast('Slot cancelled');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Cancel
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function BookingRow({ booking, canAdmin }: { booking: TourBookingResponseDto; canAdmin: boolean }) {
  const { toast } = useToast();
  const update = useUpdateTourBooking(booking.id);
  const link = useLinkTourBookingApplication(booking.id);
  return (
    <tr>
      <td className="py-2 font-medium">{booking.familyName}</td>
      <td className="text-slate-600">{booking.contactEmail}</td>
      <td>
        <span className={`rounded px-2 py-0.5 text-xs ${BOOKING_STATUS_PILL[booking.status]}`}>
          {BOOKING_STATUS_LABEL[booking.status]}
        </span>
      </td>
      <td>{booking.guests.length}</td>
      <td className="text-slate-500">
        {booking.linkedApplicationId ? booking.linkedApplicationId.slice(0, 8) : '—'}
      </td>
      <td className="space-x-2 text-right text-xs">
        {canAdmin && booking.status === 'CONFIRMED' ? (
          <>
            <button
              className="text-emerald-700 hover:underline"
              onClick={async () => {
                if (!window.confirm('Mark this tour completed?')) return;
                try {
                  await update.mutateAsync({ status: 'COMPLETED' });
                  toast('Booking completed');
                } catch (e) {
                  toast(`Failed: ${(e as Error).message}`, 'error');
                }
              }}
            >
              Mark completed
            </button>
            <button
              className="text-amber-700 hover:underline"
              onClick={async () => {
                if (!window.confirm('Mark as no-show?')) return;
                try {
                  await update.mutateAsync({ status: 'NO_SHOW' });
                  toast('Booking marked no-show');
                } catch (e) {
                  toast(`Failed: ${(e as Error).message}`, 'error');
                }
              }}
            >
              No-show
            </button>
            <button
              className="text-rose-700 hover:underline"
              onClick={async () => {
                const reason = window.prompt('Cancellation reason (required)?');
                if (!reason || reason.trim() === '') return;
                try {
                  await update.mutateAsync({ status: 'CANCELLED', cancellationReason: reason });
                  toast('Booking cancelled');
                } catch (e) {
                  toast(`Failed: ${(e as Error).message}`, 'error');
                }
              }}
            >
              Cancel
            </button>
          </>
        ) : null}
        {canAdmin && !booking.linkedApplicationId ? (
          <button
            className="text-violet-700 hover:underline"
            onClick={async () => {
              const appId = window.prompt('Application UUID to link?');
              if (!appId) return;
              try {
                await link.mutateAsync({ applicationId: appId });
                toast('Application linked');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Link application
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function CreateSlotModal({ onClose }: { onClose: () => void }) {
  const create = useCreateTourSlot();
  const { toast } = useToast();
  const [tourDate, setTourDate] = useState(new Date().toISOString().slice(0, 10));
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('11:00');
  const [tourType, setTourType] = useState<TourType>('INDIVIDUAL_FAMILY_TOUR');
  const [maxBookings, setMaxBookings] = useState(1);
  const [meetingPoint, setMeetingPoint] = useState('Reception, Main Entrance');
  const [notes, setNotes] = useState('');
  const [publishImmediately, setPublishImmediately] = useState(true);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await create.mutateAsync({
        tourDate,
        startTime,
        endTime,
        maxBookings,
        tourType,
        meetingPoint: meetingPoint || null,
        notes: notes || null,
        isPublished: publishImmediately,
      });
      toast('Slot created');
      onClose();
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        className="w-full max-w-md space-y-3 rounded-lg bg-white p-6 shadow-lg"
        onSubmit={submit}
      >
        <h3 className="text-lg font-semibold">New tour slot</h3>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Date</span>
          <input
            type="date"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={tourDate}
            onChange={(e) => setTourDate(e.target.value)}
            required
          />
        </label>
        <div className="flex gap-2">
          <label className="flex-1 text-sm">
            <span className="block font-medium text-slate-700">Start</span>
            <input
              type="time"
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              required
            />
          </label>
          <label className="flex-1 text-sm">
            <span className="block font-medium text-slate-700">End</span>
            <input
              type="time"
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              required
            />
          </label>
        </div>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Type</span>
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={tourType}
            onChange={(e) => setTourType(e.target.value as TourType)}
          >
            {TOUR_TYPES.map((t) => (
              <option key={t} value={t}>
                {TOUR_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Max bookings</span>
          <input
            type="number"
            min={1}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={maxBookings}
            onChange={(e) => setMaxBookings(Number(e.target.value))}
            required
          />
          <span className="text-xs text-slate-500">
            1 = individual family tour. Higher caps = group tour (Open Day).
          </span>
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Meeting point</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={meetingPoint}
            onChange={(e) => setMeetingPoint(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Notes</span>
          <textarea
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={publishImmediately}
            onChange={(e) => setPublishImmediately(e.target.checked)}
          />
          Publish immediately to public booking page
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="text-sm text-slate-600" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="rounded bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
