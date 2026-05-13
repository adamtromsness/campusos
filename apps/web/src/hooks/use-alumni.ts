'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AddAlumniTagPayload,
  AddRecipientsByTagPayload,
  AlumniCampaignDto,
  AlumniCampaignRecipientDto,
  AlumniDonationDto,
  AlumniEventDto,
  AlumniNewsCategory,
  AlumniNewsDto,
  AlumniProfileDto,
  AlumniTagDto,
  CampaignFunnelDto,
  CampaignRaisedDto,
  CampaignStatus,
  CreateAlumniCampaignPayload,
  CreateAlumniDonationPayload,
  CreateAlumniEventPayload,
  CreateAlumniNewsPayload,
  CreateAlumniProfilePayload,
  CreateReunionGroupPayload,
  OutreachStatus,
  ReunionGroupDto,
  ReunionStatus,
  UpdateAlumniCampaignPayload,
  UpdateAlumniEventPayload,
  UpdateAlumniNewsPayload,
  UpdateAlumniProfilePayload,
  UpdateRecipientStatusPayload,
  UpdateReunionGroupPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ─── Profiles ─────────────────────────────────────────────────

export interface AlumniListFilters {
  graduationYear?: number;
  employer?: string;
  tag?: string;
}

export function useAlumniProfiles(filters: AlumniListFilters = {}) {
  const qs = new URLSearchParams();
  if (filters.graduationYear !== undefined)
    qs.set('graduationYear', String(filters.graduationYear));
  if (filters.employer !== undefined && filters.employer.length > 0)
    qs.set('employer', filters.employer);
  if (filters.tag !== undefined && filters.tag.length > 0) qs.set('tag', filters.tag);
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return useQuery({
    queryKey: ['alumni', 'profiles', filters],
    queryFn: () => apiFetch<AlumniProfileDto[]>(PREFIX + '/alumni/profiles' + suffix),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useAlumniProfile(id: string | null) {
  return useQuery({
    queryKey: ['alumni', 'profile', id],
    queryFn: () => apiFetch<AlumniProfileDto>(PREFIX + '/alumni/profiles/' + id),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useMyAlumniProfile(enabled = true) {
  return useQuery({
    queryKey: ['alumni', 'profiles', 'me'],
    queryFn: () => apiFetch<AlumniProfileDto>(PREFIX + '/alumni/profiles/me'),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useAlumniByTag(tag: string | null) {
  return useQuery({
    queryKey: ['alumni', 'profiles', 'by-tag', tag],
    queryFn: () =>
      apiFetch<AlumniProfileDto[]>(
        PREFIX + '/alumni/profiles/by-tag/' + encodeURIComponent(tag ?? ''),
      ),
    enabled: !!tag,
    staleTime: 60_000,
  });
}

export function useCreateAlumniProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAlumniProfilePayload) =>
      apiFetch<AlumniProfileDto>(PREFIX + '/alumni/profiles', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alumni', 'profiles'] });
    },
  });
}

export function useUpdateAlumniProfile(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateAlumniProfilePayload) =>
      apiFetch<AlumniProfileDto>(PREFIX + '/alumni/profiles/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alumni', 'profiles'] });
      qc.invalidateQueries({ queryKey: ['alumni', 'profile', id] });
      qc.invalidateQueries({ queryKey: ['alumni', 'profiles', 'me'] });
    },
  });
}

// ─── Tags ─────────────────────────────────────────────────────

export function useAddAlumniTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AddAlumniTagPayload) =>
      apiFetch<AlumniTagDto>(PREFIX + '/alumni/tags', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alumni', 'profiles'] });
      qc.invalidateQueries({ queryKey: ['alumni', 'profiles', 'me'] });
    },
  });
}

export function useRemoveAlumniTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(PREFIX + '/alumni/tags/' + id, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alumni', 'profiles'] });
      qc.invalidateQueries({ queryKey: ['alumni', 'profiles', 'me'] });
    },
  });
}

// ─── Campaigns ────────────────────────────────────────────────

