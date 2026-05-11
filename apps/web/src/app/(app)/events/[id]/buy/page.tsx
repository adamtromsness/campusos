'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { EmptyState, LoadingSpinner, PageHeader } from '@/components/ui';
import { useToast } from '@/components/ui';
import { useEvent, usePurchase } from '@/hooks/use-events';
import {
  formatCurrency,
  formatEventDate,
  formatEventTime,
  tierAvailabilityLabel,
  tierAvailabilityTone,
} from '@/lib/events-format';
import { ApiError } from '@/lib/api-client';

export default function BuyTicketsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const eventId = params?.id ?? null;
  const eventQ = useEvent(eventId);
  const purchase = usePurchase(eventId ?? '');

  const [qty, setQty] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);

  const event = eventQ.data;
  const tiers = event?.tiers ?? [];

  const total = useMemo(
    () => tiers.reduce((acc, t) => acc + (qty[t.id] ?? 0) * t.price, 0),
    [tiers, qty],
  );
  const totalCount = useMemo(
    () => tiers.reduce((acc, t) => acc + (qty[t.id] ?? 0), 0),
    [tiers, qty],
  );

  if (!eventId) return null;
  if (eventQ.isLoading) return <LoadingSpinner />;
  if (!event) {
    return (
      <EmptyState
        title="Event not found"
        description="The event link may be stale."
        action={
          <Link href="/events" className="text-blue-700 hover:underline">
            Back to events →
          </Link>
        }
      />
    );
  }

  const isOnSale = event.status === 'ON_SALE';

  async function submit() {
    if (totalCount === 0) {
      toast('Pick at least one ticket', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const lines = tiers
        .filter((t) => (qty[t.id] ?? 0) > 0)
        .map((t) => ({ tierId: t.id, quantity: qty[t.id] ?? 0 }));
      await purchase.mutateAsync({ lines });
      toast('Order placed — payment intent created (dev stub).', 'success');
      router.push('/events/my-tickets');
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : String(err);
      toast(`Purchase failed: ${msg}`, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={event.title}
        description={`${formatEventDate(event.eventDate)} · ${formatEventTime(event.startTime)}${
          event.venueName ? ` · ${event.venueName}` : ''
        }`}
        actions={
          <Link href="/events" className="text-sm text-blue-700 hover:underline">
            ← Back to events
          </Link>
        }
      />

      {!isOnSale && (
        <div className="mt-4 rounded-md bg-amber-50 p-4 text-amber-900 ring-1 ring-amber-200">
          This event is not currently on sale (status: {event.status}).
        </div>
      )}

      <div className="mt-6 space-y-3">
        {tiers.length === 0 && <EmptyState title="No tiers configured" description="" />}
        {tiers.map((t) => (
          <div
            key={t.id}
            className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <div className="font-semibold text-gray-900">{t.name}</div>
              <div className="text-sm text-gray-600">
                {formatCurrency(t.price)} ·{' '}
                <span className={tierAvailabilityTone(t.remaining, t.quantity)}>
                  {tierAvailabilityLabel(t.remaining, t.quantity)}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-700" htmlFor={`qty-${t.id}`}>
                Qty
              </label>
              <input
                id={`qty-${t.id}`}
                type="number"
                min={0}
                max={Math.min(t.remaining, 10)}
                value={qty[t.id] ?? 0}
                disabled={!isOnSale || t.remaining <= 0}
                onChange={(e) =>
                  setQty((q) => ({ ...q, [t.id]: Math.max(0, Number(e.target.value || 0)) }))
                }
                className="w-20 rounded-md border border-gray-300 px-2 py-1 text-sm"
              />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-col items-end gap-3 border-t border-gray-200 pt-4">
        <div className="text-lg font-semibold text-gray-900">
          {totalCount} ticket{totalCount === 1 ? '' : 's'} — {formatCurrency(total)}
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={!isOnSale || totalCount === 0 || submitting}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow disabled:bg-gray-300 disabled:text-gray-500"
        >
          {submitting ? 'Placing order…' : 'Confirm purchase'}
        </button>
        <p className="text-xs text-gray-500">
          The order is held PENDING for 15 minutes pending Stripe confirmation. In dev, the order
          auto-confirms when the test webhook fires.
        </p>
      </div>
    </div>
  );
}
