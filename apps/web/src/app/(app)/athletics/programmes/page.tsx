'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  PROGRAMME_SEASONS,
  PROGRAMME_SEASON_LABELS,
  ROSTER_LEVELS,
  ROSTER_LEVEL_LABELS,
} from '@/lib/athletics-format';
import { useAthleticsProgrammes, useCreateAthleticsProgramme } from '@/hooks/use-athletics';
import type { AthleticsProgrammeSeason, AthleticsRosterLevel } from '@/lib/types';

export default function AthleticsProgrammesPage() {
  const user = useAuthStore((s) => s.user);
  const isAd =
    hasAnyPermission(user, ['sch-001:admin']) ||
    (user?.personType === 'STAFF' && hasAnyPermission(user, ['ath-001:write']));
  const { toast } = useToast();

  const [includeInactive, setIncludeInactive] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const programmesQ = useAthleticsProgrammes({ includeInactive });
  const createMut = useCreateAthleticsProgramme();

  const [draftSport, setDraftSport] = useState('');
  const [draftSeason, setDraftSeason] = useState<AthleticsProgrammeSeason>('FALL');
  const [draftLevels, setDraftLevels] = useState<AthleticsRosterLevel[]>(['VARSITY']);
  const [draftMinGpa, setDraftMinGpa] = useState<string>('2.0');

  function toggleLevel(lvl: AthleticsRosterLevel) {
    setDraftLevels((prev) => (prev.includes(lvl) ? prev.filter((l) => l !== lvl) : [...prev, lvl]));
  }

  async function submitCreate() {
    if (!draftSport.trim()) {
      toast('Sport name is required', 'error');
      return;
    }
    if (draftLevels.length === 0) {
      toast('Pick at least one level', 'error');
      return;
    }
    try {
      await createMut.mutateAsync({
        sportName: draftSport.trim(),
        season: draftSeason,
        levelsOffered: draftLevels,
        minGpa: draftMinGpa ? Number(draftMinGpa) : undefined,
      });
      toast('Programme created', 'success');
      setShowCreate(false);
      setDraftSport('');
      setDraftSeason('FALL');
      setDraftLevels(['VARSITY']);
      setDraftMinGpa('2.0');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to create programme', 'error');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Programmes" description="All sport programmes for this school" />

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Include inactive
        </label>
        {isAd ? (
          <button
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700"
          >
            New programme
          </button>
        ) : null}
      </div>

      {programmesQ.isLoading ? (
        <LoadingSpinner />
      ) : programmesQ.data && programmesQ.data.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {programmesQ.data.map((p) => (
            <Link
              key={p.id}
              href={`/athletics/programmes/${p.id}`}
              className="rounded-xl border border-gray-200 bg-white p-5 hover:border-campus-300"
            >
              <div className="flex items-start justify-between">
                <h3 className="text-lg font-semibold text-gray-900">{p.sportName}</h3>
                <span className="rounded bg-campus-100 px-2 py-0.5 text-xs text-campus-700">
                  {PROGRAMME_SEASON_LABELS[p.season]}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                {p.levelsOffered.map((l) => (
                  <span key={l} className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                    {ROSTER_LEVEL_LABELS[l]}
                  </span>
                ))}
              </div>
              {p.minGpa !== null ? (
                <div className="mt-3 text-xs text-gray-600">Min GPA: {p.minGpa.toFixed(2)}</div>
              ) : null}
              {!p.isActive ? <div className="mt-3 text-xs text-rose-600">Inactive</div> : null}
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-500">No programmes yet.</p>
      )}

      <Modal
        open={showCreate}
        title="New programme"
        onClose={() => setShowCreate(false)}
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-700 hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitCreate}
              disabled={createMut.isPending}
              className="rounded-lg bg-campus-600 px-4 py-2 text-sm text-white hover:bg-campus-700 disabled:opacity-50"
            >
              Create
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Sport name</label>
            <input
              type="text"
              value={draftSport}
              onChange={(e) => setDraftSport(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Season</label>
            <select
              value={draftSeason}
              onChange={(e) => setDraftSeason(e.target.value as AthleticsProgrammeSeason)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              {PROGRAMME_SEASONS.map((s) => (
                <option key={s} value={s}>
                  {PROGRAMME_SEASON_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Levels offered</label>
            <div className="mt-1 flex flex-wrap gap-2">
              {ROSTER_LEVELS.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => toggleLevel(l)}
                  className={`rounded px-3 py-1 text-sm ${
                    draftLevels.includes(l)
                      ? 'bg-campus-600 text-white'
                      : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {ROSTER_LEVEL_LABELS[l]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Minimum GPA (optional)
            </label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="4"
              value={draftMinGpa}
              onChange={(e) => setDraftMinGpa(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
