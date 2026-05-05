'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
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
import { useAthleticsGames } from '@/hooks/use-athletics';

export default function AthleticsSchedulePage() {
  const gamesQ = useAthleticsGames();

  return (
    <div className="space-y-6">
      <PageHeader title="Game schedule" description="All scheduled and completed games" />

      {gamesQ.isLoading ? (
        <LoadingSpinner />
      ) : gamesQ.data && gamesQ.data.length > 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Sport</th>
                <th className="px-4 py-2">Level</th>
                <th className="px-4 py-2">Opponent</th>
                <th className="px-4 py-2">Loc</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Score</th>
              </tr>
            </thead>
            <tbody>
              {gamesQ.data.map((g) => (
                <tr key={g.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <Link
                      href={`/athletics/games/${g.id}`}
                      className="text-campus-700 hover:underline"
                    >
                      {formatDate(g.gameDate)}
                    </Link>
                    <div className="text-xs text-gray-500">{formatTime(g.gameTime)}</div>
                  </td>
                  <td className="px-4 py-2 text-gray-700">{g.programmeName ?? '—'}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {g.rosterLevel ? ROSTER_LEVEL_LABELS[g.rosterLevel] : '—'}
                  </td>
                  <td className="px-4 py-2 font-medium text-gray-900">{g.opponentName}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${GAME_LOCATION_PILL[g.location]}`}
                    >
                      {GAME_LOCATION_LABELS[g.location]}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs ${GAME_STATUS_PILL[g.status]}`}>
                      {GAME_STATUS_LABELS[g.status]}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-700">
                    {g.result
                      ? `${g.result.homeScore} – ${g.result.awayScore} ${GAME_OUTCOME_LABELS[g.result.outcome]}`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-gray-500">No games scheduled.</p>
      )}
    </div>
  );
}
