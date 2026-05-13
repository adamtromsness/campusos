'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CreateLibraryCatalogueItemPayload,
  CreateLibraryCheckoutPayload,
  CreateLibraryCopyPayload,
  CreateLibraryHoldPayload,
  CreateLibraryLocationPayload,
  CreateLibraryReviewPayload,
  CreateReadingListItemPayload,
  CreateReadingListPayload,
  CreateReadingLogPayload,
  CreateReadingProgrammePayload,
  LibraryBarcodeLookupDto,
  LibraryCatalogueItemDto,
  LibraryCatalogueItemSearchHitDto,
  LibraryCheckoutDto,
  LibraryCheckoutPolicyDto,
  LibraryCheckoutStatus,
  LibraryCopyDto,
  LibraryFineDto,
  LibraryFineStatus,
  LibraryHoldDto,
  LibraryHoldStatus,
  LibraryLocationDto,
  LibraryReviewDto,
  ReadingListDto,
  ReadingListItemDto,
  ReadingLogDto,
  ReadingProgrammeDto,
  ReadingProgrammeLeaderboardEntryDto,
  UpdateLibraryCatalogueItemPayload,
  UpdateLibraryCopyPayload,
  UpdateLibraryLocationPayload,
  UpdateLibraryReviewPayload,
  UpdateReadingListItemPayload,
  UpdateReadingListPayload,
  UpdateReadingLogPayload,
  UpdateReadingProgrammePayload,
  WaiveLibraryFinePayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ─── Locations ────────────────────────────────────────────────

export function useLibraryLocations(includeInactive = false) {
  return useQuery({
    queryKey: ['library', 'locations', { includeInactive }],
    queryFn: () =>
      apiFetch<LibraryLocationDto[]>(
        PREFIX + '/library/locations' + (includeInactive ? '?includeInactive=true' : ''),
      ),
    staleTime: 60_000,
  });
}

export function useCreateLibraryLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLibraryLocationPayload) =>
      apiFetch<LibraryLocationDto>(PREFIX + '/library/locations', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'locations'] }),
  });
}

export function useUpdateLibraryLocation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateLibraryLocationPayload) =>
      apiFetch<LibraryLocationDto>(PREFIX + '/library/locations/' + id, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'locations'] }),
  });
}

// ─── Catalogue ────────────────────────────────────────────────

export interface CatalogueSearchArgs {
  q?: string;
  category?: string;
  author?: string;
  limit?: number;
}

export function useCatalogueSearch(args: CatalogueSearchArgs) {
  const params = new URLSearchParams();
  if (args.q) params.set('q', args.q);
  if (args.category) params.set('category', args.category);
  if (args.author) params.set('author', args.author);
  if (args.limit !== undefined) params.set('limit', String(args.limit));
  const qs = params.toString();
  return useQuery({
    queryKey: ['library', 'catalogue', 'search', args],
    queryFn: () =>
      apiFetch<LibraryCatalogueItemSearchHitDto[]>(
        PREFIX + '/library/catalogue' + (qs ? '?' + qs : ''),
      ),
    staleTime: 30_000,
  });
}

export function useCatalogueItem(id: string | null) {
  return useQuery({
    queryKey: ['library', 'catalogue', id],
    queryFn: () => apiFetch<LibraryCatalogueItemDto>(PREFIX + '/library/catalogue/' + id),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCatalogueItemCopies(id: string | null) {
  return useQuery({
    queryKey: ['library', 'catalogue', id, 'copies'],
    queryFn: () => apiFetch<LibraryCopyDto[]>(PREFIX + '/library/catalogue/' + id + '/copies'),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateCatalogueItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLibraryCatalogueItemPayload) =>
      apiFetch<LibraryCatalogueItemDto>(PREFIX + '/library/catalogue', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'catalogue'] }),
  });
}

export function useUpdateCatalogueItem(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateLibraryCatalogueItemPayload) =>
      apiFetch<LibraryCatalogueItemDto>(PREFIX + '/library/catalogue/' + id, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'catalogue'] }),
  });
}

// ─── Copies ───────────────────────────────────────────────────

