'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  CHECKOUT_STATUS_PILL,
  COPY_LOCATION_STATUS_PILL,
  HOLD_STATUS_PILL,
  LIBRARY_CHECKOUT_STATUS_LABELS,
  LIBRARY_COPY_LOCATION_STATUS_LABELS,
  LIBRARY_HOLD_STATUS_LABELS,
  formatDate,
  formatDaysUntilDue,
  isOverdue,
} from '@/lib/library-format';
import {
  useBarcodeLookup,
  useCheckouts,
  useCollectHold,
  useCreateCheckout,
  useHolds,
  useRenewCheckout,
  useReturnCheckout,
} from '@/hooks/use-library';
import type { LibraryCheckoutStatus } from '@/lib/types';

const STATUS_CHIPS: { key: LibraryCheckoutStatus | 'ALL'; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'OVERDUE', label: 'Overdue' },
  { key: 'RETURNED', label: 'Returned' },
  { key: 'LOST', label: 'Lost' },
];

export default function CirculationDeskPage() {
  const user = useAuthStore((s) => s.user);
  const isLibrarian = !!user && hasAnyPermission(user, ['sch-001:admin', 'lib-001:write']);

  if (!isLibrarian) {
    return (
      <div className="space-y-4">
        <PageHeader title="Circulation desk" />
        <p className="rounded-md bg-amber-50 p-4 text-sm text-amber-900">
          The circulation desk is for librarians and admins only. Use{' '}
          <Link href="/library" className="font-medium underline">
            /library
          </Link>{' '}
          to see your own checkouts and holds.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Circulation desk"
        description="Scan a barcode to check out, return, or renew. Process pending holds when copies become available."
      />
      <CheckoutScanner />
      <ReadyHoldsBoard />
      <CheckoutHistory />
    </div>
  );
}

function CheckoutScanner() {
  const [barcode, setBarcode] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [patronId, setPatronId] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const lookupQ = useBarcodeLookup(submitted);
  const create = useCreateCheckout();
  const returnCo = useReturnCheckout();
  const renewCo = useRenewCheckout();
  const toast = useToast();

  const lookup = lookupQ.data;
  const isCheckedOut = !!lookup?.activeCheckout;

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="text-base font-semibold text-gray-900">Scan barcode</div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (barcode.trim()) setSubmitted(barcode.trim());
        }}
        className="mt-3 flex gap-2"
      >
        <input
          ref={inputRef}
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
          placeholder="Barcode (e.g. LIB-FIC-001)"
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        />
        <button
          type="submit"
          className="rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700"
        >
          Look up
        </button>
      </form>

      {submitted && lookupQ.isLoading && (
        <div className="mt-4">
          <LoadingSpinner />
        </div>
      )}
      {submitted && lookupQ.isError && (
        <p className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
          No copy found for &quot;{submitted}&quot;.
        </p>
      )}

      {lookup && (
        <div className="mt-4 space-y-4">
          <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-sm font-semibold text-gray-900">{lookup.item.title}</div>
                <div className="text-xs text-gray-600">
                  {lookup.item.author ?? '—'} · {lookup.copy.barcode}
                </div>
              </div>
              <span
                className={
                  'rounded px-2 py-0.5 text-xs font-medium ' +
                  COPY_LOCATION_STATUS_PILL[lookup.copy.locationStatus]
                }
              >
                {LIBRARY_COPY_LOCATION_STATUS_LABELS[lookup.copy.locationStatus]}
              </span>
            </div>
            {lookup.activeCheckout && (
              <div className="mt-3 rounded-md bg-amber-50 p-3 text-xs text-amber-900">
                <span className="font-medium">Currently checked out by:</span>{' '}
                {lookup.activeCheckout.patronName ?? '—'} · due {lookup.activeCheckout.dueDate} (
                {formatDaysUntilDue(lookup.activeCheckout.daysUntilDue)})
              </div>
            )}
            {lookup.pendingHoldsCount > 0 && (
              <div className="mt-2 text-xs text-gray-600">
                {lookup.pendingHoldsCount} hold
                {lookup.pendingHoldsCount === 1 ? '' : 's'} pending
              </div>
            )}
          </div>

          {isCheckedOut ? (
            <div className="space-y-3 rounded-md border border-emerald-200 bg-emerald-50/40 p-4">
              <div className="text-sm font-semibold text-emerald-900">Process return</div>
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    if (!lookup.activeCheckout) return;
                    try {
                      await returnCo.mutateAsync(lookup.activeCheckout.checkoutId);
                      toast.toast('Returned. Copy is back on the shelf.');
                      setSubmitted(null);
                      setBarcode('');
                      inputRef.current?.focus();
                    } catch (err) {
                      const message =
                        err instanceof Error ? err.message : 'Could not return checkout';
                      toast.toast(message, 'error');
                    }
                  }}
                  disabled={returnCo.isPending}
                  className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
                >
                  {returnCo.isPending ? 'Returning…' : 'Mark returned'}
                </button>
                <button
                  onClick={async () => {
                    if (!lookup.activeCheckout) return;
                    try {
                      await renewCo.mutateAsync(lookup.activeCheckout.checkoutId);
                      toast.toast('Renewed. Due date extended.');
                      setSubmitted(null);
                      setBarcode('');
                      inputRef.current?.focus();
                    } catch (err) {
                      const message = err instanceof Error ? err.message : 'Could not renew';
                      toast.toast(message, 'error');
                    }
                  }}
                  disabled={renewCo.isPending}
                  className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-60"
                >
                  {renewCo.isPending ? 'Renewing…' : 'Renew'}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 rounded-md border border-sky-200 bg-sky-50/40 p-4">
              <div className="text-sm font-semibold text-sky-900">Process checkout</div>
              <input
                value={patronId}
                onChange={(e) => setPatronId(e.target.value)}
                placeholder="Patron iam_person.id (UUID)"
                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              />
              <p className="text-xs text-gray-500">
                Look up the patron&apos;s id at the directory, or via the catalogue page&apos;s hold
                queue when promoting a hold.
              </p>
              <button
                onClick={async () => {
                  if (!patronId.trim()) {
                    toast.toast('Enter a patron id first', 'error');
                    return;
                  }
                  try {
                    await create.mutateAsync({
                      barcode: lookup.copy.barcode,
                      patronId: patronId.trim(),
                    });
                    toast.toast('Checked out.');
                    setSubmitted(null);
                    setBarcode('');
                    setPatronId('');
                    inputRef.current?.focus();
                  } catch (err) {
                    const message = err instanceof Error ? err.message : 'Could not check out';
                    toast.toast(message, 'error');
                  }
                }}
                disabled={create.isPending || lookup.copy.locationStatus !== 'ON_SHELF'}
                className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60"
              >
                {create.isPending
                  ? 'Checking out…'
                  : lookup.copy.locationStatus !== 'ON_SHELF'
                    ? 'Copy not on shelf'
                    : 'Check out to patron'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ReadyHoldsBoard() {
  const readyQ = useHolds({ status: 'READY' });
  const collect = useCollectHold();
  const toast = useToast();
  const ready = readyQ.data ?? [];

  if (ready.length === 0) return null;

  return (
    <section className="rounded-lg border border-emerald-200 bg-emerald-50/30 p-5">
      <h2 className="text-base font-semibold text-emerald-900">Ready for pickup</h2>
      <p className="mt-1 text-xs text-emerald-800">
        These holds were notified — mark Collected when the patron picks up the copy.
      </p>
      <ul className="mt-4 divide-y divide-emerald-200">
        {ready.map((h) => (
          <li key={h.id} className="flex items-center justify-between py-2 text-sm">
            <div>
              <div className="font-medium text-emerald-900">{h.itemTitle ?? '—'}</div>
              <div className="text-xs text-emerald-800">
                {h.patronName ?? '—'} · notified {formatDate(h.notifiedAt)}
              </div>
            </div>
            <button
              onClick={async () => {
                try {
                  await collect.mutateAsync(h.id);
                  toast.toast('Hold collected.');
                } catch (err) {
                  const message = err instanceof Error ? err.message : 'Could not mark collected';
                  toast.toast(message, 'error');
                }
              }}
              disabled={collect.isPending}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              Mark collected
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CheckoutHistory() {
  const [filter, setFilter] = useState<LibraryCheckoutStatus | 'ALL'>('ACTIVE');
  const checkoutsQ = useCheckouts({
    status: filter === 'ALL' ? undefined : filter,
  });
  const renewCo = useRenewCheckout();
  const returnCo = useReturnCheckout();
  const toast = useToast();
  const list = checkoutsQ.data ?? [];

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Checkouts</h2>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {STATUS_CHIPS.map((c) => (
          <button
            key={c.key}
            onClick={() => setFilter(c.key)}
            className={
              'rounded-full px-3 py-1 text-xs font-medium transition ' +
              (filter === c.key
                ? 'bg-campus-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200')
            }
          >
            {c.label}
          </button>
        ))}
      </div>

      {checkoutsQ.isLoading ? (
        <LoadingSpinner />
      ) : list.length === 0 ? (
        <p className="mt-4 text-sm text-gray-600">No checkouts match.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
                <th className="py-2 text-left font-medium">Patron</th>
                <th className="py-2 text-left font-medium">Item</th>
                <th className="py-2 text-left font-medium">Out</th>
                <th className="py-2 text-left font-medium">Due</th>
                <th className="py-2 text-left font-medium">Renewals</th>
                <th className="py-2 text-left font-medium">Status</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {list.map((c) => (
                <tr key={c.id}>
                  <td className="py-2">{c.patronName ?? c.patronId.slice(0, 8)}</td>
                  <td className="py-2">
                    <div className="font-medium text-gray-900">{c.itemTitle ?? '—'}</div>
                    <div className="text-xs text-gray-500 font-mono">{c.copyBarcode}</div>
                  </td>
                  <td className="py-2 text-xs text-gray-700">{formatDate(c.checkoutDate)}</td>
                  <td className="py-2 text-xs text-gray-700">
                    {formatDate(c.dueDate)}
                    {isOverdue(c.daysUntilDue) && (
                      <span className="ml-1 text-rose-700">
                        ({formatDaysUntilDue(c.daysUntilDue)})
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-xs text-gray-700">{c.renewalCount}</td>
                  <td className="py-2">
                    <span
                      className={
                        'rounded px-2 py-0.5 text-xs font-medium ' + CHECKOUT_STATUS_PILL[c.status]
                      }
                    >
                      {LIBRARY_CHECKOUT_STATUS_LABELS[c.status]}
                    </span>
                  </td>
                  <td className="py-2">
                    {(c.status === 'ACTIVE' || c.status === 'OVERDUE') && (
                      <div className="flex gap-2 text-xs">
                        <button
                          onClick={async () => {
                            try {
                              await returnCo.mutateAsync(c.id);
                              toast.toast('Returned.');
                            } catch (err) {
                              toast.toast(
                                err instanceof Error ? err.message : 'Could not return',
                                'error',
                              );
                            }
                          }}
                          className="font-medium text-emerald-700 hover:text-emerald-800"
                        >
                          Return
                        </button>
                        <button
                          onClick={async () => {
                            try {
                              await renewCo.mutateAsync(c.id);
                              toast.toast('Renewed.');
                            } catch (err) {
                              toast.toast(
                                err instanceof Error ? err.message : 'Could not renew',
                                'error',
                              );
                            }
                          }}
                          className="font-medium text-sky-700 hover:text-sky-800"
                        >
                          Renew
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Suppress lint
void HOLD_STATUS_PILL;
void LIBRARY_HOLD_STATUS_LABELS;
