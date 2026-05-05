'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { useWellbeingCheckin, useWellbeingCheckins } from '@/hooks/use-wellbeing';
import { DOMAIN_LABELS, DOMAIN_PILL, formatRelative } from '@/lib/wellbeing-format';

/**
 * /wellbeing/history — Student response history.
 *
 * Read-only view of own completed check-ins, newest first. Click any
 * row to see the response detail. Students intentionally do NOT see
 * `flagged_for_follow_up` or alert status — the counsellor initiates
 * any follow-up conversation naturally without surfacing the technical
 * flag to the student.
 */
export default function StudentWellbeingHistoryPage() {
  const completedQ = useWellbeingCheckins({ pending: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const completed = (completedQ.data ?? [])
    .slice()
    .sort(
      (a, b) =>
        new Date(b.completedAt ?? b.createdAt).getTime() -
        new Date(a.completedAt ?? a.createdAt).getTime(),
    );

  return (
    <div className="space-y-6">
      <PageHeader
        title="My check-in history"
        description="Your completed wellbeing check-ins. Tap a row to see your responses."
      />

      <div className="text-sm">
        <Link href="/wellbeing" className="text-campus-700 hover:underline">
          ← Back to wellbeing
        </Link>
      </div>

      {completedQ.isLoading ? (
        <LoadingSpinner />
      ) : completed.length === 0 ? (
        <EmptyState
          title="No check-ins yet"
          description="Once you complete a check-in, it'll show up here."
        />
      ) : (
        <ul className="space-y-2">
          {completed.map((c) => {
            const open = selectedId === c.id;
            return (
              <li key={c.id} id={c.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(open ? null : c.id)}
                  className={cn(
                    'flex w-full items-baseline justify-between rounded-md border p-4 text-left transition',
                    open
                      ? 'border-campus-300 bg-campus-50/50'
                      : 'border-gray-200 bg-white hover:border-campus-300',
                  )}
                >
                  <div>
                    <div className="text-sm font-semibold text-gray-900">{c.templateName}</div>
                    <div className="mt-1 text-xs text-gray-500">
                      Completed {formatRelative(c.completedAt)}
                    </div>
                  </div>
                  <span className="text-xs font-medium text-campus-700">
                    {open ? 'Hide' : 'View →'}
                  </span>
                </button>
                {open ? <CheckinResponses checkinId={c.id} /> : null}
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-gray-500">
        Your counsellor sees your responses to support you. Teachers and parents do not see
        wellbeing check-in content.
      </p>
    </div>
  );
}

function CheckinResponses({ checkinId }: { checkinId: string }) {
  const ckinQ = useWellbeingCheckin(checkinId);
  if (ckinQ.isLoading || !ckinQ.data) {
    return (
      <div className="mt-2 rounded-md border border-gray-200 bg-white p-4">
        <LoadingSpinner />
      </div>
    );
  }
  const responses = ckinQ.data.responses ?? [];
  if (responses.length === 0) {
    return (
      <div className="mt-2 rounded-md border border-gray-200 bg-white p-4 text-sm text-gray-500">
        No responses recorded.
      </div>
    );
  }
  return (
    <ol className="mt-2 space-y-2 rounded-md border border-gray-200 bg-white p-4">
      {responses.map((r) => (
        <li key={r.id} className="rounded-md bg-gray-50 p-3">
          <div className="text-xs text-gray-500">Response</div>
          <div className="mt-1 text-sm text-gray-900">
            {r.numericResponse !== null ? (
              <span className="font-mono">{r.numericResponse}</span>
            ) : null}
            {r.textResponse ? <span>{r.textResponse}</span> : null}
            {r.numericResponse === null && !r.textResponse ? (
              <span className="text-gray-400">—</span>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

// Suppress unused imports warning — kept for future expansion.
void DOMAIN_LABELS;
void DOMAIN_PILL;
