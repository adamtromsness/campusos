'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

const PREFIX = '/api/v1/community';

/**
 * P2-21c — Community Exchange hooks.
 *
 * Cross-school marketplace + community profiles + ratings + unified
 * full-text search. Routes mount under /api/v1/community/* with the
 * regular guard chain (Auth + Tenant + Permission). Marketplace data
 * lives in the platform schema.
 */

export type ListingType =
  | 'EDUCATIONAL'
  | 'PORTFOLIO'
  | 'FIELD_TRIP'
  | 'SURPLUS_ASSET'
  | 'BOOK'
  | 'KNOWLEDGE';

export type ListingStatus = 'DRAFT' | 'ACTIVE' | 'SOLD' | 'EXPIRED';
export type ItemCondition = 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR' | 'POOR';
export type TransactionStatus =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'SHIPPING'
  | 'DELIVERED'
  | 'CONFIRMED'
  | 'DISPUTED'
  | 'REFUNDED';
export type ShippingMethod = 'PICKUP' | 'SCHOOL_DELIVERY' | 'CARRIER';
export type BuyerType = 'SCHOOL' | 'INDIVIDUAL';
export type RateableType = 'LISTING' | 'TRANSACTION' | 'FORUM_POST';
export type WatchListStatus = 'ACTIVE' | 'FULFILLED';
export type ConditionReportType = 'SELLER_LISTING' | 'BUYER_RECEIPT';
export type SearchContentType = 'LISTING' | 'FORUM_POST' | 'KNOWLEDGE_ARTICLE' | 'PROFILE';

export interface CommunityProfileDto {
  id: string;
  personId: string;
  displayName: string;
  bio: string | null;
  schoolName: string | null;
  roleLabel: string | null;
  avatarS3Key: string | null;
  reputationPoints: number;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceListingDto {
  id: string;
  listingType: ListingType;
  title: string;
  description: string;
  sellerSchoolId: string;
  sellerProfileId: string;
  sellerDisplayName: string | null;
  priceCents: number | null;
  condition: ItemCondition | null;
  category: string | null;
  tags: string[];
  photoS3Keys: string[];
  status: ListingStatus;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  averageRating: number | null;
  ratingCount: number;
}

export interface AssetTransactionDto {
  id: string;
  listingId: string;
  listingTitle: string | null;
  buyerType: BuyerType;
  buyerSchoolId: string | null;
  buyerPersonId: string | null;
  sellerSchoolId: string;
  sellerProfileId: string;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
  platformFeeCents: number;
  sellerReceivesCents: number;
  stripePaymentIntentId: string | null;
  status: TransactionStatus;
  shippingMethod: ShippingMethod | null;
  trackingNumber: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  confirmedAt: string | null;
  refundedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WatchListDto {
  id: string;
  schoolId: string;
  targetListingType: ListingType;
  searchKeywords: string | null;
  maxPriceCents: number | null;
  conditionMin: ItemCondition | null;
  status: WatchListStatus;
  createdBy: string;
  fulfilledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommunityRatingDto {
  id: string;
  rateableType: RateableType;
  rateableId: string;
  ratedBy: string;
  ratedByDisplayName: string | null;
  score: number;
  reviewText: string | null;
  helpfulVotes: number;
  createdAt: string;
  updatedAt: string;
}

export interface SearchHitDto {
  contentType: SearchContentType;
  contentId: string;
  title: string;
  bodyPreview: string | null;
  schoolId: string | null;
  authorProfileId: string | null;
  contentDate: string | null;
  rank: number;
}

// ── Profile hooks ───────────────────────────────────────────────────

export function useMyCommunityProfile() {
  return useQuery({
    queryKey: ['community', 'profile', 'me'],
    queryFn: () => apiFetch<CommunityProfileDto>(`${PREFIX}/profiles/me`),
    staleTime: 60_000,
  });
}

export function useCommunityLeaderboard(limit?: number) {
  return useQuery({
    queryKey: ['community', 'profile', 'leaderboard', limit],
    queryFn: () =>
      apiFetch<CommunityProfileDto[]>(
        `${PREFIX}/profiles/leaderboard${limit ? `?limit=${limit}` : ''}`,
      ),
    staleTime: 60_000,
  });
}

export function useUpdateMyCommunityProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<CommunityProfileDto>) =>
      apiFetch<CommunityProfileDto>(`${PREFIX}/profiles/me`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['community', 'profile'] });
    },
  });
}

// ── Marketplace hooks ───────────────────────────────────────────────

export interface ListMarketplaceArgs {
  search?: string;
  listingType?: ListingType;
  status?: ListingStatus;
  minPriceCents?: number;
  maxPriceCents?: number;
  conditionMin?: ItemCondition;
}

