'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useDeliverItProcurement, useItProcurement } from '@/hooks/use-it';
import {
  IT_PROCUREMENT_PILL,
  IT_PROCUREMENT_STATUS_LABELS,
  formatItCurrency,
  formatItDate,
} from '@/lib/it-format';
import type { ItProcurementStatus } from '@/lib/types';

const STATUSES: ItProcurementStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'ORDERED',
  'DELIVERED',
  'CANCELLED',
];

export default function ProcurementPage() {
  const [filter, setFilter] = useState<ItProcurementStatus | undefined>(undefined);
  const orders = useItProcurement({ status: filter });
  const deliver = useDeliverItProcurement();
  const { toast } = useToast();

  async function markDelivered(id: string, title: string) {
    if (!confirm(`Mark "${title}" as DELIVERED?`)) return;
    try {
      await deliver.mutateAsync({ id, body: {} });
      toast(`Marked delivered · ${title}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <PageHeader title="Procurement" description="Hardware orders and deliveries" />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`rounded-full border px-3 py-1 text-xs ${
            filter === undefined
              ? 'border-campus-600 bg-campus-100 text-campus-800'
              : 'border-gray-300 bg-white text-gray-700'
          }`}
          onClick={() => setFilter(undefined)}
        >
          All
        </button>
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={`rounded-full border px-3 py-1 text-xs ${
              filter === s
                ? 'border-campus-600 bg-campus-100 text-campus-800'
                : 'border-gray-300 bg-white text-gray-700'
            }`}
            onClick={() => setFilter(s)}
          >
            {IT_PROCUREMENT_STATUS_LABELS[s]}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="p-3">Order</th>
              <th className="p-3">Vendor</th>
              <th className="p-3">PO #</th>
              <th className="p-3">Ordered</th>
              <th className="p-3">Expected</th>
              <th className="p-3">Cost</th>
              <th className="p-3">Status</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {orders.data?.map((p) => (
              <tr key={p.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="p-3 font-medium">
                  {p.orderTitle}
                  {p.orderedByName ? (
                    <p className="text-xs text-gray-500">By {p.orderedByName}</p>
                  ) : null}
                </td>
                <td className="p-3 text-gray-700">{p.vendorName ?? '—'}</td>
                <td className="p-3 font-mono text-xs text-gray-500">
                  {p.purchaseOrderNumber ?? '—'}
                </td>
                <td className="p-3 text-gray-500">{formatItDate(p.orderDate)}</td>
                <td className="p-3 text-gray-500">{formatItDate(p.expectedDeliveryDate)}</td>
                <td className="p-3 text-gray-700">{formatItCurrency(p.totalCost)}</td>
                <td className="p-3">
                  <span className={`rounded px-2 py-0.5 text-xs ${IT_PROCUREMENT_PILL[p.status]}`}>
                    {IT_PROCUREMENT_STATUS_LABELS[p.status]}
                  </span>
                </td>
                <td className="p-3">
                  {p.status === 'ORDERED' ? (
                    <button
                      type="button"
                      onClick={() => markDelivered(p.id, p.orderTitle)}
                      className="rounded-md bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-700"
                    >
                      Mark delivered
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {!orders.isLoading && (orders.data?.length ?? 0) === 0 ? (
              <tr>
                <td colSpan={8} className="p-6 text-center text-sm text-gray-500">
                  No procurement orders match.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
