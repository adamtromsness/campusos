'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useItAssetCategories, useItAssets } from '@/hooks/use-it';
import { IT_ASSET_STATUS_LABELS, IT_ASSET_STATUS_PILL, formatItDate } from '@/lib/it-format';
import type { ItAssetStatus } from '@/lib/types';

const STATUSES: ItAssetStatus[] = ['AVAILABLE', 'ASSIGNED', 'REPAIR', 'LOST', 'RETIRED'];

export default function AssetsPage() {
  const [status, setStatus] = useState<ItAssetStatus | undefined>(undefined);
  const [categoryId, setCategoryId] = useState<string | undefined>(undefined);
  const cats = useItAssetCategories();
  const assets = useItAssets({ status, categoryId });

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <PageHeader title="Assets" description="IT asset fleet" />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`rounded-full border px-3 py-1 text-xs ${
            status === undefined
              ? 'border-campus-600 bg-campus-100 text-campus-800'
              : 'border-gray-300 bg-white text-gray-700'
          }`}
          onClick={() => setStatus(undefined)}
        >
          All ({assets.data?.length ?? 0})
        </button>
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={`rounded-full border px-3 py-1 text-xs ${
              status === s
                ? 'border-campus-600 bg-campus-100 text-campus-800'
                : 'border-gray-300 bg-white text-gray-700'
            }`}
            onClick={() => setStatus(s)}
          >
            {IT_ASSET_STATUS_LABELS[s]}
          </button>
        ))}
        <select
          className="ml-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
          value={categoryId ?? ''}
          onChange={(e) => setCategoryId(e.target.value || undefined)}
        >
          <option value="">All categories</option>
          {cats.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.assetCount})
            </option>
          ))}
        </select>
      </div>
      <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="p-3">Tag</th>
              <th className="p-3">Category</th>
              <th className="p-3">Make / Model</th>
              <th className="p-3">Status</th>
              <th className="p-3">Assignee</th>
              <th className="p-3">Warranty</th>
            </tr>
          </thead>
          <tbody>
            {assets.data?.map((a) => (
              <tr key={a.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="p-3">
                  <Link
                    href={`/it/assets/${a.id}`}
                    className="font-medium text-campus-700 hover:underline"
                  >
                    {a.assetTag}
                  </Link>
                </td>
                <td className="p-3 text-gray-700">{a.categoryName}</td>
                <td className="p-3 text-gray-700">
                  {a.make} {a.model}
                </td>
                <td className="p-3">
                  <span className={`rounded px-2 py-0.5 text-xs ${IT_ASSET_STATUS_PILL[a.status]}`}>
                    {IT_ASSET_STATUS_LABELS[a.status]}
                  </span>
                </td>
                <td className="p-3 text-gray-700">{a.currentAssigneeName ?? '—'}</td>
                <td className="p-3 text-gray-500">{formatItDate(a.warrantyExpiry)}</td>
              </tr>
            ))}
            {!assets.isLoading && (assets.data?.length ?? 0) === 0 ? (
              <tr>
                <td className="p-6 text-center text-sm text-gray-500" colSpan={6}>
                  No assets match the current filter.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
