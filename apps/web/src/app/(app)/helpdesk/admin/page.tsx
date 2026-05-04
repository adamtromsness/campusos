'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { useEmployees } from '@/hooks/use-hr';
import {
  useAssignTicket,
  useAssignVendor,
  useTicketCategories,
  useTicketVendors,
  useTickets,
} from '@/hooks/use-tickets';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  SLA_URGENCY_DOT,
  SLA_URGENCY_LABEL,
  SlaUrgency,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_PRIORITY_PILL,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_PILL,
  formatSlaRemaining,
  formatTicketAge,
  slaUrgency,
} from '@/lib/tickets-format';
import type { TicketDto, TicketPriority, TicketStatus } from '@/lib/types';

type SlaFilter = 'ALL' | 'BREACHED' | 'AT_RISK' | 'HEALTHY';

const SLA_FILTERS: Array<{ value: SlaFilter; label: string }> = [
  { value: 'ALL', label: 'All SLA' },
  { value: 'BREACHED', label: 'Breached' },
  { value: 'AT_RISK', label: 'At risk' },
  { value: 'HEALTHY', label: 'Healthy' },
];

function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

function matchesSla(urgency: SlaUrgency, filter: SlaFilter): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'BREACHED') return urgency === 'red';
  if (filter === 'AT_RISK') return urgency === 'amber';
  if (filter === 'HEALTHY') return urgency === 'green' || urgency === 'none';
  return true;
}

