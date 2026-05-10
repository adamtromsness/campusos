'use client';

import { useState } from 'react';
import { usePublicTourSlots, useBookTourPublic } from '@/hooks/use-enrolment-advanced';
import {
  GUEST_TYPE_LABEL,
  TOUR_TYPE_LABEL,
  formatDate,
  formatTime,
} from '@/lib/enrolment-advanced-format';
import type { GuestType, TourSlotResponseDto } from '@/lib/types';

/**
 * Public-facing tour booking page. Unauthenticated — prospective
 * families browse + book. The route is mounted outside the (app)
 * auth-gated layout (mirrors /shop/[storeId] from Cycle 28).
 *
 * The public booking endpoint creates an iam_person on first
 * booking per ADR-055 so future application links resolve cleanly.
 */
export default function PublicTourBookingPage() {
  const slots = usePublicTourSlots();
  const [selected, setSelected] = useState<TourSlotResponseDto | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-4xl px-4 py-12">
      <h1 className="text-3xl font-semibold text-slate-900">Book a campus tour</h1>
      <p className="mt-2 text-slate-600">
        Browse available tour slots and book — no account required. We&apos;ll send a confirmation
        email after you book.
      </p>

      {confirmation ? (
        <div className="mt-6 rounded border border-emerald-200 bg-emerald-50 p-6">
          <h2 className="text-xl font-semibold text-emerald-900">Tour booked!</h2>
          <p className="mt-2 text-emerald-800">{confirmation}</p>
          <button
            className="mt-4 text-sm text-emerald-700 hover:underline"
            onClick={() => {
              setConfirmation(null);
              setSelected(null);
            }}
          >
            Book another tour
          </button>
        </div>
      ) : selected ? (
        <BookingForm
          slot={selected}
          onCancel={() => setSelected(null)}
          onSuccess={(msg) => setConfirmation(msg)}
        />
      ) : (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {(slots.data ?? []).map((slot) => (
            <button
              key={slot.id}
              className="rounded border border-slate-200 bg-white p-4 text-left shadow-sm hover:border-sky-500 hover:shadow"
              onClick={() => setSelected(slot)}
            >
              <div className="text-sm font-medium uppercase text-sky-700">
                {TOUR_TYPE_LABEL[slot.tourType]}
              </div>
              <div className="mt-1 text-lg font-semibold text-slate-900">
                {formatDate(slot.tourDate)}
              </div>
              <div className="text-sm text-slate-600">
                {formatTime(slot.startTime)}–{formatTime(slot.endTime)}
              </div>
              {slot.meetingPoint ? (
                <div className="mt-1 text-xs text-slate-500">{slot.meetingPoint}</div>
              ) : null}
              <div className="mt-2 text-xs text-slate-500">
                {slot.availableSpots} of {slot.maxBookings} spot
                {slot.maxBookings === 1 ? '' : 's'} available
              </div>
              {slot.ledByName ? (
                <div className="mt-1 text-xs text-slate-500">Led by {slot.ledByName}</div>
              ) : null}
            </button>
          ))}
          {slots.data && slots.data.length === 0 ? (
            <div className="col-span-2 rounded border border-slate-200 bg-white p-6 text-center text-slate-500">
              No upcoming tour slots available right now. Please check back later.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface GuestRow {
  guestType: GuestType;
  firstName: string;
  lastName: string;
  age: string;
}

function BookingForm({
  slot,
  onCancel,
  onSuccess,
}: {
  slot: TourSlotResponseDto;
  onCancel: () => void;
  onSuccess: (msg: string) => void;
}) {
  const book = useBookTourPublic(slot.id);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [guests, setGuests] = useState<GuestRow[]>([
    { guestType: 'ADULT', firstName: '', lastName: '', age: '' },
  ]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await book.mutateAsync({
        firstName,
        lastName,
        familyName: familyName || `${firstName} ${lastName}`,
        contactEmail,
        contactPhone: contactPhone || null,
        notes: notes || null,
        guests: guests
          .filter((g) => g.firstName && g.lastName)
          .map((g) => ({
            guestType: g.guestType,
            firstName: g.firstName,
            lastName: g.lastName,
            age: g.age ? Number(g.age) : null,
          })),
      });
      onSuccess(
        `You're booked for the ${formatDate(slot.tourDate)} ${formatTime(slot.startTime)} ${TOUR_TYPE_LABEL[slot.tourType]}. We'll send a confirmation to ${contactEmail}.`,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <form className="mt-6 space-y-4 rounded border border-slate-200 bg-white p-6" onSubmit={submit}>
      <div>
        <h2 className="text-xl font-semibold">{TOUR_TYPE_LABEL[slot.tourType]}</h2>
        <p className="text-sm text-slate-600">
          {formatDate(slot.tourDate)} · {formatTime(slot.startTime)}–{formatTime(slot.endTime)}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="block font-medium">First name</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium">Last name</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            required
          />
        </label>
        <label className="sm:col-span-2 block text-sm">
          <span className="block font-medium">Family name (optional)</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={familyName}
            onChange={(e) => setFamilyName(e.target.value)}
            placeholder="Defaults to first + last name"
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium">Email</span>
          <input
            type="email"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            required
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium">Phone (optional)</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
          />
        </label>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-700">Guests</h3>
        <p className="text-xs text-slate-500">
          Tell us who&apos;s coming so we can plan. Add at least the prospective student.
        </p>
        <div className="mt-2 space-y-2">
          {guests.map((g, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 text-sm">
              <select
                className="col-span-3 rounded border border-slate-300 px-2 py-1.5"
                value={g.guestType}
                onChange={(e) =>
                  setGuests((arr) =>
                    arr.map((row, idx) =>
                      idx === i ? { ...row, guestType: e.target.value as GuestType } : row,
                    ),
                  )
                }
              >
                {(['ADULT', 'CHILD', 'PROSPECTIVE_STUDENT'] as GuestType[]).map((t) => (
                  <option key={t} value={t}>
                    {GUEST_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
              <input
                className="col-span-3 rounded border border-slate-300 px-2 py-1.5"
                placeholder="First name"
                value={g.firstName}
                onChange={(e) =>
                  setGuests((arr) =>
                    arr.map((row, idx) =>
                      idx === i ? { ...row, firstName: e.target.value } : row,
                    ),
                  )
                }
              />
              <input
                className="col-span-3 rounded border border-slate-300 px-2 py-1.5"
                placeholder="Last name"
                value={g.lastName}
                onChange={(e) =>
                  setGuests((arr) =>
                    arr.map((row, idx) => (idx === i ? { ...row, lastName: e.target.value } : row)),
                  )
                }
              />
              <input
                className="col-span-2 rounded border border-slate-300 px-2 py-1.5"
                placeholder="Age"
                value={g.age}
                onChange={(e) =>
                  setGuests((arr) =>
                    arr.map((row, idx) => (idx === i ? { ...row, age: e.target.value } : row)),
                  )
                }
              />
              <button
                type="button"
                className="col-span-1 text-rose-700 hover:underline"
                onClick={() =>
                  setGuests((arr) => (arr.length > 1 ? arr.filter((_, idx) => idx !== i) : arr))
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="mt-2 text-sm text-sky-700 hover:underline"
          onClick={() =>
            setGuests((arr) => [
              ...arr,
              { guestType: 'CHILD', firstName: '', lastName: '', age: '' },
            ])
          }
        >
          + Add guest
        </button>
      </div>

      <label className="block text-sm">
        <span className="block font-medium">Anything else we should know?</span>
        <textarea
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>

      {error ? <div className="rounded bg-rose-50 p-3 text-sm text-rose-800">{error}</div> : null}

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="text-sm text-slate-600" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="rounded bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700"
          disabled={book.isPending}
        >
          {book.isPending ? 'Booking…' : 'Book tour'}
        </button>
      </div>
    </form>
  );
}
