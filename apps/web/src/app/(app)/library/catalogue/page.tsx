'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useCatalogueSearch } from '@/hooks/use-library';
import { formatCurrency } from '@/lib/library-format';

/**
 * /library/catalogue — Catalogue search backed by the GIN full-text
 * index. Real-time as the user types (debounced via React Query
 * staleTime). Filter chips for category + author. Each result card
 * links to the catalogue item detail page.
 */
export default function CatalogueSearchPage() {
  const searchParams = useSearchParams();
  const initialQ = searchParams?.get('q') ?? '';

  const [q, setQ] = useState(initialQ);
  const [category, setCategory] = useState<string | null>(null);
  const [author, setAuthor] = useState('');

  const searchQ = useCatalogueSearch({
    q: q || undefined,
    category: category || undefined,
    author: author || undefined,
  });
  const results = searchQ.data ?? [];

  // Derive category facets client-side from the current result set.
  const categories = Array.from(
    new Set(results.map((r) => r.category).filter((c): c is string => !!c)),
  ).sort();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Catalogue"
        description="Search the library catalogue. The GIN full-text index ranks matches across both title and author."
      />

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Title, author, or keyword"
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
          <input
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Filter by author"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </div>

        {categories.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => setCategory(null)}
              className={
                'rounded-full px-3 py-1 text-xs font-medium transition ' +
                (category === null
                  ? 'bg-campus-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200')
              }
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={
                  'rounded-full px-3 py-1 text-xs font-medium transition ' +
                  (category === cat
                    ? 'bg-campus-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200')
                }
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </section>

      {searchQ.isLoading ? (
        <LoadingSpinner />
      ) : results.length === 0 ? (
        <EmptyState
          title={q ? 'No results' : 'Start searching'}
          description={
            q
              ? 'No catalogue items match your query. Try a broader search or clear the filters.'
              : 'Type a title, author surname, or keyword to search the catalogue.'
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {results.map((r) => (
            <li
              key={r.id}
              className="rounded-lg border border-gray-200 bg-white p-4 transition hover:border-campus-300 hover:shadow-sm"
            >
              <Link href={`/library/catalogue/${r.id}`} className="block">
                <div className="flex gap-3">
                  {r.coverImageUrl ? (
                    <div className="h-20 w-14 flex-shrink-0 overflow-hidden rounded bg-gray-100" />
                  ) : (
                    <div className="flex h-20 w-14 flex-shrink-0 items-center justify-center rounded bg-gray-100 text-2xl">
                      📕
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-gray-900 line-clamp-2">{r.title}</div>
                    <div className="text-xs text-gray-600">{r.author ?? '—'}</div>
                    {r.deweyDecimal && (
                      <div className="mt-1 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                        {r.deweyDecimal}
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between text-xs">
                  <span
                    className={
                      'font-medium ' +
                      (r.availableCopies > 0 ? 'text-emerald-700' : 'text-rose-700')
                    }
                  >
                    {r.availableCopies > 0
                      ? `${r.availableCopies} of ${r.totalCopies} available`
                      : `0 of ${r.totalCopies} available`}
                  </span>
                  {r.reviewCount > 0 && (
                    <span className="text-amber-600" title={`${r.reviewCount} reviews`}>
                      ★ {r.averageRating?.toFixed(1) ?? '—'}{' '}
                      <span className="text-gray-400">({r.reviewCount})</span>
                    </span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Suppress lint
void formatCurrency;
