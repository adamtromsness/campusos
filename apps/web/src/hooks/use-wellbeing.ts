'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ActivateWellbeingDeploymentResponse,
  CreateWellbeingDeploymentPayload,
  CreateWellbeingTemplatePayload,
  CreateWellbeingQuestionInputDto,
  DeploymentStatus,
  ResolveWellbeingAlertPayload,
  SubmitWellbeingCheckinPayload,
  UpdateWellbeingQuestionPayload,
  UpdateWellbeingTemplatePayload,
  WellbeingAlertDto,
  WellbeingAlertStatus,
  WellbeingAlertType,
  WellbeingCheckinDto,
  WellbeingDeploymentDto,
  WellbeingQuestionDto,
  WellbeingTemplateDto,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ─── Templates ────────────────────────────────────────────────

export function useWellbeingTemplates(includeInactive = false) {
  return useQuery({
    queryKey: ['wellbeing', 'templates', { includeInactive }],
    queryFn: () =>
      apiFetch<WellbeingTemplateDto[]>(
        PREFIX +
          '/counselling/wellbeing/templates' +
          (includeInactive ? '?includeInactive=true' : ''),
      ),
    staleTime: 60_000,
  });
}

export function useWellbeingTemplate(id: string | null) {
  return useQuery({
    queryKey: ['wellbeing', 'template', id],
    queryFn: () =>
      apiFetch<WellbeingTemplateDto>(PREFIX + '/counselling/wellbeing/templates/' + id),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateWellbeingTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateWellbeingTemplatePayload) =>
      apiFetch<WellbeingTemplateDto>(PREFIX + '/counselling/wellbeing/templates', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wellbeing', 'templates'] });
    },
  });
}

export function useUpdateWellbeingTemplate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateWellbeingTemplatePayload) =>
      apiFetch<WellbeingTemplateDto>(PREFIX + '/counselling/wellbeing/templates/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wellbeing', 'templates'] });
      qc.invalidateQueries({ queryKey: ['wellbeing', 'template', id] });
    },
  });
}

export function useAddWellbeingQuestion(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateWellbeingQuestionInputDto) =>
      apiFetch<WellbeingQuestionDto>(
        PREFIX + '/counselling/wellbeing/templates/' + templateId + '/questions',
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wellbeing', 'template', templateId] });
    },
  });
}

export function useUpdateWellbeingQuestion(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateWellbeingQuestionPayload }) =>
      apiFetch<WellbeingQuestionDto>(PREFIX + '/counselling/wellbeing/questions/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wellbeing', 'template', templateId] });
    },
  });
}

export function useDeleteWellbeingQuestion(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(PREFIX + '/counselling/wellbeing/questions/' + id, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wellbeing', 'template', templateId] });
    },
  });
}

// ─── Deployments ──────────────────────────────────────────────

export function useWellbeingDeployments(filters: {
  status?: DeploymentStatus;
  templateId?: string;
}) {
  const qs = new URLSearchParams();
  if (filters.status) qs.set('status', filters.status);
  if (filters.templateId) qs.set('templateId', filters.templateId);
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return useQuery({
    queryKey: ['wellbeing', 'deployments', filters],
    queryFn: () =>
      apiFetch<WellbeingDeploymentDto[]>(PREFIX + '/counselling/wellbeing/deployments' + suffix),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useWellbeingDeployment(id: string | null) {
  return useQuery({
    queryKey: ['wellbeing', 'deployment', id],
    queryFn: () =>
      apiFetch<WellbeingDeploymentDto>(PREFIX + '/counselling/wellbeing/deployments/' + id),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useCreateWellbeingDeployment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateWellbeingDeploymentPayload) =>
      apiFetch<WellbeingDeploymentDto>(PREFIX + '/counselling/wellbeing/deployments', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wellbeing', 'deployments'] });
    },
  });
}

export function useActivateWellbeingDeployment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ActivateWellbeingDeploymentResponse>(
        PREFIX + '/counselling/wellbeing/deployments/' + id + '/activate',
        { method: 'PATCH' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wellbeing', 'deployments'] });
      qc.invalidateQueries({ queryKey: ['wellbeing', 'checkins'] });
    },
  });
}

