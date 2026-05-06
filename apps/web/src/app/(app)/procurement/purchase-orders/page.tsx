'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState, PageHeader } from '@/components/ui';
import {
  formatCurrency,
  formatDate,
  PRC_PO_STATUSES,
  PO_STATUS_LABELS,
  PO_STATUS_PILL,
} from '@/lib/procurement-format';
import { usePurchaseOrders } from '@/hooks/use-procurement';

export default function PurchaseOrdersListPage() {
  const [status, setStatus] = useState<string>('');
  const pos = usePurchaseOrders(status ? { status } : undefined);

  return (
    <div>
      <PageHeader
        title="Purchase orders"
        description="Issue, track, and close POs against approved requisitions or vendor quotes."
        actions={
          <Link
            href="/procurement/purchase-orders/new"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white"
          >
            New PO
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <FilterChip label="All" active={status === ''} onClick={() => setStatus('')} />
        {PRC_PO_STATUSES.map((s) => (
          <FilterChip
            key={s}
            label={PO_STATUS_LABELS[s]}
            active={status === s}
            onClick={() => setStatus(s)}
          />
        ))}
      </div>

      {pos.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (pos.data ?? []).length === 0 ? (
        <EmptyState title="No purchase orders" description="Create a PO to begin procurement." />
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>PO #</Th>
                <Th>Status</Th>
                <Th>Vendor</Th>
                <Th>Lines</Th>
                <Th className="text-right">Total</Th>
                <Th>Issued</Th>
                <Th>Expected delivery</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(pos.data ?? []).map((p) => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <Td>
                    <Link
                      href={`/procurement/purchase-orders/${p.id}`}
                      className="font-medium text-campus-700 hover:underline"
                    >
                      {p.poNumber}
                    </Link>
                  </Td>
                  <Td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${PO_STATUS_PILL[p.status]}`}
                    >
                      {PO_STATUS_LABELS[p.status]}
                    </span>
                  </Td>
                  <Td>{p.vendorName ?? '—'}</Td>
                  <Td>{p.lines.length}</Td>
                  <Td className="text-right">{formatCurrency(p.totalAmount)}</Td>
                  <Td>{formatDate(p.issuedAt)}</Td>
                  <Td>{formatDate(p.expectedDeliveryDate)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`whitespace-nowrap px-4 py-2.5 text-sm text-gray-700 ${className}`}>
      {children}
    </td>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
        active
          ? 'bg-campus-600 text-white'
          : 'bg-white text-gray-700 ring-1 ring-gray-200 hover:ring-campus-400'
      }`}
    >
      {label}
    </button>
  );
}
