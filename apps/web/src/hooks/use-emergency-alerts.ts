'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AlertTypeDto,
  CreateAlertTypePayload,
  EmergencyAlertDeliveryDto,
  EmergencyAlertDto,
  EmergencyAlertStatusDto,
  IssueEmergencyAlertPayload,
  UpdateAlertTypePayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

export function useAlertTypes(includeInactive = false, enabled = true) {
  return useQuery({
    queryKey: ['alert-types', { includeInactive }],
    queryFn: () =>
      apiFetch<AlertTypeDto[]>(
        PREFIX + '/messaging/alert-types' + (includeInactive ? '?includeInactive=true' : ''),
      ),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

export function useCreateAlertType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAlertTypePayload) =>
      apiFetch<AlertTypeDto>(PREFIX + '/messaging/alert-types', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert-types'] });
    },
  });
}

export function useUpdateAlertType(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAlertTypePayload) =>
      apiFetch<AlertTypeDto>(PREFIX + '/messaging/alert-types/' + id, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert-types'] });
    },
  });
}

export function useEmergencyAlerts(args: { status?: 'ACTIVE' | 'RESOLVED' } = {}, enabled = true) {
  return useQuery({
    queryKey: ['emergency-alerts', args],
    queryFn: () => {
      const qs = args.status ? '?status=' + args.status : '';
      return apiFetch<EmergencyAlertDto[]>(PREFIX + '/messaging/emergency-alerts' + qs);
    },
    refetchOnWindowFocus: true,
    refetchInterval: 30 * 1000,
    staleTime: 15 * 1000,
    enabled,
  });
}

export function useEmergencyAlert(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ['emergency-alerts', id],
    queryFn: () => apiFetch<EmergencyAlertDto>(PREFIX + '/messaging/emergency-alerts/' + id),
    enabled: enabled && !!id,
    staleTime: 15 * 1000,
  });
}

export function useEmergencyAlertStatus(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ['emergency-alert-status', id],
    queryFn: () =>
      apiFetch<EmergencyAlertStatusDto>(PREFIX + '/messaging/emergency-alerts/' + id + '/status'),
    enabled: enabled && !!id,
    refetchInterval: 30 * 1000,
  });
}

export function useIssueEmergencyAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: IssueEmergencyAlertPayload) =>
      apiFetch<EmergencyAlertDto>(PREFIX + '/messaging/emergency-alerts', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['emergency-alerts'] });
    },
  });
}

export function useResolveEmergencyAlert(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<EmergencyAlertDto>(PREFIX + '/messaging/emergency-alerts/' + id + '/resolve', {
        method: 'PATCH',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['emergency-alerts'] });
      qc.invalidateQueries({ queryKey: ['emergency-alert-status', id] });
    },
  });
}

export function useAcknowledgeDelivery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deliveryId: string) =>
      apiFetch<EmergencyAlertDeliveryDto>(
        PREFIX + '/messaging/emergency-alert-deliveries/' + deliveryId + '/acknowledge',
        { method: 'POST' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['emergency-alerts'] });
    },
  });
}