export function useMarketplaceListings(args: ListMarketplaceArgs = {}) {
  const query = new URLSearchParams();
  if (args.search) query.set('search', args.search);
  if (args.listingType) query.set('listingType', args.listingType);
  if (args.status) query.set('status', args.status);
  if (args.minPriceCents !== undefined) query.set('minPriceCents', String(args.minPriceCents));
  if (args.maxPriceCents !== undefined) query.set('maxPriceCents', String(args.maxPriceCents));
  if (args.conditionMin) query.set('conditionMin', args.conditionMin);
  const qs = query.toString();
  return useQuery({
    queryKey: ['community', 'marketplace', args],
    queryFn: () => apiFetch<MarketplaceListingDto[]>(`${PREFIX}/marketplace${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
  });
}

export function useMarketplaceListing(id: string | null | undefined) {
  return useQuery({
    queryKey: ['community', 'marketplace', 'detail', id],
    queryFn: () => apiFetch<MarketplaceListingDto>(`${PREFIX}/marketplace/${id}`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export interface CreateMarketplaceListingPayload {
  listingType: ListingType;
  title: string;
  description: string;
  priceCents?: number | null;
  condition?: ItemCondition | null;
  category?: string | null;
  tags?: string[];
  photoS3Keys?: string[];
}

export function useCreateMarketplaceListing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMarketplaceListingPayload) =>
      apiFetch<MarketplaceListingDto>(`${PREFIX}/marketplace`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['community', 'marketplace'] });
    },
  });
}

export interface PatchMarketplaceListingPayload {
  title?: string;
  description?: string;
  priceCents?: number | null;
  condition?: ItemCondition | null;
  category?: string | null;
  tags?: string[];
  photoS3Keys?: string[];
  status?: ListingStatus;
}

export function usePatchMarketplaceListing(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchMarketplaceListingPayload) =>
      apiFetch<MarketplaceListingDto>(`${PREFIX}/marketplace/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['community', 'marketplace'] });
    },
  });
}

// ── Transactions hooks ──────────────────────────────────────────────

export function useMyTransactions() {
  return useQuery({
    queryKey: ['community', 'transactions', 'my'],
    queryFn: () => apiFetch<AssetTransactionDto[]>(`${PREFIX}/transactions/my`),
    staleTime: 30_000,
  });
}

export function useTransaction(id: string | null | undefined) {
  return useQuery({
    queryKey: ['community', 'transactions', 'detail', id],
    queryFn: () => apiFetch<AssetTransactionDto>(`${PREFIX}/transactions/${id}`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export interface PurchasePayload {
  buyerType: BuyerType;
  buyerSchoolId?: string | null;
  buyerPersonId?: string | null;
  quantity?: number;
  shippingMethod?: ShippingMethod;
}

export function usePurchaseListing(listingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PurchasePayload) =>
      apiFetch<AssetTransactionDto>(`${PREFIX}/marketplace/${listingId}/purchase`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['community', 'transactions'] });
      qc.invalidateQueries({ queryKey: ['community', 'marketplace'] });
    },
  });
}

// ── Watch lists hooks ───────────────────────────────────────────────

export function useWatchLists(includeFulfilled = false) {
  return useQuery({
    queryKey: ['community', 'watch-lists', includeFulfilled],
    queryFn: () =>
      apiFetch<WatchListDto[]>(
        `${PREFIX}/watch-lists${includeFulfilled ? '?includeFulfilled=true' : ''}`,
      ),
    staleTime: 60_000,
  });
}

export interface CreateWatchListPayload {
  targetListingType: ListingType;
  searchKeywords?: string | null;
  maxPriceCents?: number | null;
  conditionMin?: ItemCondition | null;
}

export function useCreateWatchList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWatchListPayload) =>
      apiFetch<WatchListDto>(`${PREFIX}/watch-lists`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['community', 'watch-lists'] });
    },
  });
}

// ── Ratings hooks ───────────────────────────────────────────────────

export function useRatings(rateableType: RateableType, rateableId: string | null | undefined) {
  return useQuery({
    queryKey: ['community', 'ratings', rateableType, rateableId],
    queryFn: () =>
      apiFetch<CommunityRatingDto[]>(`${PREFIX}/ratings/${rateableType}/${rateableId}`),
    enabled: !!rateableId,
    staleTime: 30_000,
  });
}

export interface CreateRatingPayload {
  rateableType: RateableType;
  rateableId: string;
  score: number;
  reviewText?: string | null;
}

export function useCreateRating() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRatingPayload) =>
      apiFetch<CommunityRatingDto>(`${PREFIX}/ratings`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['community', 'ratings'] });
      qc.invalidateQueries({ queryKey: ['community', 'profile'] });
    },
  });
}

// ── Search hooks ────────────────────────────────────────────────────

export function useCommunitySearch(query: string, contentType?: SearchContentType) {
  const qs = new URLSearchParams({ q: query });
  if (contentType) qs.set('contentType', contentType);
  return useQuery({
    queryKey: ['community', 'search', query, contentType],
    queryFn: () => apiFetch<SearchHitDto[]>(`${PREFIX}/search?${qs.toString()}`),
    enabled: query.trim().length > 0,
    staleTime: 30_000,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────

export function formatCents(cents: number | null): string {
  if (cents === null) return 'Free';
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}

export const LISTING_TYPE_LABELS: Record<ListingType, string> = {
  EDUCATIONAL: 'Educational',
  PORTFOLIO: 'Portfolio',
  FIELD_TRIP: 'Field Trip',
  SURPLUS_ASSET: 'Surplus Asset',
  BOOK: 'Book',
  KNOWLEDGE: 'Knowledge',
};

export const CONDITION_LABELS: Record<ItemCondition, string> = {
  NEW: 'New',
  LIKE_NEW: 'Like new',
  GOOD: 'Good',
  FAIR: 'Fair',
  POOR: 'Poor',
};

export const STATUS_PILL_CLASS: Record<ListingStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  SOLD: 'bg-sky-100 text-sky-700',
  EXPIRED: 'bg-rose-100 text-rose-700',
};

export const TRANSACTION_STATUS_PILL_CLASS: Record<TransactionStatus, string> = {
  PENDING_PAYMENT: 'bg-amber-100 text-amber-700',
  PAID: 'bg-sky-100 text-sky-700',
  SHIPPING: 'bg-indigo-100 text-indigo-700',
  DELIVERED: 'bg-emerald-100 text-emerald-700',
  CONFIRMED: 'bg-emerald-700 text-white',
  DISPUTED: 'bg-rose-100 text-rose-700',
  REFUNDED: 'bg-gray-300 text-gray-800',
};