export function useAlumniCampaigns(status?: CampaignStatus) {
  const suffix = status ? '?status=' + status : '';
  return useQuery({
    queryKey: ['alumni', 'campaigns', { status }],
    queryFn: () => apiFetch<AlumniCampaignDto[]>(PREFIX + '/alumni/campaigns' + suffix),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useAlumniCampaign(id: string | null) {
  return useQuery({
    queryKey: ['alumni', 'campaign', id],
    queryFn: () => apiFetch<AlumniCampaignDto>(PREFIX + '/alumni/campaigns/' + id),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCampaignRaised(id: string | null) {
  return useQuery({
    queryKey: ['alumni', 'campaign', id, 'raised'],
    queryFn: () => apiFetch<CampaignRaisedDto>(PREFIX + '/alumni/campaigns/' + id + '/raised'),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCampaignFunnel(id: string | null) {
  return useQuery({
    queryKey: ['alumni', 'campaign', id, 'funnel'],
    queryFn: () => apiFetch<CampaignFunnelDto>(PREFIX + '/alumni/campaigns/' + id + '/funnel'),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCampaignRecipients(id: string | null, status?: OutreachStatus) {
  const suffix = status ? '?status=' + status : '';
  return useQuery({
    queryKey: ['alumni', 'campaign', id, 'recipients', { status }],
    queryFn: () =>
      apiFetch<AlumniCampaignRecipientDto[]>(
        PREFIX + '/alumni/campaigns/' + id + '/recipients' + suffix,
      ),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCampaignDonations(id: string | null) {
  return useQuery({
    queryKey: ['alumni', 'campaign', id, 'donations'],
    queryFn: () => apiFetch<AlumniDonationDto[]>(PREFIX + '/alumni/campaigns/' + id + '/donations'),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateAlumniCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAlumniCampaignPayload) =>
      apiFetch<AlumniCampaignDto>(PREFIX + '/alumni/campaigns', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alumni', 'campaigns'] });
    },
  });
}

export function useUpdateAlumniCampaign(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateAlumniCampaignPayload) =>
      apiFetch<AlumniCampaignDto>(PREFIX + '/alumni/campaigns/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alumni', 'campaigns'] });
      qc.invalidateQueries({ queryKey: ['alumni', 'campaign', id] });
    },
  });
}

export function useActivateAlumniCampaign(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<AlumniCampaignDto>(PREFIX + '/alumni/campaigns/' + id + '/activate', {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alumni', 'campaigns'] });
      qc.invalidateQueries({ queryKey: ['alumni', 'campaign', id] });
    },
  });
}

export function useAddRecipientsByTag(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AddRecipientsByTagPayload) =>
      apiFetch<{ campaignId: string; created: number; skipped: number }>(
        PREFIX + '/alumni/campaigns/' + campaignId + '/recipients',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alumni', 'campaign', campaignId] });
      qc.invalidateQueries({ queryKey: ['alumni', 'campaign', campaignId, 'recipients'] });
      qc.invalidateQueries({ queryKey: ['alumni', 'campaign', campaignId, 'funnel'] });
    },
  });
}

export function useSendOutreach(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ campaignId: string; sent: number }>(
        PREFIX + '/alumni/campaigns/' + campaignId + '/send-outreach',
        {
          method: 'POST',
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alumni', 'campaign', campaignId, 'recipients'] });
      qc.invalidateQueries({ queryKey: ['alumni', 'campaign', campaignId, 'funnel'] });
    },
  });
}

export function useUpdateRecipientStatus(recipientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateRecipientStatusPayload) =>
      apiFetch<AlumniCampaignRecipientDto>(PREFIX + '/alumni/campaign-recipients/' + recipientId, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alumni'] });
    },
  });
}

// ─── Donations ────────────────────────────────────────────────

export function useDonate(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAlumniDonationPayload) =>
      apiFetch<AlumniDonationDto>(PREFIX + '/alumni/campaigns/' + campaignId + '/donate', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alumni', 'campaign', campaignId] });
      qc.invalidateQueries({ queryKey: ['alumni', 'campaign', campaignId, 'raised'] });
      qc.invalidateQueries({ queryKey: ['alumni', 'campaign', campaignId, 'donations'] });
      qc.invalidateQueries({ queryKey: ['alumni', 'campaign', campaignId, 'funnel'] });
      qc.invalidateQueries({ queryKey: ['alumni', 'campaign', campaignId, 'recipients'] });
      qc.invalidateQueries({ queryKey: ['alumni', 'campaigns'] });
    },
  });
}

