'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AnnouncementDto,
  AnnouncementStatsDto,
  CreateAnnouncementPayload,
  MarkAnnouncementReadResponse,
  UpdateAnnouncementPayload,
} from '@/lib/types';

interface AnnouncementsListArgs {
  includeDrafts?: boolean;
  includeExpired?: boolean;
}

export function useAnnouncements(args: AnnouncementsListArgs = {}, enabled = true) {
  const params = new URLSearchParams();
  if (args.includeDrafts) params.set('includeDrafts', 'true');
  if (args.includeExpired) params.set('includeExpired', 'true');
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'announcements',
      'list',
      { drafts: args.includeDrafts ?? false, expired: args.includeExpired ?? false },
    ],
    queryFn: () => apiFetch<AnnouncementDto[]>(`/api/v1/announcements${qs ? `?${qs}` : ''}`),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    enabled,
  });
}

export function useAnnouncement(id: string | null | undefined) {
  return useQuery({
    queryKey: ['announcements', 'detail', id],
    queryFn: () => apiFetch<AnnouncementDto>(`/api/v1/announcements/${id}`),
    enabled: typeof id === 'string' && id.length > 0,
  });
}

export function useAnnouncementStats(id: string | null | undefined) {
  return useQuery({
    queryKey: ['announcements', 'stats', id],
    queryFn: () => apiFetch<AnnouncementStatsDto>(`/api/v1/announcements/${id}/stats`),
    enabled: typeof id === 'string' && id.length > 0,
    refetchInterval: 30_000,
  });
}

export function useCreateAnnouncement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAnnouncementPayload) =>
      apiFetch<AnnouncementDto>('/api/v1/announcements', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (a) => {
      qc.setQueryData(['announcements', 'detail', a.id], a);
      void qc.invalidateQueries({ queryKey: ['announcements', 'list'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useUpdateAnnouncement(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateAnnouncementPayload) =>
      apiFetch<AnnouncementDto>(`/api/v1/announcements/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: (a) => {
      qc.setQueryData(['announcements', 'detail', a.id], a);
      void qc.invalidateQueries({ queryKey: ['announcements', 'list'] });
      void qc.invalidateQueries({ queryKey: ['announcements', 'stats', a.id] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useMarkAnnouncementRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<MarkAnnouncementReadResponse>(`/api/v1/announcements/${id}/read`, {
        method: 'POST',
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['announcements', 'detail', data.announcementId] });
      void qc.invalidateQueries({ queryKey: ['announcements', 'list'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
