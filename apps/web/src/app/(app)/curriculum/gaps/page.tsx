'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useCurDeliveryGaps, useCurMaps, useRefreshCurGaps } from '@/hooks/use-curriculum';
import { CUR_GAP_TYPE_BG, CUR_GAP_TYPE_LABELS, CUR_GAP_TYPE_PILL } from '@/lib/curriculum-format';
import type { CurDeliveryGapDto, CurGapType } from '@/lib/types';

const TYPES: CurGapType[] = ['NOT_STARTED', 'PARTIAL', 'COMPLETE'];

export default function DeliveryGapsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = hasAnyPermission(user, ['tch-008:admin', 'sch-001:admin']);
  const { toast } = useToast();
  const [mapFilter, setMapFilter] = useState<string | undefined>(undefined);
  const [typeFilter, setTypeFilter] = useState<CurGapType | undefined>(undefined);

  const maps = useCurMaps();
  const gaps = useCurDeliveryGaps({
    curriculumMapId: mapFilter,
    gapType: typeFilter,
  });
  const refresh = useRefreshCurGaps();

  async function handleRefresh() {
    try {
      const res = await refresh.mutateAsync();
      toast(`Refreshed — scanned ${res.unitsScanned} unit(s), wrote ${res.gapsWritten} gap(s)`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  // Build heatmap: rows = standards, columns = units
  const grid = new Map<string, Map<string, CurDeliveryGapDto>>();
  const allUnits = new Map<string, string>();
  for (const g of gaps.data ?? []) {
    if (!grid.has(g.standardCode)) grid.set(g.standardCode, new Map());
    grid.get(g.standardCode)!.set(g.unitId, g);
    allUnits.set(g.unitId, g.unitTitle);
  }
  const standardCodes = [...grid.keys()].sort();
  const unitEntries = [...allUnits.entries()];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Delivery gaps"
        description="Materialised nightly per ADR-018. Compares planned lessons against delivered lessons per (unit, standard) tuple."
      />

      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
          value={mapFilter ?? ''}
          onChange={(e) => setMapFilter(e.target.value || undefined)}
        >
          <option value="">All maps</option>
          {maps.data?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>

        <button
          type="button"
          className={`rounded-full border px-3 py-1 text-xs ${
            typeFilter === undefined
              ? 'border-campus-600 bg-campus-100 text-campus-800'
              : 'border-gray-300 bg-white text-gray-700'
          }`}
          onClick={() => setTypeFilter(undefined)}
        >
          All
        </button>
        {TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className={`rounded-full border px-3 py-1 text-xs ${
              typeFilter === t
                ? 'border-campus-600 bg-campus-100 text-campus-800'
                : 'border-gray-300 bg-white text-gray-700'
            }`}
            onClick={() => setTypeFilter(t)}
          >
            {CUR_GAP_TYPE_LABELS[t]}
          </button>
        ))}

        {isAdmin ? (
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refresh.isPending}
            className="ml-auto rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700 disabled:opacity-50"
          >
            {refresh.isPending ? 'Refreshing…' : 'Re-materialise gaps'}
          </button>
        ) : null}
      </div>

      {gaps.isLoading ? (
        <p className="text-sm text-gray-500">Loading gaps…</p>
      ) : (gaps.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-gray-500">No gaps recorded for the current filters.</p>
      ) : (
        <>
          <section className="rounded-md border border-gray-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-gray-700">Heatmap</h2>
            <div className="overflow-x-auto">
              <table className="text-sm">
                <thead>
                  <tr>
                    <th className="border-b border-gray-200 p-2 text-left text-xs uppercase text-gray-500">
                      Standard
                    </th>
                    {unitEntries.map(([uid, title]) => (
                      <th
                        key={uid}
                        className="border-b border-gray-200 p-2 text-left text-xs uppercase text-gray-500"
                      >
                        {title}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {standardCodes.map((code) => (
                    <tr key={code}>
                      <td className="border-b border-gray-100 p-2 font-mono text-xs">{code}</td>
                      {unitEntries.map(([uid]) => {
                        const g = grid.get(code)?.get(uid);
                        return (
                          <td
                            key={uid}
                            className={`border-b border-gray-100 p-2 text-xs ${
                              g ? CUR_GAP_TYPE_BG[g.gapType] : ''
                            }`}
                            title={
                              g
                                ? `${g.lessonsDelivered}/${g.lessonsPlanned} lessons`
                                : 'Not aligned'
                            }
                          >
                            {g ? `${g.lessonsDelivered}/${g.lessonsPlanned}` : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-md border border-gray-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-gray-700">
              All gaps ({gaps.data?.length ?? 0})
            </h2>
            <ul className="divide-y divide-gray-100 text-sm">
              {gaps.data?.map((g) => (
                <li key={g.id} className="flex items-center justify-between py-2">
                  <div>
                    <Link
                      href={`/curriculum/units/${g.unitId}`}
                      className="font-medium text-campus-700 hover:underline"
                    >
                      {g.unitTitle}
                    </Link>
                    <p className="text-xs text-gray-500 font-mono">{g.standardCode}</p>
                    <p className="line-clamp-1 text-xs text-gray-400">{g.standardDescription}</p>
                  </div>
                  <span className={`rounded px-2 py-0.5 text-xs ${CUR_GAP_TYPE_PILL[g.gapType]}`}>
                    {CUR_GAP_TYPE_LABELS[g.gapType]} · {g.lessonsDelivered}/{g.lessonsPlanned}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
