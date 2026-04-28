'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useCancelLeaveRequest,
  useLeaveRequests,
  useMyLeaveBalances,
  useMyEmployee,
} from '@/hooks/use-hr';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import type { LeaveBalanceDto, LeaveRequestDto, LeaveRequestStatus } from '@/lib/types';

export default function MyLeavePage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sch-001:admin']);
  const me = useMyEmployee(!!user);
  const balances = useMyLeaveBalances(!!user);
  const requests = useLeaveRequests({}, !!user);
  const cancel = useCancelLeaveRequest();
  const { toast } = useToast();

  const ownRequests = useMemo(() => requests.data ?? [], [requests.data]);

  if (!user) return null;

  const noEmployee = me.isError || (!me.isLoading && !me.data);

  if (noEmployee) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader
          title="My Leave"
          description="Leave is only available to staff with an employee record."
        />
        <EmptyState
          title="No employee record"
          description="The calling user has no hr_employees row, so leave balances and requests are not applicable."
        />
      </div>
    );
  }

  async function onCancel(req: LeaveRequestDto) {
    if (req.status !== 'PENDING' && req.status !== 'APPROVED') return;
    if (
      !window.confirm(
        `Cancel ${req.daysRequested}d ${req.leaveTypeName} from ${req.startDate} to ${req.endDate}?`,
      )
    ) {
      return;
    }
    try {
      await cancel.mutateAsync(req.id);
      toast('Leave request cancelled', 'success');
    } catch (e: any) {
      toast(e?.message || 'Could not cancel — please contact HR', 'error');
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="My Leave"
        description="Your balances and request history. Cancel a pending request below."
        actions={
          <Link
            href="/leave/new"
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
          >
            New request
          </Link>
        }
      />

      <section className="mt-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900">Balances</h3>
        {balances.isLoading ? (
          <div className="py-6 text-center">
            <LoadingSpinner />
          </div>
        ) : balances.isError ? (
          <p className="mt-3 text-sm text-gray-500">Couldn’t load balances.</p>
        ) : (balances.data ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No leave balances configured.</p>
        ) : (
          <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(balances.data ?? []).map((b) => (
              <BalanceCard key={b.leaveTypeId} balance={b} />
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900">Request history</h3>
        {requests.isLoading ? (
          <div className="py-6 text-center">
            <LoadingSpinner />
          </div>
        ) : requests.isError ? (
          <p className="mt-3 text-sm text-gray-500">Couldn’t load requests.</p>
        ) : ownRequests.length === 0 ? (
          <EmptyState
            title="No requests yet"
            description="When you submit a leave request, it shows up here."
          />
        ) : (
          <ul className="mt-3 divide-y divide-gray-100">
            {ownRequests.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900">{r.leaveTypeName}</p>
                  <p className="text-xs text-gray-500">
                    {r.startDate} → {r.endDate} · {r.daysRequested}d
                    {r.reason && ` · ${r.reason}`}
                  </p>
                  {r.reviewNotes && (
                    <p className="mt-1 text-xs italic text-gray-500">
                      Reviewer: {r.reviewNotes}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <LeaveStatusPill status={r.status} />
                  {(r.status === 'PENDING' ||
                    (r.status === 'APPROVED' && (isAdmin || true))) && (
                    <button
                      type="button"
                      onClick={() => onCancel(r)}
                      disabled={cancel.isPending}
                      className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function BalanceCard({ balance }: { balance: LeaveBalanceDto }) {
  const total = balance.accrued || 0;
  const usedPct = total > 0 ? Math.min(100, (balance.used / total) * 100) : 0;
  const pendingPct = total > 0 ? Math.min(100 - usedPct, (balance.pending / total) * 100) : 0;
  return (
    <li className="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-semibold text-gray-900">{balance.leaveTypeName}</p>
        <p className="text-base font-semibold text-campus-700">
          {balance.available}
          <span className="ml-1 text-xs font-normal text-gray-500">available</span>
        </p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-200">
        <div className="flex h-full">
          <div className="h-full bg-campus-600" style={{ width: `${usedPct}%` }} />
          <div className="h-full bg-amber-400" style={{ width: `${pendingPct}%` }} />
        </div>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        accrued {balance.accrued} · used {balance.used} · pending {balance.pending}
      </p>
    </li>
  );
}

function LeaveStatusPill({ status }: { status: LeaveRequestStatus }) {
  const cls =
    status === 'APPROVED'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'PENDING'
        ? 'bg-amber-100 text-amber-800'
        : status === 'REJECTED'
          ? 'bg-red-100 text-red-800'
          : 'bg-gray-100 text-gray-700';
  return (
    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', cls)}>
      {status.toLowerCase()}
    </span>
  );
}
