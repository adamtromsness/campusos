'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  GAME_LOCATION_LABELS,
  GAME_LOCATION_PILL,
  GAME_OUTCOME_LABELS,
  GAME_STATUS_LABELS,
  GAME_STATUS_PILL,
  ROSTER_LEVEL_LABELS,
  formatDate,
  formatTime,
} from '@/lib/athletics-format';
import { useAthleticsGame, useAthleticsGameStats, useEnterGameResult } from '@/hooks/use-athletics';
import type { AthleticsGameOutcome } from '@/lib/types';

export default function GameDetailPage() {
  const { id } = useParams<{ id: string }>();
  const user = useAuthStore((s) => s.user);
  const isAd =
    hasAnyPermission(user, ['sch-001:admin']) ||
    (user?.personType === 'STAFF' && hasAnyPermission(user, ['ath-002:write']));
  const { toast } = useToast();

  const gameQ = useAthleticsGame(id ?? null);
  const statsQ = useAthleticsGameStats(id ?? null);

  const [showResult, setShowResult] = useState(false);
  const [home, setHome] = useState('');
  const [away, setAway] = useState('');
  const [outcome, setOutcome] = useState<AthleticsGameOutcome>('WIN');
  const resultMut = useEnterGameResult(id ?? '');

  if (gameQ.isLoading) return <LoadingSpinner />;
  if (!gameQ.data) return <p className="text-gray-500">Game not found.</p>;
  const g = gameQ.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${g.programmeName ?? '—'} ${g.location === 'HOME' ? 'vs' : '@'} ${g.opponentName}`}
        description={`${formatDate(g.gameDate)} · ${formatTime(g.gameTime)} · ${g.rosterLevel ? ROSTER_LEVEL_LABELS[g.rosterLevel] : ''}`}
      />

      <div className="flex flex-wrap gap-2">
        <span className={`rounded px-2 py-1 text-xs ${GAME_LOCATION_PILL[g.location]}`}>
          {GAME_LOCATION_LABELS[g.location]}
        </span>
        <span className={`rounded px-2 py-1 text-xs ${GAME_STATUS_PILL[g.status]}`}>
          {GAME_STATUS_LABELS[g.status]}
        </span>
        {g.isConferenceGame ? (
          <span className="rounded bg-violet-100 px-2 py-1 text-xs text-violet-700">
            Conference
          </span>
        ) : null}
      </div>

      {g.result ? (
        <section className="rounded-xl border border-gray-200 bg-emerald-50 p-6">
          <h2 className="mb-2 text-lg font-semibold text-emerald-900">Final score</h2>
          <div className="text-3xl font-bold text-emerald-900">
            {g.result.homeScore} – {g.result.awayScore}
          </div>
          <div className="mt-1 text-sm text-emerald-700">
            {GAME_OUTCOME_LABELS[g.result.outcome]} · entered by {g.result.enteredByName ?? '—'} on{' '}
            {formatDate(g.result.enteredAt)}
          </div>
        </section>
      ) : isAd && g.status !== 'COMPLETED' && g.status !== 'CANCELLED' ? (
        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <button
            onClick={() => setShowResult(true)}
            className="rounded-lg bg-campus-600 px-4 py-2 text-sm text-white hover:bg-campus-700"
          >
            Enter result
          </button>
        </section>
      ) : null}

      {/* Box score */}
      <section className="rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-200 p-4 font-semibold text-gray-900">Box score</div>
        {statsQ.data && statsQ.data.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-4 py-2">Player</th>
                <th className="px-4 py-2">Category</th>
                <th className="px-4 py-2">Value</th>
              </tr>
            </thead>
            <tbody>
              {statsQ.data.map((s) => (
                <tr key={s.id} className="border-b border-gray-100">
                  <td className="px-4 py-2 font-medium text-gray-900">{s.studentName}</td>
                  <td className="px-4 py-2 text-gray-700">{s.statCategory}</td>
                  <td className="px-4 py-2 font-mono text-gray-700">{s.statValue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="p-4 text-sm text-gray-500">No stats entered yet.</p>
        )}
      </section>

      <Modal
        open={showResult}
        title="Enter game result"
        onClose={() => setShowResult(false)}
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowResult(false)}
              className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-700 hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                try {
                  await resultMut.mutateAsync({
                    homeScore: Number(home),
                    awayScore: Number(away),
                    outcome,
                  });
                  toast('Result recorded', 'success');
                  setShowResult(false);
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Failed', 'error');
                }
              }}
              disabled={resultMut.isPending}
              className="rounded-lg bg-campus-600 px-4 py-2 text-sm text-white hover:bg-campus-700 disabled:opacity-50"
            >
              Save result
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700">Home score</label>
              <input
                type="number"
                min={0}
                value={home}
                onChange={(e) => setHome(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Away score</label>
              <input
                type="number"
                min={0}
                value={away}
                onChange={(e) => setAway(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Outcome</label>
            <select
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as AthleticsGameOutcome)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="WIN">Win</option>
              <option value="LOSS">Loss</option>
              <option value="DRAW">Draw</option>
              <option value="FORFEIT">Forfeit</option>
            </select>
          </div>
        </div>
      </Modal>
    </div>
  );
}
