'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AccActionPlanDto,
  AccActionPlanStatus,
  AccAdoptionDto,
  AccEvidenceItemDto,
  AccEvidenceStatus,
  AccFrameworkDto,
  AccReadinessReportDto,
  AccSelfStudyRatingDto,
  AccSelfStudySummaryDto,
  AccSiteVisitPrepDto,
  AccStandardDto,
  CreateAccActionPlanPayload,
  CreateAccAdoptionPayload,
  CreateAccCustomFrameworkPayload,
  CreateAccEvidencePayload,
  CreateAccSelfStudyRatingPayload,
  CreateAccSiteVisitPrepPayload,
  ReviewAccEvidencePayload,
  UpdateAccActionPlanPayload,
  UpdateAccSiteVisitPrepPayload,
  UpdateAccSubActionPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ─── Frameworks + Adoptions ───────────────────────────────────

export function useAccFrameworks(enabled: boolean = true) {
  return useQuery({
    queryKey: ['accreditation', 'frameworks'],
    queryFn: () => apiFetch<AccFrameworkDto[]>(`${PREFIX}/accreditation/frameworks`),
    staleTime: 60_000,
    enabled,
  });
}

export function useAccAdoptions(enabled: boolean = true) {
  return useQuery({
    queryKey: ['accreditation', 'adoptions'],
    queryFn: () => apiFetch<AccAdoptionDto[]>(`${PREFIX}/accreditation/adoptions`),
    staleTime: 60_000,
    enabled,
  });
}

export function useAccStandards(frameworkId: string | undefined) {
  return useQuery({
    queryKey: ['accreditation', 'standards', frameworkId],
    queryFn: () => apiFetch<AccStandardDto[]>(`${PREFIX}/accreditation/standards/${frameworkId}`),
    staleTime: 60_000,
    enabled: !!frameworkId,
  });
}

export function useCreateAccAdoption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAccAdoptionPayload) =>
      apiFetch<AccAdoptionDto>(`${PREFIX}/accreditation/adoptions`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accreditation', 'frameworks'] });
      void qc.invalidateQueries({ queryKey: ['accreditation', 'adoptions'] });
    },
  });
}

export function useCreateAccCustomFramework() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAccCustomFrameworkPayload) =>
      apiFetch<AccFrameworkDto>(`${PREFIX}/accreditation/custom-frameworks`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accreditation', 'frameworks'] });
    },
  });
}

// ─── Evidence ─────────────────────────────────────────────────

export function useAccEvidenceForStandard(standardId: string | undefined) {
  return useQuery({
    queryKey: ['accreditation', 'evidence', 'standard', standardId],
    queryFn: () => apiFetch<AccEvidenceItemDto[]>(`${PREFIX}/accreditation/evidence/${standardId}`),
    staleTime: 30_000,
    enabled: !!standardId,
  });
}

export function useAccEvidenceByStatus(status: AccEvidenceStatus | undefined) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return useQuery({
    queryKey: ['accreditation', 'evidence', 'by-status', status ?? 'ALL'],
    queryFn: () =>
      apiFetch<AccEvidenceItemDto[]>(`${PREFIX}/accreditation/evidence/by-status${qs}`),
    staleTime: 30_000,
  });
}

export function useAccEvidenceItem(id: string | undefined) {
  return useQuery({
    queryKey: ['accreditation', 'evidence', 'item', id],
    queryFn: () => apiFetch<AccEvidenceItemDto>(`${PREFIX}/accreditation/evidence/item/${id}`),
    enabled: !!id,
  });
}

export function useCreateAccEvidence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAccEvidencePayload) =>
      apiFetch<AccEvidenceItemDto>(`${PREFIX}/accreditation/evidence`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accreditation', 'evidence'] });
      void qc.invalidateQueries({ queryKey: ['accreditation', 'site-visit'] });
    },
  });
}

export function useReviewAccEvidence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ReviewAccEvidencePayload }) =>
      apiFetch<AccEvidenceItemDto>(`${PREFIX}/accreditation/evidence/${id}/review`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accreditation', 'evidence'] });
      void qc.invalidateQueries({ queryKey: ['accreditation', 'site-visit'] });
    },
  });
}

// ─── Self-Study Ratings ──────────────────────────────────────

