'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  CERT_STATUS_LABEL,
  CERT_STATUS_PILL,
  EVENT_STATUS_LABEL,
  EVENT_STATUS_PILL,
  expiryTone,
  formatDate,
  formatDateTime,
} from '@/lib/hr-development-format';
import {
  useCertificationTypes,
  useCertificationsExpiring,
  useCreateTrainingEvent,
  useCreateTrainingProgramme,
  useEventCompletions,
  usePatchTrainingEvent,
  usePatchTrainingProgramme,
  useTrainingEvents,
  useTrainingProgrammes,
} from '@/hooks/use-hr-development';
import type { EventStatus, TrainingEventDto, TrainingProgrammeDto } from '@/lib/types';

/**
 * Training admin pipeline. Gated on hr-004:read (Staff + Admin).
 * Generic Teachers hold hr-004:read but the service-layer
 * row scope on listForEvent() restricts non-admin actors to
 * their own completion row, so the page renders the admin
 * surface only when the actor has hr-004:write or sch-001:admin.
 */
export default function TrainingPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = hasAnyPermission(user, ['hr-004:read', 'hr-004:write', 'sch-001:admin']);
  const canWrite = hasAnyPermission(user, ['hr-004:write', 'hr-004:admin', 'sch-001:admin']);

  const [tab, setTab] = useState<'programmes' | 'events' | 'expiring'>('programmes');

  if (!canRead) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Training & Certifications</h1>
        <div className="rounded border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
          The training admin surface is restricted to school staff and administrators.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Training & Certifications</h1>
        <div className="flex gap-3 text-sm">
          <Link className="text-sky-700 hover:underline" href="/hr/appraisals">
            Appraisals
          </Link>
          <Link className="text-sky-700 hover:underline" href="/hr/expense-claims">
            Expense claims
          </Link>
        </div>
      </div>

      <div className="flex gap-2 border-b border-slate-200">
        {(['programmes', 'events', 'expiring'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === k
                ? 'border-sky-600 font-semibold text-sky-700'
                : 'border-transparent text-slate-600 hover:text-slate-800'
            }`}
          >
            {k === 'programmes' ? 'Programmes' : k === 'events' ? 'Events' : 'Expiring certs'}
          </button>
        ))}
      </div>

      {tab === 'programmes' ? <ProgrammesTab canWrite={canWrite} /> : null}
      {tab === 'events' ? <EventsTab canWrite={canWrite} /> : null}
      {tab === 'expiring' ? <ExpiringTab /> : null}
    </div>
  );
}

function ProgrammesTab({ canWrite }: { canWrite: boolean }) {
  const programmes = useTrainingProgrammes(canWrite);
  const [showCreate, setShowCreate] = useState(false);
  return (
    <section className="rounded border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Programmes</h2>
        {canWrite ? (
          <button
            className="rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
            onClick={() => setShowCreate(true)}
          >
            New programme
          </button>
        ) : null}
      </div>
      <table className="mt-3 min-w-full text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="text-left">
            <th className="py-2">Name</th>
            <th>Mandatory</th>
            <th>Renewal (months)</th>
            <th>Active</th>
            <th></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {(programmes.data ?? []).map((p) => (
            <ProgrammeRow key={p.id} programme={p} canWrite={canWrite} />
          ))}
          {(programmes.data ?? []).length === 0 ? (
            <tr>
              <td colSpan={5} className="py-3 text-slate-500">
                No programmes yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {showCreate ? <CreateProgrammeModal onClose={() => setShowCreate(false)} /> : null}
    </section>
  );
}

function ProgrammeRow({
  programme,
  canWrite,
}: {
  programme: TrainingProgrammeDto;
  canWrite: boolean;
}) {
  const { toast } = useToast();
  const patch = usePatchTrainingProgramme(programme.id);
  return (
    <tr>
      <td className="py-2 font-medium">{programme.name}</td>
      <td>{programme.isMandatory ? 'Yes' : 'No'}</td>
      <td>{programme.renewalMonths ?? '—'}</td>
      <td>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            programme.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'
          }`}
        >
          {programme.isActive ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td className="text-right text-xs">
        {canWrite ? (
          <button
            className="text-sky-700 hover:underline"
            onClick={async () => {
              try {
                await patch.mutateAsync({ isActive: !programme.isActive });
                toast(programme.isActive ? 'Deactivated' : 'Reactivated');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            {programme.isActive ? 'Deactivate' : 'Reactivate'}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function CreateProgrammeModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateTrainingProgramme();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isMandatory, setIsMandatory] = useState(true);
  const [renewalMonths, setRenewalMonths] = useState('12');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await create.mutateAsync({
        name,
        description: description || undefined,
        isMandatory,
        renewalMonths: renewalMonths ? Number(renewalMonths) : undefined,
      });
      toast('Programme created');
      onClose();
    } catch (err) {
      toast(`Failed: ${(err as Error).message}`, 'error');
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        className="w-full max-w-md space-y-3 rounded-lg bg-white p-6 shadow-lg"
        onSubmit={submit}
      >
        <h3 className="text-lg font-semibold">New training programme</h3>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Name</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Description</span>
          <textarea
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isMandatory}
            onChange={(e) => setIsMandatory(e.target.checked)}
          />
          <span>Mandatory for staff</span>
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Renewal cadence (months)</span>
          <input
            type="number"
            min={1}
            max={120}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={renewalMonths}
            onChange={(e) => setRenewalMonths(e.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="text-sm text-slate-600" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="rounded bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700"
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

function EventsTab({ canWrite }: { canWrite: boolean }) {
  const [statusFilter, setStatusFilter] = useState<EventStatus | ''>('');
  const events = useTrainingEvents(statusFilter ? { status: statusFilter } : undefined);
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  return (
    <section className="rounded border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Events</h2>
        <div className="flex items-center gap-3">
          <select
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter((e.target.value as EventStatus) || '')}
          >
            <option value="">All statuses</option>
            {(['SCHEDULED', 'COMPLETED', 'CANCELLED'] as EventStatus[]).map((s) => (
              <option key={s} value={s}>
                {EVENT_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          {canWrite ? (
            <button
              className="rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
              onClick={() => setShowCreate(true)}
            >
              Schedule event
            </button>
          ) : null}
        </div>
      </div>
      <table className="mt-3 min-w-full text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="text-left">
            <th className="py-2">Title</th>
            <th>Programme</th>
            <th>When</th>
            <th>Status</th>
            <th>Completions</th>
            <th></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {(events.data ?? []).map((ev) => (
            <EventRow
              key={ev.id}
              event={ev}
              canWrite={canWrite}
              expanded={openEventId === ev.id}
              onToggle={() => setOpenEventId((cur) => (cur === ev.id ? null : ev.id))}
            />
          ))}
          {(events.data ?? []).length === 0 ? (
            <tr>
              <td colSpan={6} className="py-3 text-slate-500">
                No events found.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {showCreate ? <CreateEventModal onClose={() => setShowCreate(false)} /> : null}
    </section>
  );
}

function EventRow({
  event,
  canWrite,
  expanded,
  onToggle,
}: {
  event: TrainingEventDto;
  canWrite: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { toast } = useToast();
  const patch = usePatchTrainingEvent(event.id);
  return (
    <>
      <tr className={expanded ? 'bg-sky-50' : ''}>
        <td className="py-2 font-medium">{event.title}</td>
        <td>{event.programmeName ?? '—'}</td>
        <td>{formatDateTime(event.scheduledAt)}</td>
        <td>
          <span className={`rounded px-2 py-0.5 text-xs ${EVENT_STATUS_PILL[event.status]}`}>
            {EVENT_STATUS_LABEL[event.status]}
          </span>
        </td>
        <td className="text-center">{event.completionCount}</td>
        <td className="space-x-2 text-right text-xs">
          <button className="text-sky-700 hover:underline" onClick={onToggle}>
            {expanded ? 'Hide' : 'View'} completions
          </button>
          {canWrite && event.status === 'SCHEDULED' ? (
            <button
              className="text-emerald-700 hover:underline"
              onClick={async () => {
                if (!window.confirm('Mark this event COMPLETED?')) return;
                try {
                  await patch.mutateAsync({ status: 'COMPLETED' });
                  toast('Event marked completed');
                } catch (e) {
                  toast(`Failed: ${(e as Error).message}`, 'error');
                }
              }}
            >
              Complete
            </button>
          ) : null}
          {canWrite && event.status === 'SCHEDULED' ? (
            <button
              className="text-rose-700 hover:underline"
              onClick={async () => {
                const reason = window.prompt('Cancellation reason?');
                if (!reason || reason.trim() === '') return;
                try {
                  await patch.mutateAsync({ status: 'CANCELLED', cancellationReason: reason });
                  toast('Event cancelled');
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
      {expanded ? (
        <tr className="bg-sky-50/30">
          <td colSpan={6} className="px-4 py-3">
            <CompletionsPanel eventId={event.id} canWrite={canWrite} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function CompletionsPanel({
  eventId,
  canWrite: _canWrite,
}: {
  eventId: string;
  canWrite: boolean;
}) {
  const completions = useEventCompletions(eventId);
  return (
    <div>
      <h3 className="text-sm font-semibold">Completions</h3>
      <table className="mt-2 min-w-full text-xs">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="text-left">
            <th>Employee</th>
            <th>Completed</th>
            <th>Score</th>
            <th>Passed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {(completions.data ?? []).map((c) => (
            <tr key={c.id}>
              <td className="py-1">{c.employeeName ?? c.employeeId.slice(0, 8)}</td>
              <td>{formatDate(c.completedAt)}</td>
              <td>{c.score ?? '—'}</td>
              <td>{c.passed ? 'Yes' : 'No'}</td>
            </tr>
          ))}
          {(completions.data ?? []).length === 0 ? (
            <tr>
              <td colSpan={4} className="py-2 text-slate-500">
                No completions recorded yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function CreateEventModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const programmes = useTrainingProgrammes(false);
  const create = useCreateTrainingEvent();
  const [programmeId, setProgrammeId] = useState('');
  const [title, setTitle] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [location, setLocation] = useState('');
  const [facilitator, setFacilitator] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!programmeId) {
      toast('Select a programme', 'error');
      return;
    }
    try {
      await create.mutateAsync({
        programmeId,
        title,
        scheduledAt: new Date(scheduledAt).toISOString(),
        location: location || undefined,
        facilitator: facilitator || undefined,
      });
      toast('Event scheduled');
      onClose();
    } catch (err) {
      toast(`Failed: ${(err as Error).message}`, 'error');
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        className="w-full max-w-md space-y-3 rounded-lg bg-white p-6 shadow-lg"
        onSubmit={submit}
      >
        <h3 className="text-lg font-semibold">Schedule training event</h3>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Programme</span>
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={programmeId}
            onChange={(e) => setProgrammeId(e.target.value)}
            required
          >
            <option value="">— pick a programme —</option>
            {(programmes.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Event title</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            minLength={2}
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">When</span>
          <input
            type="datetime-local"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            required
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Location</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-slate-700">Facilitator</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            value={facilitator}
            onChange={(e) => setFacilitator(e.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="text-sm text-slate-600" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="rounded bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700"
          >
            Schedule
          </button>
        </div>
      </form>
    </div>
  );
}

function ExpiringTab() {
  const [days, setDays] = useState(60);
  const expiring = useCertificationsExpiring(days);
  const types = useCertificationTypes(false);
  const typesById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of types.data ?? []) m.set(t.id, t.name);
    return m;
  }, [types.data]);
  return (
    <section className="rounded border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Certifications expiring soon</h2>
        <label className="text-xs text-slate-600">
          Within
          <input
            type="number"
            min={7}
            max={365}
            className="ml-2 w-20 rounded border border-slate-300 px-2 py-1"
            value={days}
            onChange={(e) => setDays(Number(e.target.value) || 60)}
          />
          <span className="ml-1">days</span>
        </label>
      </div>
      <table className="mt-3 min-w-full text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="text-left">
            <th className="py-2">Employee</th>
            <th>Certification</th>
            <th>Issued</th>
            <th>Expires</th>
            <th>Days left</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {(expiring.data ?? []).map((c) => (
            <tr key={c.id}>
              <td className="py-2">{c.employeeName ?? c.employeeId.slice(0, 8)}</td>
              <td>{c.certificationTypeName ?? typesById.get(c.certificationTypeId) ?? '—'}</td>
              <td>{formatDate(c.issuedAt)}</td>
              <td>{formatDate(c.expiresAt)}</td>
              <td className={expiryTone(c.daysUntilExpiry)}>{c.daysUntilExpiry ?? '—'}</td>
              <td>
                <span className={`rounded px-2 py-0.5 text-xs ${CERT_STATUS_PILL[c.status]}`}>
                  {CERT_STATUS_LABEL[c.status]}
                </span>
              </td>
            </tr>
          ))}
          {(expiring.data ?? []).length === 0 ? (
            <tr>
              <td colSpan={6} className="py-3 text-slate-500">
                No certifications expiring within the window.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}
