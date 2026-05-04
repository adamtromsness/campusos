'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useLinkProblemTickets,
  useProblem,
  useResolveProblem,
  useTickets,
  useUpdateProblem,
} from '@/hooks/use-tickets';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  PROBLEM_STATUS_LABELS,
  PROBLEM_STATUS_PILL,
  TICKET_PRIORITY_LABELS,
  TICKET_PRIORITY_PILL,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_PILL,
  formatTicketAge,
  isTicketLive,
} from '@/lib/tickets-format';
import type { ProblemDto, ProblemStatus, TicketDto } from '@/lib/types';

function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

export default function ProblemDetailPage() {
  const params = useParams<{ id: string }>();
  const problemId = params?.id ?? '';
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['it-001:admin', 'sch-001:admin']);

  const problem = useProblem(problemId, isAdmin);
  // Pull linked-ticket details so the linked-tickets list shows status pills
  // alongside titles. Fetch all tickets the admin can see (admin row scope =
  // every ticket) and filter client-side by problem.ticketIds — small list
  // and one query covers the bulk view.
  const tickets = useTickets({ includeTerminal: true, limit: 500 }, isAdmin);

  const [editOpen, setEditOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);

  // Compute linked tickets unconditionally — Hooks must run on every render
  // even when the data isn't loaded yet. The early-return paths below
  // simply ignore this result.
  const ticketIds = problem.data?.ticketIds ?? [];
  const allTickets = tickets.data ?? [];
  const linkedTickets = useMemo(() => {
    const idSet = new Set(ticketIds);
    return allTickets.filter((t) => idSet.has(t.id));
    // We intentionally key on the joined string so the memo invalidates
    // when the linked-id set changes content rather than when its array
    // reference changes (which it does on every parent re-render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTickets, ticketIds.join('|')]);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Problem" />
        <EmptyState
          title="Admin only"
          description="Problem management is visible to school administrators only."
        />
      </div>
    );
  }

  if (problem.isLoading) {
    return (
      <div className="mx-auto max-w-3xl py-8">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      </div>
    );
  }

  if (!problem.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Problem" />
        <EmptyState
          title="Problem not found"
          description="It may have been removed or the id is incorrect."
          action={
            <Link
              href="/helpdesk/admin/problems"
              className="inline-flex items-center rounded-lg bg-campus-700 px-4 py-2 text-sm font-medium text-white hover:bg-campus-800"
            >
              Back to problems
            </Link>
          }
        />
      </div>
    );
  }

  const p = problem.data;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={p.title}
        actions={
          <Link
            href="/helpdesk/admin/problems"
            className="text-sm text-campus-700 hover:underline"
          >
            ← Back to problems
          </Link>
        }
      />

      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
              PROBLEM_STATUS_PILL[p.status],
            )}
          >
            {PROBLEM_STATUS_LABELS[p.status]}
          </span>
          <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
            {p.categoryName}
          </span>
          {p.assignedToName && (
            <span className="text-xs text-gray-500">Assigned to {p.assignedToName}</span>
          )}
          {p.vendorName && <span className="text-xs text-gray-500">Vendor: {p.vendorName}</span>}
        </div>

        <p className="mt-3 whitespace-pre-wrap text-sm text-gray-800">{p.description}</p>

        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm">
          <Field label="Root cause" value={p.rootCause} hint="Required to mark KNOWN_ERROR or RESOLVED." />
          <Field
            label="Resolution"
            value={p.resolution}
            hint="Required when resolving — describes what fixed it."
          />
          <Field label="Workaround" value={p.workaround} hint="Optional — what affected users can do until the fix lands." />
        </dl>

        {p.resolvedAt && (
          <p className="mt-3 text-xs text-emerald-700">
            Resolved {new Date(p.resolvedAt).toLocaleString()}
          </p>
        )}

        {p.status !== 'RESOLVED' && (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-gray-100 pt-4">
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50"
            >
              Edit details
            </button>
            <button
              type="button"
              onClick={() => setLinkOpen(true)}
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-campus-700 ring-1 ring-campus-200 hover:bg-campus-50"
            >
              Link more tickets
            </button>
            <button
              type="button"
              onClick={() => setResolveOpen(true)}
              className="ml-auto rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
            >
              Resolve problem
            </button>
          </div>
        )}
      </div>

      {/* Linked tickets list */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">
          Linked tickets <span className="ml-2 text-gray-400">· {p.ticketIds.length}</span>
        </h2>
        {linkedTickets.length === 0 ? (
          <p className="text-sm text-gray-500">No tickets linked yet.</p>
        ) : (
          <ul className="space-y-2">
            {linkedTickets.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-3 rounded-md border border-gray-200 p-3 hover:border-campus-300 hover:bg-campus-50/40"
              >
                <Link href={'/helpdesk/' + t.id} className="flex flex-1 items-center gap-3 text-sm">
                  <span className="font-mono text-xs text-gray-400">#{shortId(t.id)}</span>
                  <span className="flex-1 font-medium text-gray-900">{t.title}</span>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                      TICKET_PRIORITY_PILL[t.priority],
                    )}
                  >
                    {TICKET_PRIORITY_LABELS[t.priority]}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                      TICKET_STATUS_PILL[t.status],
                    )}
                  >
                    {TICKET_STATUS_LABELS[t.status]}
                  </span>
                  <span className="text-xs text-gray-500">{formatTicketAge(t.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editOpen && <EditProblemModal problem={p} onClose={() => setEditOpen(false)} />}
      {linkOpen && (
        <LinkTicketsModal
          problem={p}
          allTickets={tickets.data ?? []}
          onClose={() => setLinkOpen(false)}
        />
      )}
      {resolveOpen && (
        <ResolveProblemModal
          problem={p}
          linkedTickets={linkedTickets}
          onClose={() => setResolveOpen(false)}
        />
      )}
    </div>
  );
}

