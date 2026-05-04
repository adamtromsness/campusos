'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { useTickets, useTicketSla } from '@/hooks/use-tickets';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  SLA_URGENCY_DOT,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_PRIORITY_PILL,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_PILL,
  formatSlaRemaining,
  formatTicketAge,
  isTicketLive,
  slaUrgency,
} from '@/lib/tickets-format';
import type { TicketDto, TicketPriority } from '@/lib/types';

const HOUR_MS = 60 * 60 * 1000;

interface CategoryStats {
  categoryId: string;
  categoryName: string;
  totalLive: number;
  breached: number;
  resolved: number;
  withinSla: number;
}

interface DashboardStats {
  liveTotal: number;
  liveByPriority: Record<TicketPriority, number>;
  breachedLive: TicketDto[];
  avgResponseHours: number | null;
  avgResolutionHours: number | null;
  resolvedRowsCount: number;
  withinSla: number;
  totalResolved: number;
  byCategory: CategoryStats[];
}

function computeDashboard(tickets: TicketDto[]): DashboardStats {
  const liveByPriority: Record<TicketPriority, number> = {
    LOW: 0,
    MEDIUM: 0,
    HIGH: 0,
    CRITICAL: 0,
  };
  const breachedLive: TicketDto[] = [];
  let liveTotal = 0;

  let respondedCount = 0;
  let respondedSumHours = 0;
  let resolvedSumHours = 0;
  let resolvedRowsCount = 0;
  let withinSla = 0;
  let totalResolved = 0;

  const categoryMap = new Map<string, CategoryStats>();
  function bucket(t: TicketDto): CategoryStats {
    const key = t.categoryId;
    let row = categoryMap.get(key);
    if (!row) {
      row = {
        categoryId: key,
        categoryName: t.categoryName,
        totalLive: 0,
        breached: 0,
        resolved: 0,
        withinSla: 0,
      };
      categoryMap.set(key, row);
    }
    return row;
  }

  for (const t of tickets) {
    const cat = bucket(t);

    if (isTicketLive(t.status)) {
      liveTotal++;
      liveByPriority[t.priority]++;
      cat.totalLive++;
      const u = slaUrgency(t.sla);
      if (u === 'red') {
        breachedLive.push(t);
        cat.breached++;
      }
    }

    if (t.firstResponseAt) {
      const dt = (Date.parse(t.firstResponseAt) - Date.parse(t.createdAt)) / HOUR_MS;
      if (Number.isFinite(dt) && dt >= 0) {
        respondedSumHours += dt;
        respondedCount++;
      }
    }

    if (t.resolvedAt) {
      totalResolved++;
      cat.resolved++;
      const dt = (Date.parse(t.resolvedAt) - Date.parse(t.createdAt)) / HOUR_MS;
      if (Number.isFinite(dt) && dt >= 0) {
        resolvedSumHours += dt;
        resolvedRowsCount++;
        // Within-SLA when the row has a linked policy and the resolution
        // window was met. The SLA snapshot is computed live so we re-derive
        // here against the policy hours field (which the API includes on
        // every ticket regardless of current state).
        if (t.sla.resolutionHours !== null && dt <= t.sla.resolutionHours) {
          withinSla++;
          cat.withinSla++;
        }
      }
    }
  }

  return {
    liveTotal,
    liveByPriority,
    breachedLive,
    avgResponseHours: respondedCount > 0 ? respondedSumHours / respondedCount : null,
    avgResolutionHours: resolvedRowsCount > 0 ? resolvedSumHours / resolvedRowsCount : null,
    resolvedRowsCount,
    withinSla,
    totalResolved,
    byCategory: Array.from(categoryMap.values()).sort((a, b) => b.totalLive - a.totalLive),
  };
}

function formatHours(h: number | null): string {
  if (h === null) return '—';
  if (h < 1) return Math.round(h * 60) + 'm';
  if (h < 24) return h.toFixed(1) + 'h';
  return (h / 24).toFixed(1) + 'd';
}

function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

