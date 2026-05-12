'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  TICKET_PRIORITY_PILL,
  TICKET_STATUS_PILL,
  useCreateInternalTicket,
  useInternalTickets,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from '@/hooks/use-ops';

const STATUSES: TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'RESOLVED', 'CLOSED'];

export default function InternalTicketsPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['ops-004:read']);
  const canWrite = !!user && hasAnyPermission(user, ['ops-004:write']);

  const [filter, setFilter] = useState<TicketStatus | 'ALL'>('ALL');
  const tickets = useInternalTickets(filter !== 'ALL' ? { status: filter } : {});
  const create = useCreateInternalTicket();

  const [form, setForm] = useState({
    title: '',
    description: '',
    category: 'BUG' as TicketCategory,
    priority: 'MEDIUM' as TicketPriority,
  });
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (!user) return <LoadingSpinner />;
  if (!canRead) {
    return (
      <EmptyState
        title="Not available"
        description="Internal tickets require OPS-004:read at the PLATFORM scope."
      />
    );
  }

  const byStatus: Record<TicketStatus, typeof tickets.data> = {
    OPEN: [],
    IN_PROGRESS: [],
    BLOCKED: [],
    RESOLVED: [],
    CLOSED: [],
  };
  for (const t of tickets.data ?? []) byStatus[t.status]!.push(t);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Internal tickets"
        description="Cross-team work for CampusOS-the-company. Distinct from school helpdesk tickets."
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setFilter('ALL')}
          className={`rounded-full border px-3 py-1 text-xs ${
            filter === 'ALL' ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300'
          }`}
        >
          All
        </button>
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            className={`rounded-full border px-3 py-1 text-xs ${
              filter === s ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {canWrite ? (
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-semibold text-gray-900">Create ticket</h3>
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            onSubmit={async (ev) => {
              ev.preventDefault();
              setSubmitError(null);
              try {
                await create.mutateAsync(form);
                setForm({ ...form, title: '', description: '' });
              } catch (e) {
                setSubmitError((e as Error).message);
              }
            }}
          >
            <input
              placeholder="Title"
              value={form.title}
              onChange={(ev) => setForm({ ...form, title: ev.target.value })}
              required
              className="rounded border border-gray-300 px-3 py-2 text-sm sm:col-span-2"
            />
            <textarea
              placeholder="Description"
              value={form.description}
              onChange={(ev) => setForm({ ...form, description: ev.target.value })}
              required
              rows={3}
              className="rounded border border-gray-300 px-3 py-2 text-sm sm:col-span-2"
            />
            <select
              value={form.category}
              onChange={(ev) => setForm({ ...form, category: ev.target.value as TicketCategory })}
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            >
              <option>BUG</option>
              <option>FEATURE_REQUEST</option>
              <option>DATA_FIX</option>
              <option>INFRASTRUCTURE</option>
              <option>OTHER</option>
            </select>
            <select
              value={form.priority}
              onChange={(ev) => setForm({ ...form, priority: ev.target.value as TicketPriority })}
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            >
              <option>LOW</option>
              <option>MEDIUM</option>
              <option>HIGH</option>
              <option>CRITICAL</option>
            </select>
            <button
              type="submit"
              disabled={create.isPending}
              className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50 sm:col-span-2"
            >
              {create.isPending ? 'Creating…' : 'Create'}
            </button>
            {submitError ? (
              <p className="text-sm text-rose-700 sm:col-span-2">{submitError}</p>
            ) : null}
          </form>
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 lg:grid-cols-5">
        {STATUSES.map((s) => (
          <div key={s} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <h3 className="mb-2 text-sm font-semibold text-gray-900">
              {s} ({byStatus[s]?.length ?? 0})
            </h3>
            <ul className="space-y-2">
              {(byStatus[s] ?? []).map((t) => (
                <li
                  key={t.id}
                  className="rounded border border-gray-200 bg-white p-2 text-xs shadow-sm"
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] ${TICKET_PRIORITY_PILL[t.priority]}`}
                    >
                      {t.priority}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] ${TICKET_STATUS_PILL[t.status]}`}
                    >
                      {t.category}
                    </span>
                  </div>
                  <p className="mt-1 font-medium text-gray-900">{t.title}</p>
                  <p className="mt-1 line-clamp-2 text-gray-600">{t.description}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
