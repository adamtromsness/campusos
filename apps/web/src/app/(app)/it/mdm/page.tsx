'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useItMdmAlerts, useItMdmSyncs, useResolveItMdmAlert } from '@/hooks/use-it';
import { IT_MDM_ALERT_LABELS, IT_MDM_ALERT_PILL, formatItDateTime } from '@/lib/it-format';

export default function MdmPage() {
  const [unresolvedOnly, setUnresolvedOnly] = useState(true);
  const alerts = useItMdmAlerts(unresolvedOnly);
  const syncs = useItMdmSyncs();
  const resolve = useResolveItMdmAlert();
  const { toast } = useToast();

  const [resolveTarget, setResolveTarget] = useState<{ id: string; assetTag: string } | null>(null);
  const [notes, setNotes] = useState('');

  async function submitResolve() {
    if (!resolveTarget) return;
    try {
      await resolve.mutateAsync({
        id: resolveTarget.id,
        body: { resolutionNotes: notes || undefined },
      });
      toast(`Alert resolved · ${resolveTarget.assetTag}`);
      setResolveTarget(null);
      setNotes('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not resolve', 'error');
    }
  }

  const compliantCount = syncs.data?.filter((s) => s.isCompliant).length ?? 0;
  const totalSyncs = syncs.data?.length ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <PageHeader
        title="MDM Compliance"
        description="Mobile Device Management — Google Workspace, Apple Business, Intune, Jamf"
      />
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Recent syncs" value={totalSyncs} />
        <Stat
          label="Compliant"
          value={compliantCount}
          tone={compliantCount === totalSyncs ? 'emerald' : 'amber'}
        />
        <Stat
          label="Open alerts"
          value={alerts.data?.filter((a) => !a.isResolved).length ?? 0}
          tone="amber"
        />
      </div>

      <section className="rounded-md border border-gray-200 bg-white p-4">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">Alerts</h2>
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={unresolvedOnly}
              onChange={(e) => setUnresolvedOnly(e.target.checked)}
            />
            Only unresolved
          </label>
        </header>
        {(alerts.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">No alerts.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {alerts.data?.map((a) => (
              <li key={a.id} className="flex items-center justify-between py-2">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{a.assetTag}</p>
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${IT_MDM_ALERT_PILL[a.alertType]}`}
                    >
                      {IT_MDM_ALERT_LABELS[a.alertType]}
                    </span>
                  </div>
                  {a.alertDetail ? (
                    <p className="mt-1 text-xs text-gray-600">{a.alertDetail}</p>
                  ) : null}
                  <p className="text-xs text-gray-500">
                    First detected {formatItDateTime(a.firstDetectedAt)}
                  </p>
                </div>
                {!a.isResolved ? (
                  <button
                    type="button"
                    onClick={() => setResolveTarget({ id: a.id, assetTag: a.assetTag })}
                    className="rounded-md bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-700"
                  >
                    Resolve
                  </button>
                ) : (
                  <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                    Resolved
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-md border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Recent syncs</h2>
        {(syncs.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">No syncs recorded.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {syncs.data?.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-2">
                <div>
                  <p className="font-medium">{s.assetTag}</p>
                  <p className="text-xs text-gray-500">
                    {s.mdmProvider} · {s.deviceName ?? 'unnamed'} · OS {s.osVersion ?? '—'}
                  </p>
                  <p className="text-xs text-gray-500">Synced {formatItDateTime(s.syncAt)}</p>
                </div>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    s.isCompliant ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
                  }`}
                >
                  {s.isCompliant ? 'Compliant' : 'Non-compliant'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={!!resolveTarget}
        onClose={() => setResolveTarget(null)}
        title={`Resolve alert · ${resolveTarget?.assetTag ?? ''}`}
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setResolveTarget(null)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitResolve}
              disabled={resolve.isPending}
              className="rounded-md bg-emerald-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              {resolve.isPending ? 'Resolving…' : 'Resolve'}
            </button>
          </div>
        }
      >
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          maxLength={1000}
          placeholder="Optional resolution notes"
          className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
        />
      </Modal>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'emerald' | 'amber' | 'rose';
}) {
  const colours: Record<NonNullable<typeof tone>, string> = {
    emerald: 'text-emerald-700',
    amber: 'text-amber-700',
    rose: 'text-rose-700',
  };
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-2xl font-semibold ${tone ? colours[tone] : 'text-gray-900'}`}>{value}</p>
    </div>
  );
}
