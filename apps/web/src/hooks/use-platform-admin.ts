'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

const PREFIX = '/api/v1/admin';

/**
 * Cycle 31 Step 9 — Platform Admin Dashboard hooks.
 *
 * The endpoints under /api/v1/admin/* are gated on sys-001:admin which
 * only Platform Admin holds. School Admins do not see this surface;
 * these dashboards expose cross-tenant state.
 */

// ---------- DLQ ----------

export interface DlqRow {
  id: string;
  topic: string;
  partition: number;
  kafkaOffset: string;
  consumerGroup: string;
  eventId: string | null;
  tenantId: string | null;
  errorClass: string | null;
  retryCount: number;
  firstFailedAt: string;
  lastFailedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
  ageHours: number;
}

export interface DlqRowFull extends DlqRow {
  payload: unknown;
  headers: unknown;
  errorMessage: string;
}

export interface DlqStats {
  totalUnresolved: number;
  olderThan15Min: number;
  byConsumerGroup: Array<{ consumerGroup: string; count: number }>;
}

export function useDlqStats() {
  return useQuery<DlqStats>({
    queryKey: ['admin', 'dlq', 'stats'],
    queryFn: () => apiFetch(`${PREFIX}/dlq/stats`),
    refetchInterval: 30_000,
  });
}

export function useDlqMessages(args: {
  consumerGroup?: string;
  topic?: string;
  tenantId?: string;
  resolved?: boolean;
  limit?: number;
}) {
  const params = new URLSearchParams();
  if (args.consumerGroup) params.set('consumerGroup', args.consumerGroup);
  if (args.topic) params.set('topic', args.topic);
  if (args.tenantId) params.set('tenantId', args.tenantId);
  if (args.resolved !== undefined) params.set('resolved', String(args.resolved));
  if (args.limit) params.set('limit', String(args.limit));
  const qs = params.toString();
  return useQuery<DlqRow[]>({
    queryKey: ['admin', 'dlq', 'list', args],
    queryFn: () => apiFetch(`${PREFIX}/dlq${qs ? `?${qs}` : ''}`),
    refetchInterval: 30_000,
  });
}

export function useDlqMessage(id: string | null) {
  return useQuery<DlqRowFull>({
    queryKey: ['admin', 'dlq', 'detail', id],
    queryFn: () => apiFetch(`${PREFIX}/dlq/${id}`),
    enabled: !!id,
  });
}

export function useReplayDlq() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`${PREFIX}/dlq/${id}/replay`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'dlq'] });
    },
  });
}

export function useDiscardDlq() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      apiFetch(`${PREFIX}/dlq/${input.id}/discard`, {
        method: 'POST',
        body: JSON.stringify({ reason: input.reason }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'dlq'] });
    },
  });
}

// ---------- Tenants ----------

export interface TenantSummary {
  schoolId: string;
  subdomain: string;
  schemaName: string;
  name: string;
  isFrozen: boolean;
  baseTableCount: number | null;
  pendingDlqCount: number;
}

export function useTenants() {
  return useQuery<TenantSummary[]>({
    queryKey: ['admin', 'tenants'],
    queryFn: () => apiFetch(`${PREFIX}/platform/tenants`),
    refetchInterval: 60_000,
  });
}

// ---------- Partitions ----------

export interface PartitionRow {
  parentTable: string;
  partitionName: string;
  rangeFrom: string;
  rangeTo: string;
  rowCount: number | null;
  sizeMb: number | null;
}

export function usePartitions(parentTable?: string) {
  const qs = parentTable ? `?parentTable=${encodeURIComponent(parentTable)}` : '';
  return useQuery<PartitionRow[]>({
    queryKey: ['admin', 'partitions', parentTable ?? 'all'],
    queryFn: () => apiFetch(`${PREFIX}/platform/partitions${qs}`),
    refetchInterval: 60_000,
  });
}

// ---------- Migrations ----------

export interface MigrationRow {
  scope: 'platform' | 'tenant';
  schemaName: string | null;
  migrationName: string;
  appliedAt: string;
}

export function useMigrationHistory(args: { scope?: 'platform' | 'tenant'; limit?: number }) {
  const params = new URLSearchParams();
  if (args.scope) params.set('scope', args.scope);
  if (args.limit) params.set('limit', String(args.limit));
  const qs = params.toString();
  return useQuery<MigrationRow[]>({
    queryKey: ['admin', 'migrations', args],
    queryFn: () => apiFetch(`${PREFIX}/platform/migrations${qs ? `?${qs}` : ''}`),
  });
}
