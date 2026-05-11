'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState, LoadingSpinner, Modal, PageHeader } from '@/components/ui';
import { useToast } from '@/components/ui';
import { useCancelOrder, useMyOrders } from '@/hooks/use-events';
import {
  EVT_ORDER_STATUS_LABELS,
  EVT_ORDER_STATUS_PILL,
  EVT_TICKET_STATUS_LABELS,
  EVT_TICKET_STATUS_PILL,
  formatCurrency,
  formatDateTime,
} from '@/lib/events-format';
import type { EvtOrderDto, EvtTicketDto } from '@/lib/types';

export default function MyTicketsPage() {
  const ordersQ = useMyOrders();
  const cancelOrder = useCancelOrder();
  const { toast } = useToast();
  const [previewTicket, setPreviewTicket] = useState<EvtTicketDto | null>(null);

  const orders = useMemo(() => ordersQ.data ?? [], [ordersQ.data]);

  async function cancel(o: EvtOrderDto) {
    if (
      !window.confirm(
        'Cancel this order? Tickets will be voided and the tier inventory will be returned.',
      )
    )
      return;
    try {
      await cancelOrder.mutateAsync({
        orderId: o.id,
        cancellationReason: 'User cancelled from My tickets',
      });
      toast('Order cancelled.', 'success');
    } catch (err) {
      toast(`Cancel failed: ${String(err)}`, 'error');
    }
  }

  return (
    <div>
      <PageHeader
        title="My tickets"
        description="Orders, ticket QR codes, and refund history."
        actions={
          <Link href="/events" className="text-sm text-blue-700 hover:underline">
            ← Browse events
          </Link>
        }
      />

      {ordersQ.isLoading ? (
        <LoadingSpinner />
      ) : orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          description="When you buy tickets, they'll show up here."
          action={
            <Link
              href="/events"
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              Browse events
            </Link>
          }
        />
      ) : (
        <div className="mt-6 space-y-4">
          {orders.map((o) => (
            <div key={o.id} className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{o.eventTitle ?? 'Event'}</h3>
                  <div className="mt-1 text-sm text-gray-600">
                    Placed {formatDateTime(o.createdAt)} · {formatCurrency(o.totalAmount)} ·{' '}
                    {o.tickets.length} ticket{o.tickets.length === 1 ? '' : 's'}
                  </div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    EVT_ORDER_STATUS_PILL[o.status]
                  }`}
                >
                  {EVT_ORDER_STATUS_LABELS[o.status]}
                </span>
              </div>

              {o.status === 'PENDING' && o.expiresAt && (
                <div className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                  Payment pending. Order expires {formatDateTime(o.expiresAt)}.
                </div>
              )}

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {o.tickets.map((t) => (
                  <div
                    key={t.id}
                    className="rounded-md border border-gray-100 bg-gray-50 p-3 text-sm"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-gray-800">{t.tierName ?? 'Ticket'}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          EVT_TICKET_STATUS_PILL[t.status]
                        }`}
                      >
                        {EVT_TICKET_STATUS_LABELS[t.status]}
                      </span>
                    </div>
                    {t.holderName && (
                      <div className="mt-1 text-xs text-gray-600">For: {t.holderName}</div>
                    )}
                    <div className="mt-2 break-all font-mono text-[10px] text-gray-500">
                      {t.qrCodeToken.slice(0, 32)}…
                    </div>
                    <button
                      type="button"
                      onClick={() => setPreviewTicket(t)}
                      className="mt-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700"
                    >
                      Show at gate
                    </button>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex justify-end">
                {(o.status === 'PENDING' || o.status === 'CONFIRMED') && (
                  <button
                    type="button"
                    onClick={() => cancel(o)}
                    className="text-xs text-rose-700 hover:underline"
                  >
                    Cancel order
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={!!previewTicket}
        onClose={() => setPreviewTicket(null)}
        title="Show this at the gate"
      >
        {previewTicket && (
          <div className="space-y-3 text-center">
            <div className="font-semibold text-gray-900">{previewTicket.tierName ?? 'Ticket'}</div>
            {previewTicket.holderName && (
              <div className="text-sm text-gray-600">{previewTicket.holderName}</div>
            )}
            <div className="my-4 break-all rounded-md border border-gray-300 bg-white p-6 font-mono text-xs text-gray-800">
              {previewTicket.qrCodeToken}
            </div>
            <p className="text-xs text-gray-500">
              The gate scanner reads the QR code (a real client renders this as an image). In dev,
              copy the token and paste it into the gate scanner.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
