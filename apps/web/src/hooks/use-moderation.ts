'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CreateModerationPolicyPayload,
  ModerationPolicyDto,
  ModerationQueueRowDto,
  ReviewModerationLogPayload,
  UpdateModerationPolicyPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

export function useModerationPolicies(includeInactive = false, enabled = true) {
  return useQuery({
    queryKey: ['moderation-policies', { includeInactive }],
    queryFn: () =>
      apiFetch<ModerationPolicyDto[]>(
        PREFIX +
          '/messaging/moderation/policies' +
          (includeInactive ? '?includeInactive=true' : ''),
      ),
    staleTime: 60 * 1000,
    enabled,
  });
}

export function useCreateModerationPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateModerationPolicyPayload) =>
      apiFetch<ModerationPolicyDto>(PREFIX + '/messaging/moderation/policies', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['moderation-policies'] }),
  });
}

export function useUpdateModerationPolicy(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateModerationPolicyPayload) =>
      apiFetch<ModerationPolicyDto>(PREFIX + '/messaging/moderation/policies/' + id, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['moderation-policies'] }),
  });
}

export function useModerationQueue(enabled = true) {
  return useQuery({
    queryKey: ['moderation-queue'],
    queryFn: () => apiFetch<ModerationQueueRowDto[]>(PREFIX + '/messaging/moderation/queue'),
    refetchOnWindowFocus: true,
    refetchInterval: 30 * 1000,
    staleTime: 15 * 1000,
    enabled,
  });
}

export function useReviewModerationLog(logId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewModerationLogPayload) =>
      apiFetch<{ logId: string; messageId: string; outcome: string }>(
        PREFIX + '/messaging/moderation/log/' + logId + '/review',
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['moderation-queue'] });
      qc.invalidateQueries({ queryKey: ['moderation-log'] });
    },
  });
}

export function useModerationLog(
  filters: {
    flagType?: string;
    fromDate?: string;
    toDate?: string;
    policyId?: string;
    limit?: number;
  } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: ['moderation-log', filters],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (filters.flagType) qs.set('flagType', filters.flagType);
      if (filters.fromDate) qs.set('fromDate', filters.fromDate);
      if (filters.toDate) qs.set('toDate', filters.toDate);
      if (filters.policyId) qs.set('policyId', filters.policyId);
      if (filters.limit) qs.set('limit', String(filters.limit));
      const q = qs.toString();
      return apiFetch<ModerationQueueRowDto[]>(
        PREFIX + '/messaging/moderation/log' + (q ? '?' + q : ''),
      );
    },
    enabled,
    staleTime: 30 * 1000,
  });
}
