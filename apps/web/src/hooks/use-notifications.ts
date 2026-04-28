'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MarkAllReadResponse,
  NotificationHistoryResponse,
  NotificationInboxResponse,
} from '@/lib/types';

/**
 * useNotificationInbox — bell badge + dropdown source.
 *
 * Polls every 30s while the page is open (matches the Step 8 plan). The
 * call is cheap (Redis-only) so a 30s cadence is fine; once we add server
 * push or websockets in a later phase we can drop polling entirely.
 */
export function useNotificationInbox(limit = 10) {
  return useQuery({
    queryKey: ['notifications', 'inbox', limit],
    queryFn: () =>
      apiFetch<NotificationInboxResponse>(`/api/v1/notifications/inbox?limit=${limit}`),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

interface HistoryArgs {
  limit?: number;
  type?: string;
  before?: string;
}

export function useNotificationHistory(args: HistoryArgs = {}) {
  const params = new URLSearchParams();
  if (args.limit) params.set('limit', String(args.limit));
  if (args.type) params.set('type', args.type);
  if (args.before) params.set('before', args.before);
  const qs = params.toString();
  return useQuery({
    queryKey: ['notifications', 'history', args.limit ?? 25, args.type ?? 'all', args.before ?? ''],
    queryFn: () =>
      apiFetch<NotificationHistoryResponse>(`/api/v1/notifications/history${qs ? `?${qs}` : ''}`),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<MarkAllReadResponse>('/api/v1/notifications/mark-all-read', { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
