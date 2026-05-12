'use client';

import { useParams, useRouter } from 'next/navigation';
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
  useCreateRating,
  useMarketplaceListing,
  usePurchaseListing,
  useRatings,
} from '@/hooks/use-community';

/**
 * P2-21c — Marketplace Listing Detail.
 *
 * Shows the listing with photos, price, condition, seller, ratings,
 * and a Buy button for ACTIVE listings (gated on mkt-002:write).
 * Ratings panel below lists existing reviews and lets the caller
 * submit one.
 */
export default function ListingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const listingId = typeof params?.id === 'string' ? params.id : null;
  const user = useAuthStore((s) => s.user);
  const canBuy = !!user && hasAnyPermission(user, ['mkt-002:write']);
  const canRate = !!user && hasAnyPermission(user, ['mkt-006:write']);

  const listing = useMarketplaceListing(listingId);
  const ratings = useRatings('LISTING', listingId);
  const purchase = usePurchaseListing(listingId ?? '');
  const submitRating = useCreateRating();

  const [showPurchase, setShowPurchase] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [ratingScore, setRatingScore] = useState(5);
  const [ratingReview, setRatingReview] = useState('');
  const [ratingError, setRatingError] = useState<string | null>(null);

  if (!listingId || !user) return <LoadingSpinner />;
  if (listing.isPending) return <LoadingSpinner />;
  if (listing.isError) {
    return (
      <EmptyState
        title="Couldn't load this listing"
        description={String((listing.error as Error)?.message ?? 'Unknown error')}
      />
    );
  }
  const l = listing.data;
  if (!l) return null;

  const onPurchase = async (): Promise<void> => {
    if (!l.sellerSchoolId) return;
    setPurchaseError(null);
    try {
      const txn = await purchase.mutateAsync({
        buyerType: 'INDIVIDUAL',
        shippingMethod: 'PICKUP',
      });
      router.push(`/community/marketplace?purchased=${txn.id}`);
    } catch (e) {
      setPurchaseError(String((e as Error).message ?? 'Purchase failed'));
    }
  };

  const onSubmitRating = async (): Promise<void> => {
    setRatingError(null);
    try {
      await submitRating.mutateAsync({
        rateableType: 'LISTING',
        rateableId: l.id,
        score: ratingScore,
        reviewText: ratingReview.trim() || undefined,
      });
      setRatingReview('');
    } catch (e) {
      setRatingError(String((e as Error).message ?? 'Failed to submit rating'));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title={l.title} description={`Listed by ${l.sellerDisplayName ?? 'Unknown'}`} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="rounded-full bg-campus-100 px-2 py-0.5 text-xs font-medium text-campus-700">
                {LISTING_TYPE_LABELS[l.listingType]}
              </span>
              {l.condition && (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                  {CONDITION_LABELS[l.condition]}
                </span>
              )}
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL_CLASS[l.status]}`}
              >
                {l.status}
              </span>
              {l.averageRating !== null && (
                <span className="text-xs text-amber-700">
                  ★ {l.averageRating.toFixed(1)} ({l.ratingCount})
                </span>
              )}
            </div>
            <p className="whitespace-pre-line text-sm text-gray-700">{l.description}</p>
            {l.tags.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {l.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                  >
                    #{t}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <h3 className="text-base font-semibold text-gray-900">Reviews</h3>
            {ratings.isPending ? (
              <LoadingSpinner />
            ) : (ratings.data ?? []).length === 0 ? (
              <p className="mt-2 text-sm text-gray-500">No reviews yet.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {(ratings.data ?? []).map((r) => (
                  <li key={r.id} className="border-t border-gray-100 pt-3">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm font-medium text-gray-900">
                        {r.ratedByDisplayName ?? 'Anonymous'}
                      </span>
                      <span className="text-amber-700">★ {r.score}</span>
                    </div>
                    {r.reviewText && <p className="mt-1 text-sm text-gray-700">{r.reviewText}</p>}
                    {r.helpfulVotes > 0 && (
                      <p className="mt-1 text-xs text-gray-500">
                        {r.helpfulVotes} found this helpful
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canRate && (
              <div className="mt-4 border-t border-gray-100 pt-4">
                <h4 className="text-sm font-medium text-gray-900">Submit a review</h4>
                <div className="mt-2 flex items-center gap-2">
                  <label className="text-xs">Score:</label>
                  <select
                    value={ratingScore}
                    onChange={(e) => setRatingScore(Number(e.target.value))}
                    className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                  >
                    {[5, 4, 3, 2, 1].map((s) => (
                      <option key={s} value={s}>
                        {s} ★
                      </option>
                    ))}
                  </select>
                </div>
                <textarea
                  className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  rows={2}
                  placeholder="Optional review text…"
                  value={ratingReview}
                  onChange={(e) => setRatingReview(e.target.value)}
                />
                {ratingError && <p className="mt-1 text-sm text-rose-700">{ratingError}</p>}
                <button
                  type="button"
                  onClick={onSubmitRating}
                  disabled={submitRating.isPending}
                  className="mt-2 rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
                >
                  {submitRating.isPending ? 'Saving…' : 'Submit review'}
                </button>
              </div>
            )}
          </div>
        </div>

        <aside className="space-y-4">
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <p className="text-xs text-gray-500">Price</p>
            <p className="text-2xl font-semibold text-gray-900">{formatCents(l.priceCents)}</p>
            {l.priceCents !== null && (
              <p className="mt-1 text-xs text-gray-500">
                +5% platform fee · seller receives {formatCents(Math.floor(l.priceCents * 0.95))}
              </p>
            )}
            {l.status === 'ACTIVE' && canBuy && l.priceCents !== null && (
              <button
                type="button"
                onClick={() => setShowPurchase(true)}
                className="mt-4 w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
              >
                Buy now
              </button>
            )}
            {l.status !== 'ACTIVE' && (
              <p className="mt-4 text-sm text-gray-500">
                This listing is {l.status.toLowerCase()}.
              </p>
            )}
          </div>
        </aside>
      </div>

      {showPurchase && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-base font-semibold text-gray-900">Confirm purchase</h3>
            <p className="mt-2 text-sm text-gray-700">
              Buy {l.title} for {formatCents(l.priceCents)}? The platform fee is 5% and the seller
              receives 95%.
            </p>
            {purchaseError && <p className="mt-2 text-sm text-rose-700">{purchaseError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowPurchase(false)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onPurchase}
                disabled={purchase.isPending}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {purchase.isPending ? 'Processing…' : 'Confirm purchase'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
