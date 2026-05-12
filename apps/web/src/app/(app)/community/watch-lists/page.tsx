'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  CONDITION_LABELS,
  LISTING_TYPE_LABELS,
  formatCents,
  useCreateWatchList,
  useWatchLists,
  type ItemCondition,
  type ListingType,
} from '@/hooks/use-community';

const LISTING_TYPE_OPTIONS: ListingType[] = [
  'EDUCATIONAL',
  'PORTFOLIO',
  'FIELD_TRIP',
  'SURPLUS_ASSET',
  'BOOK',
  'KNOWLEDGE',
];

const CONDITION_OPTIONS: ItemCondition[] = ['NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'POOR'];

/**
 * P2-21c — School Watch Lists.
 *
 * Schools register search criteria; the WatchListMatchConsumer matches
 * on every new listing publication and surfaces matching watch lists.
 *
 * Notification fan-out is wired into the future Cycle 14 notification
 * pipeline — for now the surface is the watch-list management UI plus
 * the API-side log line.
 */
export default function WatchListsPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['mkt-007:read']);
  const canWrite = !!user && hasAnyPermission(user, ['mkt-007:write']);

  const lists = useWatchLists(false);
  const create = useCreateWatchList();

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<{
    targetListingType: ListingType;
    searchKeywords: string;
    maxPriceCents: string;
    conditionMin: ItemCondition | '';
  }>({
    targetListingType: 'BOOK',
    searchKeywords: '',
    maxPriceCents: '',
    conditionMin: '',
  });
  const [error, setError] = useState<string | null>(null);

  if (!user) return <LoadingSpinner />;
  if (!canRead) {
    return (
      <EmptyState
        title="Not available"
        description="Watch lists are managed by school staff with MKT-007:read."
      />
    );
  }

  const onCreate = async (): Promise<void> => {
    setError(null);
    try {
      await create.mutateAsync({
        targetListingType: form.targetListingType,
        searchKeywords: form.searchKeywords.trim() || undefined,
        maxPriceCents: form.maxPriceCents ? Number(form.maxPriceCents) * 100 : undefined,
        conditionMin: form.conditionMin || undefined,
      });
      setShowForm(false);
      setForm({
        targetListingType: 'BOOK',
        searchKeywords: '',
        maxPriceCents: '',
        conditionMin: '',
      });
    } catch (e) {
      setError(String((e as Error).message ?? 'Failed to create watch list'));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Watch Lists"
        description="When new marketplace listings match your criteria, you'll be notified."
        actions={
          canWrite ? (
            <button
              type="button"
              onClick={() => setShowForm((v) => !v)}
              className="rounded-md bg-campus-600 px-3 py-2 text-sm font-medium text-white hover:bg-campus-700"
            >
              {showForm ? 'Cancel' : 'New watch list'}
            </button>
          ) : null
        }
      />

      {showForm && canWrite && (
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="text-base font-semibold text-gray-900">New watch list</h3>
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-700">Listing type</label>
              <select
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                value={form.targetListingType}
                onChange={(e) =>
                  setForm((f) => ({ ...f, targetListingType: e.target.value as ListingType }))
                }
              >
                {LISTING_TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {LISTING_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700">Minimum condition</label>
              <select
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                value={form.conditionMin}
                onChange={(e) =>
                  setForm((f) => ({ ...f, conditionMin: e.target.value as ItemCondition | '' }))
                }
              >
                <option value="">No minimum</option>
                {CONDITION_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {CONDITION_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-700">Keywords</label>
              <input
                type="text"
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                placeholder="e.g. science lab kit"
                value={form.searchKeywords}
                onChange={(e) => setForm((f) => ({ ...f, searchKeywords: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700">Max price (USD)</label>
              <input
                type="number"
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                placeholder="optional"
                value={form.maxPriceCents}
                onChange={(e) => setForm((f) => ({ ...f, maxPriceCents: e.target.value }))}
              />
            </div>
          </div>
          {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
          <div className="mt-4">
            <button
              type="button"
              onClick={onCreate}
              disabled={create.isPending}
              className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {create.isPending ? 'Saving…' : 'Save watch list'}
            </button>
          </div>
        </div>
      )}

      {lists.isPending ? (
        <LoadingSpinner />
      ) : (lists.data ?? []).length === 0 ? (
        <EmptyState
          title="No watch lists yet"
          description={
            canWrite
              ? 'Create one to be notified when matching listings appear.'
              : 'Your school admin has not set up any watch lists.'
          }
        />
      ) : (
        <ul className="space-y-3">
          {(lists.data ?? []).map((w) => (
            <li key={w.id} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {LISTING_TYPE_LABELS[w.targetListingType]}
                    {w.searchKeywords && (
                      <span className="ml-2 text-xs font-normal text-gray-500">
                        “{w.searchKeywords}”
                      </span>
                    )}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-3 text-xs text-gray-600">
                    {w.maxPriceCents !== null && <span>≤ {formatCents(w.maxPriceCents)}</span>}
                    {w.conditionMin && (
                      <span>min condition: {CONDITION_LABELS[w.conditionMin]}</span>
                    )}
                  </div>
                </div>
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                  {w.status}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
