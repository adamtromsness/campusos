'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useNoShowAlerts, useResolveNoShow, useRunNoShowSweep } from '@/hooks/use-transport';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { NO_SHOW_RESOLUTION_LABEL } from '@/lib/transport-format';
import type { NoShowAlertDto, NoShowResolution } from '@/lib/types';

export default function NoShowsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['trn-001:admin']);

  const [showResolved, setShowResolved] = useState(false);
  const [active, setActive] = useState<NoShowAlertDto | null>(null);
  const alertsQ = useNoShowAlerts({ resolved: showResolved ? true : false });
  const sweep = useRunNoShowSweep();
  const { toast } = useToast();

  return (
    <div>
      <PageHeader
        title="No-show alerts"
        description="Students expected on a route but not scanned within the grace window"
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/transport"
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              ← Transportation
            </Link>
            {isAdmin && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    const res = await sweep.mutateAsync(undefined);
                    toast(
                      `Sweep complete: ${res.inserted} new alert${res.inserted === 1 ? '' : 's'}`,
                      'success',
                    );
                  } catch (err) {
                    toast((err as Error).message, 'error');
                  }
                }}
                disabled={sweep.isPending}
                className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
              >
                {sweep.isPending ? 'Running…' : 'Run sweep now'}
              </button>
            )}
          </div>
        }
      />

      <div className="mb-4 flex gap-2">
        <button
          type="button"
          onClick={() => setShowResolved(false)}
          className={`rounded-lg border px-3 py-1.5 text-sm ${
            showResolved
              ? 'border-gray-300 bg-white text-gray-700'
              : 'border-rose-700 bg-rose-700 text-white'
          }`}
        >
          Open
        </button>
        <button
          type="button"
          onClick={() => setShowResolved(true)}
          className={`rounded-lg border px-3 py-1.5 text-sm ${
            showResolved
              ? 'border-emerald-700 bg-emerald-700 text-white'
              : 'border-gray-300 bg-white text-gray-700'
          }`}
        >
          Resolved
        </button>
      </div>

      {alertsQ.isLoading ? (
        <LoadingSpinner />
      ) : alertsQ.data && alertsQ.data.length > 0 ? (
        <ul className="space-y-2">
          {alertsQ.data.map((a) => (
            <li
              key={a.id}
              className={`rounded-2xl border p-4 ${
                a.resolution ? 'border-emerald-200 bg-white' : 'border-rose-200 bg-rose-50'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium text-gray-900">{a.studentName ?? 'Student'}</div>
                  <div className="text-xs text-gray-500">
                    Stop: {a.expectedStopName ?? '—'} · {a.expectedDate}
                  </div>
                  <div className="text-xs text-gray-500">
                    Alert at {new Date(a.alertTime).toLocaleString()}
                  </div>
                </div>
                {a.resolution ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                    {NO_SHOW_RESOLUTION_LABEL[a.resolution]}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setActive(a)}
                    className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
                  >
                    Resolve…
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500">
          {showResolved ? 'No resolved alerts.' : 'No open no-show alerts.'}
        </p>
      )}

      {active && <ResolveModal alert={active} onClose={() => setActive(null)} />}
    </div>
  );
}

function ResolveModal({ alert, onClose }: { alert: NoShowAlertDto; onClose: () => void }) {
  const resolve = useResolveNoShow(alert.id);
  const { toast } = useToast();
  const [resolution, setResolution] = useState<NoShowResolution>('PARENT_NOTIFIED');
  const [notes, setNotes] = useState('');

  return (
    <Modal
      open
      onClose={onClose}
      title="Resolve no-show alert"
      footer={
        <button
          type="button"
          onClick={async () => {
            try {
              await resolve.mutateAsync({ resolution, resolutionNotes: notes || undefined });
              toast('Alert resolved', 'success');
              onClose();
            } catch (err) {
              toast((err as Error).message, 'error');
            }
          }}
          disabled={resolve.isPending}
          className="rounded-lg bg-campus-700 px-3 py-2 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
        >
          {resolve.isPending ? 'Saving…' : 'Save resolution'}
        </button>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="rounded-lg bg-gray-50 p-3">
          <div className="font-medium">{alert.studentName ?? 'Student'}</div>
          <div className="text-xs text-gray-500">
            {alert.expectedStopName ?? '—'} · {alert.expectedDate}
          </div>
        </div>
        <fieldset>
          <legend className="block font-medium text-gray-700">Resolution</legend>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {(['ABSENT_CONFIRMED', 'LATE_ARRIVAL', 'PARENT_NOTIFIED', 'FALSE_ALARM'] as const).map(
              (r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setResolution(r)}
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    resolution === r
                      ? 'border-campus-700 bg-campus-700 text-white'
                      : 'border-gray-300 bg-white text-gray-700'
                  }`}
                >
                  {NO_SHOW_RESOLUTION_LABEL[r]}
                </button>
              ),
            )}
          </div>
        </fieldset>
        <label className="block">
          <span className="block font-medium text-gray-700">Notes</span>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
    </Modal>
  );
}
