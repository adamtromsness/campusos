'use client';

import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useExpiredSafety, useRosterSafety } from '@/hooks/use-athletics-advanced';
import {
  useAthleticsProgrammes,
  useAthleticsRostersForSeason,
  useAthleticsSeasonsForProgramme,
} from '@/hooks/use-athletics';

const COMPLIANCE_PILL: Record<string, string> = {
  GREEN: 'bg-emerald-100 text-emerald-700',
  AMBER: 'bg-amber-100 text-amber-700',
  ROSE: 'bg-rose-100 text-rose-700',
  NEUTRAL: 'bg-gray-100 text-gray-600',
};

export default function SafetyComplianceDashboardPage() {
  const programmesQ = useAthleticsProgrammes();
  const [programmeId, setProgrammeId] = useState<string | null>(null);
  const seasonsQ = useAthleticsSeasonsForProgramme(programmeId);
  const [seasonId, setSeasonId] = useState<string | null>(null);
  const rostersQ = useAthleticsRostersForSeason(seasonId);
  const [rosterId, setRosterId] = useState<string | null>(null);

  const safetyQ = useRosterSafety(rosterId);
  const expiredQ = useExpiredSafety();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Safety Compliance"
        description="Per-roster safety equipment checklist with certification expiry tracking"
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Programme</label>
          <select
            value={programmeId ?? ''}
            onChange={(e) => {
              setProgrammeId(e.target.value || null);
              setSeasonId(null);
              setRosterId(null);
            }}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">— select —</option>
            {programmesQ.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sportName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Season</label>
          <select
            value={seasonId ?? ''}
            onChange={(e) => {
              setSeasonId(e.target.value || null);
              setRosterId(null);
            }}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            disabled={!programmeId}
          >
            <option value="">— select —</option>
            {seasonsQ.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.academicYear} — {s.status}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Roster</label>
          <select
            value={rosterId ?? ''}
            onChange={(e) => setRosterId(e.target.value || null)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            disabled={!seasonId}
          >
            <option value="">— select —</option>
            {rostersQ.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.level}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!rosterId ? (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-gray-500">
          Pick a roster above to see compliance.
        </div>
      ) : safetyQ.isLoading ? (
        <LoadingSpinner />
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-2 text-xs font-semibold uppercase text-gray-500">Student</th>
                <th className="px-4 py-2 text-xs font-semibold uppercase text-gray-500">
                  Equipment
                </th>
                <th className="px-4 py-2 text-xs font-semibold uppercase text-gray-500">Issued</th>
                <th className="px-4 py-2 text-xs font-semibold uppercase text-gray-500">
                  Cert expires
                </th>
                <th className="px-4 py-2 text-xs font-semibold uppercase text-gray-500">State</th>
              </tr>
            </thead>
            <tbody>
              {safetyQ.data?.map((row) => (
                <tr key={row.id} className="border-t border-gray-100">
                  <td className="px-4 py-3 font-medium text-gray-900">{row.studentName ?? '—'}</td>
                  <td className="px-4 py-3 text-xs text-gray-700">{row.equipmentType}</td>
                  <td className="px-4 py-3 text-gray-700">{row.issued ? 'Yes' : 'No'}</td>
                  <td className="px-4 py-3 text-gray-700">{row.certificationExpiry ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${COMPLIANCE_PILL[row.complianceState]}`}
                    >
                      {row.complianceState}
                    </span>
                  </td>
                </tr>
              ))}
              {(safetyQ.data?.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                    No safety equipment recorded for this roster.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <section>
        <h2 className="font-display text-xl text-campus-700 mb-2">Expired certifications</h2>
        {expiredQ.isLoading ? (
          <LoadingSpinner />
        ) : (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-4">
            {(expiredQ.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-emerald-800">No expired certifications.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {expiredQ.data!.map((row) => (
                  <li key={row.id}>
                    <span className="font-medium">{row.studentName}</span> — {row.equipmentType}{' '}
                    expired {row.certificationExpiry}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
