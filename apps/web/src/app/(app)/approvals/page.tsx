'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { useApprovals } from '@/hooks/use-approvals';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  REQUEST_STATUS_PILL,
  REQUEST_STATUS_LABELS,
  formatStepPosition,
} from '@/lib/approvals-format';

export default function ApprovalsPage() {
  const user = useAuthStore((s) => s.user);
  const canApprovals = !!user && hasAnyPermission(user, ['ops-001:read']);
  const approvals = useApprovals({ status: 'PENDING' }, canApprovals);

  // Default queue: requests where I'm the AWAITING approver. Admin
  // override: filter is the same client-side; the back-end already row-
  // scopes non-admins to "own + EXISTS approver_id = me" so the list is
  // approver-relevant.
  const myQueue = useMemo(() => {
    if (!user) return [];
    return (approvals.data ?? []).filter((r) =>
      r.steps.some((s) => s.status === 'AWAITING' && s.approverId === user.id),
    );
  }, [approvals.data, user]);

  if (!user) return null;
  if (!canApprovals) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Approvals" />
        <EmptyState title="Access required" description="You need OPS-001 read access." />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="My approvals"
        description={
          myQueue.length === 0
            ? 'No requests are waiting on you.'
            : myQueue.length === 1
              ? '1 request waiting'
              : myQueue.length + ' requests waiting'
        }
        actions={
          <Link
            href="/approvals/my-requests"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            My requests →
          </Link>
        }
      />

      {approvals.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : myQueue.length === 0 ? (
        <EmptyState
          title="No pending approvals"
          description="When someone submits a request that routes to you, it lands here. You can also browse requests you submitted under My requests."
        />
      ) : (
        <ul className="space-y-3">
          {myQueue.map((r) => (
            <li
              key={r.id}
              className="rounded-card border border-gray-200 bg-white shadow-card transition-colors hover:border-campus-300 hover:shadow-elevated"
            >
              <Link href={'/approvals/' + r.id} className="block p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-base font-semibold text-gray-900">
                    {r.requestType}
                    {r.referenceTable && (
                      <span className="ml-2 font-mono text-xs text-gray-500">
                        {r.referenceTable}
                      </span>
                    )}
                  </h2>
                  <span
                    className={cn(
                      'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                      REQUEST_STATUS_PILL[r.status],
                    )}
                  >
                    {REQUEST_STATUS_LABELS[r.status]}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-700">
                  Requested by {r.requesterName ?? '—'} · {new Date(r.submittedAt).toLocaleString()}
                </p>
                <p className="mt-2 text-xs text-gray-500">
                  {formatStepPosition(r.steps, r.steps.length)} · template: {r.templateName}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