export function useBarcodeLookup(barcode: string | null) {
  return useQuery({
    queryKey: ['library', 'barcode', barcode],
    queryFn: () =>
      apiFetch<LibraryBarcodeLookupDto>(
        PREFIX + '/library/copies/barcode/' + encodeURIComponent(barcode ?? ''),
      ),
    enabled: !!barcode && barcode.length > 0,
    staleTime: 0,
    retry: false,
  });
}

export function useCreateCopy(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLibraryCopyPayload) =>
      apiFetch<LibraryCopyDto>(PREFIX + '/library/catalogue/' + itemId + '/copies', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'catalogue'] }),
  });
}

export function useUpdateCopy(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateLibraryCopyPayload) =>
      apiFetch<LibraryCopyDto>(PREFIX + '/library/copies/' + id, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'catalogue'] }),
  });
}

// ─── Checkouts ────────────────────────────────────────────────

export function useCheckoutPolicies() {
  return useQuery({
    queryKey: ['library', 'checkout-policies'],
    queryFn: () => apiFetch<LibraryCheckoutPolicyDto[]>(PREFIX + '/library/checkout-policies'),
    staleTime: 5 * 60_000,
  });
}

export interface CheckoutsListArgs {
  status?: LibraryCheckoutStatus;
  patronId?: string;
  onlyActive?: boolean;
}

export function useCheckouts(args: CheckoutsListArgs = {}) {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.patronId) params.set('patronId', args.patronId);
  if (args.onlyActive) params.set('onlyActive', 'true');
  const qs = params.toString();
  return useQuery({
    queryKey: ['library', 'checkouts', args],
    queryFn: () =>
      apiFetch<LibraryCheckoutDto[]>(PREFIX + '/library/checkouts' + (qs ? '?' + qs : '')),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useOverdueCheckouts() {
  return useQuery({
    queryKey: ['library', 'checkouts', 'overdue'],
    queryFn: () => apiFetch<LibraryCheckoutDto[]>(PREFIX + '/library/checkouts/overdue'),
    staleTime: 30_000,
  });
}

export function useCreateCheckout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLibraryCheckoutPayload) =>
      apiFetch<LibraryCheckoutDto>(PREFIX + '/library/checkouts', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['library', 'checkouts'] });
      qc.invalidateQueries({ queryKey: ['library', 'catalogue'] });
      qc.invalidateQueries({ queryKey: ['library', 'barcode'] });
    },
  });
}

export function useReturnCheckout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<LibraryCheckoutDto>(PREFIX + '/library/checkouts/' + id + '/return', {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['library', 'checkouts'] });
      qc.invalidateQueries({ queryKey: ['library', 'fines'] });
      qc.invalidateQueries({ queryKey: ['library', 'holds'] });
      qc.invalidateQueries({ queryKey: ['library', 'catalogue'] });
      qc.invalidateQueries({ queryKey: ['library', 'barcode'] });
    },
  });
}

export function useRenewCheckout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<LibraryCheckoutDto>(PREFIX + '/library/checkouts/' + id + '/renew', {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'checkouts'] }),
  });
}

// ─── Holds ────────────────────────────────────────────────────

export interface HoldsListArgs {
  status?: LibraryHoldStatus;
  patronId?: string;
}

export function useHolds(args: HoldsListArgs = {}) {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.patronId) params.set('patronId', args.patronId);
  const qs = params.toString();
  return useQuery({
    queryKey: ['library', 'holds', args],
    queryFn: () => apiFetch<LibraryHoldDto[]>(PREFIX + '/library/holds' + (qs ? '?' + qs : '')),
    staleTime: 30_000,
  });
}

export function usePlaceHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLibraryHoldPayload) =>
      apiFetch<LibraryHoldDto>(PREFIX + '/library/holds', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['library', 'holds'] });
      qc.invalidateQueries({ queryKey: ['library', 'catalogue'] });
    },
  });
}

export function useCancelHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<LibraryHoldDto>(PREFIX + '/library/holds/' + id + '/cancel', {
        method: 'PATCH',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'holds'] }),
  });
}

export function useCollectHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<LibraryHoldDto>(PREFIX + '/library/holds/' + id + '/collect', {
        method: 'PATCH',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'holds'] }),
  });
}

// ─── Fines ────────────────────────────────────────────────────

