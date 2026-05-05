'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  PROGRAMME_SEASON_LABELS,
  ROSTER_LEVEL_LABELS,
  SEASON_STATUS_LABELS,
  SEASON_STATUS_PILL,
} from '@/lib/athletics-format';
import { useAthleticsProgrammes, useAthleticsSchedule } from '@/hooks/use-athletics';

export default function AthleticsLandingPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user?.personType === 'STAFF';
  const isAd = isAdmin || (isStaff && hasAnyPermission(user, ['ath-001:write']));
  const isStudent = user?.personType === 'STUDENT';
  const isParent = user?.personType === 'GUARDIAN';

  const programmesQ = useAthleticsProgrammes({ includeInactive: false });
  const scheduleQ = useAthleticsSchedule();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Athletics"
        description={
          isAd
            ? 'Programmes, rosters, games, results, and athlete injury tracking'
            : isStudent
              ? 'My sports, game schedule, and stats'
              : isParent
                ? "Game schedule and your child's athletic programmes"
                : 'Athletic programmes and game schedule'
        }
      />

      {/* Quick navigation */}
      <div className="flex flex-wrap gap-2">
        <Link
          href="/athletics/programmes"
          className="inline-flex items-center rounded-lg bg-campus-50 px-3 py-1.5 text-sm text-campus-700 hover:bg-campus-100"
        >
          Programmes
        </Link>
        <Link
          href="/athletics/schedule"
          className="inline-flex items-center rounded-lg bg-campus-50 px-3 py-1.5 text-sm text-campus-700 hover:bg-campus-100"
        >
          Game schedule
        </Link>
        {isStudent ? (
          <Link
            href="/athletics/my"
            className="inline-flex items-center rounded-lg bg-campus-50 px-3 py-1.5 text-sm text-campus-700 hover:bg-campus-100"
          >
            My sports
          </Link>
        ) : null}
        {isAd ? (
          <Link
            href="/athletics/injuries"
            className="inline-flex items-center rounded-lg bg-rose-50 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-100"
          >
            Injury log
          </Link>
        ) : null}
      </div>

      {/* Active programmes */}
      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Programmes</h2>
        {programmesQ.isLoading ? (
          <LoadingSpinner />
        ) : programmesQ.data && programmesQ.data.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {programmesQ.data.map((p) => (
              <Link
                key={p.id}
                href={`/athletics/programmes/${p.id}`}
                className="rounded-lg border border-gray-200 p-4 hover:border-campus-300 hover:bg-campus-50"
              >
                <div className="flex items-start justify-between">
                  <h3 className="font-medium text-gray-900">{p.sportName}</h3>
                  <span className="rounded bg-campus-100 px-2 py-0.5 text-xs text-campus-700">
                    {PROGRAMME_SEASON_LABELS[p.season]}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {p.levelsOffered.map((lvl) => (
                    <span
                      key={lvl}
                      className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700"
                    >
                      {ROSTER_LEVEL_LABELS[lvl]}
                    </span>
                  ))}
                </div>
                {p.minGpa !== null ? (
                  <div className="mt-2 text-xs text-gray-600">Min GPA: {p.minGpa.toFixed(1)}</div>
                ) : null}
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No active programmes yet.</p>
        )}
      </section>

      {/* Upcoming schedule */}
      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Upcoming games</h2>
        {scheduleQ.isLoading ? (
          <LoadingSpinner />
        ) : scheduleQ.data && scheduleQ.data.length > 0 ? (
          <div className="space-y-2">
            {scheduleQ.data.slice(0, 8).map((g) => (
              <Link
                key={g.id}
                href={`/athletics/games/${g.id}`}
                className="flex items-center justify-between rounded-lg border border-gray-200 p-3 hover:border-campus-300"
              >
                <div>
                  <div className="font-medium text-gray-900">
                    {g.programmeName ?? '—'} {g.location === 'HOME' ? 'vs' : '@'} {g.opponentName}
                  </div>
                  <div className="text-xs text-gray-500">
                    {new Date(g.gameDate).toLocaleDateString()} · {g.gameTime} ·{' '}
                    {g.rosterLevel ? ROSTER_LEVEL_LABELS[g.rosterLevel] : ''}
                  </div>
                </div>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    SEASON_STATUS_PILL[g.status as never] ?? 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {SEASON_STATUS_LABELS[g.status as never] ?? g.status}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No upcoming games scheduled.</p>
        )}
      </section>
    </div>
  );
}