export function useAccSelfStudy(cycleId: string | undefined) {
  return useQuery({
    queryKey: ['accreditation', 'self-study', cycleId],
    queryFn: () =>
      apiFetch<AccSelfStudyRatingDto[]>(`${PREFIX}/accreditation/self-study/${cycleId}`),
    enabled: !!cycleId,
    staleTime: 30_000,
  });
}

export function useAccSelfStudySummary(cycleId: string | undefined) {
  return useQuery({
    queryKey: ['accreditation', 'self-study', cycleId, 'summary'],
    queryFn: () =>
      apiFetch<AccSelfStudySummaryDto>(`${PREFIX}/accreditation/self-study/${cycleId}/summary`),
    enabled: !!cycleId,
    staleTime: 30_000,
  });
}

export function useCreateAccSelfStudyRating() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAccSelfStudyRatingPayload) =>
      apiFetch<AccSelfStudyRatingDto>(`${PREFIX}/accreditation/self-study-ratings`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accreditation', 'self-study'] });
      void qc.invalidateQueries({ queryKey: ['accreditation', 'site-visit'] });
    },
  });
}

// ─── Action Plans ────────────────────────────────────────────

export function useAccActionPlans(status: AccActionPlanStatus | undefined) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return useQuery({
    queryKey: ['accreditation', 'action-plans', status ?? 'ALL'],
    queryFn: () => apiFetch<AccActionPlanDto[]>(`${PREFIX}/accreditation/action-plans${qs}`),
    staleTime: 30_000,
  });
}

export function useAccActionPlan(id: string | undefined) {
  return useQuery({
    queryKey: ['accreditation', 'action-plan', id],
    queryFn: () => apiFetch<AccActionPlanDto>(`${PREFIX}/accreditation/action-plans/${id}`),
    enabled: !!id,
  });
}

export function useCreateAccActionPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAccActionPlanPayload) =>
      apiFetch<AccActionPlanDto>(`${PREFIX}/accreditation/action-plans`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accreditation', 'action-plans'] });
    },
  });
}

export function useUpdateAccActionPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateAccActionPlanPayload }) =>
      apiFetch<AccActionPlanDto>(`${PREFIX}/accreditation/action-plans/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: ['accreditation', 'action-plans'] });
      void qc.invalidateQueries({ queryKey: ['accreditation', 'action-plan', vars.id] });
    },
  });
}

export function useUpdateAccSubAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateAccSubActionPayload }) =>
      apiFetch<AccActionPlanDto>(`${PREFIX}/accreditation/action-plans/${id}/actions`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: ['accreditation', 'action-plans'] });
      void qc.invalidateQueries({ queryKey: ['accreditation', 'action-plan', vars.id] });
    },
  });
}

export function useDeleteAccActionPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: true }>(`${PREFIX}/accreditation/action-plans/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accreditation', 'action-plans'] });
    },
  });
}

// ─── Site Visit Prep ─────────────────────────────────────────

export function useAccSiteVisits() {
  return useQuery({
    queryKey: ['accreditation', 'site-visit'],
    queryFn: () => apiFetch<AccSiteVisitPrepDto[]>(`${PREFIX}/accreditation/site-visit`),
    staleTime: 30_000,
  });
}

export function useAccSiteVisit(id: string | undefined) {
  return useQuery({
    queryKey: ['accreditation', 'site-visit', id],
    queryFn: () => apiFetch<AccSiteVisitPrepDto>(`${PREFIX}/accreditation/site-visit/${id}`),
    enabled: !!id,
  });
}

export function useAccSiteVisitReadiness(id: string | undefined) {
  return useQuery({
    queryKey: ['accreditation', 'site-visit', id, 'readiness'],
    queryFn: () =>
      apiFetch<AccReadinessReportDto>(`${PREFIX}/accreditation/site-visit/${id}/readiness`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateAccSiteVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAccSiteVisitPrepPayload) =>
      apiFetch<AccSiteVisitPrepDto>(`${PREFIX}/accreditation/site-visit`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accreditation', 'site-visit'] });
    },
  });
}

export function useUpdateAccSiteVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateAccSiteVisitPrepPayload }) =>
      apiFetch<AccSiteVisitPrepDto>(`${PREFIX}/accreditation/site-visit/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: ['accreditation', 'site-visit'] });
      void qc.invalidateQueries({ queryKey: ['accreditation', 'site-visit', vars.id] });
    },
  });
}
