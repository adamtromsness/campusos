'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useFacBuildings,
  useFacCreateBooking,
  useFacMyBookings,
  useFacSpaceBookings,
  useFacSpaces,
  useFacUpdateBooking,
} from '@/hooks/use-facilities';
import {
  FAC_BOOKING_STATUS_LABEL,
  FAC_BOOKING_STATUS_PILL,
  formatDateTime,
} from '@/lib/facilities-format';
import type { FacBookingDto } from '@/lib/types';

export default function BookingsPage() {
  const buildingsQ = useFacBuildings();
  const myBookingsQ = useFacMyBookings();
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const spacesQ = useFacSpaces(buildingId);
  const bookingsQ = useFacSpaceBookings(spaceId);

  useEffect(() => {
    if (!buildingId && (buildingsQ.data?.length ?? 0) > 0) {
      setBuildingId(buildingsQ.data![0]!.id);
    }
  }, [buildingId, buildingsQ.data]);

  return (
    <div>
      <PageHeader
        title="Space bookings"
        description="EXCLUDE gist on (space, time-range) prevents overlapping CONFIRMED bookings"
        actions={
          <Link
            href="/facilities"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Facilities
          </Link>
        }
      />

      <section className="mb-4 rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Browse a space</h2>
        <div className="mt-2 grid gap-3 lg:grid-cols-3">
          <label className="block text-sm">
            <span className="block font-medium text-gray-700">Building</span>
            <select
              value={buildingId ?? ''}
              onChange={(e) => {
                setBuildingId(e.target.value || null);
                setSpaceId(null);
              }}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {(buildingsQ.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm lg:col-span-2">
            <span className="block font-medium text-gray-700">Space</span>
            <select
              value={spaceId ?? ''}
              onChange={(e) => setSpaceId(e.target.value || null)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              disabled={!buildingId}
            >
              <option value="">— pick a space —</option>
              {(spacesQ.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.spaceType})
                </option>
              ))}
            </select>
          </label>
        </div>
        {spaceId && (
          <button
            type="button"
            onClick={() => setShowNew(true)}
            className="mt-3 rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
          >
            New booking
          </button>
        )}
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Bookings on this space</h2>
        {!spaceId ? (
          <p className="mt-3 text-sm text-gray-500">Pick a space to see its bookings.</p>
        ) : bookingsQ.isLoading ? (
          <LoadingSpinner />
        ) : bookingsQ.data && bookingsQ.data.length > 0 ? (
          <ul className="mt-3 space-y-1 text-sm">
            {bookingsQ.data.map((bk) => (
              <BookingRow key={bk.id} booking={bk} />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No bookings on this space yet.</p>
        )}
      </section>

      <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">My bookings</h2>
        {myBookingsQ.isLoading ? (
          <LoadingSpinner />
        ) : myBookingsQ.data && myBookingsQ.data.length > 0 ? (
          <ul className="mt-3 space-y-1 text-sm">
            {myBookingsQ.data.map((bk) => (
              <BookingRow key={bk.id} booking={bk} />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">You have no bookings yet.</p>
        )}
      </section>

      {showNew && spaceId && (
        <NewBookingModal spaceId={spaceId} onClose={() => setShowNew(false)} />
      )}
    </div>
  );
}

function BookingRow({ booking }: { booking: FacBookingDto }) {
  const update = useFacUpdateBooking(booking.id);
  const { toast } = useToast();
  return (
    <li className="flex items-baseline justify-between gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
      <div>
        <div className="font-medium text-gray-900">{booking.title}</div>
        <div className="text-xs text-gray-600">
          {booking.spaceName} · {formatDateTime(booking.startsAt)} →{' '}
          {formatDateTime(booking.endsAt)}
        </div>
        <div className="text-xs text-gray-500">By {booking.bookedByName ?? 'unknown'}</div>
      </div>
      <div className="flex items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${FAC_BOOKING_STATUS_PILL[booking.status]}`}
        >
          {FAC_BOOKING_STATUS_LABEL[booking.status]}
        </span>
        {booking.status === 'CONFIRMED' && (
          <button
            type="button"
            onClick={async () => {
              try {
                await update.mutateAsync({ status: 'CANCELLED' });
                toast('Booking cancelled', 'success');
              } catch (err) {
                toast((err as Error).message, 'error');
              }
            }}
            className="text-xs text-rose-700 underline underline-offset-4"
          >
            Cancel
          </button>
        )}
      </div>
    </li>
  );
}

function NewBookingModal({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const create = useFacCreateBooking(spaceId);
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');

  return (
    <Modal
      open
      onClose={onClose}
      title="New booking"
      footer={
        <button
          type="button"
          onClick={async () => {
            if (!title || !startsAt || !endsAt) {
              toast('Fill all fields', 'error');
              return;
            }
            try {
              await create.mutateAsync({
                title,
                startsAt: new Date(startsAt).toISOString(),
                endsAt: new Date(endsAt).toISOString(),
              });
              toast('Booking confirmed', 'success');
              onClose();
            } catch (err) {
              const e = err as { status?: number; message?: string };
              if (e.status === 409) {
                toast(
                  'Conflict — this space is already booked for an overlapping time. Pick a different time.',
                  'error',
                );
              } else {
                toast(e.message ?? 'Failed to book', 'error');
              }
            }
          }}
          disabled={create.isPending}
          className="rounded-lg bg-campus-700 px-3 py-2 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
        >
          {create.isPending ? 'Booking…' : 'Book space'}
        </button>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="block font-medium text-gray-700">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Grade 5 Assembly"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="block font-medium text-gray-700">Starts at</span>
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="block font-medium text-gray-700">Ends at</span>
          <input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
    </Modal>
  );
}
