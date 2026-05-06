import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CreatePubDistributionListPayload,
  CreatePubEditionPayload,
  CreatePubSectionPayload,
  CreatePubSeriesPayload,
  PubAudiencePreviewDto,
  PubCollaboratorDto,
  PubDistributeResultDto,
  PubDistributionListDto,
  PubDistributionStatusDto,
  PubEditionDto,
  PubPublicationDetailDto,
  PubPublicationDto,
  PubSectionCommentDto,
  PubSectionDto,
  PubSeriesDto,
  PubStatus,
  PubSubscriptionDto,
  UpdatePubSectionPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// Series + editions ─────────────────────────────────────────

export function useSeries() {
  return useQuery({
    queryKey: ['publications', 'series'],
    queryFn: () => apiFetch<PubSeriesDto[]>(`${PREFIX}/publications/series`),
    staleTime: 30_000,
  });
}

export function useSeriesById(id: string | null) {
  return useQuery({
    queryKey: ['publications', 'series', id],
    queryFn: () => apiFetch<PubSeriesDto>(`${PREFIX}/publications/series/${id}`),
    enabled: !!id,
  });
}

export function useEditionsForSeries(seriesId: string | null) {
  return useQuery({
    queryKey: ['publications', 'series', seriesId, 'editions'],
    queryFn: () => apiFetch<PubEditionDto[]>(`${PREFIX}/publications/series/${seriesId}/editions`),
    enabled: !!seriesId,
  });
}

export function useCreateSeries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePubSeriesPayload) =>
      apiFetch<PubSeriesDto>(`${PREFIX}/publications/series`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publications'] }),
  });
}

export function useCreateEdition(seriesId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePubEditionPayload) =>
      apiFetch<PubEditionDto>(`${PREFIX}/publications/series/${seriesId}/editions`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publications'] }),
  });
}

// Publications ──────────────────────────────────────────────

export function usePublications(args: { status?: PubStatus; seriesId?: string } = {}) {
  const qs = new URLSearchParams();
  if (args.status) qs.append('status', args.status);
  if (args.seriesId) qs.append('seriesId', args.seriesId);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return useQuery({
    queryKey: ['publications', 'list', args],
    queryFn: () => apiFetch<PubPublicationDto[]>(`${PREFIX}/publications${suffix}`),
    staleTime: 30_000,
  });
}

export function usePublication(id: string | null) {
  return useQuery({
    queryKey: ['publications', 'detail', id],
    queryFn: () => apiFetch<PubPublicationDetailDto>(`${PREFIX}/publications/${id}`),
    enabled: !!id,
  });
}

export function useUpdatePublicationStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: PubStatus) =>
      apiFetch<PubPublicationDto>(`${PREFIX}/publications/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publications'] }),
  });
}

export function useInviteCollaborator(publicationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      userId: string;
      role: 'EDITOR' | 'CONTRIBUTOR' | 'REVIEWER' | 'VIEWER';
    }) =>
      apiFetch<PubCollaboratorDto>(`${PREFIX}/publications/${publicationId}/collaborators`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publications'] }),
  });
}

// Sections ──────────────────────────────────────────────────

export function useSections(publicationId: string | null) {
  return useQuery({
    queryKey: ['publications', publicationId, 'sections'],
    queryFn: () => apiFetch<PubSectionDto[]>(`${PREFIX}/publications/${publicationId}/sections`),
    enabled: !!publicationId,
  });
}

export function useCreateSection(publicationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePubSectionPayload) =>
      apiFetch<PubSectionDto>(`${PREFIX}/publications/${publicationId}/sections`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publications'] }),
  });
}

export function useUpdateSection(sectionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdatePubSectionPayload) =>
      apiFetch<PubSectionDto>(`${PREFIX}/publication-sections/${sectionId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publications'] }),
  });
}

export function useApproveSection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sectionId: string) =>
      apiFetch<PubSectionDto>(`${PREFIX}/publication-sections/${sectionId}/approve`, {
        method: 'PATCH',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publications'] }),
  });
}

export function useSectionComments(sectionId: string | null) {
  return useQuery({
    queryKey: ['publications', 'section', sectionId, 'comments'],
    queryFn: () =>
      apiFetch<PubSectionCommentDto[]>(`${PREFIX}/publication-sections/${sectionId}/comments`),
    enabled: !!sectionId,
  });
}

export function usePostComment(sectionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { body: string; parentCommentId?: string }) =>
      apiFetch<PubSectionCommentDto>(`${PREFIX}/publication-sections/${sectionId}/comments`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publications', 'section'] }),
  });
}

export function useResolveComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) =>
      apiFetch<PubSectionCommentDto>(`${PREFIX}/publication-comments/${commentId}/resolve`, {
        method: 'PATCH',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publications', 'section'] }),
  });
}

// Distribution ──────────────────────────────────────────────

export function useDistributionLists(publicationId: string | null) {
  return useQuery({
    queryKey: ['publications', publicationId, 'distribution-lists'],
    queryFn: () =>
      apiFetch<PubDistributionListDto[]>(
        `${PREFIX}/publications/${publicationId}/distribution-lists`,
      ),
    enabled: !!publicationId,
  });
}

export function useCreateDistributionList(publicationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePubDistributionListPayload) =>
      apiFetch<PubDistributionListDto>(
        `${PREFIX}/publications/${publicationId}/distribution-lists`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publications'] }),
  });
}

export function usePreviewAudience(publicationId: string) {
  return useMutation({
    mutationFn: () =>
      apiFetch<PubAudiencePreviewDto>(`${PREFIX}/publications/${publicationId}/audience-preview`, {
        method: 'POST',
      }),
  });
}

export function useDistribute(publicationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<PubDistributeResultDto>(`${PREFIX}/publications/${publicationId}/distribute`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publications'] }),
  });
}

export function useDistributionStatus(publicationId: string | null) {
  return useQuery({
    queryKey: ['publications', publicationId, 'distribution-status'],
    queryFn: () =>
      apiFetch<PubDistributionStatusDto>(
        `${PREFIX}/publications/${publicationId}/distribution-status`,
      ),
    enabled: !!publicationId,
    staleTime: 15_000,
  });
}

// Subscriptions ─────────────────────────────────────────────

export function useMySubscriptions() {
  return useQuery({
    queryKey: ['publications', 'my-subscriptions'],
    queryFn: () => apiFetch<PubSubscriptionDto[]>(`${PREFIX}/publications/my-subscriptions`),
    staleTime: 30_000,
  });
}

export function useSubscribe(seriesId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<PubSubscriptionDto>(`${PREFIX}/publications/series/${seriesId}/subscribe`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publications'] }),
  });
}

export function useUnsubscribe(seriesId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<PubSubscriptionDto>(`${PREFIX}/publications/series/${seriesId}/unsubscribe`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publications'] }),
  });
}