export function useCompleteWellbeingDeployment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<WellbeingDeploymentDto>(
        PREFIX + '/counselling/wellbeing/deployments/' + id + '/complete',
        { method: 'PATCH' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wellbeing', 'deployments'] });
    },
  });
}

export function useCancelWellbeingDeployment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<WellbeingDeploymentDto>(
        PREFIX + '/counselling/wellbeing/deployments/' + id + '/cancel',
        { method: 'PATCH' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wellbeing', 'deployments'] });
    },
  });
}

// ─── Check-ins ────────────────────────────────────────────────

export function useWellbeingCheckins(filters: {
  pending?: boolean;
  flagged?: boolean;
  deploymentId?: string;
  studentId?: string;
}) {
  const qs = new URLSearchParams();
  if (filters.pending !== undefined) qs.set('pending', String(filters.pending));
  if (filters.flagged !== undefined) qs.set('flagged', String(filters.flagged));
  if (filters.deploymentId) qs.set('deploymentId', filters.deploymentId);
  if (filters.studentId) qs.set('studentId', filters.studentId);
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return useQuery({
    queryKey: ['wellbeing', 'checkins', filters],
    queryFn: () =>
      apiFetch<WellbeingCheckinDto[]>(PREFIX + '/counselling/wellbeing/checkins' + suffix),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useWellbeingCheckin(id: string | null) {
  return useQuery({
    queryKey: ['wellbeing', 'checkin', id],
    queryFn: () => apiFetch<WellbeingCheckinDto>(PREFIX + '/counselling/wellbeing/checkins/' + id),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useSubmitWellbeingCheckin(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SubmitWellbeingCheckinPayload) =>
      apiFetch<WellbeingCheckinDto>(PREFIX + '/counselling/wellbeing/checkins/' + id + '/submit', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wellbeing', 'checkins'] });
      qc.invalidateQueries({ queryKey: ['wellbeing', 'checkin', id] });
      qc.invalidateQueries({ queryKey: ['wellbeing', 'alerts'] });
      qc.invalidateQueries({ queryKey: ['wellbeing', 'deployments'] });
    },
  });
}

// ─── Alerts ───────────────────────────────────────────────────

export function useWellbeingAlerts(filters: {
  status?: WellbeingAlertStatus;
  alertType?: WellbeingAlertType;
  studentId?: string;
}) {
  const qs = new URLSearchParams();
  if (filters.status) qs.set('status', filters.status);
  if (filters.alertType) qs.set('alertType', filters.alertType);
  if (filters.studentId) qs.set('studentId', filters.studentId);
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return useQuery({
    queryKey: ['wellbeing', 'alerts', filters],
    queryFn: () => apiFetch<WellbeingAlertDto[]>(PREFIX + '/counselling/wellbeing/alerts' + suffix),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useWellbeingAlert(id: string | null) {
  return useQuery({
    queryKey: ['wellbeing', 'alert', id],
    queryFn: () => apiFetch<WellbeingAlertDto>(PREFIX + '/counselling/wellbeing/alerts/' + id),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useAcknowledgeWellbeingAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<WellbeingAlertDto>(PREFIX + '/counselling/wellbeing/alerts/' + id + '/acknowledge', {
        method: 'PATCH',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wellbeing', 'alerts'] });
    },
  });
}

export function useResolveWellbeingAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ResolveWellbeingAlertPayload }) =>
      apiFetch<WellbeingAlertDto>(PREFIX + '/counselling/wellbeing/alerts/' + id + '/resolve', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wellbeing', 'alerts'] });
    },
  });
}
