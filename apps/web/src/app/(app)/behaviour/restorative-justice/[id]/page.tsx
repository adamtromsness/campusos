'use client';

import { use, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  useRjConference,
  useAddRjAction,
  useCompleteRjAction,
  type RjActionStatus,
} from '@/hooks/use-behaviour-advanced';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';

const ACTION_PILL: Record<RjActionStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  OVERDUE: 'bg-rose-100 text-rose-700',
};

export default function RjConferenceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useAuthStore();
  const canWrite = hasAnyPermission(user, ['beh-001:write', 'beh-001:admin']);
  const conf = useRjConference(id);
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState('');
  const [studentId, setStudentId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [completeOpen, setCompleteOpen] = useState<string | null>(null);
  const [evidence, setEvidence] = useState('');
  const addAction = useAddRjAction(id);
  const completeAction = useCompleteRjAction();
  const { toast } = useToast();

  if (conf.isLoading) return <LoadingSpinner />;
  if (!conf.data) return <EmptyState title="Not found" description="Conference not found." />;
  const c = conf.data;

  async function submitAction() {
    try {
      await addAction.mutateAsync({
        actionDescription: desc,
        assignedToStudentId: studentId,
        dueDate,
      });
      toast('Action added', 'success');
      setOpen(false);
      setDesc('');
      setStudentId('');
      setDueDate('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  async function complete(actionId: string) {
    try {
      const r = await completeAction.mutateAsync({ id: actionId, evidenceNotes: evidence });
      toast(
        r.conferenceResolved ? 'Action completed — conference RESOLVED' : 'Action completed',
        'success',
      );
      setCompleteOpen(null);
      setEvidence('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="RJ conference"
        description={`Offender: ${c.offenderStudentName ?? '—'} · ${c.status}`}
      />

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="font-medium text-gray-900 mb-3">Agreement actions</h2>
        {c.actions && c.actions.length > 0 ? (
          <ul className="space-y-2">
            {c.actions.map((a) => (
              <li
                key={a.id}
                className="flex items-start justify-between gap-3 border-b border-gray-100 pb-3"
              >
                <div>
                  <div className="font-medium text-gray-900">{a.actionDescription}</div>
                  <div className="text-xs text-gray-500">
                    Due {a.dueDate} · Assigned to{' '}
                    {a.assignedToStudentName ?? a.assignedToStudentId.slice(0, 8)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={'rounded-full px-2 py-1 text-xs ' + ACTION_PILL[a.status]}>
                    {a.status}
                  </span>
                  {canWrite && a.status !== 'COMPLETED' ? (
                    <button
                      type="button"
                      onClick={() => setCompleteOpen(a.id)}
                      className="text-xs text-campus-700 hover:underline"
                    >
                      Mark complete
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">No actions yet.</p>
        )}

        {canWrite && c.status !== 'RESOLVED_SUCCESSFULLY' && c.status !== 'FAILED' ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-4 rounded-md border border-campus-300 px-3 py-1.5 text-sm font-medium text-campus-700 hover:bg-campus-50"
          >
            Add action
          </button>
        ) : null}
      </section>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add agreement action"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitAction}
              disabled={!desc || !studentId || !dueDate}
              className="rounded-md bg-campus-700 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Add
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="text-sm">Description</span>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={2}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm">Assigned student UUID</span>
            <input
              type="text"
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm">Due date</span>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </Modal>

      <Modal
        open={!!completeOpen}
        onClose={() => setCompleteOpen(null)}
        title="Mark action complete"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCompleteOpen(null)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => completeOpen && complete(completeOpen)}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm text-white"
            >
              Complete
            </button>
          </div>
        }
      >
        <div className="space-y-2">
          <p className="text-sm text-gray-600">
            If this is the final action, the conference will auto-transition to
            RESOLVED_SUCCESSFULLY.
          </p>
          <label className="block">
            <span className="text-sm">Evidence notes (optional)</span>
            <textarea
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              rows={3}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}