// ─── News ─────────────────────────────────────────────────────

export interface AlumniNewsFilters {
  category?: AlumniNewsCategory;
  includeDrafts?: boolean;
}

export function useAlumniNews(filters: AlumniNewsFilters = {}) {
  const qs = new URLSearchParams();
  if (filters.category) qs.set('category', filters.category);
  if (filters.includeDrafts) qs.set('includeDrafts', 'true');
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return useQuery({
    queryKey: ['alumni', 'news', filters],
    queryFn: () => apiFetch<AlumniNewsDto[]>(PREFIX + '/alumni/news' + suffix),
    staleTime: 30_000,
  });
}

export function useAlumniNewsArticle(id: string | null) {
  return useQuery({
    queryKey: ['alumni', 'news', id],
    queryFn: () => apiFetch<AlumniNewsDto>(PREFIX + '/alumni/news/' + id),
    enabled: !!id,
  });
}

export function useCreateAlumniNews() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAlumniNewsPayload) =>
      apiFetch<AlumniNewsDto>(PREFIX + '/alumni/news', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alumni', 'news'] }),
  });
}

export function useUpdateAlumniNews(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateAlumniNewsPayload) =>
      apiFetch<AlumniNewsDto>(PREFIX + '/alumni/news/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alumni', 'news'] }),
  });
}

export function useDeleteAlumniNews() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(PREFIX + '/alumni/news/' + id, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alumni', 'news'] }),
  });
}

// ─── Reunions ─────────────────────────────────────────────────

export interface ReunionFilters {
  graduationYear?: number;
  status?: ReunionStatus;
}

export function useReunions(filters: ReunionFilters = {}) {
  const qs = new URLSearchParams();
  if (filters.graduationYear !== undefined)
    qs.set('graduationYear', String(filters.graduationYear));
  if (filters.status) qs.set('status', filters.status);
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return useQuery({
    queryKey: ['alumni', 'reunions', filters],
    queryFn: () => apiFetch<ReunionGroupDto[]>(PREFIX + '/alumni/reunions' + suffix),
    staleTime: 30_000,
  });
}

export function useReunion(id: string | null) {
  return useQuery({
    queryKey: ['alumni', 'reunion', id],
    queryFn: () => apiFetch<ReunionGroupDto>(PREFIX + '/alumni/reunions/' + id),
    enabled: !!id,
  });
}

export function useCreateReunion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateReunionGroupPayload) =>
      apiFetch<ReunionGroupDto>(PREFIX + '/alumni/reunions', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alumni', 'reunions'] }),
  });
}

export function useUpdateReunion(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateReunionGroupPayload) =>
      apiFetch<ReunionGroupDto>(PREFIX + '/alumni/reunions/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alumni'] }),
  });
}

// ─── Alumni Events ────────────────────────────────────────────

export interface AlumniEventFilters {
  fromDate?: string;
  toDate?: string;
}

export function useAlumniEvents(filters: AlumniEventFilters = {}) {
  const qs = new URLSearchParams();
  if (filters.fromDate) qs.set('fromDate', filters.fromDate);
  if (filters.toDate) qs.set('toDate', filters.toDate);
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return useQuery({
    queryKey: ['alumni', 'events', filters],
    queryFn: () => apiFetch<AlumniEventDto[]>(PREFIX + '/alumni/events' + suffix),
    staleTime: 30_000,
  });
}

export function useAlumniEvent(id: string | null) {
  return useQuery({
    queryKey: ['alumni', 'event', id],
    queryFn: () => apiFetch<AlumniEventDto>(PREFIX + '/alumni/events/' + id),
    enabled: !!id,
  });
}

export function useCreateAlumniEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAlumniEventPayload) =>
      apiFetch<AlumniEventDto>(PREFIX + '/alumni/events', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alumni', 'events'] }),
  });
}

export function useUpdateAlumniEvent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateAlumniEventPayload) =>
      apiFetch<AlumniEventDto>(PREFIX + '/alumni/events/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alumni'] }),
  });
}

export function useDeleteAlumniEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(PREFIX + '/alumni/events/' + id, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alumni', 'events'] }),
  });
}
