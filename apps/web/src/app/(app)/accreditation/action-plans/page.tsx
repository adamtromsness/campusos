'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PageHeader, EmptyState, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useAccActionPlans,
  useCreateAccActionPlan,
  useUpdateAccActionPlan,
  useUpdateAccSubAction,
} from '@/hooks/use-accreditation';
import {
  ACC_ACTION_PLAN_STATUS_LABEL,
  ACC_ACTION_PLAN_STATUS_PILL,
  ACC_SUB_ACTION_STATUS_LABEL,
  ACC_SUB_ACTION_STATUS_PILL,
  daysUntil,
  formatDateOnly,
} from '@/lib/accreditation-format';
import type {
  AccActionPlanDto,
  AccActionPlanStatus,
  AccSubAction,
  AccSubActionStatus,
} from '@/lib/types';

const COLUMNS: { key: AccActionPlanStatus; label: string }[] = [
  { key: 'PLANNED', label: 'Planned' },
  { key: 'IN_PROGRESS', label: 'In Progress' },
  { key: 'OVERDUE', label: 'Overdue' },
  { key: 'COMPLETE', label: 'Complete' },
];

export default function ActionPlansPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user?.personType === 'STAFF';
  const showStaffSurfaces = isStaff || isAdmin;

  const plansQ = useAccActionPlans(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [opened, setOpened] = useState<AccActionPlanDto | null>(null);

  const grouped = useMemo(() => {
    const map: Record<AccActionPlanStatus, AccActionPlanDto[]> = {
      PLANNED: [],
      IN_PROGRESS: [],
      OVERDUE: [],
      COMPLETE: [],
    };
    (plansQ.data ?? []).forEach((p) => {
      map[p.status].push(p);
    });
    return map;
  }, [plansQ.data]);

  if (!showStaffSurfaces) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <PageHeader title="Action Plans" />
        <EmptyState
          title="Not available"
          description="Action plans are restricted to staff and administrators."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <PageHeader
        title="Action Plans"
        description="Improvement work tied to standards. Kanban by status — overdue rows highlighted in rose."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/accreditation"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          ← Dashboard
        </Link>
        <button
          type="button"
          className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
          onClick={() => setCreateOpen(true)}
        >
          New action plan
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        {COLUMNS.map((col) => (
          <div key={col.key} className="rounded-card border border-gray-200 bg-gray-50 p-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-800">{col.label}</h2>
              <span className="rounded-full bg-white px-2 py-0.5 text-xs text-gray-500 ring-1 ring-gray-200">
                {grouped[col.key].length}
              </span>
            </div>
            <ul className="mt-3 space-y-2">
              {grouped[col.key].length === 0 ? (
                <li className="text-xs italic text-gray-400">No plans</li>
              ) : (
                grouped[col.key].map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={
                        'w-full rounded-md border bg-white p-3 text-left shadow-sm hover:border-campus-300 ' +
                        (p.status === 'OVERDUE' ? 'border-rose-200' : 'border-gray-200')
                      }
                      onClick={() => setOpened(p)}
                    >
                      <div className="line-clamp-2 text-sm font-medium text-gray-800">{p.goal}</div>
                      <div className="mt-1 flex items-center justify-between text-xs text-gray-500">
                        <span>{formatDateOnly(p.targetDate)}</span>
                        <DueChip targetDate={p.targetDate} status={p.status} />
                      </div>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        ))}
      </div>

      <CreateActionPlanModal open={createOpen} onClose={() => setCreateOpen(false)} />

      {opened && (
        <ActionPlanDetailModal plan={opened} open={!!opened} onClose={() => setOpened(null)} />
      )}
    </div>
  );
}

function DueChip({ targetDate, status }: { targetDate: string; status: AccActionPlanStatus }) {
  if (status === 'COMPLETE') return null;
  const d = daysUntil(targetDate);
  if (d === null) return null;
  if (d < 0)
    return (
      <span className="rounded-full bg-rose-100 px-2 py-0.5 text-rose-700">{`${-d}d overdue`}</span>
    );
  if (d <= 7)
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">{`${d}d left`}</span>
    );
  return <span className="text-gray-500">{`${d}d left`}</span>;
}

function CreateActionPlanModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateAccActionPlan();
  const [standardId, setStandardId] = useState('');
  const [goal, setGoal] = useState('');
  const [responsibleParty, setResponsibleParty] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [notes, setNotes] = useState('');
  const [actions, setActions] = useState<AccSubAction[]>([
    { description: '', due_date: '', status: 'PENDING' },
  ]);

  function updateAction(i: number, patch: Partial<AccSubAction>) {
    setActions((arr) => arr.map((a, idx) => (i === idx ? { ...a, ...patch } : a)));
  }
  function addAction() {
    setActions((arr) => [...arr, { description: '', due_date: '', status: 'PENDING' }]);
  }
  function removeAction(i: number) {
    setActions((arr) => arr.filter((_, idx) => idx !== i));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!standardId || !goal.trim() || !responsibleParty.trim() || !targetDate) {
      toast('All required fields must be set', 'error');
      return;
    }
    const cleaned = actions.filter((a) => a.description.trim() && a.due_date.trim());
    if (cleaned.length === 0) {
      toast('At least one sub-action is required', 'error');
      return;
    }
    try {
      await create.mutateAsync({
        standardId,
        goal: goal.trim(),
        responsibleParty,
        targetDate,
        notes: notes || undefined,
        actions: cleaned,
      });
      toast('Action plan created', 'success');
      setStandardId('');
      setGoal('');
      setResponsibleParty('');
      setTargetDate('');
      setNotes('');
      setActions([{ description: '', due_date: '', status: 'PENDING' }]);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      toast(msg, 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New action plan"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="ap-form"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white"
            disabled={create.isPending}
          >
            Create
          </button>
        </div>
      }
    >
      <form id="ap-form" onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Standard ID</span>
          <input
            type="text"
            value={standardId}
            onChange={(e) => setStandardId(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
            placeholder="UUID of the standard (platform or custom)"
            required
          />
          <p className="mt-1 text-xs text-gray-500">
            Copy from /accreditation/standards. SOFT INTEGRITY — resolves to platform OR custom.
          </p>
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Goal</span>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            rows={2}
            maxLength={2000}
            required
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Responsible party (employee ID)</span>
            <input
              type="text"
              value={responsibleParty}
              onChange={(e) => setResponsibleParty(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
              placeholder="UUID from /staff"
              required
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Target date</span>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              required
            />
          </label>
        </div>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            rows={2}
            maxLength={4000}
          />
        </label>
        <div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">Sub-actions</span>
            <button
              type="button"
              className="text-xs text-campus-600 hover:text-campus-700"
              onClick={addAction}
            >
              + Add sub-action
            </button>
          </div>
          <div className="mt-2 space-y-2">
            {actions.map((a, i) => (
              <div
                key={i}
                className="flex flex-col gap-2 rounded-md border border-gray-200 p-2 sm:flex-row"
              >
                <input
                  type="text"
                  value={a.description}
                  onChange={(e) => updateAction(i, { description: e.target.value })}
                  placeholder="Describe the sub-action"
                  className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-xs"
                />
                <input
                  type="date"
                  value={a.due_date}
                  onChange={(e) => updateAction(i, { due_date: e.target.value })}
                  className="rounded-md border border-gray-300 px-2 py-1 text-xs"
                />
                <button
                  type="button"
                  onClick={() => removeAction(i)}
                  className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50"
                  disabled={actions.length === 1}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      </form>
    </Modal>
  );
}

function ActionPlanDetailModal({
  plan,
  open,
  onClose,
}: {
  plan: AccActionPlanDto;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const update = useUpdateAccActionPlan();
  const updateSub = useUpdateAccSubAction();

  async function setStatus(status: AccActionPlanStatus) {
    try {
      await update.mutateAsync({ id: plan.id, body: { status } });
      toast(`Status → ${ACC_ACTION_PLAN_STATUS_LABEL[status]}`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      toast(msg, 'error');
    }
  }

  async function setSubStatus(index: number, status: AccSubActionStatus) {
    try {
      await updateSub.mutateAsync({ id: plan.id, body: { index, status } });
      toast('Sub-action updated', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      toast(msg, 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={plan.goal}
      size="lg"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span
            className={
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
              ACC_ACTION_PLAN_STATUS_PILL[plan.status]
            }
          >
            {ACC_ACTION_PLAN_STATUS_LABEL[plan.status]}
          </span>
          <div className="flex flex-wrap gap-2">
            {plan.status === 'PLANNED' && (
              <button
                type="button"
                className="rounded-md bg-sky-600 px-3 py-1.5 text-sm text-white"
                onClick={() => setStatus('IN_PROGRESS')}
              >
                Mark in progress
              </button>
            )}
            {(plan.status === 'IN_PROGRESS' || plan.status === 'OVERDUE') && (
              <button
                type="button"
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white"
                onClick={() => setStatus('COMPLETE')}
              >
                Mark complete
              </button>
            )}
            <button
              type="button"
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3 text-xs text-gray-500">
          <div>
            <div className="font-medium uppercase tracking-wide">Target date</div>
            <div className="mt-1 text-gray-700">{formatDateOnly(plan.targetDate)}</div>
          </div>
          <div>
            <div className="font-medium uppercase tracking-wide">Responsible</div>
            <div className="mt-1 font-mono text-gray-700">{plan.responsibleParty.slice(0, 8)}…</div>
          </div>
        </div>
        {plan.notes && (
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Notes</div>
            <p className="mt-1 whitespace-pre-wrap text-gray-700">{plan.notes}</p>
          </div>
        )}
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Sub-actions ({plan.actions.length})
          </div>
          <ul className="mt-2 divide-y divide-gray-100 rounded-md border border-gray-200">
            {plan.actions.map((a, i) => (
              <li key={i} className="flex flex-col gap-2 p-2 sm:flex-row sm:items-center">
                <div className="flex-1">
                  <div className="text-sm text-gray-800">{a.description}</div>
                  <div className="text-xs text-gray-500">Due {formatDateOnly(a.due_date)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={
                      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
                      ACC_SUB_ACTION_STATUS_PILL[a.status]
                    }
                  >
                    {ACC_SUB_ACTION_STATUS_LABEL[a.status]}
                  </span>
                  {a.status !== 'COMPLETED' && (
                    <button
                      type="button"
                      className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50"
                      onClick={() => setSubStatus(i, 'COMPLETED')}
                      disabled={updateSub.isPending}
                    >
                      Complete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
