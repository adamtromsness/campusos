'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader, EmptyState, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useAlumniEvents,
  useCreateAlumniEvent,
  useDeleteAlumniEvent,
  useUpdateAlumniEvent,
} from '@/hooks/use-alumni';
import { formatDateOnly } from '@/lib/alumni-format';
import type { AlumniEventDto } from '@/lib/types';

export default function AlumniEventsPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user?.activePersona?.type === 'STAFF';
  const showStaffSurfaces = isStaff || isAdmin;

  const eventsQ = useAlumniEvents();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AlumniEventDto | null>(null);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Alumni Events"
        description="Homecoming, networking nights, special programmes."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/alumni"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          ← Directory
        </Link>
        {showStaffSurfaces && (
          <button
            type="button"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
            onClick={() => setCreateOpen(true)}
          >
            New event
          </button>
        )}
      </div>

      {eventsQ.isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (eventsQ.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="No upcoming events"
          description={showStaffSurfaces ? 'Plan one to fill the calendar.' : 'Check back soon.'}
        />
      ) : (
        <ul className="space-y-3">
          {eventsQ.data!.map((e) => (
            <li key={e.id} className="rounded-md border border-gray-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-gray-900">{e.title}</h3>
                  <div className="mt-1 text-xs text-gray-500">
                    {formatDateOnly(e.eventDate)}
                    {e.venue ? ' · ' + e.venue : ''}
                  </div>
                  {e.description && <p className="mt-2 text-sm text-gray-700">{e.description}</p>}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  {e.evtEventId ? (
                    e.ticketsAvailable !== null ? (
                      <div className="flex flex-col items-end gap-1">
                        <span className="rounded bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                          {e.ticketsAvailable} tickets left
                        </span>
                        <Link
                          href={`/events/${e.evtEventId}`}
                          className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700"
                        >
                          Buy tickets
                        </Link>
                      </div>
                    ) : (
                      <span className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-700 ring-1 ring-amber-200">
                        Ticketing linked but not enabled
                      </span>
                    )
                  ) : e.rsvpUrl ? (
                    <a
                      href={e.rsvpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-md bg-campus-600 px-3 py-1 text-xs font-medium text-white hover:bg-campus-700"
                    >
                      RSVP ↗
                    </a>
                  ) : null}
                  {showStaffSurfaces && (
                    <button
                      type="button"
                      className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
                      onClick={() => setEditing(e)}
                    >
                      Edit
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {showStaffSurfaces && (
        <CreateEventModal open={createOpen} onClose={() => setCreateOpen(false)} />
      )}
      {editing && (
        <EditEventModal open={!!editing} onClose={() => setEditing(null)} event={editing} />
      )}
    </div>
  );
}

function CreateEventModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateAlumniEvent();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [venue, setVenue] = useState('');
  const [rsvpUrl, setRsvpUrl] = useState('');
  const [evtEventId, setEvtEventId] = useState('');

  const submit = async () => {
    if (!title.trim() || !eventDate) {
      toast('Title and date are required.', 'error');
      return;
    }
    try {
      await create.mutateAsync({
        title: title.trim(),
        description: description || undefined,
        eventDate,
        venue: venue || undefined,
        rsvpUrl: rsvpUrl || undefined,
        evtEventId: evtEventId || undefined,
      });
      toast('Event created.', 'success');
      setTitle('');
      setDescription('');
      setEventDate('');
      setVenue('');
      setRsvpUrl('');
      setEvtEventId('');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New alumni event"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
            onClick={submit}
            disabled={create.isPending}
          >
            Create
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Title</span>
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Date</span>
          <input
            type="date"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Venue</span>
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={venue}
            onChange={(e) => setVenue(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Description</span>
          <textarea
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">RSVP URL</span>
          <input
            type="url"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            placeholder="https://…"
            value={rsvpUrl}
            onChange={(e) => setRsvpUrl(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">
            Linked P2-12 Event ID (optional)
          </span>
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            placeholder="UUID of the evt_events row"
            value={evtEventId}
            onChange={(e) => setEvtEventId(e.target.value)}
          />
          <p className="mt-1 text-xs text-gray-500">
            Set this to the corresponding Events row to enable ticketing. The Alumni module runs
            independently — when Events isn&apos;t enabled, the UI falls back to the RSVP URL.
          </p>
        </label>
      </div>
    </Modal>
  );
}

function EditEventModal({
  open,
  onClose,
  event,
}: {
  open: boolean;
  onClose: () => void;
  event: AlumniEventDto;
}) {
  const { toast } = useToast();
  const update = useUpdateAlumniEvent(event.id);
  const del = useDeleteAlumniEvent();
  const [title, setTitle] = useState(event.title);
  const [description, setDescription] = useState(event.description ?? '');
  const [eventDate, setEventDate] = useState(event.eventDate);
  const [venue, setVenue] = useState(event.venue ?? '');
  const [rsvpUrl, setRsvpUrl] = useState(event.rsvpUrl ?? '');
  const [evtEventId, setEvtEventId] = useState(event.evtEventId ?? '');

  const save = async () => {
    try {
      await update.mutateAsync({
        title: title.trim() || undefined,
        description,
        eventDate,
        venue,
        rsvpUrl,
        evtEventId: evtEventId || undefined,
      });
      toast('Saved.', 'success');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this event?')) return;
    try {
      await del.mutateAsync(event.id);
      toast('Deleted.', 'success');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit event"
      footer={
        <div className="flex w-full items-center justify-between">
          <button
            type="button"
            className="rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50"
            onClick={remove}
          >
            Delete
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
              onClick={save}
              disabled={update.isPending}
            >
              Save
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Title</span>
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Date</span>
          <input
            type="date"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Venue</span>
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={venue}
            onChange={(e) => setVenue(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Description</span>
          <textarea
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">RSVP URL</span>
          <input
            type="url"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={rsvpUrl}
            onChange={(e) => setRsvpUrl(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">
            Linked P2-12 Event ID
          </span>
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={evtEventId}
            onChange={(e) => setEvtEventId(e.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}
