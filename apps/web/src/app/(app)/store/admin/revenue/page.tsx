'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Modal, PageHeader, useToast } from '@/components/ui';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/store-format';
import { useMaterialiseRevenue, useRevenue, useStores } from '@/hooks/use-store';

export default function AdminRevenuePage() {
  const { toast } = useToast();
  const stores = useStores();
  const revenue = useRevenue();
  const materialise = useMaterialiseRevenue();
  const [modalOpen, setModalOpen] = useState(false);
  const [storeId, setStoreId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');

  const onMaterialise = async () => {
    if (!storeId || !periodStart || !periodEnd) {
      toast('Store + period dates are required', 'error');
      return;
    }
    try {
      const r = await materialise.mutateAsync({ storeId, periodStart, periodEnd });
      toast(
        `Materialised — ${r.totalOrders} orders, ${formatCurrency(r.totalRevenue)} revenue, ${formatCurrency(r.grossMargin)} margin`,
        'success',
      );
      setModalOpen(false);
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Materialise failed', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        title="Store revenue"
        description="Materialised periodic revenue summaries — total orders, revenue, cost, margin per (store, period)."
        actions={
          <div className="flex gap-2">
            <Link href="/store" className="text-sm text-campus-600 hover:underline">
              ← Store
            </Link>
            <button
              onClick={() => setModalOpen(true)}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              Materialise period
            </button>
          </div>
        }
      />

      {revenue.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (revenue.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-500">
          No revenue snapshots yet. Click &quot;Materialise period&quot; to compute one.
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>Store</Th>
                <Th>Period</Th>
                <Th className="text-right">Orders</Th>
                <Th className="text-right">Revenue</Th>
                <Th className="text-right">Cost</Th>
                <Th className="text-right">Margin</Th>
                <Th>Computed</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(revenue.data ?? []).map((r) => (
                <tr key={r.id}>
                  <Td>{r.storeName ?? '—'}</Td>
                  <Td>
                    {formatDate(r.periodStart)} → {formatDate(r.periodEnd)}
                  </Td>
                  <Td className="text-right">{r.totalOrders}</Td>
                  <Td className="text-right">{formatCurrency(r.totalRevenue)}</Td>
                  <Td className="text-right">{formatCurrency(r.totalCost)}</Td>
                  <Td className="text-right font-semibold text-emerald-700">
                    {formatCurrency(r.grossMargin)}
                  </Td>
                  <Td>{formatDateTime(r.computedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Materialise revenue"
        footer={
          <>
            <button
              onClick={() => setModalOpen(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={onMaterialise}
              disabled={materialise.isPending}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Materialise
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="rounded-md bg-sky-50 p-3 text-xs text-sky-800">
            Aggregates COMPLETED orders in the period. Idempotent — re-running for the same period
            replaces the existing row.
          </div>
          <label className="block text-sm">
            <div className="mb-1 font-medium text-gray-700">Store</div>
            <select
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">— select —</option>
              {(stores.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.storeType} · {s.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <div className="mb-1 font-medium text-gray-700">Period start</div>
              <input
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm">
              <div className="mb-1 font-medium text-gray-700">Period end</div>
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <td className={`whitespace-nowrap px-4 py-2.5 text-sm text-gray-700 ${className}`}>
      {children}
    </td>
  );
}
