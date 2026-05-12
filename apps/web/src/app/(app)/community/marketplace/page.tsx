'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  CONDITION_LABELS,
  LISTING_TYPE_LABELS,
  STATUS_PILL_CLASS,
  formatCents,
  useMarketplaceListings,
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

/**
 * P2-21c — Community Marketplace browse page.
 *
 * Cross-school marketplace listing grid. Search uses the tsvector GIN
 * index on the API side. Filters: type / price / condition. Parents
 * cannot reach the "New listing" CTA — they hold MKT-001:read only
 * (no :write).
 */
export default function CommunityMarketplacePage() {
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['mkt-001:read']);
  const canCreate = !!user && hasAnyPermission(user, ['mkt-001:write']);

  const [search, setSearch] = useState('');
  const [listingType, setListingType] = useState<ListingType | ''>('');
  const listings = useMarketplaceListings({
    search: search.trim().length > 0 ? search : undefined,
    listingType: listingType || undefined,
  });

  if (!user) return <LoadingSpinner />;
  if (!canRead) {
    return (
      <EmptyState
        title="Not available"
        description="The Community Marketplace is open to all authenticated users with MKT-001:read."
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Community Marketplace"
        description="Cross-school marketplace for surplus assets, educational resources, books, and knowledge."
        actions={
          canCreate ? (
            <Link
              href="/community/marketplace/new"
              className="rounded-md bg-campus-600 px-3 py-2 text-sm font-medium text-white hover:bg-campus-700"
            >
              New listing
            </Link>
          ) : null
        }
      />

      <div className="flex flex-wrap items-end gap-3 rounded-md border border-gray-200 bg-white p-4">
        <div className="flex-1 min-w-[240px]">
          <label className="block text-xs font-medium text-gray-700">Search</label>
          <input
            type="search"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            placeholder="Search title, description, tags…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700">Listing type</label>
          <select
            className="mt-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
            value={listingType}
            onChange={(e) => setListingType((e.target.value as ListingType) || '')}
          >
            <option value="">All types</option>
            {LISTING_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {LISTING_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {listings.isPending ? (
        <LoadingSpinner />
      ) : listings.isError ? (
        <EmptyState
          title="Couldn't load listings"
          description={String((listings.error as Error)?.message ?? 'Unknown error')}
        />
      ) : (listings.data ?? []).length === 0 ? (
        <EmptyState title="No listings found" description="Try a different search or filter." />
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {(listings.data ?? []).map((l) => (
            <li key={l.id}>
              <Link
                href={`/community/marketplace/${l.id}`}
                className="block rounded-lg border border-gray-200 bg-white p-4 hover:border-campus-400 hover:shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold text-gray-900 line-clamp-2">{l.title}</h3>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL_CLASS[l.status]}`}
                  >
                    {l.status}
                  </span>
                </div>
                <p className="mt-2 text-xs text-gray-600 line-clamp-2">{l.description}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-campus-100 px-2 py-0.5 text-campus-700">
                    {LISTING_TYPE_LABELS[l.listingType]}
                  </span>
                  {l.condition && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-700">
                      {CONDITION_LABELS[l.condition]}
                    </span>
                  )}
                  {l.averageRating !== null && (
                    <span className="text-amber-700">
                      ★ {l.averageRating.toFixed(1)} ({l.ratingCount})
                    </span>
                  )}
                </div>
                <div className="mt-3 flex items-baseline justify-between">
                  <span className="text-lg font-semibold text-gray-900">
                    {formatCents(l.priceCents)}
                  </span>
                  <span className="text-xs text-gray-500">
                    by {l.sellerDisplayName ?? 'Unknown'}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
