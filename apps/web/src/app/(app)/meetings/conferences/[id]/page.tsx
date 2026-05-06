'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  useBookSlot,
  useCancelSlot,
  useConference,
  useMeetings,
  useMeetingSlots,
} from '@/hooks/use-meetings';
import { useAuthStore } from '@/lib/auth-store';
import type { MeetingDto, MeetingSlotDto } from '@/lib/types';

const CONFERENCE_STATUS_PILL: Record<string, string> = {
  SCHEDULED: 'bg-sky-100 text-sky-800',
  ACTIVE: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-gray-100 text-gray-700',
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatDateLabel(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export default function ConferenceDetailPage() {
  const params = useParams();
  const conferenceId = String(params.id);
  const user = useAuthStore((s) => s.user);
  const { data: conference } = useConference(conferenceId);
  const { data: meetings } = useMeetings({ conferenceEventId: conferenceId });
  const teacherMeetings = (meetings ?? []).filter((m) => m.conferenceEventId === conferenceId);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader
        title={conference?.title ?? 'Conference'}
        description={
          conference
            ? (conference.description ??
              conference.conferenceType.replace(/_/g, ' ') +
                ' · ' +
                formatDateLabel(conference.startDate) +
                ' — ' +
                formatDateLabel(conference.endDate))
            : 'Loading…'
        }
        actions={
          <Link
            href="/meetings"
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            ← All meetings
          </Link>
        }
      />

      {conference && (
        <div className="mt-3 flex items-center gap-3 text-sm">
          <span
            className={
              'rounded-full px-2 py-0.5 text-xs font-semibold ' +
              (CONFERENCE_STATUS_PILL[conference.status] ?? 'bg-gray-100 text-gray-700')
            }
          >
            {conference.status}
          </span>
          <span className="text-gray-500">
            {conference.bookedSlots ?? 0} of {conference.totalSlots ?? 0} slots booked
          </span>
        </div>
      )}

      <div className="mt-6 space-y-6">
        {teacherMeetings.length === 0 ? (
          <EmptyState
            title="No teacher availability set"
            description={
              user?.personType === 'GUARDIAN'
                ? 'Teachers have not yet posted availability for this conference. Check back soon.'
                : 'Create a meeting per teacher and add time slots to make availability bookable.'
            }
          />
        ) : (
          teacherMeetings.map((m) => <TeacherSlotColumn key={m.id} meeting={m} />)
        )}
      </div>
    </div>
  );
}

function TeacherSlotColumn({ meeting }: { meeting: MeetingDto }) {
  const user = useAuthStore((s) => s.user);
  const { data: slots } = useMeetingSlots(meeting.id);
  const sorted = (slots ?? []).slice().sort((a, b) => a.startTime.localeCompare(b.startTime));

  // Group by date for parent self-service browse
  const byDate = new Map<string, MeetingSlotDto[]>();
  for (const s of sorted) {
    const date = new Date(s.startTime).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const list = byDate.get(date) ?? [];
    list.push(s);
    byDate.set(date, list);
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">
            {meeting.organiserName ?? 'Teacher'} — {meeting.title}
          </h3>
          <p className="text-xs text-gray-500">{meeting.meetingTypeName ?? 'Meeting'}</p>
        </div>
      </div>
      {sorted.length === 0 ? (
        <p className="text-sm text-gray-500">No slots posted yet.</p>
      ) : (
        <div className="space-y-3">
          {Array.from(byDate.entries()).map(([date, list]) => (
            <div key={date}>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                {date}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {list.map((slot) => (
                  <SlotChip key={slot.id} slot={slot} myAccountId={user?.id ?? null} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SlotChip({ slot, myAccountId }: { slot: MeetingSlotDto; myAccountId: string | null }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const book = useBookSlot();
  const cancel = useCancelSlot();
  const { toast } = useToast();

  const isMine = slot.bookedBy && myAccountId && slot.bookedBy === myAccountId;
  const label = formatTime(slot.startTime) + ' — ' + formatTime(slot.endTime);

  if (slot.isBooked) {
    return (
      <div
        className={
          'rounded-md border px-3 py-2 text-xs font-semibold ' +
          (isMine
            ? 'border-emerald-700 bg-emerald-50 text-emerald-800'
            : 'border-gray-200 bg-gray-50 text-gray-500')
        }
      >
        <div>{label}</div>
        {isMine ? (
          <div className="mt-1">
            <span className="block text-[10px] uppercase tracking-wide">Your booking</span>
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Cancel your booking for ' + label + '?')) {
                  cancel.mutate(slot.id, {
                    onSuccess: () => toast('Booking cancelled', 'success'),
                    onError: (err) =>
                      toast(
                        'Failed to cancel: ' + (err instanceof Error ? err.message : 'unknown'),
                        'error',
                      ),
                  });
                }
              }}
              className="mt-1 text-[10px] uppercase text-rose-700 hover:underline"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="mt-1 text-[10px] uppercase tracking-wide text-gray-400">
            Booked{slot.bookedByName ? ' — ' + slot.bookedByName : ''}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        className="rounded-md border border-campus-700 bg-white px-3 py-2 text-xs font-semibold text-campus-800 hover:bg-campus-50"
      >
        <div>{label}</div>
        <div className="mt-1 text-[10px] uppercase tracking-wide text-emerald-700">Available</div>
      </button>
      {confirmOpen && (
        <Modal
          open
          onClose={() => setConfirmOpen(false)}
          title="Book this slot?"
          footer={
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  book.mutate(slot.id, {
                    onSuccess: () => {
                      toast('Slot booked', 'success');
                      setConfirmOpen(false);
                    },
                    onError: (err) =>
                      toast(
                        'Failed to book: ' + (err instanceof Error ? err.message : 'unknown'),
                        'error',
                      ),
                  });
                }}
                disabled={book.isPending}
                className="rounded-md bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-campus-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {book.isPending ? 'Booking…' : 'Confirm booking'}
              </button>
            </div>
          }
        >
          <p className="text-sm text-gray-700">
            You are about to book <strong>{label}</strong>. The slot will be reserved on a
            first-come, first-served basis.
          </p>
        </Modal>
      )}
    </>
  );
}
