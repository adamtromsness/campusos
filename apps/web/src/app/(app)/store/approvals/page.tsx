'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Modal, PageHeader, useToast } from '@/components/ui';
import {
  APPROVAL_STATUS_LABELS,
  APPROVAL_STATUS_PILL,
  formatCurrency,
  formatDateTime,
} from '@/lib/store-format';
import { useApprovals, useApproveApproval, useDeclineApproval, useOrders } from '@/hooks/use-store';

export default function ApprovalsPage() {
  const { toast } = useToast();
  const approvals = useApprovals();
  const orders = useOrders();
  const approve = useApproveApproval();
  const decline = useDeclineApproval();
  const [declineOpen, setDeclineOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const orderById = useMemo(() => {
    const m = new Map(
      typeof window === 'undefined' ? [] : (orders.data ?? []).map((o) => [o.id, o]),
    );
    return m;
  }, [orders.data]);

  const onApprove = async (id: string) => {
    try {
      await approve.mutateAsync(id);
      toast('Order approved — payment will be charged to family account', 'success');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Approve failed', 'error');
    }
  };

  const onDecline = async () => {
    if (!activeId) return;
    if (!reason.trim()) {
      toast('Decline reason is required', 'error');
      return;
    }
    try {
      await decline.mutateAsync({ id: activeId, reason });
      toast('Order declined — inventory released', 'success');
      setDeclineOpen(false);
      setReason('');
      setActiveId(null);
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Decline failed', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        title="Order approvals"
        description="Review pending student orders. Approving charges the family account; declining cancels the order and releases inventory."
        actions={
          <Link href="/store" className="text-sm text-campus-600 hover:underline">
            ← Store
          </Link>
        }
      />

      {approvals.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (approvals.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-500">
          No approval requests yet.
        </div>
      ) : (
        <ul className="space-y-3">
          {(approvals.data ?? []).map((a) => {
            const order = orderById.get(a.orderId);
            return (
              <li key={a.id} className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
                <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-gray-900">
                      {order?.orderNumber ?? a.orderId.slice(0, 8)}
                      {order?.studentName ? ` · for ${order.studentName}` : ''}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      Requested {formatDateTime(a.requestedAt)}
                      {a.respondedAt ? ` · responded ${formatDateTime(a.respondedAt)}` : ''}
                    </div>
                  </div>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${APPROVAL_STATUS_PILL[a.status]}`}
                  >
                    {APPROVAL_STATUS_LABELS[a.status]}
                  </span>
                </div>
                {order && (
                  <div className="mb-3 rounded-md bg-gray-50 p-3 text-sm">
                    <div className="mb-1 text-xs uppercase text-gray-500">Items</div>
                    <ul className="space-y-1">
                      {order.lines.map((l) => (
                        <li key={l.id} className="flex items-center justify-between">
                          <span>
                            {l.quantity} × {l.productName ?? '—'}
                          </span>
                          <span className="text-gray-700">{formatCurrency(l.lineTotal)}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-2 flex items-center justify-between border-t border-gray-200 pt-2 font-medium">
                      <span>Total</span>
                      <span>{formatCurrency(order.total)}</span>
                    </div>
                  </div>
                )}
                {a.declineReason && (
                  <div className="mb-2 rounded-md bg-rose-50 p-2 text-xs text-rose-700">
                    <strong>Declined:</strong> {a.declineReason}
                  </div>
                )}
                {a.status === 'PENDING' && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => onApprove(a.id)}
                      disabled={approve.isPending}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveId(a.id);
                        setReason('');
                        setDeclineOpen(true);
                      }}
                      className="rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50"
                    >
                      Decline…
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        open={declineOpen}
        onClose={() => setDeclineOpen(false)}
        title="Decline order"
        footer={
          <>
            <button
              onClick={() => setDeclineOpen(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Keep open
            </button>
            <button
              onClick={onDecline}
              disabled={decline.isPending}
              className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Decline
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="text-sm text-gray-600">
            The student will see your reason. Inventory reserved for this order will be released
            atomically.
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            placeholder="Reason for declining"
          />
        </div>
      </Modal>
    </div>
  );
}
