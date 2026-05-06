'use client';

import { useState } from 'react';
import { useApplicationStages, useAdvanceApplicationStage } from '@/hooks/use-enrollment';
import { APPLICATION_STAGE_TARGETS, type ApplicationStageTarget } from '@/lib/types';
import { useToast } from '@/components/ui/Toast';
import { Modal } from '@/components/ui/Modal';

interface Props {
  applicationId: string;
  currentStatus: string;
  canEdit: boolean;
}

const STAGE_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  INTERVIEW: 'Interview',
  ASSESSMENT: 'Assessment',
  OFFERED: 'Offered',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  WAITLISTED: 'Waitlisted',
  WITHDRAWN: 'Withdrawn',
  ENROLLED: 'Enrolled',
};

const STAGE_PILL: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  SUBMITTED: 'bg-sky-100 text-sky-700',
  UNDER_REVIEW: 'bg-violet-100 text-violet-700',
  INTERVIEW: 'bg-violet-100 text-violet-700',
  ASSESSMENT: 'bg-violet-100 text-violet-700',
  OFFERED: 'bg-amber-100 text-amber-700',
  ACCEPTED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-rose-100 text-rose-700',
  WAITLISTED: 'bg-amber-100 text-amber-700',
  WITHDRAWN: 'bg-gray-100 text-gray-700',
  ENROLLED: 'bg-emerald-100 text-emerald-700',
};

export function StagesPanel({ applicationId, currentStatus, canEdit }: Props) {
  const stagesQ = useApplicationStages(applicationId);
  const advance = useAdvanceApplicationStage(applicationId);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ApplicationStageTarget>('UNDER_REVIEW');
  const [notes, setNotes] = useState('');

  const stages = stagesQ.data ?? [];

  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Stage history</h2>
          <p className="text-xs text-gray-500">
            Audit of every status transition (immutable). Current:{' '}
            <span
              className={`rounded px-1.5 py-0.5 text-xs ${
                STAGE_PILL[currentStatus] ?? 'bg-gray-100 text-gray-700'
              }`}
            >
              {STAGE_LABEL[currentStatus] ?? currentStatus}
            </span>
          </p>
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded bg-campus-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-campus-700"
          >
            Advance stage
          </button>
        ) : null}
      </header>
      {stagesQ.isLoading ? (
        <div className="p-4 text-sm text-gray-500">Loading…</div>
      ) : stages.length === 0 ? (
        <div className="p-4 text-sm text-gray-500">No stage history yet.</div>
      ) : (
        <ol className="divide-y divide-gray-100">
          {stages.map((s) => (
            <li key={s.id} className="px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {s.fromStatus ? (
                    <>
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${
                          STAGE_PILL[s.fromStatus] ?? 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        {STAGE_LABEL[s.fromStatus] ?? s.fromStatus}
                      </span>
                      <span className="text-gray-400">→</span>
                    </>
                  ) : null}
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      STAGE_PILL[s.toStatus] ?? 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {STAGE_LABEL[s.toStatus] ?? s.toStatus}
                  </span>
                </div>
                <div className="text-xs text-gray-500">
                  {s.changedByName ?? 'Unknown'} · {new Date(s.changedAt).toLocaleString()}
                </div>
              </div>
              {s.notes ? <p className="mt-1 text-xs text-gray-600">{s.notes}</p> : null}
            </li>
          ))}
        </ol>
      )}

      <Modal
        open={open}
        title="Advance application stage"
        onClose={() => setOpen(false)}
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-gray-300 px-3 py-1.5 text-sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={advance.isPending}
              className="rounded bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
              onClick={async () => {
                try {
                  await advance.mutateAsync({ toStatus: target, notes: notes || undefined });
                  toast(`Advanced to ${STAGE_LABEL[target] ?? target}`, 'success');
                  setOpen(false);
                  setNotes('');
                } catch (err) {
                  const msg = (err as { message?: string })?.message ?? 'Failed to advance stage';
                  toast(msg, 'error');
                }
              }}
            >
              {advance.isPending ? 'Advancing…' : 'Advance'}
            </button>
          </div>
        }
      >
        <div className="space-y-3 text-sm">
          <div>
            <label htmlFor="stage-target" className="mb-1 block font-medium text-gray-700">
              Target status
            </label>
            <select
              id="stage-target"
              value={target}
              onChange={(e) => setTarget(e.target.value as ApplicationStageTarget)}
              className="w-full rounded border border-gray-300 px-2 py-1.5"
            >
              {APPLICATION_STAGE_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {STAGE_LABEL[t] ?? t}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Server validates the transition is legal from the current state.
            </p>
          </div>
          <div>
            <label htmlFor="stage-notes" className="mb-1 block font-medium text-gray-700">
              Notes (optional)
            </label>
            <textarea
              id="stage-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={2000}
              className="w-full rounded border border-gray-300 px-2 py-1.5"
              placeholder="Reason for the transition…"
            />
          </div>
        </div>
      </Modal>
    </section>
  );
}
