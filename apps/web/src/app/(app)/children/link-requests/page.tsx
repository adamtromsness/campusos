'use client';

import { useState } from 'react';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useApproveChildLinkRequest,
  useChildLinkRequests,
  useRejectChildLinkRequest,
} from '@/hooks/use-children';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import type { ChildLinkRequestDto, ChildLinkRequestStatus } from '@/lib/types';

export default function ChildLinkRequestsPage() {
  const user = useAuthStore((s) => s.user);
  const [status, setStatus] = useState<ChildLinkRequestStatus>('PENDING');
  const requests = useChildLinkRequests(status, !!user);
  const [reviewing, setReviewing] = useState<{
    request: ChildLinkRequestDto;
    action: 'approve' | 'reject';
  } | null>(null);

  if (!user) return null;
  const isAdmin = hasAnyPermission(user, ['stu-001:admin', 'sch-001:admin']);
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="Child link requests" />
        <EmptyState
          title="Admin only"
          description="This queue is visible to school administrators only."
        />
      </div>
    );
  }

  const list = requests.data ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Child link requests"
        description="Guardian-submitted requests to link existing students or add new children. Approve to activate the link; reject if the relationship can't be confirmed."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {(['PENDING', 'APPROVED', 'REJECTED'] as ChildLinkRequestStatus[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              status === s
                ? 'border-campus-700 bg-campus-700 text-white'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50',
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {requests.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title={`No ${status.toLowerCase()} requests`}
          description="Once parents submit Add Child requests, they will appear here for review."
        />
      ) : (
        <div className="space-y-3">
          {list.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              onApprove={() => setReviewing({ request: r, action: 'approve' })}
              onReject={() => setReviewing({ request: r, action: 'reject' })}
            />
          ))}
        </div>
      )}

      {reviewing && (
        <ReviewModal
          request={reviewing.request}
          action={reviewing.action}
          onClose={() => setReviewing(null)}
        />
      )}
    </div>
  );
}

function RequestRow({
  request,
  onApprove,
  onReject,
}: {
  request: ChildLinkRequestDto;
  onApprove: () => void;
  onReject: () => void;
}) {
  const subject =
    request.requestType === 'LINK_EXISTING'
      ? `Link to ${request.existingStudentName ?? 'student'}`
      : `Add ${request.newChildFirstName ?? ''} ${request.newChildLastName ?? ''}`;
  return (
    <div className="rounded-card border border-gray-200 bg-white p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">{subject}</p>
          <p className="text-xs text-gray-500">
            Requested by {request.requestingGuardianName ?? '—'} ·{' '}
            {new Date(request.createdAt).toLocaleString()}
          </p>
          {request.requestType === 'ADD_NEW' && (
            <p className="mt-1 text-xs text-gray-700">
              DOB {request.newChildDateOfBirth ?? '—'} · Grade {request.newChildGradeLevel ?? '—'}
              {request.newChildGender ? ` · ${request.newChildGender}` : ''}
            </p>
          )}
          <span
            className={cn(
              'mt-2 inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
              request.status === 'PENDING' && 'bg-amber-100 text-amber-800',
              request.status === 'APPROVED' && 'bg-emerald-100 text-emerald-800',
              request.status === 'REJECTED' && 'bg-rose-100 text-rose-800',
            )}
          >
            {request.status}
          </span>
          {request.reviewerNotes && (
            <p className="mt-1 text-xs italic text-gray-600">Notes: {request.reviewerNotes}</p>
          )}
        </div>
        {request.status === 'PENDING' && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onApprove}
              className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-600"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={onReject}
              className="rounded-lg border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50"
            >
              Reject
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewModal({
  request,
  action,
  onClose,
}: {
  request: ChildLinkRequestDto;
  action: 'approve' | 'reject';
  onClose: () => void;
}) {
  const [notes, setNotes] = useState('');
  const approve = useApproveChildLinkRequest();
  const reject = useRejectChildLinkRequest();
  const { toast } = useToast();
  const pending = approve.isPending || reject.isPending;

  async function submit() {
    try {
      const payload = notes.trim() ? { reviewerNotes: notes.trim() } : {};
      if (action === 'approve') {
        await approve.mutateAsync({ id: request.id, payload });
        toast('Request approved', 'success');
      } else {
        await reject.mutateAsync({ id: request.id, payload });
        toast('Request rejected', 'success');
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
      title={action === 'approve' ? 'Approve link request' : 'Reject link request'}
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
              action === 'approve'
                ? 'bg-emerald-700 hover:bg-emerald-600'
                : 'bg-rose-700 hover:bg-rose-600',
            )}
          >
            {action === 'approve' ? 'Approve' : 'Reject'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-gray-700">
          {action === 'approve'
            ? 'Approving will create the parent-child link and, for new-child requests, will create the student record.'
            : 'Rejecting will close this request without making any changes. The parent can submit a new request later.'}
        </p>
        <label className="block">
          <span className="font-medium text-gray-700">Reviewer notes (optional)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </label>
      </div>
    </Modal>
  );
}
