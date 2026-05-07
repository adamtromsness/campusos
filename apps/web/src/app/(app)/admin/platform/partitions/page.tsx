'use client';

import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { usePartitions } from '@/hooks/use-platform-admin';

/**
 * Cycle 31 Step 9 — Partitions surface.
 *
 * Lists every RANGE/HASH partitioned parent + its leaves. Surfaces
 * row count + size per leaf so an operator can spot leaves that need
 * archiving or pre-emptive splitting before they hit the partition
 * activation runbook (infra/partition-activation-runbook.md).
 */
export default function PartitionsPage() {
  const user = useAuthStore((s) => s.user);
  const isPlatformAdmin = !!user && hasAnyPermission(user, ['sys-001:admin']);
  const [filter, setFilter] = useState('');
  const partitions = usePartitions();

  const grouped = useMemo(() => {
    const map = new Map<string, typeof partitions.data>();
    for (const p of partitions.data ?? []) {
      if (filter && !p.parentTable.toLowerCase().includes(filter.toLowerCase())) continue;
      const arr = map.get(p.parentTable) ?? [];
      arr.push(p);
      map.set(p.parentTable, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [partitions.data, filter]);

  if (!user) return null;
  if (!isPlatformAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Partitions" />
        <EmptyState title="Platform Admin only" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Partitions"
        description="RANGE / HASH partition leaves with row count + size. Drift indicates a missing partition rotation."
      />

      <input
        type="text"
        placeholder="Filter by parent table…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm sm:max-w-sm"
      />

      {partitions.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : grouped.length === 0 ? (
        <EmptyState
          title="No partitions found"
          description="Either nothing matches the filter, or the platform schema has no partitioned tables."
        />
      ) : (
        <div className="space-y-4">
          {grouped.map(([parent, leaves]) => (
            <details
              key={parent}
              open={grouped.length === 1}
              className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card"
            >
              <summary className="cursor-pointer bg-gray-50 px-4 py-2 font-mono text-sm text-gray-900 hover:bg-gray-100">
                {parent} ({leaves?.length ?? 0} leaves)
              </summary>
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-white text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Leaf</th>
                    <th className="px-3 py-2 text-left">Range</th>
                    <th className="px-3 py-2 text-right">Rows</th>
                    <th className="px-3 py-2 text-right">Size (MB)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {leaves?.map((p) => (
                    <tr key={p.partitionName} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono text-xs text-gray-900">
                        {p.partitionName}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-700">
                        {p.rangeFrom} {p.rangeTo && '→'} {p.rangeTo}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                        {p.rowCount?.toLocaleString() ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                        {p.sizeMb ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