export interface FinesListArgs {
  status?: LibraryFineStatus;
  patronId?: string;
}

export function useFines(args: FinesListArgs = {}) {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.patronId) params.set('patronId', args.patronId);
  const qs = params.toString();
  return useQuery({
    queryKey: ['library', 'fines', args],
    queryFn: () => apiFetch<LibraryFineDto[]>(PREFIX + '/library/fines' + (qs ? '?' + qs : '')),
    staleTime: 30_000,
  });
}

export function usePayFine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<LibraryFineDto>(PREFIX + '/library/fines/' + id + '/pay', {
        method: 'PATCH',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'fines'] }),
  });
}

export function useWaiveFine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: WaiveLibraryFinePayload }) =>
      apiFetch<LibraryFineDto>(PREFIX + '/library/fines/' + id + '/waive', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'fines'] }),
  });
}

// ─── Reading programmes ──────────────────────────────────────

export function useReadingProgrammes(includeInactive = false) {
  return useQuery({
    queryKey: ['library', 'programmes', { includeInactive }],
    queryFn: () =>
      apiFetch<ReadingProgrammeDto[]>(
        PREFIX + '/library/programmes' + (includeInactive ? '?includeInactive=true' : ''),
      ),
    staleTime: 60_000,
  });
}

export function useReadingProgramme(id: string | null) {
  return useQuery({
    queryKey: ['library', 'programme', id],
    queryFn: () => apiFetch<ReadingProgrammeDto>(PREFIX + '/library/programmes/' + id),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useReadingProgrammeLeaderboard(id: string | null, limit = 25) {
  return useQuery({
    queryKey: ['library', 'programme', id, 'leaderboard', limit],
    queryFn: () =>
      apiFetch<ReadingProgrammeLeaderboardEntryDto[]>(
        PREFIX + '/library/programmes/' + id + '/leaderboard?limit=' + limit,
      ),
    enabled: !!id,
    staleTime: 60_000,
  });
}

export function useCreateReadingProgramme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateReadingProgrammePayload) =>
      apiFetch<ReadingProgrammeDto>(PREFIX + '/library/programmes', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'programmes'] }),
  });
}

export function useUpdateReadingProgramme(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateReadingProgrammePayload) =>
      apiFetch<ReadingProgrammeDto>(PREFIX + '/library/programmes/' + id, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['library', 'programmes'] });
      qc.invalidateQueries({ queryKey: ['library', 'programme', id] });
    },
  });
}

// ─── Reading log ─────────────────────────────────────────────

export function useReadingLog(args: { studentId?: string } = {}) {
  const qs = args.studentId ? '?studentId=' + args.studentId : '';
  return useQuery({
    queryKey: ['library', 'reading-log', args],
    queryFn: () => apiFetch<ReadingLogDto[]>(PREFIX + '/library/reading-log' + qs),
    staleTime: 30_000,
  });
}

export function useLogBook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateReadingLogPayload) =>
      apiFetch<ReadingLogDto>(PREFIX + '/library/reading-log', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['library', 'reading-log'] });
      qc.invalidateQueries({ queryKey: ['library', 'programmes'] });
      qc.invalidateQueries({ queryKey: ['library', 'programme'] });
    },
  });
}

export function useUpdateReadingLog(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateReadingLogPayload) =>
      apiFetch<ReadingLogDto>(PREFIX + '/library/reading-log/' + id, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['library', 'reading-log'] });
      qc.invalidateQueries({ queryKey: ['library', 'programmes'] });
      qc.invalidateQueries({ queryKey: ['library', 'programme'] });
    },
  });
}

// ─── Reading lists ───────────────────────────────────────────

export function useReadingLists(includeUnpublished = false) {
  return useQuery({
    queryKey: ['library', 'reading-lists', { includeUnpublished }],
    queryFn: () =>
      apiFetch<ReadingListDto[]>(
        PREFIX + '/library/reading-lists' + (includeUnpublished ? '?includeUnpublished=true' : ''),
      ),
    staleTime: 60_000,
  });
}

export function useReadingList(id: string | null) {
  return useQuery({
    queryKey: ['library', 'reading-list', id],
    queryFn: () => apiFetch<ReadingListDto>(PREFIX + '/library/reading-lists/' + id),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateReadingList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateReadingListPayload) =>
      apiFetch<ReadingListDto>(PREFIX + '/library/reading-lists', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'reading-lists'] }),
  });
}

