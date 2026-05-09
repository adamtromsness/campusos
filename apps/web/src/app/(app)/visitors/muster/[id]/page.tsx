'use client';

import { useParams } from 'next/navigation';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useCloseMuster, useMusterDetail, useUpdateMusterEntry } from '@/hooks/use-visitors';
import type { MusterEntryStatus } from '@/lib/types';
import {
  DRILL_TYPE_LABEL,
  formatDateTime,
  MUSTER_ENTRY_STATUSES,
  MUSTER_ENTRY_STATUS_LABEL,
  MUSTER_ENTRY_STATUS_PILL,
} from '@/lib/visitors-format';

/**
 * /visitors/muster/[id] — accountability tracker for a single muster.
 *
 * Per-entry buttons: UNKNOWN / ACCOUNTED_FOR / EVACUATED / ASSISTANCE_NEEDED.
 * Live summary bar at the top with counts. Refreshes every 15s.
 * Close button stamps closed_at + closed_by atomically.
 */
export default function MusterDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? null;
  const detailQ = useMusterDetail(id);
  const updateEntry = useUpdateMusterEntry(id ?? '');
  const closeMuster = useCloseMuster();
  const { toast } = useToast();

  if (!id) return null;
  if (detailQ.isLoading) return <LoadingSpinner />;
  if (!detailQ.data) return null;
  const { muster, entries, summary } = detailQ.data;

  async function setStatus(entryId: string, status: MusterEntryStatus) {
    try {
      await updateEntry.mutateAsync({ entryId, payload: { status } });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  async function handleClose() {
    if (!confirm('Close this muster? Reception staff will no longer be able to mark entries.'))
      return;
    try {
      await closeMuster.mutateAsync(muster.id);
      toast('Muster closed', 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={DRILL_TYPE_LABEL[muster.drillType] + ' muster'}
        description={
          'Created ' +
          formatDateTime(muster.createdAt) +
          ' by ' +
          (muster.createdByName ?? 'staff') +
          (muster.closedAt ? ' · closed ' + formatDateTime(muster.closedAt) : ' · OPEN')
        }
      />

      {/* Summary bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <SummaryCell label="Total" value={summary.total} tone="bg-gray-100 text-gray-800" />
        <SummaryCell label="Unknown" value={summary.unknown} tone="bg-rose-100 text-rose-800" />
        <SummaryCell
          label="Accounted for"
          value={summary.accountedFor}
          tone="bg-emerald-100 text-emerald-800"
        />
        <SummaryCell label="Evacuated" value={summary.evacuated} tone="bg-sky-100 text-sky-800" />
        <SummaryCell
          label="Assistance"
          value={summary.assistanceNeeded}
          tone="bg-amber-100 text-amber-800"
        />
      </div>

      {!muster.closedAt && (
        <div className="flex justify-end">
          <button
            onClick={handleClose}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
          >
            Close muster
          </button>
        </div>
      )}

      <ul className="space-y-2">
        {entries.map((e) => (
          <li
            key={e.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3"
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium text-gray-900">{e.visitorName}</div>
              <div className="text-xs text-gray-500">
                {e.visitorType}
                {e.visitorCompany ? ' · ' + e.visitorCompany : ''}
                {e.building ? ' · ' + e.building : ''}
                {e.markedAt && (
                  <span>
                    {' '}
                    · marked {formatDateTime(e.markedAt)} by {e.markedByName ?? 'staff'}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={
                  'inline-flex rounded px-2 py-1 text-xs font-medium ' +
                  MUSTER_ENTRY_STATUS_PILL[e.status]
                }
              >
                {MUSTER_ENTRY_STATUS_LABEL[e.status]}
              </span>
              {!muster.closedAt &&
                MUSTER_ENTRY_STATUSES.filter((s) => s !== e.status).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatus(e.id, s)}
                    className="rounded border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Mark {MUSTER_ENTRY_STATUS_LABEL[s]}
                  </button>
                ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SummaryCell({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={'rounded-lg px-3 py-2 ' + tone}>
      <div className="text-xs uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}
