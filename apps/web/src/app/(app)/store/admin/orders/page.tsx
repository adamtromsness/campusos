'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Modal, PageHeader, useToast } from '@/components/ui';
import {
  formatCurrency,
  formatDate,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_PILL,
  ORDER_TYPE_LABELS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_PILL,
  STR_ORDER_STATUSES,
} from '@/lib/store-format';
import { useCancelOrder, useCompleteOrder, useFulfilOrder, useOrders } from '@/hooks/use-store';
import type { StrOrderDto } from '@/lib/types';

export default function AdminOrdersPage() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>('');
  const orders = useOrders(statusFilter ? { status: statusFilter } : undefined);
  const fulfil = useFulfilOrder();
  const complete = useCompleteOrder();
  const cancel = useCancelOrder();
  const [shipModalOpen, setShipModalOpen] = useState(false);
  const [activeOrder, setActiveOrder] = useState<StrOrderDto | null>(null);
  const [tracking, setTracking] = useState('');

  const onMarkReady = async (o: StrOrderDto) => {
    try {
      await fulfil.mutateAsync({ id: o.id, payload: { toStatus: 'READY_FOR_PICKUP' } });
      toast('Order ready for pickup', 'success');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Update failed', 'error');
    }
  };

  const onShip = async () => {
    if (!activeOrder) return;
    try {
      await fulfil.mutateAsync({
        id: activeOrder.id,
        payload: { toStatus: 'SHIPPED', trackingNumber: tracking || undefined },
      });
      toast('Order shipped', 'success');
      setShipModalOpen(false);
      setTracking('');
      setActiveOrder(null);
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Ship failed', 'error');
    }
  };

  const onComplete = async (o: StrOrderDto) => {
    try {
      await complete.mutateAsync(o.id);
      toast('Order completed — inventory decremented', 'success');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Complete failed', 'error');
    }
  };

  const onCancel = async (o: StrOrderDto) => {
    if (!window.confirm(`Cancel order ${o.orderNumber}? Reserved inventory will be released.`))
      return;
    try {
      await cancel.mutateAsync({ id: o.id, reason: 'Cancelled by store' });
      toast('Order cancelled', 'success');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Cancel failed', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        title="Order fulfilment"
        description="All orders across both stores. Use the action buttons to advance through the lifecycle."
        actions={
          <Link href="/store" className="text-sm text-campus-600 hover:underline">
            ← Store
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Chip label="All" active={statusFilter === ''} onClick={() => setStatusFilter('')} />
        {STR_ORDER_STATUSES.map((s) => (
          <Chip
            key={s}
            label={ORDER_STATUS_LABELS[s]}
            active={statusFilter === s}
            onClick={() => setStatusFilter(s)}
          />
        ))}
      </div>

      {orders.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (orders.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-500">
          No orders match this filter.
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>Order #</Th>
                <Th>Type</Th>
                <Th>Customer</Th>
                <Th>Items</Th>
                <Th className="text-right">Total</Th>
                <Th>Date</Th>
                <Th>Status</Th>
                <Th>Payment</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(orders.data ?? []).map((o) => (
                <tr key={o.id}>
                  <Td>{o.orderNumber}</Td>
                  <Td>{ORDER_TYPE_LABELS[o.orderType]}</Td>
                  <Td>{o.customerName ?? o.externalCustomerName ?? '—'}</Td>
                  <Td>{o.lines.length}</Td>
                  <Td className="text-right">{formatCurrency(o.total)}</Td>
                  <Td>{formatDate(o.orderDate)}</Td>
                  <Td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ORDER_STATUS_PILL[o.status]}`}
                    >
                      {ORDER_STATUS_LABELS[o.status]}
                    </span>
                  </Td>
                  <Td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${PAYMENT_STATUS_PILL[o.paymentStatus]}`}
                    >
                      {PAYMENT_STATUS_LABELS[o.paymentStatus]}
                    </span>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {(o.status === 'PROCESSING' || o.status === 'BACKORDERED') && (
                        <>
                          <button
                            onClick={() => onMarkReady(o)}
                            className="rounded-md bg-emerald-600 px-2 py-1 text-xs text-white"
                          >
                            Ready
                          </button>
                          <button
                            onClick={() => {
                              setActiveOrder(o);
                              setTracking('');
                              setShipModalOpen(true);
                            }}
                            className="rounded-md bg-amber-600 px-2 py-1 text-xs text-white"
                          >
                            Ship…
                          </button>
                        </>
                      )}
                      {(o.status === 'READY_FOR_PICKUP' || o.status === 'SHIPPED') && (
                        <button
                          onClick={() => onComplete(o)}
                          className="rounded-md bg-emerald-600 px-2 py-1 text-xs text-white"
                        >
                          Complete
                        </button>
                      )}
                      {o.status !== 'COMPLETED' && o.status !== 'CANCELLED' && (
                        <button
                          onClick={() => onCancel(o)}
                          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={shipModalOpen}
        onClose={() => setShipModalOpen(false)}
        title="Ship order"
        footer={
          <>
            <button
              onClick={() => setShipModalOpen(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={onShip}
              disabled={fulfil.isPending}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Ship
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block text-sm">
            <div className="mb-1 font-medium text-gray-700">Tracking number (optional)</div>
            <input
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium ${
        active
          ? 'bg-campus-600 text-white'
          : 'bg-white text-gray-700 ring-1 ring-gray-200 hover:ring-campus-400'
      }`}
    >
      {label}
    </button>
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
