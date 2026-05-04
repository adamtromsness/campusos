'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { useTickets } from '@/hooks/use-tickets';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  SLA_URGENCY_DOT,
  SLA_URGENCY_LABEL,
  TICKET_PRIORITY_LABELS,
  TICKET_PRIORITY_PILL,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_PILL,
  formatSlaRemaining,
  formatTicketAge,
  isTicketLive,
  slaUrgency,
} from '@/lib/tickets-format';
import type { TicketDto } from '@/lib/types';

type FilterChip = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'ALL';

const FILTER_CHIPS: Array<{ value: FilterChip; label: string }> = [
  { value: 'OPEN', label: 'Open' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'ALL', label: 'All' },
];

function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

function filterTickets(list: TicketDto[], chip: FilterChip): TicketDto[] {
  switch (chip) {
    case 'OPEN':
      return list.filter((t) => t.status === 'OPEN');
    case 'IN_PROGRESS':
      return list.filter(
        (t) => t.status === 'IN_PROGRESS' || t.status === 'VENDOR_ASSIGNED' || t.status === 'PENDING_REQUESTER',
      );
    case 'RESOLVED':
      return list.filter((t) => t.status === 'RESOLVED');
    case 'ALL':
    default:
      return list;
  }
}

export default function HelpdeskPage() {
  const user = useAuthStore((s) => s.user);
  const canHelpdesk = !!user && hasAnyPermission(user, ['it-001:read']);
  const [filter, setFilter] = useState<FilterChip>('OPEN');

  // Always fetch with includeTerminal=true so the All filter has CLOSED +
  // CANCELLED rows to show. Per-chip filtering is client-side.
  const tickets = useTickets({ includeTerminal: true, limit: 200 }, canHelpdesk);

  const visible = useMemo(() => filterTickets(tickets.data ?? [], filter), [tickets.data, filter]);
  const liveCount = useMemo(
    () => (tickets.data ?? []).filter((t) => isTicketLive(t.status)).length,
    [tickets.data],
  );

  if (!user) return null;
  if (!canHelpdesk) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Helpdesk" />
        <EmptyState
          title="Access required"
          description="You need IT-001 read access to view tickets."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Helpdesk"
        description={
          liveCount === 0
            ? 'No open tickets — submit one if something needs attention.'
            : liveCount === 1
              ? '1 open ticket'
              : liveCount + ' open tickets'
        }
        actions={
          <Link
            href="/helpdesk/new"
            className="inline-flex items-center gap-2 rounded-lg bg-campus-700 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-campus-800"
          >
            New ticket
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTER_CHIPS.map((chip) => (
          <button
            key={chip.value}
            type="button"
            onClick={() => setFilter(chip.value)}
            className={cn(
              'rounded-full px-3 py-1 text-sm transition',
              filter === chip.value
                ? 'bg-campus-700 text-white'
                : 'bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50',
            )}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {tickets.isLoading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          title="No tickets to show"
          description={
            filter === 'OPEN'
              ? 'No open tickets. Submit one if something needs attention.'
              : 'Nothing matches this filter.'
          }
        />
      ) : (
        <ul className="space-y-2">
          {visible.map((t) => (
            <TicketRow key={t.id} ticket={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TicketRow({ ticket }: { ticket: TicketDto }) {
  const urgency = slaUrgency(ticket.sla);
  const remaining = formatSlaRemaining(ticket.sla);
  return (
    <li>
      <Link
        href={'/helpdesk/' + ticket.id}
        className="block rounded-lg border border-gray-200 bg-white p-4 transition hover:border-campus-300 hover:bg-campus-50/40"
      >
        <div className="flex items-start gap-3">
          <span
            className={cn('mt-2 inline-block h-2 w-2 flex-none rounded-full', SLA_URGENCY_DOT[urgency])}
            title={SLA_URGENCY_LABEL[urgency] + (remaining ? ' · ' + remaining : '')}
            aria-label={SLA_URGENCY_LABEL[urgency]}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-gray-400">#{shortId(ticket.id)}</span>
              <span
                className={cn(
                  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                  TICKET_PRIORITY_PILL[ticket.priority],
                )}
              >
                {TICKET_PRIORITY_LABELS[ticket.priority]}
              </span>
              <span
                className={cn(
                  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                  TICKET_STATUS_PILL[ticket.status],
                )}
              >
                {TICKET_STATUS_LABELS[ticket.status]}
              </span>
              {remaining && (
                <span className="text-xs text-gray-500">
                  SLA: <span className="font-medium">{remaining}</span>
                </span>
              )}
            </div>
            <p className="mt-1 truncate text-sm font-medium text-gray-900">{ticket.title}</p>
            <p className="mt-0.5 text-xs text-gray-500">
              {ticket.categoryName}
              {ticket.subcategoryName ? ' · ' + ticket.subcategoryName : ''}
              {ticket.assigneeName ? ' · Assigned to ' + ticket.assigneeName : ticket.vendorName ? ' · Vendor: ' + ticket.vendorName : ' · Unassigned'}
              {' · ' + formatTicketAge(ticket.createdAt)}
            </p>
          </div>
        </div>
      </Link>
    </li>
  );
}