export default function SlaDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['it-001:admin', 'sch-001:admin']);

  // Pull a wider window — the dashboard wants closed/cancelled in the
  // averages too. The `limit: 500` cap prevents blowing the budget on
  // heavily-used schools; if a tenant has more tickets than that we'll
  // start emitting per-window aggregations server-side in a later cycle.
  const tickets = useTickets({ includeTerminal: true, limit: 500 }, isAdmin);
  const sla = useTicketSla(isAdmin);

  const stats = useMemo(() => (tickets.data ? computeDashboard(tickets.data) : null), [tickets.data]);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="SLA dashboard" />
        <EmptyState
          title="Admin only"
          description="The helpdesk SLA dashboard is visible to school administrators only."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="SLA dashboard"
        actions={
          <Link
            href="/helpdesk/admin"
            className="text-sm text-campus-700 hover:underline"
          >
            ← Back to queue
          </Link>
        }
      />

      {tickets.isLoading || !stats ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <StatCard
              label="Open tickets"
              value={stats.liveTotal}
              hint={
                stats.liveByPriority.CRITICAL +
                  stats.liveByPriority.HIGH ===
                0
                  ? 'No urgent rows'
                  : stats.liveByPriority.CRITICAL +
                    ' critical · ' +
                    stats.liveByPriority.HIGH +
                    ' high'
              }
              tone="default"
            />
            <StatCard
              label="Avg response"
              value={formatHours(stats.avgResponseHours)}
              hint="Time from submit to first staff comment"
              tone="default"
            />
            <StatCard
              label="Avg resolution"
              value={formatHours(stats.avgResolutionHours)}
              hint="Time from submit to resolved"
              tone="default"
            />
            <StatCard
              label="SLA compliance"
              value={
                stats.totalResolved === 0
                  ? '—'
                  : Math.round((stats.withinSla / stats.totalResolved) * 100) + '%'
              }
              hint={
                stats.totalResolved === 0
                  ? 'No resolved tickets yet'
                  : stats.withinSla + ' / ' + stats.totalResolved + ' within target'
              }
              tone={
                stats.totalResolved === 0
                  ? 'default'
                  : stats.withinSla / stats.totalResolved >= 0.9
                    ? 'good'
                    : stats.withinSla / stats.totalResolved >= 0.7
                      ? 'warn'
                      : 'bad'
              }
            />
          </div>

          {/* Live by priority */}
          <section className="rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-gray-900">Open tickets by priority</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {TICKET_PRIORITIES.slice()
                .reverse() // CRITICAL first
                .map((p) => (
                  <div
                    key={p}
                    className={cn(
                      'rounded-lg border p-3 text-center',
                      stats.liveByPriority[p] > 0 ? 'border-gray-200' : 'border-gray-100 opacity-60',
                    )}
                  >
                    <div className="text-2xl font-semibold text-gray-900">
                      {stats.liveByPriority[p]}
                    </div>
                    <span
                      className={cn(
                        'mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                        TICKET_PRIORITY_PILL[p],
                      )}
                    >
                      {TICKET_PRIORITY_LABELS[p]}
                    </span>
                  </div>
                ))}
            </div>
          </section>

          {/* Breached tickets table */}
          <section className="rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-gray-900">
              Breached tickets {stats.breachedLive.length > 0 && (
                <span className="ml-2 inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700">
                  {stats.breachedLive.length}
                </span>
              )}
            </h2>
            {stats.breachedLive.length === 0 ? (
              <p className="text-sm text-emerald-700">All open tickets are within SLA. ✓</p>
            ) : (
              <ul className="space-y-2">
                {stats.breachedLive.map((t) => {
                  const remaining = formatSlaRemaining(t.sla);
                  return (
                    <li
                      key={t.id}
                      className="rounded-md border border-rose-200 bg-rose-50/40 p-3"
                    >
                      <Link
                        href={'/helpdesk/' + t.id}
                        className="flex items-center gap-3 text-sm"
                      >
                        <span className={cn('h-2 w-2 rounded-full', SLA_URGENCY_DOT.red)} />
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
                        {remaining && <span className="text-xs text-rose-700">{remaining}</span>}
                        <span className="text-xs text-gray-500">{formatTicketAge(t.createdAt)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Per-category breakdown */}
          <section className="rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-gray-900">By category</h2>
            {stats.byCategory.length === 0 ? (
              <p className="text-sm text-gray-500">No tickets in any category yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="pb-2">Category</th>
                    <th className="pb-2 text-right">Open</th>
                    <th className="pb-2 text-right">Breached</th>
                    <th className="pb-2 text-right">Resolved</th>
                    <th className="pb-2 text-right">Within SLA</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {stats.byCategory.map((c) => (
                    <tr key={c.categoryId}>
                      <td className="py-2 font-medium text-gray-900">{c.categoryName}</td>
                      <td className="py-2 text-right text-gray-700">{c.totalLive}</td>
                      <td className={cn('py-2 text-right', c.breached > 0 ? 'text-rose-700' : 'text-gray-400')}>
                        {c.breached}
                      </td>
                      <td className="py-2 text-right text-gray-700">{c.resolved}</td>
                      <td className="py-2 text-right text-gray-700">
                        {c.resolved === 0
                          ? '—'
                          : Math.round((c.withinSla / c.resolved) * 100) + '%'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* SLA matrix configured for the school */}
          <section className="rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-gray-900">SLA matrix configured</h2>
            {sla.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <LoadingSpinner size="sm" /> Loading…
              </div>
            ) : (sla.data ?? []).length === 0 ? (
              <p className="text-sm text-amber-700">
                No SLA policies configured. Run <code>seed:tickets</code> or add via the API.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="pb-2">Category</th>
                    <th className="pb-2">Priority</th>
                    <th className="pb-2 text-right">Response</th>
                    <th className="pb-2 text-right">Resolution</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(sla.data ?? []).map((p) => (
                    <tr key={p.id}>
                      <td className="py-2 font-medium text-gray-900">{p.categoryName}</td>
                      <td className="py-2">
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                            TICKET_PRIORITY_PILL[p.priority],
                          )}
                        >
                          {TICKET_PRIORITY_LABELS[p.priority]}
                        </span>
                      </td>
                      <td className="py-2 text-right text-gray-700">{p.responseHours}h</td>
                      <td className="py-2 text-right text-gray-700">{p.resolutionHours}h</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint: string;
  tone: 'default' | 'good' | 'warn' | 'bad';
}) {
  const ring = {
    default: 'ring-gray-200',
    good: 'ring-emerald-200 bg-emerald-50/50',
    warn: 'ring-amber-200 bg-amber-50/50',
    bad: 'ring-rose-200 bg-rose-50/50',
  }[tone];
  return (
    <div className={cn('rounded-lg bg-white p-4 ring-1', ring)}>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-gray-900">{value}</div>
      <p className="mt-1 text-xs text-gray-500">{hint}</p>
    </div>
  );
}
