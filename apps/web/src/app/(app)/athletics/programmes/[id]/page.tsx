'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  PROGRAMME_SEASON_LABELS,
  ROSTER_LEVELS,
  ROSTER_LEVEL_LABELS,
  SEASON_STATUS_LABELS,
  SEASON_STATUS_PILL,
  formatDate,
} from '@/lib/athletics-format';
import {
  useAthleticsProgramme,
  useAthleticsRostersForSeason,
  useAthleticsSeasonsForProgramme,
  useCreateAthleticsRoster,
  useCreateAthleticsSeason,
} from '@/hooks/use-athletics';
import type { AthleticsRosterLevel } from '@/lib/types';

export default function ProgrammeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const user = useAuthStore((s) => s.user);
  const isAd =
    hasAnyPermission(user, ['sch-001:admin']) ||
    (user?.personType === 'STAFF' && hasAnyPermission(user, ['ath-001:write']));
  const { toast } = useToast();

  const programmeQ = useAthleticsProgramme(id ?? null);
  const seasonsQ = useAthleticsSeasonsForProgramme(id ?? null);
  const [activeSeasonId, setActiveSeasonId] = useState<string | null>(null);
  const effectiveSeasonId =
    activeSeasonId ??
    seasonsQ.data?.find((s) => s.status === 'ACTIVE')?.id ??
    seasonsQ.data?.[0]?.id ??
    null;
  const rostersQ = useAthleticsRostersForSeason(effectiveSeasonId);

  const [showSeason, setShowSeason] = useState(false);
  const [showRoster, setShowRoster] = useState(false);
  const [draftAcademicYear, setDraftAcademicYear] = useState('2025-2026');
  const [draftLevel, setDraftLevel] = useState<AthleticsRosterLevel>('VARSITY');

  const seasonMut = useCreateAthleticsSeason(id ?? '');
  const rosterMut = useCreateAthleticsRoster(effectiveSeasonId ?? '');

  if (programmeQ.isLoading) return <LoadingSpinner />;
  if (!programmeQ.data) return <p className="text-gray-500">Programme not found.</p>;
  const p = programmeQ.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={p.sportName}
        description={`${PROGRAMME_SEASON_LABELS[p.season]} · Levels: ${p.levelsOffered.map((l) => ROSTER_LEVEL_LABELS[l]).join(', ')}${p.minGpa !== null ? ` · Min GPA ${p.minGpa.toFixed(2)}` : ''}`}
      />

      {/* Seasons */}
      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Seasons</h2>
          {isAd ? (
            <button
              onClick={() => setShowSeason(true)}
              className="rounded-lg bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
            >
              New season
            </button>
          ) : null}
        </div>
        {seasonsQ.isLoading ? (
          <LoadingSpinner />
        ) : seasonsQ.data && seasonsQ.data.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {seasonsQ.data.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveSeasonId(s.id)}
                className={`rounded-lg border p-3 text-left ${
                  effectiveSeasonId === s.id
                    ? 'border-campus-600 bg-campus-50'
                    : 'border-gray-200 hover:border-campus-300'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="font-medium">{s.academicYear}</div>
                  <span className={`rounded px-2 py-0.5 text-xs ${SEASON_STATUS_PILL[s.status]}`}>
                    {SEASON_STATUS_LABELS[s.status]}
                  </span>
                </div>
                <div className="mt-1 text-xs text-gray-500">
                  {formatDate(s.firstGameDate)} – {formatDate(s.lastGameDate)}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No seasons yet.</p>
        )}
      </section>

      {/* Rosters for active season */}
      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Rosters</h2>
          {isAd && effectiveSeasonId ? (
            <button
              onClick={() => setShowRoster(true)}
              className="rounded-lg bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
            >
              Add roster
            </button>
          ) : null}
        </div>
        {effectiveSeasonId ? (
          rostersQ.isLoading ? (
            <LoadingSpinner />
          ) : rostersQ.data && rostersQ.data.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {rostersQ.data.map((r) => (
                <Link
                  key={r.id}
                  href={`/athletics/rosters/${r.id}`}
                  className="rounded-lg border border-gray-200 p-4 hover:border-campus-300"
                >
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-gray-900">{ROSTER_LEVEL_LABELS[r.level]}</div>
                    {r.isCertified ? (
                      <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                        Certified
                      </span>
                    ) : (
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                        Draft
                      </span>
                    )}
                  </div>
                  <div className="mt-2 text-xs text-gray-500">
                    {r.headCoachName ? `Coach: ${r.headCoachName}` : 'No head coach'}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    {r.eligibleCount ?? 0}/{r.memberCount ?? 0} eligible members
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500">No rosters in this season.</p>
          )
        ) : (
          <p className="text-sm text-gray-500">Select a season above.</p>
        )}
      </section>

      <Modal
        open={showSeason}
        title="New season"
        onClose={() => setShowSeason(false)}
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowSeason(false)}
              className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-700 hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                try {
                  await seasonMut.mutateAsync({ academicYear: draftAcademicYear });
                  toast('Season created', 'success');
                  setShowSeason(false);
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Failed', 'error');
                }
              }}
              disabled={seasonMut.isPending}
              className="rounded-lg bg-campus-600 px-4 py-2 text-sm text-white hover:bg-campus-700 disabled:opacity-50"
            >
              Create
            </button>
          </div>
        }
      >
        <div>
          <label className="block text-sm font-medium text-gray-700">Academic year</label>
          <input
            type="text"
            value={draftAcademicYear}
            onChange={(e) => setDraftAcademicYear(e.target.value)}
            placeholder="2025-2026"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
      </Modal>

      <Modal
        open={showRoster}
        title="Add roster"
        onClose={() => setShowRoster(false)}
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowRoster(false)}
              className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-700 hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                try {
                  await rosterMut.mutateAsync({ level: draftLevel });
                  toast('Roster created', 'success');
                  setShowRoster(false);
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Failed', 'error');
                }
              }}
              disabled={rosterMut.isPending}
              className="rounded-lg bg-campus-600 px-4 py-2 text-sm text-white hover:bg-campus-700 disabled:opacity-50"
            >
              Create
            </button>
          </div>
        }
      >
        <div>
          <label className="block text-sm font-medium text-gray-700">Level</label>
          <select
            value={draftLevel}
            onChange={(e) => setDraftLevel(e.target.value as AthleticsRosterLevel)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            {ROSTER_LEVELS.filter((l) => p.levelsOffered.includes(l)).map((l) => (
              <option key={l} value={l}>
                {ROSTER_LEVEL_LABELS[l]}
              </option>
            ))}
          </select>
        </div>
      </Modal>
    </div>
  );
}
