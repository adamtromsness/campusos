'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader, Modal, useToast } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { usePeriods, useUpdatePeriodStatus } from '@/hooks/use-finance';
import { PERIOD_STATUS_LABELS, PERIOD_STATUS_PILL, formatDate } from '@/lib/finance-format';
import type { FinPeriodDto, FinPeriodStatus } from '@/lib/types';

export default function PeriodsPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['fin-005:write']);
  const periodsQ = usePeriods('FY2025-2026');
  const periods = periodsQ.data ?? [];
  const [lockTarget, setLockTarget] = useState<FinPeriodDto | null>(null);
  const updateMut = useUpdatePeriodStatus(lockTarget?.id ?? '');
  const { toast } = useToast();

  async function transition(p: FinPeriodDto, status: FinPeriodStatus) {
    if (status === 'LOCKED') {
      setLockTarget(p);
      return;
    }
    try {
      await patchPeriodStatusInline(p.id, status);
      toast(`Period ${p.periodName} → ${PERIOD_STATUS_LABELS[status]}.`, 'success');
      periodsQ.refetch();
    } catch (e: unknown) {
      toast((e as Error).message, 'error');
    }
  }

  function nextStatuses(p: FinPeriodDto): FinPeriodStatus[] {
    if (p.status === 'FUTURE') return ['OPEN'];
    if (p.status === 'OPEN') return ['CLOSED', 'FUTURE'];
    if (p.status === 'CLOSED') return ['OPEN', 'LOCKED'];
    return []; // LOCKED is terminal
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Accounting periods"
        description="Lifecycle: FUTURE → OPEN → CLOSED → LOCKED. LOCKED is permanent."
      />
      <Link href="/finance" className="text-sm text-campus-700 hover:underline">
        ← Back to finance
      </Link>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2 text-left">#</th>
              <th className="px-4 py-2 text-left">Period</th>
              <th className="px-4 py-2 text-left">Window</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Closed</th>
              <th className="px-4 py-2 text-left">Locked</th>
              {isAdmin && <th className="px-4 py-2 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.id} className="border-t border-gray-100">
                <td className="px-4 py-2 font-mono text-xs">{p.periodNumber}</td>
                <td className="px-4 py-2">{p.periodName}</td>
                <td className="px-4 py-2 text-xs text-gray-600">
                  {formatDate(p.startDate)} → {formatDate(p.endDate)}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${PERIOD_STATUS_PILL[p.status]}`}
                  >
                    {PERIOD_STATUS_LABELS[p.status]}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">
                  {p.closedAt ? formatDate(p.closedAt) : '—'}
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">
                  {p.lockedAt ? formatDate(p.lockedAt) : '—'}
                </td>
                {isAdmin && (
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      {nextStatuses(p).map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => transition(p, s)}
                          className={`rounded px-2 py-0.5 text-xs font-medium ${s === 'LOCKED' ? 'bg-rose-600 text-white hover:bg-rose-700' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                        >
                          → {PERIOD_STATUS_LABELS[s]}
                        </button>
                      ))}
                      {p.status === 'LOCKED' && (
                        <span className="text-xs text-rose-700">Permanent</span>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={!!lockTarget}
        onClose={() => setLockTarget(null)}
        title={lockTarget ? `Lock ${lockTarget.periodName}?` : ''}
        footer={
          lockTarget && (
            <div className="flex w-full justify-end gap-2">
              <button
                type="button"
                onClick={() => setLockTarget(null)}
                className="rounded bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await updateMut.mutateAsync('LOCKED');
                    toast(`${lockTarget.periodName} locked permanently.`, 'success');
                    setLockTarget(null);
                    periodsQ.refetch();
                  } catch (e: unknown) {
                    toast((e as Error).message, 'error');
                  }
                }}
                className="rounded bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700"
              >
                I understand — lock permanently
              </button>
            </div>
          )
        }
      >
        <div className="space-y-3 text-sm">
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800">
            <strong>This action is permanent and cannot be undone.</strong>
            <p className="mt-1 text-xs">
              Once a period is LOCKED, no further posting is possible — not even by a Platform
              Admin. All journal batches targeting this period will be rejected with a 400 error.
              The
              <code className="font-mono"> PeriodService.patchStatus </code> method refuses any
              transition out of LOCKED.
            </p>
          </div>
          <p className="text-gray-600">
            Locking is the financial integrity contract. Use it to seal a closed-and-audited period
            against any future revisions.
          </p>
        </div>
      </Modal>
    </div>
  );
}

// Inline mutation helper since useUpdatePeriodStatus is keyed on a single id and
// we need to call it for arbitrary periods. Wraps a fresh fetch.
async function patchPeriodStatusInline(id: string, status: FinPeriodStatus) {
  const { apiFetch } = await import('@/lib/api-client');
  return apiFetch(`/api/v1/finance/periods/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}