function Field({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | null;
  hint?: string;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className={cn('mt-0.5 whitespace-pre-wrap text-sm', value ? 'text-gray-800' : 'italic text-gray-400')}>
        {value ?? 'Not set'}
      </dd>
      {hint && <p className="mt-0.5 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

// ── Edit Problem Modal ─────────────────────────────────────────

function EditProblemModal({ problem, onClose }: { problem: ProblemDto; onClose: () => void }) {
  const update = useUpdateProblem(problem.id);
  const { toast } = useToast();
  const [title, setTitle] = useState(problem.title);
  const [description, setDescription] = useState(problem.description);
  const [status, setStatus] = useState<Exclude<ProblemStatus, 'RESOLVED'>>(
    problem.status === 'RESOLVED' ? 'KNOWN_ERROR' : (problem.status as Exclude<ProblemStatus, 'RESOLVED'>),
  );
  const [rootCause, setRootCause] = useState(problem.rootCause ?? '');
  const [workaround, setWorkaround] = useState(problem.workaround ?? '');

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await update.mutateAsync({
        title: title.trim() !== problem.title ? title.trim() : undefined,
        description: description.trim() !== problem.description ? description.trim() : undefined,
        status: status !== problem.status ? status : undefined,
        rootCause:
          rootCause.trim() !== (problem.rootCause ?? '') ? (rootCause.trim() || null) : undefined,
        workaround:
          workaround.trim() !== (problem.workaround ?? '')
            ? workaround.trim() || null
            : undefined,
      });
      toast('Problem updated', 'success');
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Save failed';
      toast(msg, 'error');
    }
  }

  return (
    <Modal open={true} onClose={onClose} title="Edit problem" size="lg">
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700">Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            rows={3}
            maxLength={4000}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as Exclude<ProblemStatus, 'RESOLVED'>)}
            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
          >
            <option value="OPEN">Open</option>
            <option value="INVESTIGATING">Investigating</option>
            <option value="KNOWN_ERROR">Known error (root cause documented)</option>
          </select>
          <p className="mt-1 text-xs text-gray-500">
            Use the Resolve button to mark RESOLVED — it batch-resolves linked tickets in one transaction.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Root cause</label>
          <textarea
            value={rootCause}
            onChange={(e) => setRootCause(e.target.value)}
            rows={2}
            maxLength={4000}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">
            Required when status is KNOWN_ERROR.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Workaround</label>
          <textarea
            value={workaround}
            onChange={(e) => setWorkaround(e.target.value)}
            rows={2}
            maxLength={4000}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim() || !description.trim() || update.isPending}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Link Tickets Modal ─────────────────────────────────────────

