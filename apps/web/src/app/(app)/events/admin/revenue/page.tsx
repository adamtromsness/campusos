'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState, LoadingSpinner, PageHeader } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useRevenueSummary } from '@/hooks/use-events';
import { EVT_EVENT_TYPE_LABELS, formatCurrency } from '@/lib/events-format';

export default function EventsRevenuePage() {
  const user = useAuthStore((s) => s.user);
  const isManager = user ? hasAnyPermission(user, ['evt-001:write', 'sch-001:admin']) : false;

  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const defaultTo = today.toISOString().slice(0, 10);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const summary = useRevenueSummary({ from, to });

  if (!isManager) {
    return (
      <div>
        <PageHeader title="Revenue summary" description="" />
        <p className="text-sm text-gray-600">Requires evt-001:write or admin scope.</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Revenue summary"
        description="Gross + refunds + net revenue by event type for the selected window."
        actions={
          <Link href="/events/admin" className="text-sm text-blue-700 hover:underline">
            ← Event admin
          </Link>
        }
      />

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-600">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-600">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </label>
      </div>

      {summary.isLoading ? (
        <div className="mt-6">
          <LoadingSpinner />
        </div>
      ) : !summary.data ? (
        <EmptyState title="No data" description="" />
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat
              label="Gross"
              value={formatCurrency(summary.data.totals.grossRevenue)}
              tone="emerald"
            />
            <Stat
              label="Refunds"
              value={formatCurrency(summary.data.totals.refundsIssued)}
              tone="rose"
            />
            <Stat
              label="Net"
              value={formatCurrency(summary.data.totals.netRevenue)}
              tone="default"
            />
            <Stat
              label="Orders"
              value={String(summary.data.totals.ordersConfirmed)}
              tone="default"
            />
            <Stat
              label="Tickets sold"
              value={String(summary.data.totals.ticketsSold)}
              tone="default"
            />
          </div>

          <div className="mt-6 overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Event type
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Orders
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Tickets sold
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Gross
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Refunds
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-500">
                    Net
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {summary.data.byEventType.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-sm text-gray-500">
                      No confirmed orders in this window.
                    </td>
                  </tr>
                ) : (
                  summary.data.byEventType.map((row) => (
                    <tr key={row.eventType}>
                      <td className="px-3 py-2 font-medium text-gray-900">
                        {EVT_EVENT_TYPE_LABELS[row.eventType]}
                      </td>
                      <td className="px-3 py-2 text-gray-700">{row.ordersConfirmed}</td>
                      <td className="px-3 py-2 text-gray-700">{row.ticketsSold}</td>
                      <td className="px-3 py-2 text-gray-700">
                        {formatCurrency(row.grossRevenue)}
                      </td>
                      <td className="px-3 py-2 text-gray-700">
                        {formatCurrency(row.refundsIssued)}
                      </td>
                      <td className="px-3 py-2 text-gray-700">{formatCurrency(row.netRevenue)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'emerald' | 'rose' | 'default';
}) {
  const cls =
    tone === 'emerald' ? 'text-emerald-700' : tone === 'rose' ? 'text-rose-700' : 'text-gray-900';
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3 shadow-sm">
      <div className={`text-xl font-semibold ${cls}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}
