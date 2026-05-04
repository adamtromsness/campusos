'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AdministerDosePayload,
  AdministrationDto,
  ConditionDto,
  CreateAccommodationPayload,
  CreateDietaryProfilePayload,
  CreateGoalProgressPayload,
  CreateIepGoalPayload,
  CreateIepPlanPayload,
  CreateIepServicePayload,
  CreateNurseVisitPayload,
  CreateScreeningPayload,
  DietaryProfileDto,
  HealthAccessLogRowDto,
  HealthAccessType,
  HealthRecordDto,
  IepAccommodationDto,
  IepGoalDto,
  IepGoalProgressDto,
  IepPlanDto,
  IepServiceDto,
  ImmunisationComplianceRowDto,
  ImmunisationDto,
  ListNurseVisitsArgs,
  ListScreeningsArgs,
  LogMissedDosePayload,
  MedicationDashboardRowDto,
  MedicationDto,
  NurseVisitDto,
  ScreeningDto,
  UpdateAccommodationPayload,
  UpdateDietaryProfilePayload,
  UpdateIepGoalPayload,
  UpdateIepPlanPayload,
  UpdateIepServicePayload,
  UpdateNurseVisitPayload,
  UpdateScreeningPayload,
} from '@/lib/types';

/* Cycle 10 — React Query hooks for the health UI.
 * Step 8 shipped the read paths; Step 9 adds the IEP / Screening /
 * Dietary mutation surface plus a per-student visit history hook
 * that backs the parent /children/[id]/health page.
 */

const PREFIX = '/api/v1';

// ─── Health record + conditions + immunisations ─────────────

export function useHealthRecord(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['health', 'record', studentId],
    queryFn: () => apiFetch<HealthRecordDto>(`${PREFIX}/health/students/${studentId}`),
    enabled: enabled && !!studentId,
    staleTime: 30_000,
  });
}

export function useConditions(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['health', 'conditions', studentId],
    queryFn: () => apiFetch<ConditionDto[]>(`${PREFIX}/health/students/${studentId}/conditions`),
    enabled: enabled && !!studentId,
    staleTime: 30_000,
  });
}

export function useImmunisations(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['health', 'immunisations', studentId],
    queryFn: () =>
      apiFetch<ImmunisationDto[]>(`${PREFIX}/health/students/${studentId}/immunisations`),
    enabled: enabled && !!studentId,
    staleTime: 30_000,
  });
}