function LinkTicketsModal({
  problem,
  allTickets,
  onClose,
}: {
  problem: ProblemDto;
  allTickets: TicketDto[];
  onClose: () => void;
}) {
  const link = useLinkProblemTickets(problem.id);
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const linkedSet = new Set(problem.ticketIds);
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allTickets
      .filter((t) => !linkedSet.has(t.id) && isTicketLive(t.status))
      .filter((t) =>
        q === ''
          ? true
          : t.title.toLowerCase().includes(q) ||
            t.categoryName.toLowerCase().includes(q) ||
            (t.subcategoryName ?? '').toLowerCase().includes(q),
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [allTickets, linkedSet, search]);

  function toggle(id: string): void {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onSubmit(): Promise<void> {
    if (picked.size === 0) return;
    try {
      await link.mutateAsync({ ticketIds: Array.from(picked) });
      toast(picked.size === 1 ? '1 ticket linked' : picked.size + ' tickets linked', 'success');
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Link failed';
      toast(msg, 'error');
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Link tickets to this problem"
      size="lg"
      footer={
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-500">
            {picked.size === 0 ? 'Pick one or more tickets' : picked.size + ' selected'}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSubmit}
              disabled={picked.size === 0 || link.isPending}
              className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
            >
              Link {picked.size > 0 ? picked.size : ''} ticket{picked.size === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by title or category"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        <p className="text-xs text-gray-500">
          Showing live tickets (Open / In progress / Vendor assigned / Pending requester) that aren&apos;t already linked.
        </p>
        <div className="max-h-96 overflow-y-auto rounded-md border border-gray-200">
          {candidates.length === 0 ? (
            <p className="p-4 text-sm text-gray-500">
              {linkedSet.size === allTickets.length
                ? 'All visible tickets are already linked.'
                : 'No tickets match the search.'}
            </p>
          ) : (
            <ul>
              {candidates.map((t) => (
                <li key={t.id}>
                  <label
                    className={cn(
                      'flex cursor-pointer items-start gap-3 px-3 py-2 text-sm hover:bg-gray-50',
                      picked.has(t.id) && 'bg-campus-50',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(t.id)}
                      onChange={() => toggle(t.id)}
                      className="mt-1 rounded border-gray-300 text-campus-600 focus:ring-campus-300"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-gray-400">#{shortId(t.id)}</span>
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                            TICKET_PRIORITY_PILL[t.priority],
                          )}
                        >
                          {TICKET_PRIORITY_LABELS[t.priority]}
                        </span>
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                            TICKET_STATUS_PILL[t.status],
                          )}
                        >
                          {TICKET_STATUS_LABELS[t.status]}
                        </span>
                        <span className="text-xs text-gray-500">{formatTicketAge(t.createdAt)}</span>
                      </div>
                      <p className="truncate font-medium text-gray-900">{t.title}</p>
                      <p className="text-xs text-gray-500">
                        {t.categoryName}
                        {t.subcategoryName ? ' / ' + t.subcategoryName : ''}
                      </p>
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Resolve Problem Modal — the keystone batch-resolve flow ────

function ResolveProblemModal({
  problem,
  linkedTickets,
  onClose,
}: {
  problem: ProblemDto;
  linkedTickets: TicketDto[];
  onClose: () => void;
}) {
  const resolve = useResolveProblem(problem.id);
  const { toast } = useToast();
  const [rootCause, setRootCause] = useState(problem.rootCause ?? '');
  const [resolution, setResolution] = useState(problem.resolution ?? '');
  const [workaround, setWorkaround] = useState(problem.workaround ?? '');

  const flippableTickets = useMemo(
    () => linkedTickets.filter((t) => isTicketLive(t.status)),
    [linkedTickets],
  );

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!rootCause.trim() || !resolution.trim()) return;
    try {
      const res = await resolve.mutateAsync({
        rootCause: rootCause.trim(),
        resolution: resolution.trim(),
        workaround: workaround.trim() || undefined,
      });
      toast(
        res.ticketsFlipped.length === 0
          ? 'Problem resolved'
          : 'Problem resolved — ' +
              res.ticketsFlipped.length +
              ' linked ticket' +
              (res.ticketsFlipped.length === 1 ? '' : 's') +
              ' flipped to RESOLVED',
        'success',
      );
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Resolve failed';
      toast(msg, 'error');
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Resolve problem"
      size="lg"
      footer={
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-500">
            {flippableTickets.length === 0
              ? 'No live linked tickets to flip — only the problem will resolve.'
              : flippableTickets.length === 1
                ? '1 linked ticket will flip to RESOLVED'
                : flippableTickets.length + ' linked tickets will flip to RESOLVED'}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSubmit}
              disabled={!rootCause.trim() || !resolution.trim() || resolve.isPending}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Resolve & batch-flip
            </button>
          </div>
        </div>
      }
    >
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="rounded-md bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-200">
          <strong>This is irreversible from the UI.</strong> Resolving the problem will flip every
          linked ticket currently in OPEN / IN_PROGRESS / VENDOR_ASSIGNED / PENDING_REQUESTER to
          RESOLVED, emit one tkt.ticket.resolved per flipped ticket, and stop the SLA clock on
          each. Already-resolved tickets are left untouched.
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Root cause <span className="text-rose-600">*</span>
          </label>
          <textarea
            value={rootCause}
            onChange={(e) => setRootCause(e.target.value)}
            required
            rows={3}
            maxLength={4000}
            placeholder="What was actually broken?"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Resolution <span className="text-rose-600">*</span>
          </label>
          <textarea
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            required
            rows={3}
            maxLength={4000}
            placeholder="What did you do to fix it?"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Workaround (optional)</label>
          <textarea
            value={workaround}
            onChange={(e) => setWorkaround(e.target.value)}
            rows={2}
            maxLength={4000}
            placeholder="Anything affected users could do until the fix landed."
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        {flippableTickets.length > 0 && (
          <div className="rounded-md border border-gray-200 p-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Tickets that will flip
            </h4>
            <ul className="mt-2 space-y-1 text-sm">
              {flippableTickets.map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  <span className="font-mono text-xs text-gray-400">#{shortId(t.id)}</span>
                  <span className="truncate">{t.title}</span>
                  <span
                    className={cn(
                      'ml-auto inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                      TICKET_STATUS_PILL[t.status],
                    )}
                  >
                    {TICKET_STATUS_LABELS[t.status]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </Modal>
  );
}
