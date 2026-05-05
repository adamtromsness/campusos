'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useAcknowledgeWellbeingAlert,
  useResolveWellbeingAlert,
  useWellbeingAlerts,
} from '@/hooks/use-wellbeing';
import {
  ALERT_STATUSES,
  ALERT_STATUS_LABELS,
  ALERT_STATUS_PILL,
  ALERT_TYPE_LABELS,
  ALERT_TYPE_PILL,
  alertSeverityRank,
  formatRelative,
} from '@/lib/wellbeing-format';
import type { WellbeingAlertDto, WellbeingAlertStatus } from '@/lib/types';

const STATUS_FILTERS: Array<{ key: WellbeingAlertStatus | 'OPEN' | 'ALL'; label: string }> = [
  { key: 'OPEN', label: 'Open' },
  { key: 'NEW', label: 'New' },
  { key: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { key: 'IN_PROGRESS', label: 'In progress' },
  { key: 'RESOLVED', label: 'Resolved' },
  { key: 'ALL', label: 'All' },
];

export default function WellbeingAlertQueuePage() {
  const [filter, setFilter] = useState<WellbeingAlertStatus | 'OPEN' | 'ALL'>('OPEN');
  const [resolveTarget, setResolveTarget] = useState<WellbeingAlertDto | null>(null);
  const [resolveNotes, setResolveNotes] = useState('');

  const status = filter === 'OPEN' || filter === 'ALL' ? undefined : filter;
  const alertsQ = useWellbeingAlerts(status ? { status } : {});
  const ack = useAcknowledgeWellbeingAlert();
  const resolve = useResolveWellbeingAlert();
  const { toast } = useToast();

  const list = (alertsQ.data ?? []).slice().sort((a, b) => {
    const r = alertSeverityRank(a.alertType) - alertSeverityRank(b.alertType);
    if (r !== 0) return r;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  const filtered =
    filter === 'OPEN'
      ? list.filter(
          (a) => a.status === 'NEW' || a.status === 'ACKNOWLEDGED' || a.status === 'IN_PROGRESS',
        )
      : list;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Wellbeing alerts"
        description="Severity-sorted queue. SELF_HARM_INDICATOR alerts auto-escalate to administrators on creation."
      />

      <div className="text-sm">
        <Link href="/counselling/wellbeing" className="text-campus-700 hover:underline">
          ← Wellbeing dashboard
        </Link>
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium ring-1',
              filter === f.key
                ? 'bg-campus-600 text-white ring-campus-700'
                : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {alertsQ.isLoading ? (
        <LoadingSpinner />
      ) : filtered.length === 0 ? (
        <EmptyState title="No alerts" description="Nothing matches the current filter." />
      ) : (
        <ul className="space-y-2">
          {filtered.map((a) => (
            <li
              key={a.id}
              className={cn(
                'rounded-md border p-3',
                a.alertType === 'SELF_HARM_INDICATOR'
                  ? 'border-rose-300 bg-rose-50/40'
                  : 'border-gray-200 bg-white',
              )}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      ALERT_TYPE_PILL[a.alertType],
                    )}
                  >
                    {ALERT_TYPE_LABELS[a.alertType]}
                  </span>
                  <span className="text-sm font-semibold text-gray-900">
                    {a.studentName ?? '—'}
                  </span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      ALERT_STATUS_PILL[a.status],
                    )}
                  >
                    {ALERT_STATUS_LABELS[a.status]}
                  </span>
                </div>
                <span className="text-xs text-gray-500">{formatRelative(a.createdAt)}</span>
              </div>
              {a.questionText ? (
                <div className="mt-2 text-sm text-gray-700">
                  <span className="font-medium">Q:</span> {a.questionText}
                </div>
              ) : null}
              {a.responsePreview ? (
                <div className="mt-1 text-sm text-gray-700">
                  <span className="font-medium">A:</span>{' '}
                  <span className="font-mono">{a.responsePreview}</span>
                </div>
              ) : null}
              {a.resolutionNotes ? (
                <div className="mt-2 rounded-md bg-emerald-50 p-2 text-xs text-emerald-900 ring-1 ring-emerald-200">
                  <strong>Resolution:</strong> {a.resolutionNotes}
                </div>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {a.status === 'NEW' ? (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await ack.mutateAsync(a.id);
                        toast('Alert acknowledged', 'success');
                      } catch (err) {
                        toast(
                          err instanceof Error ? err.message : 'Failed to acknowledge',
                          'error',
                        );
                      }
                    }}
                    className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700"
                  >
                    Acknowledge
                  </button>
                ) : null}
                {a.status !== 'RESOLVED' ? (
                  <button
                    type="button"
                    onClick={() => {
                      setResolveTarget(a);
                      setResolveNotes('');
                    }}
                    className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700"
                  >
                    Resolve…
                  </button>
                ) : null}
                {a.acknowledgedByName ? (
                  <span className="text-xs text-gray-500">
                    Last action by {a.acknowledgedByName} · {formatRelative(a.acknowledgedAt)}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Resolve modal */}
      {resolveTarget ? (
        <Modal
          open={!!resolveTarget}
          onClose={() => setResolveTarget(null)}
          title={'Resolve alert · ' + (resolveTarget.studentName ?? '')}
          footer={
            <>
              <button
                type="button"
                onClick={() => setResolveTarget(null)}
                className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!resolveNotes.trim() || resolveNotes.trim().length < 5}
                onClick={async () => {
                  try {
                    await resolve.mutateAsync({
                      id: resolveTarget.id,
                      payload: { resolutionNotes: resolveNotes.trim() },
                    });
                    toast('Alert resolved', 'success');
                    setResolveTarget(null);
                  } catch (err) {
                    toast(err instanceof Error ? err.message : 'Failed to resolve', 'error');
                  }
                }}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Resolve
              </button>
            </>
          }
        >
          <div className="space-y-3">
            <p className="text-sm text-gray-700">
              <span className="font-medium">{ALERT_TYPE_LABELS[resolveTarget.alertType]}</span> ·{' '}
              {resolveTarget.questionText}
            </p>
            {resolveTarget.alertType === 'SELF_HARM_INDICATOR' ? (
              <p className="rounded-md bg-rose-50 p-2 text-xs text-rose-900 ring-1 ring-rose-200">
                <strong>SELF_HARM_INDICATOR</strong> alerts auto-escalate to admin on creation. Make
                sure you have followed your school&apos;s safety-plan protocol before resolving.
              </p>
            ) : null}
            <div>
              <label className="text-xs font-medium text-gray-700">
                Resolution notes (required)
              </label>
              <textarea
                value={resolveNotes}
                onChange={(e) => setResolveNotes(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="What happened, what you did, and any follow-up actions…"
                className="mt-1 w-full rounded-md border border-gray-300 p-2 text-sm"
              />
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

// Suppress unused-status import; ALERT_STATUSES is used by the filter chip array indirectly via type narrowing
void ALERT_STATUSES;