export function useUpdateReadingList(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateReadingListPayload) =>
      apiFetch<ReadingListDto>(PREFIX + '/library/reading-lists/' + id, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['library', 'reading-lists'] });
      qc.invalidateQueries({ queryKey: ['library', 'reading-list', id] });
    },
  });
}

export function useAddReadingListItem(listId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateReadingListItemPayload) =>
      apiFetch<ReadingListItemDto>(PREFIX + '/library/reading-lists/' + listId + '/items', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'reading-list', listId] }),
  });
}

export function useUpdateReadingListItem(listId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateReadingListItemPayload }) =>
      apiFetch<ReadingListItemDto>(PREFIX + '/library/reading-list-items/' + id, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'reading-list', listId] }),
  });
}

export function useRemoveReadingListItem(listId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(PREFIX + '/library/reading-list-items/' + id, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'reading-list', listId] }),
  });
}

// ─── Reviews ─────────────────────────────────────────────────

export function useItemReviews(itemId: string | null) {
  return useQuery({
    queryKey: ['library', 'reviews', itemId],
    queryFn: () =>
      apiFetch<LibraryReviewDto[]>(PREFIX + '/library/catalogue/' + itemId + '/reviews'),
    enabled: !!itemId,
    staleTime: 30_000,
  });
}

export function useSubmitReview(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLibraryReviewPayload) =>
      apiFetch<LibraryReviewDto>(PREFIX + '/library/catalogue/' + itemId + '/reviews', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['library', 'reviews', itemId] });
      qc.invalidateQueries({ queryKey: ['library', 'catalogue', itemId] });
    },
  });
}

export function useUpdateReview(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateLibraryReviewPayload }) =>
      apiFetch<LibraryReviewDto>(PREFIX + '/library/reviews/' + id, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'reviews', itemId] }),
  });
}

export function useHideReview(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<LibraryReviewDto>(PREFIX + '/library/reviews/' + id + '/hide', {
        method: 'PATCH',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'reviews', itemId] }),
  });
}

export function useUnhideReview(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<LibraryReviewDto>(PREFIX + '/library/reviews/' + id + '/unhide', {
        method: 'PATCH',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'reviews', itemId] }),
  });
}

// ─── P2-25b — Library Advanced ────────────────────────────────

import type {
  ClassSetCheckoutDto,
  ClassSetStatus,
  CreateCatalogueImportJobPayload,
  CreateClassSetCheckoutPayload,
  CreateInterlibraryLoanPayload,
  CatalogueImportJobDto,
  IllDirection,
  IllStatus,
  InterlibraryLoanDto,
  RecommendationDto,
  RecommendationWeightsDto,
  ReturnClassSetCopiesPayload,
  UpdateInterlibraryLoanPayload,
  UpdateRecommendationWeightsPayload,
} from '@/lib/types';

// ── Class sets ──────────────────────────────────────────────

export interface ClassSetListArgs {
  status?: ClassSetStatus;
  teacherPatronId?: string;
}

export function useClassSets(args: ClassSetListArgs = {}) {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.teacherPatronId) params.set('teacherPatronId', args.teacherPatronId);
  const qs = params.toString();
  return useQuery({
    queryKey: ['library', 'class-sets', args],
    queryFn: () =>
      apiFetch<ClassSetCheckoutDto[]>(PREFIX + '/library/class-sets' + (qs ? '?' + qs : '')),
    staleTime: 30_000,
  });
}

export function useClassSet(id: string | null) {
  return useQuery({
    queryKey: ['library', 'class-sets', id],
    queryFn: () => apiFetch<ClassSetCheckoutDto>(PREFIX + '/library/class-sets/' + id),
    enabled: !!id,
  });
}

export function useCreateClassSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateClassSetCheckoutPayload) =>
      apiFetch<ClassSetCheckoutDto>(PREFIX + '/library/class-sets', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'class-sets'] }),
  });
}

export function useReturnClassSetCopies(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReturnClassSetCopiesPayload) =>
      apiFetch<ClassSetCheckoutDto>(PREFIX + '/library/class-sets/' + id + '/return', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'class-sets'] }),
  });
}

