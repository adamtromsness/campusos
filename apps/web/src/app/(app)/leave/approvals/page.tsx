'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useApproveLeaveRequest, useLeaveRequests, useRejectLeaveRequest } from '@/hooks/use-hr';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import type { LeaveRequestDto } from '@/lib/types';

type Pending = LeaveRequestDto & { status: 'PENDING' };

export default function LeaveApprovalsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sch-001:admin']);
  const requests = useLeaveRequests({ status: 'PENDING' }, isAdmin);
  const [reviewing, setReviewing] = useState<{ req: Pending; mode: 'approve' | 'reject' } | null>(
    null,
  );

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Leave Approvals" description="Approving leave requests is admin-only." />
        <EmptyState
          title="Admin access required"
          description="Ask a school admin to review pending leave requests."
        />
      </div>
    );
  }

  const queue = (requests.data ?? []) as Pending[];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Leave Approvals"
        description={
          queue.length === 0
            ? 'No pending requests right now.'
            : `${queue.length} pending ${queue.length === 1 ? 'request' : 'requests'}.`
        }
        actions={
          <Link
            href="/leave"
            className="text-sm text-gray-500 transition-colors hover:text-campus-700"
          >
            My Leave →
          </Link>
        }
      />

      <div className="mt-6">
        {requests.isLoading ? (
          <div className="py-16 text-center">
            <LoadingSpinner />
          </div>
        ) : requests.isError ? (
          <EmptyState title="Couldn’t load the queue" />
        ) : queue.length === 0 ? (
          <EmptyState
            title="Queue clear"
            description="When a staff member submits a request, it shows up here."
          />
        ) : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white shadow-sm">
            {queue.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-3">
                  <Avatar name={r.employeeName} size="md" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{r.employeeName}</p>
                    <p className="text-xs text-gray-500">
                      {r.leaveTypeName} · {r.startDate} → {r.endDate} · {r.daysRequested}d
                    </p>
                    {r.reason && <p className="mt-1 text-xs italic text-gray-500">“{r.reason}”</p>}
                    <p className="mt-1 text-xs text-gray-400">
                      submitted {r.submittedAt.slice(0, 10)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 sm:flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => setReviewing({ req: r, mode: 'reject' })}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => setReviewing({ req: r, mode: 'approve' })}
                    className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
                  >
                    Approve
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {reviewing && (
        <ReviewModal mode={reviewing.mode} req={reviewing.req} onClose={() => setReviewing(null)} />
      )}
    </div>
  );
}

function ReviewModal({
  mode,
  req,
  onClose,
}: {
  mode: 'approve' | 'reject';
  req: Pending;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const approve = useApproveLeaveRequest(req.id);
  const reject = useRejectLeaveRequest(req.id);
  const [notes, setNotes] = useState('');

  const action = mode === 'approve' ? approve : reject;
  const verb = mode === 'approve' ? 'Approve' : 'Reject';

  async function onConfirm() {
    try {
      await action.mutateAsync({ reviewNotes: notes.trim() || undefined });
      toast(`${verb}d ${req.daysRequested}d ${req.leaveTypeName}`, 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || `Could not ${verb.toLowerCase()} — please try again`, 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${verb} ${req.employeeName}'s leave`}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={action.isPending}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={action.isPending}
            className={
              mode === 'approve'
                ? 'rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50'
                : 'rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50'
            }
          >
            {action.isPending ? `${verb}ing…` : verb}
          </button>
        </div>
      }
    >
      <p className="text-sm text-gray-700">
        {req.leaveTypeName} · {req.startDate} → {req.endDate} ({req.daysRequested} day
        {req.daysRequested === 1 ? '' : 's'})
      </p>
      {req.reason && <p className="mt-2 text-sm italic text-gray-500">“{req.reason}”</p>}
      <label className="mt-4 block text-sm font-medium text-gray-700">
        {mode === 'approve' ? 'Approval note (optional)' : 'Reason (optional)'}
      </label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        maxLength={500}
        className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
      />
    </Modal>
  );
}
