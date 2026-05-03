'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useAddApprovalComment,
  useApproval,
  useApproveStep,
  useRejectStep,
  useWithdrawApproval,
} from '@/hooks/use-approvals';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  REQUEST_STATUS_LABELS,
  REQUEST_STATUS_PILL,
  STEP_STATUS_LABELS,
  STEP_STATUS_PILL,
} from '@/lib/approvals-format';
import type { ApprovalStepDto } from '@/lib/types';

export default function ApprovalDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['ops-001:admin', 'sch-001:admin']);
  const canApprovals = !!user && hasAnyPermission(user, ['ops-001:read']);

  const approval = useApproval(id, canApprovals);
  const withdraw = useWithdrawApproval(id ?? '');
  const addComment = useAddApprovalComment(id ?? '');
  const { toast } = useToast();

  const [reviewing, setReviewing] = useState<{
    step: ApprovalStepDto;
    decision: 'APPROVE' | 'REJECT';
  } | null>(null);
  const [commentBody, setCommentBody] = useState('');
  const [commentInternal, setCommentInternal] = useState(false);

  if (!user) return null;
  if (!canApprovals) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Approval" />
        <EmptyState title="Access required" description="You need OPS-001 read access." />
      </div>
    );
  }

  if (approval.isLoading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-gray-500">
        <LoadingSpinner size="sm" /> Loading…
      </div>
    );
  }
  if (approval.isError || !approval.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Approval" />
        <EmptyState
          title="Approval not found"
          description="It may have been deleted or you don't have access."
        />
      </div>
    );
  }

  const r = approval.data;
  const isRequester = r.requesterId === user.id;
  const sortedSteps = [...r.steps].sort((a, b) => a.stepOrder - b.stepOrder);
  const myAwaitingStep = sortedSteps.find(
    (s) => s.status === 'AWAITING' && (s.approverId === user.id || isAdmin),
  );

  async function onWithdraw() {
    if (!window.confirm('Withdraw this request?')) return;
    try {
      await withdraw.mutateAsync();
      toast('Request withdrawn', 'success');
    } catch (e: any) {
      toast(e?.message || 'Could not withdraw', 'error');
    }
  }

  async function onComment() {
    if (!commentBody.trim()) return;
    try {
      await addComment.mutateAsync({
        body: commentBody.trim(),
        isRequesterVisible: !commentInternal,
      });
      setCommentBody('');
      setCommentInternal(false);
      toast('Comment posted', 'success');
    } catch (e: any) {
      toast(e?.message || 'Could not post', 'error');
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={r.requestType}
        actions={
          <Link href="/approvals" className="text-sm text-campus-700 hover:text-campus-900">
            ← Back
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span
          className={cn(
            'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
            REQUEST_STATUS_PILL[r.status],
          )}
        >
          {REQUEST_STATUS_LABELS[r.status]}
        </span>
        <span className="text-xs text-gray-500">
          template: <strong>{r.templateName}</strong>
        </span>
        {r.referenceTable && r.referenceId && (
          <span className="text-xs text-gray-500">
            ref: <span className="font-mono">{r.referenceTable}</span>{' '}
            <span className="font-mono">{r.referenceId.slice(0, 8)}…</span>
          </span>
        )}
      </div>

      <section className="mb-6 rounded-card border border-gray-200 bg-white p-6 shadow-card">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-gray-500">Requester</p>
            <p className="mt-1 font-medium text-gray-900">{r.requesterName ?? '—'}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-gray-500">Submitted</p>
            <p className="mt-1 text-gray-900">{new Date(r.submittedAt).toLocaleString()}</p>
          </div>
          {r.resolvedAt && (
            <div className="col-span-2">
              <p className="text-[10px] uppercase tracking-wide text-gray-500">Resolved</p>
              <p className="mt-1 text-gray-900">{new Date(r.resolvedAt).toLocaleString()}</p>
            </div>
          )}
        </div>
        {isRequester && r.status === 'PENDING' && (
          <div className="mt-4 border-t border-gray-100 pt-4">
            <button
              type="button"
              onClick={onWithdraw}
              disabled={withdraw.isPending}
              className="rounded-lg border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50"
            >
              Withdraw request
            </button>
          </div>
        )}
      </section>

      <section className="mb-6 rounded-card border border-gray-200 bg-white p-6 shadow-card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
          Step timeline
        </h2>
        <ol className="mt-3 space-y-3">
          {sortedSteps.map((s) => (
            <li
              key={s.id}
              className={cn(
                'relative rounded-lg border border-gray-200 bg-white p-3',
                s.status === 'AWAITING' && 'border-amber-300 bg-amber-50',
              )}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-gray-900">
                  Step {s.stepOrder}: {s.approverName ?? '—'}
                </p>
                <span
                  className={cn(
                    'inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium',
                    STEP_STATUS_PILL[s.status],
                  )}
                >
                  {STEP_STATUS_LABELS[s.status]}
                </span>
              </div>
              {s.actionedAt && (
                <p className="mt-1 text-xs text-gray-500">
                  {new Date(s.actionedAt).toLocaleString()}
                </p>
              )}
              {s.comments && (
                <p className="mt-1 italic text-xs text-gray-700">&ldquo;{s.comments}&rdquo;</p>
              )}
              {s.status === 'AWAITING' && (s.approverId === user.id || isAdmin) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setReviewing({ step: s, decision: 'APPROVE' })}
                    className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-600"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => setReviewing({ step: s, decision: 'REJECT' })}
                    className="rounded-lg border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50"
                  >
                    Reject
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
        {myAwaitingStep === undefined && r.status === 'PENDING' && (
          <p className="mt-3 text-xs text-gray-500">
            Waiting on the assigned approver. You don&rsquo;t have an action on this step.
          </p>
        )}
      </section>

      <section className="rounded-card border border-gray-200 bg-white p-6 shadow-card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">Comments</h2>
        {r.comments.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No comments yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {r.comments.map((c) => (
              <li
                key={c.id}
                className={cn(
                  'rounded-lg border border-gray-200 bg-white p-3',
                  !c.isRequesterVisible && 'border-amber-200 bg-amber-50',
                )}
              >
                <div className="flex items-baseline justify-between gap-2 text-xs text-gray-500">
                  <span>
                    <strong className="text-gray-700">{c.authorName ?? '—'}</strong>
                    {!c.isRequesterVisible && (
                      <span className="ml-2 rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">
                        Internal
                      </span>
                    )}
                  </span>
                  <span>{new Date(c.createdAt).toLocaleString()}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{c.body}</p>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 border-t border-gray-100 pt-4">
          <textarea
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Add a comment…"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            {!isRequester && (
              <label className="inline-flex items-center gap-2 text-xs text-gray-700">
                <input
                  type="checkbox"
                  checked={commentInternal}
                  onChange={(e) => setCommentInternal(e.target.checked)}
                  className="rounded border-gray-300 text-campus-600 focus:ring-campus-500"
                />
                Internal only — hide from requester
              </label>
            )}
            <button
              type="button"
              onClick={onComment}
              disabled={!commentBody.trim() || addComment.isPending}
              className="ml-auto rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
            >
              Post comment
            </button>
          </div>
        </div>
      </section>

      {reviewing && (
        <ReviewStepModal
          requestId={r.id}
          step={reviewing.step}
          decision={reviewing.decision}
          onClose={() => setReviewing(null)}
        />
      )}
    </div>
  );
}

function ReviewStepModal({
  requestId,
  step,
  decision,
  onClose,
}: {
  requestId: string;
  step: ApprovalStepDto;
  decision: 'APPROVE' | 'REJECT';
  onClose: () => void;
}) {
  const [comments, setComments] = useState('');
  const approve = useApproveStep(requestId, step.id);
  const reject = useRejectStep(requestId, step.id);
  const { toast } = useToast();
  const pending = approve.isPending || reject.isPending;

  async function submit() {
    try {
      const payload = comments.trim() ? { comments: comments.trim() } : {};
      if (decision === 'APPROVE') {
        await approve.mutateAsync(payload);
        toast('Step approved', 'success');
      } else {
        await reject.mutateAsync(payload);
        toast('Step rejected', 'success');
      }
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not save', 'error');
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={
        decision === 'APPROVE' ? 'Approve step ' + step.stepOrder : 'Reject step ' + step.stepOrder
      }
      size="md"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors disabled:opacity-50',
              decision === 'APPROVE'
                ? 'bg-emerald-700 hover:bg-emerald-600'
                : 'bg-rose-700 hover:bg-rose-600',
            )}
          >
            {decision === 'APPROVE' ? 'Approve' : 'Reject'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-gray-700">
          {decision === 'APPROVE'
            ? 'Approving advances the request to the next step (if any) or resolves it as APPROVED.'
            : 'Rejecting resolves the request as REJECTED. Remaining steps are skipped.'}
        </p>
        <textarea
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          rows={3}
          maxLength={2000}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          placeholder="Optional reviewer comment…"
        />
      </div>
    </Modal>
  );
}