export default function HelpdeskAdminQueuePage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['it-001:admin', 'sch-001:admin']);

  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'ALL'>('ALL');
  const [priorityFilter, setPriorityFilter] = useState<TicketPriority | 'ALL'>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [slaFilter, setSlaFilter] = useState<SlaFilter>('ALL');

  const tickets = useTickets(
    {
      includeTerminal: true,
      limit: 200,
      ...(statusFilter !== 'ALL' ? { status: statusFilter as TicketStatus } : {}),
      ...(priorityFilter !== 'ALL' ? { priority: priorityFilter as TicketPriority } : {}),
      ...(categoryFilter !== 'ALL' ? { categoryId: categoryFilter } : {}),
    },
    isAdmin,
  );
  const categories = useTicketCategories(isAdmin);

  const visible = useMemo(() => {
    const list = tickets.data ?? [];
    if (slaFilter === 'ALL') return list;
    return list.filter((t) => matchesSla(slaUrgency(t.sla), slaFilter));
  }, [tickets.data, slaFilter]);

  const breachedCount = useMemo(
    () => (tickets.data ?? []).filter((t) => slaUrgency(t.sla) === 'red').length,
    [tickets.data],
  );

  const [assignTarget, setAssignTarget] = useState<TicketDto | null>(null);
  const [assignVendorTarget, setAssignVendorTarget] = useState<TicketDto | null>(null);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Helpdesk admin" />
        <EmptyState
          title="Admin only"
          description="The helpdesk admin queue is visible to school administrators only."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Helpdesk queue"
        description={
          breachedCount > 0
            ? breachedCount + ' ticket' + (breachedCount === 1 ? '' : 's') + ' breached SLA — review at the top of the list.'
            : 'Triage, assign, and track every ticket across the school.'
        }
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/helpdesk/admin/sla"
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-campus-700 ring-1 ring-campus-200 hover:bg-campus-50"
            >
              SLA dashboard
            </Link>
            <Link
              href="/helpdesk/admin/problems"
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-campus-700 ring-1 ring-campus-200 hover:bg-campus-50"
            >
              Problems
            </Link>
            <Link
              href="/helpdesk/admin/categories"
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50"
            >
              Categories
            </Link>
            <Link
              href="/helpdesk/admin/vendors"
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50"
            >
              Vendors
            </Link>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:grid-cols-4">
        <div>
          <label className="block text-xs font-medium text-gray-500">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="ALL">All statuses</option>
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TICKET_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">Priority</label>
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as typeof priorityFilter)}
            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="ALL">All priorities</option>
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {TICKET_PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">Category</label>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="ALL">All categories</option>
            {(categories.data ?? [])
              .filter((c) => c.parentCategoryId === null)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">SLA</label>
          <select
            value={slaFilter}
            onChange={(e) => setSlaFilter(e.target.value as SlaFilter)}
            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
          >
            {SLA_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {tickets.isLoading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : visible.length === 0 ? (
        <EmptyState title="No tickets to show" description="Adjust the filters or wait for the queue to fill up." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2">SLA</th>
                <th className="px-3 py-2">Ticket</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Priority</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Assigned</th>
                <th className="px-3 py-2">Age</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map((t) => {
                const urgency = slaUrgency(t.sla);
                const remaining = formatSlaRemaining(t.sla);
                return (
                  <tr key={t.id} className={cn(urgency === 'red' && 'bg-rose-50/40')}>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <span className={cn('inline-block h-2 w-2 rounded-full', SLA_URGENCY_DOT[urgency])} />
                        <span className="text-xs text-gray-600">
                          {remaining ?? SLA_URGENCY_LABEL[urgency]}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <Link href={'/helpdesk/' + t.id} className="block text-campus-700 hover:underline">
                        <span className="font-mono text-xs text-gray-400">#{shortId(t.id)}</span>{' '}
                        <span className="font-medium">{t.title}</span>
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          TICKET_STATUS_PILL[t.status],
                        )}
                      >
                        {TICKET_STATUS_LABELS[t.status]}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          TICKET_PRIORITY_PILL[t.priority],
                        )}
                      >
                        {TICKET_PRIORITY_LABELS[t.priority]}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-gray-700">
                      {t.categoryName}
                      {t.subcategoryName ? (
                        <span className="text-gray-400"> / {t.subcategoryName}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-gray-700">
                      {t.assigneeName
                        ? t.assigneeName
                        : t.vendorName
                          ? 'Vendor: ' + t.vendorName
                          : <span className="text-gray-400">Unassigned</span>}
                    </td>
                    <td className="px-3 py-3 text-gray-500">{formatTicketAge(t.createdAt)}</td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setAssignTarget(t)}
                          className="rounded-md bg-white px-2 py-1 text-xs font-medium text-campus-700 ring-1 ring-campus-200 hover:bg-campus-50"
                        >
                          Assign
                        </button>
                        <button
                          type="button"
                          onClick={() => setAssignVendorTarget(t)}
                          className="rounded-md bg-white px-2 py-1 text-xs font-medium text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50"
                        >
                          Vendor
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {assignTarget && (
        <AssignEmployeeModal ticket={assignTarget} onClose={() => setAssignTarget(null)} />
      )}
      {assignVendorTarget && (
        <AssignVendorModal ticket={assignVendorTarget} onClose={() => setAssignVendorTarget(null)} />
      )}
    </div>
  );
}

// ── Assign-employee modal ──────────────────────────────────────

function AssignEmployeeModal({ ticket, onClose }: { ticket: TicketDto; onClose: () => void }) {
  const employees = useEmployees({});
  const assign = useAssignTicket(ticket.id);
  const { toast } = useToast();
  const [selected, setSelected] = useState<string>(ticket.assigneeId ?? '');
  const [filter, setFilter] = useState<string>('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (employees.data ?? []).filter((e) => e.employmentStatus === 'ACTIVE');
    if (!q) return list;
    return list.filter(
      (e) =>
        e.fullName.toLowerCase().includes(q) ||
        (e.primaryPositionTitle ?? '').toLowerCase().includes(q),
    );
  }, [employees.data, filter]);

  async function onConfirm(): Promise<void> {
    if (!selected) return;
    try {
      await assign.mutateAsync({ assigneeEmployeeId: selected });
      toast('Ticket reassigned', 'success');
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not assign';
      toast(msg, 'error');
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={'Assign — ' + ticket.title}
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!selected || assign.isPending}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
          >
            Reassign
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search by name or role"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        <div className="max-h-72 overflow-y-auto rounded-md border border-gray-200">
          {employees.isLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-gray-500">
              <LoadingSpinner size="sm" /> Loading employees…
            </div>
          ) : filtered.length === 0 ? (
            <p className="p-4 text-sm text-gray-500">No active employees match.</p>
          ) : (
            <ul>
              {filtered.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(e.id)}
                    className={cn(
                      'flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50',
                      selected === e.id && 'bg-campus-50',
                    )}
                  >
                    <div>
                      <div className="font-medium text-gray-900">{e.fullName}</div>
                      <div className="text-xs text-gray-500">
                        {e.primaryPositionTitle ?? 'Staff'}
                        {e.employeeNumber ? ' · ' + e.employeeNumber : ''}
                      </div>
                    </div>
                    {selected === e.id && (
                      <span className="text-xs font-medium text-campus-700">Selected</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Assign-vendor modal ────────────────────────────────────────

function AssignVendorModal({ ticket, onClose }: { ticket: TicketDto; onClose: () => void }) {
  const vendors = useTicketVendors();
  const assign = useAssignVendor(ticket.id);
  const { toast } = useToast();
  const [selected, setSelected] = useState<string>(ticket.vendorId ?? '');
  const [reference, setReference] = useState<string>(ticket.vendorReference ?? '');

  async function onConfirm(): Promise<void> {
    if (!selected) return;
    try {
      await assign.mutateAsync({ vendorId: selected, vendorReference: reference || undefined });
      toast('Vendor assigned', 'success');
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not assign vendor';
      toast(msg, 'error');
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={'Assign vendor — ' + ticket.title}
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!selected || assign.isPending}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
          >
            Send to vendor
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700">Vendor</label>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">Pick a vendor…</option>
            {(vendors.data ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.isPreferred ? '★ ' : ''}
                {v.vendorName} ({v.vendorType})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Vendor reference</label>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="WO-2026-0451"
            maxLength={80}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">
            Optional. Most vendors return a work-order or case number.
          </p>
        </div>
      </div>
    </Modal>
  );
}