// ── Recommendations ─────────────────────────────────────────

export function useRecommendations(
  studentId: string | null,
  args: { includeDismissed?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (args.includeDismissed) params.set('includeDismissed', 'true');
  const qs = params.toString();
  return useQuery({
    queryKey: ['library', 'recommendations', studentId, args],
    queryFn: () =>
      apiFetch<RecommendationDto[]>(
        PREFIX + '/library/recommendations/' + studentId + (qs ? '?' + qs : ''),
      ),
    enabled: !!studentId,
    staleTime: 60_000,
  });
}

export function useDismissRecommendation(studentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (recommendationId: string) =>
      apiFetch<void>(PREFIX + '/library/recommendations/' + recommendationId + '/dismiss', {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'recommendations', studentId] }),
  });
}

export function useRecommendationConfig(enabled = true) {
  return useQuery({
    queryKey: ['library', 'recommendation-config'],
    queryFn: () => apiFetch<RecommendationWeightsDto>(PREFIX + '/library/recommendation-config'),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useUpdateRecommendationConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateRecommendationWeightsPayload) =>
      apiFetch<RecommendationWeightsDto>(PREFIX + '/library/recommendation-config', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'recommendation-config'] }),
  });
}

// ── Interlibrary loans ──────────────────────────────────────

export interface IllListArgs {
  status?: IllStatus;
  loanDirection?: IllDirection;
}

export function useInterlibraryLoans(args: IllListArgs = {}) {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.loanDirection) params.set('loanDirection', args.loanDirection);
  const qs = params.toString();
  return useQuery({
    queryKey: ['library', 'ill', args],
    queryFn: () => apiFetch<InterlibraryLoanDto[]>(PREFIX + '/library/ill' + (qs ? '?' + qs : '')),
    staleTime: 30_000,
  });
}

export function useInterlibraryLoan(id: string | null) {
  return useQuery({
    queryKey: ['library', 'ill', id],
    queryFn: () => apiFetch<InterlibraryLoanDto>(PREFIX + '/library/ill/' + id),
    enabled: !!id,
  });
}

export function useOverdueInterlibraryLoans() {
  return useQuery({
    queryKey: ['library', 'ill', 'overdue'],
    queryFn: () => apiFetch<InterlibraryLoanDto[]>(PREFIX + '/library/ill/overdue'),
    staleTime: 60_000,
  });
}

export function useCreateInterlibraryLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInterlibraryLoanPayload) =>
      apiFetch<InterlibraryLoanDto>(PREFIX + '/library/ill', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'ill'] }),
  });
}

export function useUpdateInterlibraryLoan(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateInterlibraryLoanPayload) =>
      apiFetch<InterlibraryLoanDto>(PREFIX + '/library/ill/' + id, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'ill'] }),
  });
}

// ── Catalogue import ────────────────────────────────────────

export function useCatalogueImports() {
  return useQuery({
    queryKey: ['library', 'imports'],
    queryFn: () => apiFetch<CatalogueImportJobDto[]>(PREFIX + '/library/imports'),
    staleTime: 30_000,
    refetchInterval: (q) => {
      const data = q.state.data as CatalogueImportJobDto[] | undefined;
      if (!data) return false;
      const running = data.some(
        (j) => j.status === 'QUEUED' || j.status === 'PARSING' || j.status === 'IMPORTING',
      );
      return running ? 5_000 : false;
    },
  });
}

export function useCatalogueImport(id: string | null) {
  return useQuery({
    queryKey: ['library', 'imports', id],
    queryFn: () => apiFetch<CatalogueImportJobDto>(PREFIX + '/library/imports/' + id),
    enabled: !!id,
    refetchInterval: (q) => {
      const data = q.state.data as CatalogueImportJobDto | undefined;
      if (!data) return false;
      return data.status === 'QUEUED' || data.status === 'PARSING' || data.status === 'IMPORTING'
        ? 3_000
        : false;
    },
  });
}

export function useCreateCatalogueImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCatalogueImportJobPayload) =>
      apiFetch<CatalogueImportJobDto>(PREFIX + '/library/imports', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library', 'imports'] }),
  });
}
