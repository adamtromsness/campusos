'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ApprovalCommentDto,
  ApprovalRequestDto,
  CreateApprovalCommentPayload,
  ListApprovalsArgs,
  ReviewStepPayload,
  SubmitApprovalPayload,
  WorkflowTemplateDto,
} from '@/lib/types';

function buildQs(args: ListApprovalsArgs): string {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.requestType) params.set('requestType', args.requestType);
  if (typeof args.mine === 'boolean') params.set('mine', args.mine ? 'true' : 'false');
  const qs = params.toString();
  return qs ? '?' + qs : '';
}

export function useApprovals(args: ListApprovalsArgs = {}, enabled = true) {
  return useQuery({
    queryKey: [
      'approvals',
      'list',
      {
        status: args.status ?? null,
        requestType: args.requestType ?? null,
        mine: args.mine ?? null,
      },
    ],
    queryFn: () => apiFetch<ApprovalRequestDto[]>('/api/v1/approvals' + buildQs(args)),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export function useApproval(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['approvals', 'one', id],
    queryFn: () => apiFetch<ApprovalRequestDto>('/api/v1/approvals/' + id),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useSubmitApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SubmitApprovalPayload) =>
      apiFetch<ApprovalRequestDto>('/api/v1/approvals', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });
}

export function useApproveStep(requestId: string, stepId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReviewStepPayload) =>
      apiFetch<ApprovalRequestDto>(
        '/api/v1/approvals/' + requestId + '/steps/' + stepId + '/approve',
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });
}

export function useRejectStep(requestId: string, stepId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReviewStepPayload) =>
      apiFetch<ApprovalRequestDto>(
        '/api/v1/approvals/' + requestId + '/steps/' + stepId + '/reject',
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });
}

export function useAddApprovalComment(requestId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateApprovalCommentPayload) =>
      apiFetch<ApprovalCommentDto>('/api/v1/approvals/' + requestId + '/comments', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['approvals', 'one', requestId] });
    },
  });
}

export function useWithdrawApproval(requestId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<ApprovalRequestDto>('/api/v1/approvals/' + requestId + '/withdraw', {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });
}

export function useWorkflowTemplates(enabled = true) {
  return useQuery({
    queryKey: ['workflow-templates', 'list'],
    queryFn: () => apiFetch<WorkflowTemplateDto[]>('/api/v1/workflow-templates'),
    enabled,
  });
}

export function useWorkflowTemplate(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['workflow-templates', 'one', id],
    queryFn: () => apiFetch<WorkflowTemplateDto>('/api/v1/workflow-templates/' + id),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}
