'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useItLicences } from '@/hooks/use-it';
import { useItLicenceRenewals, useRenewItLicence } from '@/hooks/use-it-advanced';
import {
  IT_LICENCE_TYPE_LABELS,
  formatItCurrency,
  formatItDate,
  formatItUtilisation,
  utilisationPill,
} from '@/lib/it-format';
import { formatItDateTime } from '@/lib/it-advanced-format';

export default function LicencesPage() {
  const user = useAuthStore((s) => s.user);
  const canRenew = hasAnyPermission(user, ['it-004:write']);
  const licences = useItLicences();
  const [renewingId, setRenewingId] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <PageHeader
        title="Software licences"
        description="Per-seat / site / subscription licence registry with renewal history"
      />
      <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="p-3">Software</th>
              <th className="p-3">Vendor</th>
              <th className="p-3">Type</th>
              <th className="p-3">Seats</th>
              <th className="p-3">Utilisation</th>
              <th className="p-3">Cost</th>
              <th className="p-3">Expiry</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {licences.data?.map((l) => (
              <tr key={l.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="p-3 font-medium">{l.softwareName}</td>
                <td className="p-3 text-gray-700">{l.vendor ?? '—'}</td>
                <td className="p-3 text-gray-700">{IT_LICENCE_TYPE_LABELS[l.licenceType]}</td>
                <td className="p-3 text-gray-700">
                  {l.totalSeats === null ? '∞' : `${l.usedSeats} / ${l.totalSeats}`}
                </td>
                <td className="p-3">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${utilisationPill(l.utilisationPct)}`}
                  >
                    {formatItUtilisation(l.utilisationPct)}
                  </span>
                </td>
                <td className="p-3 text-gray-700">{formatItCurrency(l.annualCost)} / yr</td>
                <td className="p-3 text-gray-500">{formatItDate(l.expiryDate)}</td>
                <td className="p-3 text-right">
                  <button
                    type="button"
                    onClick={() => setRenewingId(l.id)}
                    className="text-sm font-medium text-campus-700 hover:underline"
                  >
                    Renewals →
                  </button>
                </td>
              </tr>
            ))}
            {!licences.isLoading && (licences.data?.length ?? 0) === 0 ? (
              <tr>
                <td colSpan={8} className="p-6 text-center text-sm text-gray-500">
                  No licences configured.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {renewingId ? (
        <RenewalsModal
          licenceId={renewingId}
          currentExpiry={licences.data?.find((l) => l.id === renewingId)?.expiryDate ?? null}
          softwareName={licences.data?.find((l) => l.id === renewingId)?.softwareName ?? ''}
          canRenew={canRenew}
          onClose={() => setRenewingId(null)}
        />
      ) : null}
    </div>
  );
}

function RenewalsModal({
  licenceId,
  currentExpiry,
  softwareName,
  canRenew,
  onClose,
}: {
  licenceId: string;
  currentExpiry: string | null;
  softwareName: string;
  canRenew: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const renewals = useItLicenceRenewals(licenceId);
  const renew = useRenewItLicence(licenceId);
  const [showForm, setShowForm] = useState(false);
  const [newExpiry, setNewExpiry] = useState('');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');

  const submit = async () => {
    if (!newExpiry) {
      toast('Pick a new expiry date.', 'warning');
      return;
    }
    if (currentExpiry && newExpiry <= currentExpiry) {
      toast('New expiry must be after current expiry.', 'warning');
      return;
    }
    try {
      const parsedCost = cost.trim() ? Number(cost.trim()) : undefined;
      if (parsedCost !== undefined && Number.isNaN(parsedCost)) {
        toast('Cost must be a number.', 'warning');
        return;
      }
      await renew.mutateAsync({
        newExpiryDate: newExpiry,
        renewalCost: parsedCost,
        notes: notes.trim() || undefined,
      });
      toast(`${softwareName} renewed until ${newExpiry}.`, 'success');
      setShowForm(false);
      setNewExpiry('');
      setCost('');
      setNotes('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Renewal failed', 'error');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${softwareName} — renewals`}
      size="lg"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          Close
        </button>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          Current expiry: {formatItDate(currentExpiry)}. Renewal atomically writes a history row and
          extends the licence expiry inside one tenant tx.
        </p>
        {canRenew ? (
          showForm ? (
            <div className="rounded-md border border-campus-200 bg-campus-50 p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs font-medium uppercase text-gray-600">
                    New expiry date
                  </label>
                  <input
                    type="date"
                    value={newExpiry}
                    onChange={(e) => setNewExpiry(e.target.value)}
                    className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium uppercase text-gray-600">Cost (USD)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={cost}
                    onChange={(e) => setCost(e.target.value)}
                    className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    placeholder="500.00"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-xs font-medium uppercase text-gray-600">Notes</label>
                  <input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    placeholder="Renewed via Adobe portal"
                  />
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={submit}
                  disabled={renew.isPending}
                  className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-campus-700"
                >
                  Save renewal
                </button>
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
            >
              Record renewal
            </button>
          )
        ) : null}
        <div>
          <h3 className="text-xs font-semibold uppercase text-gray-500">
            History ({renewals.data?.length ?? 0})
          </h3>
          {(renewals.data?.length ?? 0) === 0 ? (
            <p className="mt-2 text-sm text-gray-500">No renewals yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-gray-100">
              {renewals.data?.map((r) => (
                <li key={r.id} className="py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <p className="font-medium">
                      {formatItDate(r.previousExpiryDate)} → {formatItDate(r.newExpiryDate)}
                    </p>
                    <p className="text-xs text-gray-500">
                      {formatItCurrency(r.renewalCost)} · {r.renewedByName ?? '—'}
                    </p>
                  </div>
                  <p className="text-xs text-gray-500">{formatItDateTime(r.renewedAt)}</p>
                  {r.notes ? <p className="mt-1 text-xs text-gray-700">{r.notes}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
