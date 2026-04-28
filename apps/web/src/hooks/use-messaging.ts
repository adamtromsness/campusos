'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CreateThreadPayload,
  MarkThreadReadResponse,
  MessageDto,
  MessagingRecipientDto,
  PostMessagePayload,
  ThreadDto,
  ThreadTypeDto,
} from '@/lib/types';

/**
 * useThreads — inbox query. Polls every 15s while the inbox is open so
 * incoming messages and unread counters refresh without a manual reload.
 */
export function useThreads(includeArchived = false) {
  const qs = includeArchived ? '?includeArchived=true' : '';
  return useQuery({
    queryKey: ['messaging', 'threads', { includeArchived }],
    queryFn: () => apiFetch<ThreadDto[]>(`/api/v1/threads${qs}`),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useThread(threadId: string | null | undefined) {
  return useQuery({
    queryKey: ['messaging', 'thread', threadId],
    queryFn: () => apiFetch<ThreadDto>(`/api/v1/threads/${threadId}`),
    enabled: typeof threadId === 'string' && threadId.length > 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useThreadMessages(threadId: string | null | undefined, limit = 50) {
  return useQuery({
    queryKey: ['messaging', 'messages', threadId, limit],
    queryFn: () =>
      apiFetch<MessageDto[]>(
        `/api/v1/threads/${threadId}/messages?limit=${limit}`,
      ),
    enabled: typeof threadId === 'string' && threadId.length > 0,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useThreadTypes() {
  return useQuery({
    queryKey: ['messaging', 'thread-types'],
    queryFn: () => apiFetch<ThreadTypeDto[]>('/api/v1/threads/types'),
    staleTime: 5 * 60_000,
  });
}

export function useMessagingRecipients(threadTypeId: string | null | undefined) {
  return useQuery({
    queryKey: ['messaging', 'recipients', threadTypeId],
    queryFn: () =>
      apiFetch<MessagingRecipientDto[]>(
        `/api/v1/threads/recipients?threadTypeId=${threadTypeId}`,
      ),
    enabled: typeof threadTypeId === 'string' && threadTypeId.length > 0,
    staleTime: 60_000,
  });
}

export function useCreateThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateThreadPayload) =>
      apiFetch<ThreadDto>('/api/v1/threads', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (thread) => {
      qc.setQueryData(['messaging', 'thread', thread.id], thread);
      void qc.invalidateQueries({ queryKey: ['messaging', 'threads'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function usePostMessage(threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: PostMessagePayload) =>
      apiFetch<MessageDto>(`/api/v1/threads/${threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['messaging', 'messages', threadId] });
      void qc.invalidateQueries({ queryKey: ['messaging', 'thread', threadId] });
      void qc.invalidateQueries({ queryKey: ['messaging', 'threads'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useMarkThreadRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) =>
      apiFetch<MarkThreadReadResponse>(`/api/v1/threads/${threadId}/read`, {
        method: 'POST',
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['messaging', 'thread', data.threadId] });
      void qc.invalidateQueries({ queryKey: ['messaging', 'threads'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useArchiveThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { threadId: string; isArchived: boolean }) =>
      apiFetch<ThreadDto>(`/api/v1/threads/${args.threadId}/archive`, {
        method: 'PATCH',
        body: JSON.stringify({ isArchived: args.isArchived }),
      }),
    onSuccess: (thread) => {
      qc.setQueryData(['messaging', 'thread', thread.id], thread);
      void qc.invalidateQueries({ queryKey: ['messaging', 'threads'] });
    },
  });
}
