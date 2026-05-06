'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useFdsAllergenCheckPatron,
  useFdsCreateTransaction,
  useFdsDailyMenu,
  useFdsPosDevices,
  useFdsSessions,
} from '@/hooks/use-food-service';
import { FDS_PAYMENT_METHOD_LABEL, formatCurrency } from '@/lib/food-service-format';
import type { FdsAllergenMatchDto, FdsPaymentMethod } from '@/lib/types';

export default function PosCheckoutPage() {
  const today = new Date().toISOString().slice(0, 10);
  const sessionsQ = useFdsSessions({ fromDate: today, toDate: today });
  const devicesQ = useFdsPosDevices();
  const menuQ = useFdsDailyMenu(today, 'LUNCH');

  const activeSession = (sessionsQ.data ?? []).find((s) => s.closedAt === null);
  const defaultDevice = (devicesQ.data ?? []).find((d) => d.isActive);

  const [patronId, setPatronId] = useState('');
  const [supervisorId, setSupervisorId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<FdsPaymentMethod>('CASH');
  const [selectedItems, setSelectedItems] = useState<Record<string, boolean>>({});
  const [blockedAllergens, setBlockedAllergens] = useState<FdsAllergenMatchDto[] | null>(null);
  const [lastTxn, setLastTxn] = useState<string | null>(null);

  const allergenCheck = useFdsAllergenCheckPatron(patronId || null);
  const createTxn = useFdsCreateTransaction();
  const { toast } = useToast();

  const items = menuQ.data?.items ?? [];
  const selected = items.filter((it) => selectedItems[it.id]);
  const total = selected.reduce((sum, it) => sum + Number(it.unitCost ?? 0), 0);

  async function submit() {
    if (!activeSession) {
      toast('No active session — open one in /food-service/sessions', 'error');
      return;
    }
    if (!defaultDevice) {
      toast('No active POS device', 'error');
      return;
    }
    if (!patronId) {
      toast('Enter a patron id', 'error');
      return;
    }
    if (selected.length === 0) {
      toast('Select at least one item', 'error');
      return;
    }
    setBlockedAllergens(null);
    try {
      const res = await createTxn.mutateAsync({
        patronId,
        sessionId: activeSession.id,
        posDeviceId: defaultDevice.id,
        items: selected.map((it) => ({
          itemId: it.menuItemId,
          name: it.menuItemName ?? undefined,
          price: Number(it.unitCost ?? 0),
        })),
        paymentMethod,
        supervisorOverrideId: supervisorId || undefined,
      });
      toast(
        res.allergenOverrideRequired
          ? 'Transaction recorded with supervisor override'
          : `Transaction ${formatCurrency(res.total)} recorded`,
        'success',
      );
      setLastTxn(res.id);
      setSelectedItems({});
      setSupervisorId('');
    } catch (err) {
      const e = err as { status?: number; response?: { blocked?: FdsAllergenMatchDto[] } };
      if (e.status === 422 && e.response?.blocked) {
        setBlockedAllergens(e.response.blocked);
        toast('CRITICAL allergen — supervisor override required', 'error');
        return;
      }
      toast((err as Error).message, 'error');
    }
  }

  return (
    <div>
      <PageHeader
        title="POS Checkout"
        description="Allergen safety enforcement at the point of sale"
        actions={
          <Link
            href="/food-service"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Food Service
          </Link>
        }
      />

      {!activeSession && (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          No active LUNCH session for today. Open one from the{' '}
          <Link href="/food-service/sessions" className="underline underline-offset-4">
            Sessions
          </Link>{' '}
          page first.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-semibold text-gray-900">Patron + items</h2>

          <label className="mt-3 block text-sm">
            <span className="block font-medium text-gray-700">Patron ID (iam_person id)</span>
            <input
              value={patronId}
              onChange={(e) => setPatronId(e.target.value.trim())}
              placeholder="Scan student ID or paste UUID"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
            />
          </label>

          {allergenCheck.data && (
            <div
              className={`mt-3 rounded-lg p-3 text-sm ${
                allergenCheck.data.criticalCount > 0
                  ? 'border border-rose-300 bg-rose-50 text-rose-900'
                  : allergenCheck.data.warningCount > 0
                    ? 'border border-amber-300 bg-amber-50 text-amber-900'
                    : 'border border-gray-200 bg-gray-50 text-gray-700'
              }`}
            >
              <div className="font-medium">
                {allergenCheck.data.criticalCount > 0
                  ? '🚨 CRITICAL allergens on file'
                  : allergenCheck.data.warningCount > 0
                    ? '⚠ Allergens on file'
                    : 'No active allergen alerts'}
              </div>
              {allergenCheck.data.activeAllergens.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {allergenCheck.data.activeAllergens.map((code) => (
                    <span key={code} className="rounded-full bg-white px-2 py-0.5 text-xs">
                      {code}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <fieldset className="mt-4">
            <legend className="block text-sm font-medium text-gray-700">Items</legend>
            <div className="mt-1 space-y-1">
              {items.map((it) => (
                <label
                  key={it.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm hover:bg-gray-100"
                >
                  <input
                    type="checkbox"
                    checked={!!selectedItems[it.id]}
                    onChange={(e) =>
                      setSelectedItems((prev) => ({ ...prev, [it.id]: e.target.checked }))
                    }
                  />
                  <span className="flex-1 font-medium text-gray-900">{it.menuItemName}</span>
                  <span className="text-xs text-gray-500">{formatCurrency(it.unitCost)}</span>
                  <span className="flex flex-wrap gap-1">
                    {it.allergenCodes.map((code) => (
                      <span
                        key={code}
                        className="rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-700"
                      >
                        {code}
                      </span>
                    ))}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="mt-4">
            <legend className="block text-sm font-medium text-gray-700">Payment</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {(
                [
                  'LUNCH_ACCOUNT',
                  'CASH',
                  'INVOICE',
                  'FREE_MEAL',
                  'STAFF_ACCOUNT',
                ] as FdsPaymentMethod[]
              ).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setPaymentMethod(m)}
                  className={`rounded-lg border px-3 py-1.5 text-xs ${
                    paymentMethod === m
                      ? 'border-campus-700 bg-campus-700 text-white'
                      : 'border-gray-300 bg-white text-gray-700'
                  }`}
                >
                  {FDS_PAYMENT_METHOD_LABEL[m]}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="mt-4 flex items-baseline justify-between rounded-lg bg-gray-100 p-3">
            <span className="text-sm font-medium text-gray-700">Total</span>
            <span className="text-xl font-semibold text-gray-900">{formatCurrency(total)}</span>
          </div>

          <button
            type="button"
            onClick={submit}
            disabled={createTxn.isPending || !activeSession}
            className="mt-3 w-full rounded-lg bg-campus-700 px-3 py-2 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
          >
            {createTxn.isPending ? 'Submitting…' : 'Record transaction'}
          </button>

          {lastTxn && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              Last transaction id: <code className="font-mono">{lastTxn}</code>
            </div>
          )}
        </section>

        {blockedAllergens && (
          <section className="rounded-2xl border-2 border-rose-700 bg-rose-50 p-5">
            <h2 className="text-base font-semibold text-rose-900">
              🚨 BLOCKED — Supervisor Override Required
            </h2>
            <p className="mt-1 text-sm text-rose-800">
              The transaction contains items with CRITICAL allergens for this patron. A supervisor
              must enter their account ID to override.
            </p>
            <ul className="mt-3 space-y-1 text-sm">
              {blockedAllergens.map((b) => (
                <li key={b.itemId} className="rounded-lg bg-white p-2 ring-1 ring-rose-200">
                  <div className="font-medium text-rose-900">{b.itemName}</div>
                  <div className="text-xs text-rose-700">
                    Matched: {b.matchedAllergens.join(', ')}
                  </div>
                </li>
              ))}
            </ul>

            <label className="mt-4 block text-sm">
              <span className="block font-medium text-rose-900">Supervisor account ID</span>
              <input
                value={supervisorId}
                onChange={(e) => setSupervisorId(e.target.value.trim())}
                placeholder="Supervisor scans their ID"
                className="mt-1 w-full rounded-lg border border-rose-300 px-3 py-2 font-mono text-sm"
              />
            </label>

            <button
              type="button"
              onClick={submit}
              disabled={createTxn.isPending || !supervisorId}
              className="mt-3 w-full rounded-lg bg-rose-700 px-3 py-2 text-sm font-medium text-white hover:bg-rose-800 disabled:bg-gray-300"
            >
              {createTxn.isPending ? 'Submitting…' : 'Override and record'}
            </button>
          </section>
        )}

        {!blockedAllergens && (
          <section className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-semibold text-gray-900">Cashier guide</h2>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-gray-700">
              <li>Scan or enter the student&apos;s ID — the allergen panel shows live alerts.</li>
              <li>Tick today&apos;s items the patron is taking.</li>
              <li>Pick the payment method.</li>
              <li>Submit. CRITICAL allergen matches block until a supervisor overrides.</li>
            </ol>
          </section>
        )}
      </div>
    </div>
  );
}