export function useImmunisationCompliance(enabled = true) {
  return useQuery({
    queryKey: ['health', 'immunisation-compliance'],
    queryFn: () =>
      apiFetch<ImmunisationComplianceRowDto[]>(`${PREFIX}/health/immunisation-compliance`),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

// ─── Medications ───────────────────────────────────────────

export function useStudentMedications(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['health', 'medications', studentId],
    queryFn: () => apiFetch<MedicationDto[]>(`${PREFIX}/health/students/${studentId}/medications`),
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
      apiFetch<AdministrationDto[]>(`${PREFIX}/health/medications/${medicationId}/administrations`),
    enabled: enabled && !!medicationId,
    staleTime: 15_000,
  });
}

export function useMedicationDashboard(enabled = true) {
  return useQuery({
    queryKey: ['health', 'medication-dashboard'],
    queryFn: () => apiFetch<MedicationDashboardRowDto[]>(`${PREFIX}/health/medication-dashboard`),
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useAdministerDose(medicationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AdministerDosePayload) =>
      apiFetch<AdministrationDto>(`${PREFIX}/health/medications/${medicationId}/administer`, {
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
      apiFetch<AdministrationDto>(`${PREFIX}/health/medications/${medicationId}/missed`, {
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
    queryFn: () =>
      apiFetch<NurseVisitDto[]>(`${PREFIX}/health/nurse-visits${buildNurseVisitsQs(args)}`),
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useNurseVisitRoster(enabled = true) {
  return useQuery({
    queryKey: ['health', 'nurse-visits', 'roster'],
    queryFn: () => apiFetch<NurseVisitDto[]>(`${PREFIX}/health/nurse-visits/roster`),
    enabled,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Per-student visit history for parents + nurses (gated on hlt-001:read +
 * row-scope at the service layer). Backs the parent /children/[id]/health
 * recent-visits section.
 */
export function useStudentVisits(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['health', 'student-visits', studentId],
    queryFn: () => apiFetch<NurseVisitDto[]>(`${PREFIX}/health/students/${studentId}/visits`),
    enabled: enabled && !!studentId,
    staleTime: 30_000,
  });
}

export function useCreateNurseVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateNurseVisitPayload) =>
      apiFetch<NurseVisitDto>(`${PREFIX}/health/nurse-visits`, {
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
      apiFetch<NurseVisitDto>(`${PREFIX}/health/nurse-visits/${visitId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['health', 'nurse-visits'] });
    },
  });
}

// ─── IEP / 504 plan ────────────────────────────────────────

export function useIepPlan(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['health', 'iep', 'student', studentId],
    queryFn: () => apiFetch<IepPlanDto | null>(`${PREFIX}/health/students/${studentId}/iep`),
    enabled: enabled && !!studentId,
    staleTime: 30_000,
  });
}

function invalidateIep(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['health', 'iep'] });
}

export function useCreateIepPlan(studentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateIepPlanPayload) =>
      apiFetch<IepPlanDto>(`${PREFIX}/health/students/${studentId}/iep`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateIep(qc),
  });
}

export function useUpdateIepPlan(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateIepPlanPayload) =>
      apiFetch<IepPlanDto>(`${PREFIX}/health/iep-plans/${planId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateIep(qc),
  });
}

export function useCreateIepGoal(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateIepGoalPayload) =>
      apiFetch<IepGoalDto>(`${PREFIX}/health/iep-plans/${planId}/goals`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateIep(qc),
  });
}

export function useUpdateIepGoal(goalId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateIepGoalPayload) =>
      apiFetch<IepGoalDto>(`${PREFIX}/health/iep-goals/${goalId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateIep(qc),
  });
}

export function useCreateGoalProgress(goalId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateGoalProgressPayload) =>
      apiFetch<IepGoalProgressDto>(`${PREFIX}/health/iep-goals/${goalId}/progress`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateIep(qc),
  });
}

export function useCreateIepService(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateIepServicePayload) =>
      apiFetch<IepServiceDto>(`${PREFIX}/health/iep-plans/${planId}/services`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateIep(qc),
  });
}

export function useUpdateIepService(serviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateIepServicePayload) =>
      apiFetch<IepServiceDto>(`${PREFIX}/health/iep-services/${serviceId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateIep(qc),
  });
}

export function useCreateAccommodation(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAccommodationPayload) =>
      apiFetch<IepAccommodationDto>(`${PREFIX}/health/iep-plans/${planId}/accommodations`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateIep(qc),
  });
}

export function useUpdateAccommodation(accommodationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateAccommodationPayload) =>
      apiFetch<IepAccommodationDto>(`${PREFIX}/health/iep-accommodations/${accommodationId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateIep(qc),
  });
}

export function useDeleteAccommodation(accommodationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<void>(`${PREFIX}/health/iep-accommodations/${accommodationId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => invalidateIep(qc),
  });
}

// ─── Screenings ────────────────────────────────────────────

function buildScreeningsQs(args: ListScreeningsArgs): string {
  const p = new URLSearchParams();
  if (args.studentId) p.set('studentId', args.studentId);
  if (args.screeningType) p.set('screeningType', args.screeningType);
  if (args.result) p.set('result', args.result);
  if (args.fromDate) p.set('fromDate', args.fromDate);
  if (args.toDate) p.set('toDate', args.toDate);
  if (args.limit) p.set('limit', String(args.limit));
  const qs = p.toString();
  return qs ? '?' + qs : '';
}

export function useScreenings(args: ListScreeningsArgs = {}, enabled = true) {
  return useQuery({
    queryKey: ['health', 'screenings', args],
    queryFn: () =>
      apiFetch<ScreeningDto[]>(`${PREFIX}/health/screenings${buildScreeningsQs(args)}`),
    enabled,
    staleTime: 30_000,
  });
}

export function useFollowUpScreenings(enabled = true) {
  return useQuery({
    queryKey: ['health', 'screenings', 'follow-up'],
    queryFn: () => apiFetch<ScreeningDto[]>(`${PREFIX}/health/screenings/follow-up`),
    enabled,
    staleTime: 30_000,
  });
}

export function useCreateScreening() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateScreeningPayload) =>
      apiFetch<ScreeningDto>(`${PREFIX}/health/screenings`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['health', 'screenings'] });
    },
  });
}

export function useUpdateScreening(screeningId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateScreeningPayload) =>
      apiFetch<ScreeningDto>(`${PREFIX}/health/screenings/${screeningId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['health', 'screenings'] });
    },
  });
}

// ─── Dietary profiles ──────────────────────────────────────

export function useDietaryProfile(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['health', 'dietary', studentId],
    queryFn: () =>
      apiFetch<DietaryProfileDto | null>(`${PREFIX}/health/students/${studentId}/dietary`),
    enabled: enabled && !!studentId,
    staleTime: 30_000,
  });
}

/** Admin/nurse only — students with pos_allergen_alert=true. */
export function useAllergenAlerts(enabled = true) {
  return useQuery({
    queryKey: ['health', 'allergen-alerts'],
    queryFn: () => apiFetch<DietaryProfileDto[]>(`${PREFIX}/health/allergen-alerts`),
    enabled,
    staleTime: 30_000,
  });
}

export function useCreateDietaryProfile(studentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateDietaryProfilePayload) =>
      apiFetch<DietaryProfileDto>(`${PREFIX}/health/students/${studentId}/dietary`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['health', 'dietary'] });
      qc.invalidateQueries({ queryKey: ['health', 'allergen-alerts'] });
    },
  });
}

export function useUpdateDietaryProfile(profileId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateDietaryProfilePayload) =>
      apiFetch<DietaryProfileDto>(`${PREFIX}/health/dietary-profiles/${profileId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['health', 'dietary'] });
      qc.invalidateQueries({ queryKey: ['health', 'allergen-alerts'] });
    },
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
    queryFn: () =>
      apiFetch<HealthAccessLogRowDto[]>(`${PREFIX}/health/access-log${qs ? '?' + qs : ''}`),
    enabled,
    staleTime: 30_000,
  });
}

// Re-export for convenience on the Step 8 nurse visit log page.
export type { NurseVisitDto } from '@/lib/types';
