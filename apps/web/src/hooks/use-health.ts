'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AdministerDosePayload,
  AdministrationDto,
  ConditionDto,
  CreateNurseVisitPayload,
  DietaryProfileDto,
  HealthAccessLogRowDto,
  HealthAccessType,
  HealthRecordDto,
  IepPlanDto,
  ImmunisationComplianceRowDto,
  ImmunisationDto,
  ListNurseVisitsArgs,
  LogMissedDosePayload,
  MedicationDashboardRowDto,
  MedicationDto,
  NurseVisitDto,
  UpdateNurseVisitPayload,
} from '@/lib/types';

/* Cycle 10 Step 8 — React Query hooks for the health UI.
 *
 * 30s staleTime + refetch on focus on the live-changing reads
 * (nurse roster, medication dashboard) so the nurse dashboard
 * shows fresh data after another tab marks a dose as administered.
 * Mutation invalidation pattern matches the Cycle 9 use-discipline.ts
 * convention.
 */

// ─── Health record + conditions + immunisations ─────────────

export function useHealthRecord(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['health', 'record', studentId],
    queryFn: () => apiFetch<HealthRecordDto>(`/health/students/${studentId}`),
    enabled: enabled && !!studentId,
    staleTime: 30_000,
  });
}

export function useConditions(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['health', 'conditions', studentId],
    queryFn: () => apiFetch<ConditionDto[]>(`/health/students/${studentId}/conditions`),
    enabled: enabled && !!studentId,
    staleTime: 30_000,
  });
}

export function useImmunisations(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['health', 'immunisations', studentId],
    queryFn: () => apiFetch<ImmunisationDto[]>(`/health/students/${studentId}/immunisations`),
    enabled: enabled && !!studentId,
    staleTime: 30_000,
  });
}

export function useImmunisationCompliance(enabled = true) {
  return useQuery({
    queryKey: ['health', 'immunisation-compliance'],
    queryFn: () => apiFetch<ImmunisationComplianceRowDto[]>('/health/immunisation-compliance'),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

// ─── Medications ───────────────────────────────────────────

export function useStudentMedications(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['health', 'medications', studentId],
    queryFn: () => apiFetch<MedicationDto[]>(`/health/students/${studentId}/medications`),
    enabled: enabled && !!studentId,
    staleTime: 30_000,
  });
}

export function useMedicationAdministrations(
  medicationId: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ['health', 'medication-administrations', medicationId],
    queryFn: () =>
      apiFetch<AdministrationDto[]>(`/health/medications/${medicationId}/administrations`),
    enabled: enabled && !!medicationId,
    staleTime: 15_000,
  });
}

export function useMedicationDashboard(enabled = true) {
  return useQuery({
    queryKey: ['health', 'medication-dashboard'],
    queryFn: () => apiFetch<MedicationDashboardRowDto[]>('/health/medication-dashboard'),
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useAdministerDose(medicationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AdministerDosePayload) =>
      apiFetch<AdministrationDto>(`/health/medications/${medicationId}/administer`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['health', 'medication-dashboard'] });
      qc.invalidateQueries({ queryKey: ['health', 'medication-administrations', medicationId] });
    },
  });
}

export function useLogMissedDose(medicationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: LogMissedDosePayload) =>
      apiFetch<AdministrationDto>(`/health/medications/${medicationId}/missed`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['health', 'medication-dashboard'] });
      qc.invalidateQueries({ queryKey: ['health', 'medication-administrations', medicationId] });
    },
  });
}

// ─── Nurse visits ──────────────────────────────────────────

function buildNurseVisitsQs(args: ListNurseVisitsArgs): string {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.fromDate) params.set('fromDate', args.fromDate);
  if (args.toDate) params.set('toDate', args.toDate);
  if (args.limit) params.set('limit', String(args.limit));
  const qs = params.toString();
  return qs ? '?' + qs : '';
}

export function useNurseVisits(args: ListNurseVisitsArgs = {}, enabled = true) {
  return useQuery({
    queryKey: ['health', 'nurse-visits', args],
    queryFn: () => apiFetch<NurseVisitDto[]>(`/health/nurse-visits${buildNurseVisitsQs(args)}`),
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useNurseVisitRoster(enabled = true) {
  return useQuery({
    queryKey: ['health', 'nurse-visits', 'roster'],
    queryFn: () => apiFetch<NurseVisitDto[]>('/health/nurse-visits/roster'),
    enabled,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}

export function useCreateNurseVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateNurseVisitPayload) =>
      apiFetch<NurseVisitDto>('/health/nurse-visits', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['health', 'nurse-visits'] });
    },
  });
}

export function useUpdateNurseVisit(visitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateNurseVisitPayload) =>
      apiFetch<NurseVisitDto>(`/health/nurse-visits/${visitId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['health', 'nurse-visits'] });
    },
  });
}

// ─── IEP / Screening / Dietary (read-only here for Step 8 Health Record tabs) ──

export function useIepPlan(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['health', 'iep', studentId],
    queryFn: () => apiFetch<IepPlanDto | null>(`/health/students/${studentId}/iep`),
    enabled: enabled && !!studentId,
    staleTime: 30_000,
  });
}

export function useDietaryProfile(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['health', 'dietary', studentId],
    queryFn: () => apiFetch<DietaryProfileDto | null>(`/health/students/${studentId}/dietary`),
    enabled: enabled && !!studentId,
    staleTime: 30_000,
  });
}

// ─── Audit log (admin only) ────────────────────────────────

export function useHealthAccessLog(
  args: { studentId?: string; accessType?: HealthAccessType; limit?: number } = {},
  enabled = true,
) {
  const params = new URLSearchParams();
  if (args.studentId) params.set('studentId', args.studentId);
  if (args.accessType) params.set('accessType', args.accessType);
  if (args.limit) params.set('limit', String(args.limit));
  const qs = params.toString();
  return useQuery({
    queryKey: ['health', 'access-log', args],
    queryFn: () => apiFetch<HealthAccessLogRowDto[]>('/health/access-log' + (qs ? '?' + qs : '')),
    enabled,
    staleTime: 30_000,
  });
}

// Re-export for convenience on the Step 8 nurse visit log page.
export type { NurseVisitDto, ScreeningDto } from '@/lib/types';
