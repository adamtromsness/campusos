'use client';

import { useState } from 'react';
import {
  useApplicationScores,
  useCreateApplicationScore,
  useDeleteApplicationScore,
} from '@/hooks/use-enrollment';
import { useToast } from '@/components/ui/Toast';
import { Modal } from '@/components/ui/Modal';

interface Props {
  applicationId: string;
  canEdit: boolean;
}

export function ScoresPanel({ applicationId, canEdit }: Props) {
  const scoresQ = useApplicationScores(applicationId);
  const create = useCreateApplicationScore(applicationId);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [criterion, setCriterion] = useState('');
  const [score, setScore] = useState('');
  const [maxScore, setMaxScore] = useState('');
  const [notes, setNotes] = useState('');

  const scores = scoresQ.data ?? [];

  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Scores</h2>
          <p className="text-xs text-gray-500">
            Per-criterion scores recorded during interview / assessment.
          </p>
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded bg-campus-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-campus-700"
          >
            Record score
          </button>
        ) : null}
      </header>
      {scoresQ.isLoading ? (
        <div className="p-4 text-sm text-gray-500">Loading…</div>
      ) : scores.length === 0 ? (
        <div className="p-4 text-sm text-gray-500">No scores recorded.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">Criterion</th>
                <th className="px-4 py-2 text-left">Score</th>
                <th className="px-4 py-2 text-left">Recorded by</th>
                <th className="px-4 py-2 text-left">Notes</th>
                {canEdit ? <th className="px-4 py-2 text-right">Actions</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {scores.map((s) => (
                <ScoreRow key={s.id} score={s} applicationId={applicationId} canEdit={canEdit} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={open}
        title="Record score"
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
              disabled={create.isPending || !criterion.trim() || !score.trim()}
              className="rounded bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
              onClick={async () => {
                const scoreNum = Number(score);
                const maxNum = maxScore.trim() === '' ? undefined : Number(maxScore);
                if (Number.isNaN(scoreNum) || (maxNum !== undefined && Number.isNaN(maxNum))) {
                  toast('Score and max score must be numeric', 'error');
                  return;
                }
                try {
                  await create.mutateAsync({
                    criterionName: criterion.trim(),
                    score: scoreNum,
                    maxScore: maxNum,
                    notes: notes.trim() || undefined,
                  });
                  toast('Score recorded', 'success');
                  setOpen(false);
                  setCriterion('');
                  setScore('');
                  setMaxScore('');
                  setNotes('');
                } catch (err) {
                  toast(
                    (err as { message?: string })?.message ?? 'Failed to record score',
                    'error',
                  );
                }
              }}
            >
              {create.isPending ? 'Recording…' : 'Record'}
            </button>
          </div>
        }
      >
        <div className="space-y-3 text-sm">
          <div>
            <label htmlFor="criterion" className="mb-1 block font-medium text-gray-700">
              Criterion name
            </label>
            <input
              id="criterion"
              value={criterion}
              onChange={(e) => setCriterion(e.target.value)}
              maxLength={120}
              className="w-full rounded border border-gray-300 px-2 py-1.5"
              placeholder="e.g. Math Assessment, Interview"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="score" className="mb-1 block font-medium text-gray-700">
                Score
              </label>
              <input
                id="score"
                type="number"
                value={score}
                onChange={(e) => setScore(e.target.value)}
                step="0.1"
                min={0}
                className="w-full rounded border border-gray-300 px-2 py-1.5"
              />
            </div>
            <div>
              <label htmlFor="max-score" className="mb-1 block font-medium text-gray-700">
                Max score (optional)
              </label>
              <input
                id="max-score"
                type="number"
                value={maxScore}
                onChange={(e) => setMaxScore(e.target.value)}
                step="0.1"
                min={0}
                className="w-full rounded border border-gray-300 px-2 py-1.5"
              />
            </div>
          </div>
          <div>
            <label htmlFor="score-notes" className="mb-1 block font-medium text-gray-700">
              Notes (optional)
            </label>
            <textarea
              id="score-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              className="w-full rounded border border-gray-300 px-2 py-1.5"
            />
          </div>
        </div>
      </Modal>
    </section>
  );
}

function ScoreRow({
  score,
  applicationId,
  canEdit,
}: {
  score: {
    id: string;
    criterionName: string;
    score: number;
    maxScore: number | null;
    scoredByName: string | null;
    notes: string | null;
  };
  applicationId: string;
  canEdit: boolean;
}) {
  const del = useDeleteApplicationScore(score.id, applicationId);
  const { toast } = useToast();
  return (
    <tr>
      <td className="px-4 py-2 font-medium text-gray-900">{score.criterionName}</td>
      <td className="px-4 py-2">
        {score.score}
        {score.maxScore !== null ? (
          <span className="text-gray-500"> / {score.maxScore}</span>
        ) : null}
      </td>
      <td className="px-4 py-2 text-gray-600">{score.scoredByName ?? '—'}</td>
      <td className="max-w-xs px-4 py-2 text-gray-600">{score.notes ?? '—'}</td>
      {canEdit ? (
        <td className="px-4 py-2 text-right">
          <button
            type="button"
            disabled={del.isPending}
            onClick={async () => {
              try {
                await del.mutateAsync();
                toast('Score deleted', 'success');
              } catch (err) {
                toast((err as { message?: string })?.message ?? 'Failed to delete', 'error');
              }
            }}
            className="text-xs text-rose-600 hover:underline disabled:opacity-50"
          >
            Delete
          </button>
        </td>
      ) : null}
    </tr>
  );
}
