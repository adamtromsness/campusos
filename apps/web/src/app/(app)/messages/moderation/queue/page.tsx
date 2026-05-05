'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { useModerationQueue, useReviewModerationLog } from '@/hooks/use-moderation';
import type { ModerationQueueRowDto, ModerationReviewOutcome } from '@/lib/types';

const FLAG_PILL: Record<string, string> = {
  BLOCKED: 'bg-rose-100 text-rose-800',
  FLAGGED_FOR_REVIEW: 'bg-amber-100 text-amber-800',
  ESCALATED_TO_COUNSELLOR: 'bg-violet-100 text-violet-800',
  AUTO_APPROVED: 'bg-emerald-100 text-emerald-800',
};

export default function ModerationQueuePage() {
  const queueQ = useModerationQueue();
  const rows = queueQ.data ?? [];

  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader
        title="Flagged messages"
        description="Messages whose moderation status is BLOCKED, FLAGGED_FOR_REVIEW, or ESCALATED_TO_COUNSELLOR and that have not yet been reviewed. RELEASE makes a flagged message visible again."
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/messages/moderation"
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Policies
            </Link>
            <Link
              href="/messages/moderation/log"
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Audit log
            </Link>
          </div>
        }
      />

      <div className="mt-4 space-y-3">
        {rows.length === 0 ? (
          <EmptyState
            title="No messages awaiting review"
            description="Flagged messages from the content moderation pipeline will appear here for review."
          />
        ) : (
          rows.map((r) => <QueueRow key={r.logId} row={r} />)
        )}
      </div>
    </div>
  );
}

function QueueRow({ row }: { row: ModerationQueueRowDto }) {
  const [reviewOpen, setReviewOpen] = useState<ModerationReviewOutcome | null>(null);
  const review = useReviewModerationLog(row.logId);
  const pill = FLAG_PILL[row.flagType] ?? 'bg-gray-100 text-gray-700';

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={'rounded-full px-2 py-0.5 text-xs font-semibold ' + pill}>
              {row.flagType.replace(/_/g, ' ')}
            </span>
            <span className="text-xs text-gray-500">
              Policy: {row.policyName ?? row.policyId} · Severity {row.severity}
            </span>
          </div>
          <p className="mt-2 text-sm text-gray-700">
            {row.messagePreview ?? <em className="text-gray-400">[message body not available]</em>}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <span>From {row.senderName ?? row.senderId}</span>
            <span>·</span>
            <span>{new Date(row.loggedAt).toLocaleString()}</span>
            {row.threadId && (
              <>
                <span>·</span>
                <Link
                  href={'/messages/' + row.threadId}
                  className="text-campus-700 hover:underline"
                >
                  Open thread
                </Link>
              </>
            )}
          </div>
          {row.matchedKeywords.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {row.matchedKeywords.map((kw) => (
                <span
                  key={kw}
                  className="rounded bg-rose-50 px-2 py-0.5 font-mono text-xs text-rose-800"
                >
                  {kw}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <button
            type="button"
            onClick={() => setReviewOpen('RELEASED')}
            className="rounded-md border border-emerald-700 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-100"
          >
            Release
          </button>
          <button
            type="button"
            onClick={() => setReviewOpen('CONFIRMED_BLOCK')}
            className="rounded-md border border-rose-700 bg-rose-50 px-3 py-1.5 text-sm font-semibold text-rose-800 hover:bg-rose-100"
          >
            Confirm block
          </button>
        </div>
      </div>
      {reviewOpen && (
        <ReviewModal
          outcome={reviewOpen}
          onClose={() => setReviewOpen(null)}
          onSubmit={async (notes) => {
            await review.mutateAsync({ outcome: reviewOpen, notes });
            setReviewOpen(null);
          }}
          pending={review.isPending}
        />
      )}
    </div>
  );
}

function ReviewModal({
  outcome,
  onClose,
  onSubmit,
  pending,
}: {
  outcome: ModerationReviewOutcome;
  onClose: () => void;
  onSubmit: (notes: string | undefined) => Promise<void>;
  pending: boolean;
}) {
  const [notes, setNotes] = useState('');
  const isRelease = outcome === 'RELEASED';
  return (
    <Modal
      open
      onClose={onClose}
      title={isRelease ? 'Release this message?' : 'Confirm block?'}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(notes || undefined)}
            disabled={pending}
            className={
              'rounded-md px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-60 ' +
              (isRelease ? 'bg-emerald-700 hover:bg-emerald-800' : 'bg-rose-700 hover:bg-rose-800')
            }
          >
            {pending ? 'Saving…' : isRelease ? 'Release' : 'Confirm block'}
          </button>
        </div>
      }
    >
      <p className="text-sm text-gray-700">
        {isRelease
          ? 'Releasing makes the message visible to its recipient and stamps the audit log with RELEASED.'
          : 'Confirming the block keeps the message hidden and stamps the audit log with CONFIRMED_BLOCK.'}
      </p>
      <label className="mt-3 block text-sm font-medium text-gray-700">Notes (optional)</label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        maxLength={2000}
        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-campus-700 focus:outline-none focus:ring-1 focus:ring-campus-700"
        placeholder="Optional context for the audit log."
      />
    </Modal>
  );
}
