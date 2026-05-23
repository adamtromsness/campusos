'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader, EmptyState, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useCreateReunion,
  useMyAlumniProfile,
  useReunions,
  useUpdateReunion,
} from '@/hooks/use-alumni';
import { REUNION_STATUS_LABEL, REUNION_STATUS_PILL, formatDateOnly } from '@/lib/alumni-format';
import { REUNION_STATUSES } from '@/lib/types';
import type { ReunionGroupDto, ReunionStatus } from '@/lib/types';

export default function ReunionsPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user?.activePersona?.type === 'STAFF';
  const showStaffSurfaces = isStaff || isAdmin;

  const myProfileQ = useMyAlumniProfile();
  const [statusFilter, setStatusFilter] = useState<'ALL' | ReunionStatus>('ALL');
  const [yearFilter, setYearFilter] = useState('');
  const reunionsQ = useReunions({
    status: statusFilter === 'ALL' ? undefined : statusFilter,
    graduationYear: yearFilter ? Number(yearFilter) : undefined,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ReunionGroupDto | null>(null);

  const canCreate = myProfileQ.data || showStaffSurfaces;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Class Reunions"
        description="Organise and discover class reunions across the years."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/alumni"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          ← Directory
        </Link>
        {canCreate && (
          <button
            type="button"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
            onClick={() => setCreateOpen(true)}
          >
            New reunion
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(['ALL', ...REUNION_STATUSES] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={
              'rounded-full border px-3 py-1 text-xs ' +
              (statusFilter === s
                ? 'border-campus-600 bg-campus-50 text-campus-700'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')
            }
            onClick={() => setStatusFilter(s)}
          >
            {s === 'ALL' ? 'All' : REUNION_STATUS_LABEL[s]}
          </button>
        ))}
        <input
          type="number"
          className="ml-2 w-32 rounded-md border border-gray-300 px-2 py-1 text-xs"
          placeholder="filter year"
          value={yearFilter}
          onChange={(e) => setYearFilter(e.target.value)}
        />
      </div>

      {reunionsQ.isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (reunionsQ.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="No reunions yet"
          description={canCreate ? 'Be the first to plan one for your class.' : 'Check back soon.'}
        />
      ) : (
        <ul className="space-y-3">
          {reunionsQ.data!.map((r) => {
            const canEdit =
              showStaffSurfaces || (myProfileQ.data && myProfileQ.data.id === r.organiserId);
            return (
              <li key={r.id} className="rounded-md border border-gray-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-gray-900">{r.name}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded bg-campus-50 px-2 py-0.5 font-medium text-campus-700 ring-1 ring-campus-200">
                        Class of {r.graduationYear}
                      </span>
                      <span
                        className={
                          'rounded px-1.5 py-0.5 font-medium ' + REUNION_STATUS_PILL[r.status]
                        }
                      >
                        {REUNION_STATUS_LABEL[r.status]}
                      </span>
                      <span className="text-gray-500">Organised by {r.organiserName ?? '—'}</span>
                    </div>
                    {r.description && <p className="mt-2 text-sm text-gray-700">{r.description}</p>}
                    <div className="mt-2 text-xs text-gray-500">
                      {r.eventDate ? (
                        <span>Event: {formatDateOnly(r.eventDate)}</span>
                      ) : (
                        <span>No date set yet.</span>
                      )}
                      {r.rsvpDeadline && (
                        <span className="ml-3">RSVP by {formatDateOnly(r.rsvpDeadline)}</span>
                      )}
                      {r.venue && <span className="ml-3">Venue: {r.venue}</span>}
                    </div>
                  </div>
                  {canEdit && (
                    <button
                      type="button"
                      className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
                      onClick={() => setEditing(r)}
                    >
                      Edit
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canCreate && (
        <CreateReunionModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          defaultOrganiserId={myProfileQ.data?.id ?? ''}
          defaultGraduationYear={myProfileQ.data?.graduationYear ?? new Date().getFullYear()}
        />
      )}
      {editing && (
        <EditReunionModal open={!!editing} onClose={() => setEditing(null)} reunion={editing} />
      )}
    </div>
  );
}

function CreateReunionModal({
  open,
  onClose,
  defaultOrganiserId,
  defaultGraduationYear,
}: {
  open: boolean;
  onClose: () => void;
  defaultOrganiserId: string;
  defaultGraduationYear: number;
}) {
  const { toast } = useToast();
  const create = useCreateReunion();
  const [graduationYear, setGraduationYear] = useState(String(defaultGraduationYear));
  const [name, setName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [rsvpDeadline, setRsvpDeadline] = useState('');
  const [venue, setVenue] = useState('');
  const [description, setDescription] = useState('');

  const submit = async () => {
    if (!name.trim() || !defaultOrganiserId) {
      toast('Name + organiser are required.', 'error');
      return;
    }
    try {
      await create.mutateAsync({
        graduationYear: Number(graduationYear),
        name: name.trim(),
        organiserId: defaultOrganiserId,
        eventDate: eventDate || undefined,
        rsvpDeadline: rsvpDeadline || undefined,
        venue: venue || undefined,
        description: description || undefined,
      });
      toast('Reunion created as PLANNING.', 'success');
      setName('');
      setEventDate('');
      setRsvpDeadline('');
      setVenue('');
      setDescription('');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New reunion"
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
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-gray-500">Class year</span>
            <input
              type="number"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
              value={graduationYear}
              onChange={(e) => setGraduationYear(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-gray-500">Name</span>
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
              placeholder="e.g. Class of 2020 — 5-Year Reunion"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-gray-500">Event date</span>
            <input
              type="date"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-gray-500">
              RSVP deadline
            </span>
            <input
              type="date"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
              value={rsvpDeadline}
              onChange={(e) => setRsvpDeadline(e.target.value)}
            />
          </label>
        </div>
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
      </div>
    </Modal>
  );
}

function EditReunionModal({
  open,
  onClose,
  reunion,
}: {
  open: boolean;
  onClose: () => void;
  reunion: ReunionGroupDto;
}) {
  const { toast } = useToast();
  const update = useUpdateReunion(reunion.id);
  const [name, setName] = useState(reunion.name);
  const [eventDate, setEventDate] = useState(reunion.eventDate ?? '');
  const [rsvpDeadline, setRsvpDeadline] = useState(reunion.rsvpDeadline ?? '');
  const [venue, setVenue] = useState(reunion.venue ?? '');
  const [description, setDescription] = useState(reunion.description ?? '');
  const [status, setStatus] = useState<ReunionStatus>(reunion.status);

  const save = async () => {
    try {
      await update.mutateAsync({
        name: name.trim() || undefined,
        eventDate: eventDate || undefined,
        rsvpDeadline: rsvpDeadline || undefined,
        venue: venue || undefined,
        description: description || undefined,
        status,
      });
      toast('Saved.', 'success');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit reunion"
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
            onClick={save}
            disabled={update.isPending}
          >
            Save
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Name</span>
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Status</span>
          <select
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={status}
            onChange={(e) => setStatus(e.target.value as ReunionStatus)}
          >
            {REUNION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {REUNION_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-500">
            CONFIRMED requires an event date — the backend enforces this.
          </p>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-gray-500">Event date</span>
            <input
              type="date"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-gray-500">
              RSVP deadline
            </span>
            <input
              type="date"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
              value={rsvpDeadline}
              onChange={(e) => setRsvpDeadline(e.target.value)}
            />
          </label>
        </div>
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
      </div>
    </Modal>
  );
}
