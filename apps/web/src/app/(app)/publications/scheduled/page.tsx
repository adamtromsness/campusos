'use client';

import { PageHeader, EmptyState } from '@/components/ui';
import { useScheduledPublications } from '@/hooks/use-publications';
import {
  SCHEDULED_STATUS_LABELS,
  SCHEDULED_STATUS_PILL,
  formatCountdown,
  formatDateTime,
} from '@/lib/publications-format';

export default function ScheduledPublicationsPage() {
  const scheduledQ = useScheduledPublications();
  const rows = scheduledQ.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Scheduled Publications"
        description="Publications queued for automatic publishing. The worker fires every minute."
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No scheduled publications"
          description="Schedule a publication from its detail page to add it to the queue."
        />
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
            <tr>
              <th className="pb-2 pr-3">Publication</th>
              <th className="pb-2 pr-3">When</th>
              <th className="pb-2 pr-3">Status</th>
              <th className="pb-2 pr-3">Worker attempts</th>
              <th className="pb-2 pr-3">Scheduled by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-b border-gray-100">
                <td className="py-2 pr-3">
                  <p className="font-semibold text-campus-700">
                    {s.publicationTitle ?? 'Untitled publication'}
                  </p>
                  <p className="text-xs text-gray-500">{s.publicationId}</p>
                </td>
                <td className="py-2 pr-3">
                  <p>{formatDateTime(s.scheduledAt)}</p>
                  {s.status === 'SCHEDULED' && (
                    <p className="text-xs text-amber-700">{formatCountdown(s.scheduledAt)}</p>
                  )}
                  {s.status === 'PUBLISHED' && s.publishedAt && (
                    <p className="text-xs text-emerald-700">
                      Published {formatDateTime(s.publishedAt)}
                    </p>
                  )}
                  {s.status === 'CANCELLED' && s.cancelledAt && (
                    <p className="text-xs text-gray-500">
                      Cancelled {formatDateTime(s.cancelledAt)}
                    </p>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <span
                    className={
                      'inline-block rounded px-2 py-0.5 text-xs font-semibold ' +
                      SCHEDULED_STATUS_PILL[s.status]
                    }
                  >
                    {SCHEDULED_STATUS_LABELS[s.status]}
                  </span>
                </td>
                <td className="py-2 pr-3 text-xs text-gray-600">
                  {s.workerAttempts > 0 ? (
                    <span title={s.lastError ?? ''}>
                      {s.workerAttempts} attempt(s){' '}
                      {s.lastError && <span className="text-rose-700">· error</span>}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="py-2 pr-3 text-xs text-gray-600">
                  {s.scheduledByName ?? s.scheduledById}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
