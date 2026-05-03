'use client';

import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { useApprovals } from '@/hooks/use-approvals';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  REQUEST_STATUS_LABELS,
  REQUEST_STATUS_PILL,
  formatStepPosition,
} from '@/lib/approvals-format';

export default function MyRequestsPage() {
  const user = useAuthStore((s) => s.user);
  const canApprovals = !!user && hasAnyPermission(user, ['ops-001:read']);
  const approvals = useApprovals({ mine: true }, canApprovals);

  if (!user) return null;
  if (!canApprovals) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="My requests" />
        <EmptyState title="Access required" description="You need OPS-001 read access." />
      </div>
    );
  }

  const list = (approvals.data ?? []).filter((r) => r.requesterId === user.id);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="My requests"
        description="Approval requests you submitted. Each shows the current step + status."
        actions={
          <Link
            href="/approvals"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            ← My approvals
          </Link>
        }
      />

      {approvals.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title="You haven't submitted any approval requests"
          description="When you submit a leave request or other approval-driven flow, the request lands here so you can track its progress."
        />
      ) : (
        <ul className="space-y-3">
          {list.map((r) => (
            <li
              key={r.id}
              className="rounded-card border border-gray-200 bg-white shadow-card transition-colors hover:border-campus-300"
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
                  Submitted {new Date(r.submittedAt).toLocaleString()}
                  {r.resolvedAt && ' · resolved ' + new Date(r.resolvedAt).toLocaleString()}
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
