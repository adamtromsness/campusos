'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useFacPmPlan,
  useFacPmPlans,
  useFacPmTaskResults,
  useFacPmTasks,
  useFacSubmitPmResults,
  useFacUpdatePmTask,
} from '@/hooks/use-facilities';
import { FAC_PM_STATUS_LABEL, FAC_PM_STATUS_PILL, formatDateOnly } from '@/lib/facilities-format';
import type { FacPmTaskStatus } from '@/lib/types';

const STATUSES: FacPmTaskStatus[] = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE'];

export default function PmPage() {
  const plansQ = useFacPmPlans();
  const tasksQ = useFacPmTasks({});
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  return (
    <div>
      <PageHeader
        title="Preventive maintenance"
        description="Recurring plans + scheduled tasks. FAIL on a checklist item auto-creates a follow-up work order."
        actions={
          <Link
            href="/facilities"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Facilities
          </Link>
        }
      />

      <section className="mb-4 rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Plans</h2>
        {plansQ.isLoading ? (
          <LoadingSpinner />
        ) : plansQ.data && plansQ.data.length > 0 ? (
          <ul className="mt-3 grid gap-2 lg:grid-cols-2">
            {plansQ.data.map((p) => (
              <li key={p.id} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium text-gray-900">{p.name}</span>
                  <span className="text-xs text-gray-500">
                    Every {p.frequencyMonths} mo · {p.targetType}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-600">
                  {p.items.length} checklist item{p.items.length === 1 ? '' : 's'}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No PM plans yet.</p>
        )}
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Tasks</h2>
        {tasksQ.isLoading ? (
          <LoadingSpinner />
        ) : tasksQ.data && tasksQ.data.length > 0 ? (
          <div className="mt-3 grid gap-3 lg:grid-cols-4">
            {STATUSES.map((status) => {
              const items = tasksQ.data!.filter((t) => t.status === status);
              return (
                <div key={status} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <h3 className="mb-2 text-sm font-semibold text-gray-700">
                    {FAC_PM_STATUS_LABEL[status]}{' '}
                    <span className="ml-1 rounded-full bg-white px-2 py-0.5 text-xs">
                      {items.length}
                    </span>
                  </h3>
                  <ul className="space-y-1">
                    {items.map((t) => (
                      <li
                        key={t.id}
                        className="cursor-pointer rounded-lg border border-gray-200 bg-white p-2 hover:border-campus-300"
                        onClick={() => setOpenTaskId(t.id)}
                      >
                        <div className="flex items-baseline gap-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${FAC_PM_STATUS_PILL[t.status]}`}
                          >
                            {formatDateOnly(t.scheduledDate)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-gray-700">{t.planName}</p>
                        {t.assignedToName && (
                          <p className="text-[11px] text-gray-500">{t.assignedToName}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No PM tasks generated yet.</p>
        )}
      </section>

      {openTaskId && <PmTaskModal id={openTaskId} onClose={() => setOpenTaskId(null)} />}
    </div>
  );
}

function PmTaskModal({ id, onClose }: { id: string; onClose: () => void }) {
  const tasksQ = useFacPmTasks({});
  const task = tasksQ.data?.find((t) => t.id === id);
  const planQ = useFacPmPlan(task?.planId ?? null);
  const resultsQ = useFacPmTaskResults(id);
  const update = useFacUpdatePmTask(id);
  const submit = useFacSubmitPmResults(id);
  const { toast } = useToast();
  const [pendingResults, setPendingResults] = useState<
    Map<string, { passed: boolean; notes: string }>
  >(new Map());

  const items = planQ.data?.items ?? [];
  const hasResults = (resultsQ.data?.length ?? 0) > 0;

  return (
    <Modal open onClose={onClose} title="PM task">
      {!task ? (
        <LoadingSpinner />
      ) : (
        <div className="space-y-3 text-sm">
          <div className="text-gray-700">
            <strong>{task.planName}</strong> · scheduled {formatDateOnly(task.scheduledDate)} ·{' '}
            <span className={`rounded-full px-2 py-0.5 text-xs ${FAC_PM_STATUS_PILL[task.status]}`}>
              {FAC_PM_STATUS_LABEL[task.status]}
            </span>
          </div>

          {task.status !== 'COMPLETED' && task.status !== 'OVERDUE' && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={async () => {
                  await update.mutateAsync({ status: 'IN_PROGRESS' });
                  toast('Started', 'success');
                }}
                className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-700"
              >
                Start
              </button>
            </div>
          )}

          {hasResults ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <h4 className="text-sm font-semibold text-emerald-900">
                Results submitted (immutable)
              </h4>
              <ul className="mt-2 space-y-1 text-xs">
                {(resultsQ.data ?? []).map((r) => (
                  <li key={r.id} className="flex items-baseline gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] ${
                        r.passed ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                      }`}
                    >
                      {r.passed ? 'PASS' : 'FAIL'}
                    </span>
                    <span className="text-gray-900">{r.itemName}</span>
                    {r.followUpWorkOrderId && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">
                        ↗ Follow-up WO
                      </span>
                    )}
                    {r.notes && <span className="text-gray-600 italic">— {r.notes}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              <h4 className="text-sm font-semibold text-gray-900">Submit checklist</h4>
              <ul className="mt-2 space-y-2 text-xs">
                {items.map((it) => {
                  const cur = pendingResults.get(it.id);
                  return (
                    <li key={it.id} className="rounded border border-gray-100 p-2">
                      <div className="font-medium text-gray-900">{it.itemName}</div>
                      <div className="mt-1 flex gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            const next = new Map(pendingResults);
                            next.set(it.id, { passed: true, notes: cur?.notes ?? '' });
                            setPendingResults(next);
                          }}
                          className={`rounded border px-2 py-0.5 text-[11px] ${
                            cur?.passed === true
                              ? 'border-emerald-700 bg-emerald-700 text-white'
                              : 'border-gray-300 bg-white text-gray-700'
                          }`}
                        >
                          PASS
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const next = new Map(pendingResults);
                            next.set(it.id, { passed: false, notes: cur?.notes ?? '' });
                            setPendingResults(next);
                          }}
                          className={`rounded border px-2 py-0.5 text-[11px] ${
                            cur?.passed === false
                              ? 'border-rose-700 bg-rose-700 text-white'
                              : 'border-gray-300 bg-white text-gray-700'
                          }`}
                        >
                          FAIL
                        </button>
                        <input
                          value={cur?.notes ?? ''}
                          onChange={(e) => {
                            const next = new Map(pendingResults);
                            next.set(it.id, {
                              passed: cur?.passed ?? true,
                              notes: e.target.value,
                            });
                            setPendingResults(next);
                          }}
                          placeholder="notes (required for FAIL)"
                          className="flex-1 rounded border border-gray-300 px-2 py-0.5 text-[11px]"
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
              <button
                type="button"
                onClick={async () => {
                  if (pendingResults.size !== items.length) {
                    toast('Mark every item PASS or FAIL', 'error');
                    return;
                  }
                  try {
                    const res = await submit.mutateAsync({
                      results: items.map((it) => ({
                        checklistItemId: it.id,
                        passed: pendingResults.get(it.id)!.passed,
                        notes: pendingResults.get(it.id)!.notes || undefined,
                      })),
                    });
                    if (res.followUpWorkOrders.length > 0) {
                      toast(
                        `${res.followUpWorkOrders.length} follow-up work order(s) auto-created`,
                        'success',
                      );
                    } else {
                      toast('Results submitted', 'success');
                    }
                  } catch (err) {
                    toast((err as Error).message, 'error');
                  }
                }}
                className="mt-3 rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
                disabled={submit.isPending}
              >
                {submit.isPending ? 'Submitting…' : 'Submit results'}
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
