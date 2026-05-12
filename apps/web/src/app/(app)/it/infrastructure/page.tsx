'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useItInfrastructure } from '@/hooks/use-it';
import {
  useItInfrastructureWarrantyExpiring,
  useMarkItInfrastructureChecked,
} from '@/hooks/use-it-advanced';
import { IT_INFRA_LABELS, formatItDate } from '@/lib/it-format';
import { warrantyExpiryTone } from '@/lib/it-advanced-format';
import type { ItInfraItemType } from '@/lib/types';

const TYPES: ItInfraItemType[] = [
  'SWITCH',
  'ROUTER',
  'ACCESS_POINT',
  'FIREWALL',
  'SERVER',
  'STORAGE_ARRAY',
  'UPS',
  'PRINTER',
  'OTHER',
];

export default function InfrastructurePage() {
  const user = useAuthStore((s) => s.user);
  const canWrite = hasAnyPermission(user, ['it-007:write']);
  const [filter, setFilter] = useState<ItInfraItemType | undefined>(undefined);
  const items = useItInfrastructure({ itemType: filter });
  const warranty = useItInfrastructureWarrantyExpiring(30);
  const markChecked = useMarkItInfrastructureChecked();
  const { toast } = useToast();

  const run = async (id: string, itemName: string) => {
    try {
      await markChecked.mutateAsync(id);
      toast(`${itemName} marked as checked.`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not mark checked', 'error');
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <PageHeader
        title="Infrastructure"
        description="Network gear, servers, UPS, and other building IT items"
      />

      {(warranty.data?.length ?? 0) > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">
            Warranty expiring in 30 days ({warranty.data?.length})
          </h2>
          <ul className="mt-2 space-y-1">
            {warranty.data?.map((w) => (
              <li key={w.id} className="flex items-center justify-between text-xs">
                <span>
                  <strong>{w.itemName}</strong>{' '}
                  <span className="text-gray-500">
                    · {w.itemType} · {w.location}
                  </span>
                </span>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${warrantyExpiryTone(w.daysUntilExpiry)}`}
                >
                  {formatItDate(w.warrantyExpiry)} ·{' '}
                  {w.daysUntilExpiry < 0
                    ? `${Math.abs(w.daysUntilExpiry)}d overdue`
                    : `${w.daysUntilExpiry}d left`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`rounded-full border px-3 py-1 text-xs ${
            filter === undefined
              ? 'border-campus-600 bg-campus-100 text-campus-800'
              : 'border-gray-300 bg-white text-gray-700'
          }`}
          onClick={() => setFilter(undefined)}
        >
          All
        </button>
        {TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className={`rounded-full border px-3 py-1 text-xs ${
              filter === t
                ? 'border-campus-600 bg-campus-100 text-campus-800'
                : 'border-gray-300 bg-white text-gray-700'
            }`}
            onClick={() => setFilter(t)}
          >
            {IT_INFRA_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="p-3">Name</th>
              <th className="p-3">Type</th>
              <th className="p-3">Location</th>
              <th className="p-3">IP / MAC</th>
              <th className="p-3">Make / Model</th>
              <th className="p-3">Warranty</th>
              <th className="p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {items.data?.map((i) => (
              <tr key={i.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="p-3 font-medium">{i.itemName}</td>
                <td className="p-3 text-gray-700">{IT_INFRA_LABELS[i.itemType]}</td>
                <td className="p-3 text-gray-700">{i.location ?? '—'}</td>
                <td className="p-3 font-mono text-xs text-gray-500">
                  {i.ipAddress ?? '—'}
                  <br />
                  {i.macAddress ?? ''}
                </td>
                <td className="p-3 text-gray-700">
                  {i.make} {i.model}
                </td>
                <td className="p-3 text-gray-500">{formatItDate(i.warrantyExpiry)}</td>
                <td className="p-3">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      i.status === 'ACTIVE'
                        ? 'bg-emerald-100 text-emerald-700'
                        : i.status === 'MAINTENANCE'
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {i.status}
                  </span>
                </td>
                <td className="p-3 text-right">
                  {canWrite ? (
                    <button
                      type="button"
                      onClick={() => run(i.id, i.itemName)}
                      className="text-xs font-medium text-campus-700 hover:underline"
                    >
                      Mark checked
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {!items.isLoading && (items.data?.length ?? 0) === 0 ? (
              <tr>
                <td colSpan={8} className="p-6 text-center text-sm text-gray-500">
                  No infrastructure items.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
