'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useItInfrastructure } from '@/hooks/use-it';
import { IT_INFRA_LABELS, formatItDate } from '@/lib/it-format';
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
  const [filter, setFilter] = useState<ItInfraItemType | undefined>(undefined);
  const items = useItInfrastructure({ itemType: filter });

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <PageHeader
        title="Infrastructure"
        description="Network gear, servers, UPS, and other building IT items"
      />
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
                        : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {i.status}
                  </span>
                </td>
              </tr>
            ))}
            {!items.isLoading && (items.data?.length ?? 0) === 0 ? (
              <tr>
                <td colSpan={7} className="p-6 text-center text-sm text-gray-500">
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
