'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { useModerationLog } from '@/hooks/use-moderation';

const FLAG_TYPES = [
  'BLOCKED',
  'FLAGGED_FOR_REVIEW',
  'ESCALATED_TO_COUNSELLOR',
  'AUTO_APPROVED',
] as const;

const FLAG_PILL: Record<string, string> = {
  BLOCKED: 'bg-rose-100 text-rose-800',
  FLAGGED_FOR_REVIEW: 'bg-amber-100 text-amber-800',
  ESCALATED_TO_COUNSELLOR: 'bg-violet-100 text-violet-800',
  AUTO_APPROVED: 'bg-emerald-100 text-emerald-800',
};

export default function ModerationLogPage() {
  const [flagType, setFlagType] = useState<string>('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');

  const filters: { flagType?: string; fromDate?: string; toDate?: string } = {};
  if (flagType) filters.flagType = flagType;
  if (fromDate) filters.fromDate = fromDate + 'T00:00:00.000Z';
  if (toDate) filters.toDate = toDate + 'T23:59:59.999Z';

  const logQ = useModerationLog(filters);
  const rows = logQ.data ?? [];

  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader
        title="Moderation audit log"
        description="Immutable audit trail of every moderation action. Each row is a msg_moderation_log entry written by ContentModerationService.evaluate()."
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/messages/moderation"
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Policies
            </Link>
            <Link
              href="/messages/moderation/queue"
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Flagged queue
            </Link>
          </div>
        }
      />

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <select
          value={flagType}
          onChange={(e) => setFlagType(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-1.5 shadow-sm"
        >
          <option value="">All flag types</option>
          {FLAG_TYPES.map((f) => (
            <option key={f} value={f}>
              {f.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-1.5 shadow-sm"
        />
        <span className="text-gray-500">to</span>
        <input
          type="date"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-1.5 shadow-sm"
        />
      </div>

      <div className="mt-4">
        {rows.length === 0 ? (
          <EmptyState
            title="No log entries"
            description="When messages are evaluated by the moderation pipeline, log entries will appear here."
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <Th>When</Th>
                  <Th>Flag</Th>
                  <Th>Policy</Th>
                  <Th>Sender</Th>
                  <Th>Preview</Th>
                  <Th>Outcome</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => {
                  const pill = FLAG_PILL[r.flagType] ?? 'bg-gray-100 text-gray-700';
                  return (
                    <tr key={r.logId}>
                      <Td>{new Date(r.loggedAt).toLocaleString()}</Td>
                      <Td>
                        <span className={'rounded-full px-2 py-0.5 text-xs font-semibold ' + pill}>
                          {r.flagType.replace(/_/g, ' ')}
                        </span>
                      </Td>
                      <Td>{r.policyName ?? <span className="text-gray-400">—</span>}</Td>
                      <Td>{r.senderName ?? r.senderId}</Td>
                      <Td>
                        <span className="line-clamp-2 max-w-md text-gray-700">
                          {r.messagePreview ?? <span className="text-gray-400">[unavailable]</span>}
                        </span>
                      </Td>
                      <Td>
                        {r.reviewOutcome ? (
                          <span className="text-xs text-gray-700">
                            {r.reviewOutcome.replace(/_/g, ' ')}
                            {r.reviewedByName && (
                              <span className="block text-gray-500">by {r.reviewedByName}</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">Pending</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3 align-top">{children}</td>;
}
