'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useAuthStore } from '@/lib/auth-store';
import {
  ELIGIBILITY_PILL,
  GAME_LOCATION_LABELS,
  GAME_OUTCOME_LABELS,
  GAME_STATUS_LABELS,
  GAME_STATUS_PILL,
  RETURN_TO_PLAY_LABELS,
  ROSTER_LEVEL_LABELS,
  formatDate,
  formatTime,
} from '@/lib/athletics-format';
import { useAthleticsInjuries, useAthleticsSchedule } from '@/hooks/use-athletics';

export default function StudentAthleticsPortal() {
  const user = useAuthStore((s) => s.user);
  const isStudent = user?.personType === 'STUDENT';

  const scheduleQ = useAthleticsSchedule();
  const injuriesQ = useAthleticsInjuries();

  if (!isStudent) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-6">
        <h2 className="text-lg font-semibold text-amber-900">Student-only surface</h2>
        <p className="mt-2 text-sm text-amber-800">
          The &quot;My sports&quot; page is for student-athletes only. Use the{' '}
          <Link href="/athletics" className="underline">
            Athletics dashboard
          </Link>{' '}
          for the staff and parent view.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="My sports" description="Game schedule, eligibility, and injury status" />

      {/* Upcoming games */}
      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Upcoming games</h2>
        {scheduleQ.isLoading ? (
          <LoadingSpinner />
        ) : scheduleQ.data && scheduleQ.data.length > 0 ? (
          <div className="space-y-2">
            {scheduleQ.data.slice(0, 6).map((g) => (
              <div
                key={g.id}
                className="flex items-center justify-between rounded-lg border border-gray-200 p-3"
              >
                <div>
                  <div className="font-medium text-gray-900">
                    {g.programmeName} {g.location === 'HOME' ? 'vs' : '@'} {g.opponentName}
                  </div>
                  <div className="text-xs text-gray-500">
                    {formatDate(g.gameDate)} · {formatTime(g.gameTime)} ·{' '}
                    {GAME_LOCATION_LABELS[g.location]}
                    {g.rosterLevel ? ` · ${ROSTER_LEVEL_LABELS[g.rosterLevel]}` : ''}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={`rounded px-2 py-0.5 text-xs ${GAME_STATUS_PILL[g.status]}`}>
                    {GAME_STATUS_LABELS[g.status]}
                  </span>
                  {g.result ? (
                    <span className="text-xs text-gray-700">
                      {g.result.homeScore}-{g.result.awayScore}{' '}
                      {GAME_OUTCOME_LABELS[g.result.outcome]}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No upcoming games.</p>
        )}
      </section>

      {/* Injury history (own) */}
      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-3 text-lg font-semibold text-gray-900">My injury history</h2>
        {injuriesQ.isLoading ? (
          <LoadingSpinner />
        ) : injuriesQ.data && injuriesQ.data.length > 0 ? (
          <div className="space-y-2">
            {injuriesQ.data.map((i) => (
              <Link
                key={i.id}
                href={`/athletics/injuries/${i.id}`}
                className="block rounded-lg border border-gray-200 p-3 hover:border-campus-300"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-medium text-gray-900">{i.bodyPart}</div>
                    <div className="text-xs text-gray-500">{formatDate(i.injuryDate)}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${ELIGIBILITY_PILL[i.returnToPlayStatus === 'CLEARED' ? 'ELIGIBLE' : i.returnToPlayStatus === 'CONCUSSION_PROTOCOL' ? 'INJURED_NOT_CLEARED' : 'INELIGIBLE']}`}
                    >
                      {RETURN_TO_PLAY_LABELS[i.returnToPlayStatus]}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No injuries on file. Stay healthy!</p>
        )}
      </section>
    </div>
  );
}
