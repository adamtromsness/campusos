import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AchievementDto,
  AchievementShareDto,
  CreateAchievementPayload,
  CreateAchievementSharePayload,
  CreatePortfolioItemPayload,
  CreatePortfolioPayload,
  CreateSharePayload,
  ItemSourceCandidateDto,
  PortfolioDetailDto,
  PortfolioDto,
  PortfolioItemDto,
  PublicPortfolioViewDto,
  ShareDto,
  UpdateAchievementPayload,
  UpdatePortfolioItemPayload,
  UpdatePortfolioPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ── Portfolio ─────────────────────────────────────────────────

export function useMyPortfolio(enabled = true) {
  return useQuery({
    queryKey: ['portfolio', 'my'],
    queryFn: () => apiFetch<PortfolioDetailDto>(`${PREFIX}/portfolio/my`),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function usePortfolioForStudent(studentId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['portfolio', 'student', studentId],
    queryFn: () => apiFetch<PortfolioDetailDto>(`${PREFIX}/portfolio/students/${studentId}`),
    enabled: enabled && !!studentId,
    staleTime: 30_000,
  });
}

export function useCreatePortfolio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePortfolioPayload) =>
      apiFetch<PortfolioDto>(`${PREFIX}/portfolio`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio'] }),
  });
}

export function useUpdatePortfolio(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdatePortfolioPayload) =>
      apiFetch<PortfolioDto>(`${PREFIX}/portfolio/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio'] }),
  });
}

// ── Portfolio items ───────────────────────────────────────────

export function usePortfolioItems(portfolioId: string | null) {
  return useQuery({
    queryKey: ['portfolio', portfolioId, 'items'],
    queryFn: () => apiFetch<PortfolioItemDto[]>(`${PREFIX}/portfolio/${portfolioId}/items`),
    enabled: !!portfolioId,
    staleTime: 30_000,
  });
}

export function useItemSources(enabled = true) {
  return useQuery({
    queryKey: ['portfolio', 'item-sources'],
    queryFn: () => apiFetch<ItemSourceCandidateDto[]>(`${PREFIX}/portfolio/items/sources`),
    enabled,
    staleTime: 60_000,
  });
}

export function useAddPortfolioItem(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePortfolioItemPayload) =>
      apiFetch<PortfolioItemDto>(`${PREFIX}/portfolio/${portfolioId}/items`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio'] }),
  });
}

export function useUpdatePortfolioItem(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdatePortfolioItemPayload) =>
      apiFetch<PortfolioItemDto>(`${PREFIX}/portfolio-items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio'] }),
  });
}

export function useRemovePortfolioItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) =>
      apiFetch<void>(`${PREFIX}/portfolio-items/${itemId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio'] }),
  });
}

// ── Shares ────────────────────────────────────────────────────

export function usePortfolioShares(portfolioId: string | null) {
  return useQuery({
    queryKey: ['portfolio', portfolioId, 'shares'],
    queryFn: () => apiFetch<ShareDto[]>(`${PREFIX}/portfolio/${portfolioId}/shares`),
    enabled: !!portfolioId,
    staleTime: 30_000,
  });
}

export function useCreateShare(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSharePayload) =>
      apiFetch<ShareDto>(`${PREFIX}/portfolio/${portfolioId}/shares`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio'] }),
  });
}

export function useRevokeShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) =>
      apiFetch<void>(`${PREFIX}/portfolio-shares/${shareId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio'] }),
  });
}

export function usePublicShare(token: string | null) {
  return useQuery({
    queryKey: ['portfolio', 'share', token],
    queryFn: () => apiFetch<PublicPortfolioViewDto>(`${PREFIX}/portfolio/share/${token}`),
    enabled: !!token,
    staleTime: 60_000,
    retry: false,
  });
}

// ── Achievements ──────────────────────────────────────────────

export function useAchievements(studentId?: string) {
  return useQuery({
    queryKey: ['portfolio', 'achievements', studentId ?? 'all'],
    queryFn: () => {
      const qs = studentId ? `?studentId=${studentId}` : '';
      return apiFetch<AchievementDto[]>(`${PREFIX}/portfolio/achievements${qs}`);
    },
    staleTime: 30_000,
  });
}

export function useStudentAchievements(studentId: string | null) {
  return useQuery({
    queryKey: ['portfolio', 'student-achievements', studentId],
    queryFn: () =>
      apiFetch<AchievementDto[]>(`${PREFIX}/portfolio/students/${studentId}/achievements`),
    enabled: !!studentId,
    staleTime: 30_000,
  });
}

export function useAchievement(id: string | null) {
  return useQuery({
    queryKey: ['portfolio', 'achievement', id],
    queryFn: () => apiFetch<AchievementDto>(`${PREFIX}/portfolio/achievements/${id}`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useAwardAchievement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAchievementPayload) =>
      apiFetch<AchievementDto>(`${PREFIX}/portfolio/achievements`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio'] }),
  });
}

export function useUpdateAchievement(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateAchievementPayload) =>
      apiFetch<AchievementDto>(`${PREFIX}/portfolio/achievements/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio'] }),
  });
}

export function useAchievementShares(id: string | null) {
  return useQuery({
    queryKey: ['portfolio', 'achievement', id, 'shares'],
    queryFn: () => apiFetch<AchievementShareDto[]>(`${PREFIX}/portfolio/achievements/${id}/shares`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useShareAchievement(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAchievementSharePayload) =>
      apiFetch<AchievementShareDto>(`${PREFIX}/portfolio/achievements/${id}/share`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio'] }),
  });
}
