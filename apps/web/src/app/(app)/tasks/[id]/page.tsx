'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useAcknowledge,
  useAcknowledgement,
  useDispute,
  useTask,
  useUpdateTask,
} from '@/hooks/use-tasks';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  ACKNOWLEDGEMENT_SOURCE_LABELS,
  TASK_CATEGORY_LABELS,
  TASK_PRIORITY_LABELS,
  TASK_PRIORITY_PILL,
  TASK_SOURCE_LABELS,
  TASK_STATUS_LABELS,
  TASK_STATUS_PILL,
  formatRelativeDue,
  isTaskOverdue,
} from '@/lib/tasks-format';
import type { TaskStatus } from '@/lib/types';

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const user = useAuthStore((s) => s.user);
  const canTasks = !!user && hasAnyPermission(user, ['ops-001:read']);

  const task = useTask(id, canTasks);
  const ack = useAcknowledgement(task.data?.acknowledgementId ?? null, !!task.data?.acknowledgementId);
  const update = useUpdateTask(id ?? '');
  const acknowledge = useAcknowledge(task.data?.acknowledgementId ?? '');
  const dispute = useDispute(task.data?.acknowledgementId ?? '');
  const { toast } = useToast();
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');

  if (!user) return null;
  if (!canTasks) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Task" />
        <EmptyState title="Access required" description="You need OPS-001 read access." />
      </div>
    );
  }
  if (task.isLoading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-gray-500">
        <LoadingSpinner size="sm" /> Loading…
      </div>
    );
  }
  if (task.isError || !task.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Task" />
        <EmptyState title="Task not found" description="It may have been deleted or you don't have access." />
      </div>
    );
  }

  const t = task.data;
  const overdue = isTaskOverdue(t.dueAt, t.status);
  const dueLabel = formatRelativeDue(t.dueAt);
  const isAck = t.taskCategory === 'ACKNOWLEDGEMENT' && !!t.acknowledgementId;
  const ackData = ack.data;
  const ackSettled =
    !!ackData &&
    (ackData.status === 'ACKNOWLEDGED' || ackData.status === 'ACKNOWLEDGED_WITH_DISPUTE');

  async function flipStatus(next: TaskStatus) {
    try {
      await update.mutateAsync({ status: next });
      toast('Status: ' + TASK_STATUS_LABELS[next], 'success');
    } catch (e: any) {
      toast(e?.message || 'Could not update', 'error');
    }
  }

  async function onAcknowledge() {
    try {
      await acknowledge.mutateAsync();
      toast('Acknowledged', 'success');
    } catch (e: any) {
      toast(e?.message || 'Could not acknowledge', 'error');
    }
  }

  async function onDispute() {
    if (!disputeReason.trim()) return;
    try {
      await dispute.mutateAsync({ reason: disputeReason.trim() });
      toast('Dispute recorded', 'success');
      setDisputeOpen(false);
      setDisputeReason('');
    } catch (e: any) {
      toast(e?.message || 'Could not record dispute', 'error');
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={t.title}
        actions={
          <Link href="/tasks" className="text-sm text-campus-700 hover:text-campus-900">
            ← Back
          </Link>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span
          className={cn(
            'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
            TASK_STATUS_PILL[t.status],
          )}
        >
          {TASK_STATUS_LABELS[t.status]}
        </span>
        <span
          className={cn(
            'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
            TASK_PRIORITY_PILL[t.priority],
          )}
        >
          {TASK_PRIORITY_LABELS[t.priority]}
        </span>
        <span className="text-xs text-gray-500">
          {TASK_CATEGORY_LABELS[t.taskCategory]} · {TASK_SOURCE_LABELS[t.source]}
        </span>
      </div>

      <section className="mb-6 rounded-card border border-gray-200 bg-white p-6 shadow-card">
        {t.description && (
          <p className="whitespace-pre-wrap text-sm text-gray-700">{t.description}</p>
        )}
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-gray-500">Due</p>
            <p className={cn('mt-1 font-medium', overdue ? 'text-rose-600' : 'text-gray-900')}>
              {dueLabel ?? '—'}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-gray-500">Owner</p>
            <p className="mt-1 font-medium text-gray-900">{t.ownerName ?? '—'}</p>
          </div>
          {t.createdForName && (
            <div className="col-span-2">
              <p className="text-[10px] uppercase tracking-wide text-gray-500">Created by</p>
              <p className="mt-1 text-gray-700">{t.createdForName}</p>
            </div>
          )}
          {t.source !== 'MANUAL' && t.sourceRefId && (
            <div className="col-span-2">
              <p className="text-[10px] uppercase tracking-wide text-gray-500">Auto-created from</p>
              <p className="mt-1 font-mono text-xs text-gray-600">{t.sourceRefId}</p>
            </div>
          )}
        </div>
      </section>

      {isAck && (
        <section className="mb-6 rounded-card border border-rose-200 bg-rose-50 p-6 shadow-card">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-rose-900">
            Acknowledgement required
          </h2>
          {ackData ? (
            <>
              <p className="mt-2 text-sm text-rose-900">{ackData.title}</p>
              <p className="mt-1 text-xs text-rose-700">
                {ACKNOWLEDGEMENT_SOURCE_LABELS[ackData.sourceType]}
                {ackData.expiresAt && ' · expires ' + new Date(ackData.expiresAt).toLocaleDateString()}
              </p>
              {ackData.bodyS3Key && (
                <p className="mt-2 text-xs text-rose-700">
                  A document is attached. Download links land in a future cycle.
                </p>
              )}
              {ackData.status === 'PENDING' ? (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={onAcknowledge}
                    disabled={acknowledge.isPending}
                    className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
                  >
                    I acknowledge
                  </button>
                  {ackData.requiresDisputeOption && (
                    <button
                      type="button"
                      onClick={() => setDisputeOpen(true)}
                      className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50"
                    >
                      Dispute
                    </button>
                  )}
                </div>
              ) : (
                <p className="mt-3 text-xs text-rose-700">
                  Status: <strong>{ackData.status}</strong>
                  {ackData.acknowledgedAt &&
                    ' — recorded ' + new Date(ackData.acknowledgedAt).toLocaleString()}
                  {ackData.disputeReason && (
                    <span className="mt-1 block italic">Reason: {ackData.disputeReason}</span>
                  )}
                </p>
              )}
            </>
          ) : (
            <p className="mt-2 text-xs text-rose-700">Loading acknowledgement…</p>
          )}
        </section>
      )}

      {!ackSettled && (
        <section className="rounded-card border border-gray-200 bg-white p-6 shadow-card">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
            Status
          </h2>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {t.status !== 'IN_PROGRESS' && t.status !== 'DONE' && t.status !== 'CANCELLED' && (
              <button
                type="button"
                onClick={() => flipStatus('IN_PROGRESS')}
                disabled={update.isPending}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
              >
                Start
              </button>
            )}
            {t.status !== 'DONE' && t.status !== 'CANCELLED' && !isAck && (
              <button
                type="button"
                onClick={() => flipStatus('DONE')}
                disabled={update.isPending}
                className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
              >
                Mark done
              </button>
            )}
            {(t.status === 'DONE' || t.status === 'CANCELLED') && (
              <button
                type="button"
                onClick={() => flipStatus('TODO')}
                disabled={update.isPending}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
              >
                Re-open
              </button>
            )}
            {t.status !== 'CANCELLED' && t.status !== 'DONE' && (
              <button
                type="button"
                onClick={() => flipStatus('CANCELLED')}
                disabled={update.isPending}
                className="ml-auto rounded-lg border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50"
              >
                Cancel task
              </button>
            )}
          </div>
        </section>
      )}

      <Modal
        open={disputeOpen}
        onClose={() => setDisputeOpen(false)}
        title="Dispute this acknowledgement"
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setDisputeOpen(false)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onDispute}
              disabled={dispute.isPending || disputeReason.trim().length === 0}
              className="rounded-lg bg-rose-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rose-600 disabled:opacity-50"
            >
              Record dispute
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-gray-700">
            Tell the school why you don&rsquo;t agree. The acknowledgement will be marked
            ACKNOWLEDGED_WITH_DISPUTE and your reason will be visible to admins.
          </p>
          <textarea
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
            rows={4}
            maxLength={2000}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            placeholder="Reason for dispute…"
          />
        </div>
      </Modal>
    </div>
  );
}
