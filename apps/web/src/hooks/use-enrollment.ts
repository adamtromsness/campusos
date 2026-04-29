'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AcademicYearDto,
  ApplicationDto,
  ApplicationNoteDto,
  CreateAdmissionStreamPayload,
  CreateApplicationNotePayload,
  CreateApplicationPayload,
  CreateEnrollmentPeriodPayload,
  CreateIntakeCapacityPayload,
  CreateOfferPayload,
  EnrollmentPeriodDto,
  ListApplicationsArgs,
  ListWaitlistArgs,
  OfferDto,
  OfferFromWaitlistPayload,
  RespondToOfferPayload,
  UpdateApplicationStatusPayload,
  UpdateEnrollmentPeriodPayload,
  UpdateOfferConditionsMetPayload,
  WaitlistEntryDto,
} from '@/lib/types';

// ── Academic Years (catalogue) ─────────────────────────────

export function useAcademicYears(enabled = true) {
  return useQuery({
    queryKey: ['sis', 'academic-years'],
    queryFn: () => apiFetch<AcademicYearDto[]>('/api/v1/academic-years'),
    enabled,
    staleTime: 5 * 60_000,
  });
}

// ── Enrollment Periods ─────────────────────────────────────

export function useEnrollmentPeriods(enabled = true) {
  return useQuery({
    queryKey: ['enrollment', 'periods'],
    queryFn: () => apiFetch<EnrollmentPeriodDto[]>('/api/v1/enrollment-periods'),
    enabled,
  });
}

export function useEnrollmentPeriod(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['enrollment', 'period', id],
    queryFn: () => apiFetch<EnrollmentPeriodDto>(`/api/v1/enrollment-periods/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useCreateEnrollmentPeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateEnrollmentPeriodPayload) =>
      apiFetch<EnrollmentPeriodDto>('/api/v1/enrollment-periods', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['enrollment', 'periods'] });
    },
  });
}

export function useUpdateEnrollmentPeriod(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateEnrollmentPeriodPayload) =>
      apiFetch<EnrollmentPeriodDto>(`/api/v1/enrollment-periods/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['enrollment', 'periods'] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'period', id] });
    },
  });
}

export function useCreateAdmissionStream(periodId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAdmissionStreamPayload) =>
      apiFetch<EnrollmentPeriodDto>(`/api/v1/enrollment-periods/${periodId}/streams`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['enrollment', 'periods'] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'period', periodId] });
    },
  });
}

export function useCreateIntakeCapacity(periodId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateIntakeCapacityPayload) =>
      apiFetch<EnrollmentPeriodDto>(`/api/v1/enrollment-periods/${periodId}/capacities`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['enrollment', 'periods'] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'period', periodId] });
    },
  });
}

// ── Applications ───────────────────────────────────────────

export function useApplications(args: ListApplicationsArgs = {}, enabled = true) {
  const params = new URLSearchParams();
  if (args.enrollmentPeriodId) params.set('enrollmentPeriodId', args.enrollmentPeriodId);
  if (args.status) params.set('status', args.status);
  if (args.applyingForGrade) params.set('applyingForGrade', args.applyingForGrade);
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'enrollment',
      'applications',
      {
        enrollmentPeriodId: args.enrollmentPeriodId ?? null,
        status: args.status ?? null,
        applyingForGrade: args.applyingForGrade ?? null,
      },
    ],
    queryFn: () => apiFetch<ApplicationDto[]>(`/api/v1/applications${qs ? `?${qs}` : ''}`),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useApplication(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['enrollment', 'application', id],
    queryFn: () => apiFetch<ApplicationDto>(`/api/v1/applications/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useCreateApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateApplicationPayload) =>
      apiFetch<ApplicationDto>('/api/v1/applications', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['enrollment', 'applications'] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'periods'] });
    },
  });
}

export function useUpdateApplicationStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateApplicationStatusPayload) =>
      apiFetch<ApplicationDto>(`/api/v1/applications/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['enrollment', 'applications'] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'application', id] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'periods'] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'waitlist'] });
    },
  });
}

export function useAddApplicationNote(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateApplicationNotePayload) =>
      apiFetch<ApplicationNoteDto>(`/api/v1/applications/${id}/notes`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['enrollment', 'application', id] });
    },
  });
}

// ── Offers ─────────────────────────────────────────────────

export function useOffers(enabled = true) {
  return useQuery({
    queryKey: ['enrollment', 'offers'],
    queryFn: () => apiFetch<OfferDto[]>('/api/v1/offers'),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useOffer(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['enrollment', 'offer', id],
    queryFn: () => apiFetch<OfferDto>(`/api/v1/offers/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useIssueOffer(applicationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateOfferPayload) =>
      apiFetch<OfferDto>(`/api/v1/applications/${applicationId}/offer`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['enrollment', 'offers'] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'application', applicationId] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'applications'] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'periods'] });
    },
  });
}

export function useSetOfferConditionsMet(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateOfferConditionsMetPayload) =>
      apiFetch<OfferDto>(`/api/v1/offers/${id}/conditions-met`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['enrollment', 'offers'] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'offer', id] });
    },
  });
}

export function useRespondToOffer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: RespondToOfferPayload) =>
      apiFetch<OfferDto>(`/api/v1/offers/${id}/respond`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['enrollment', 'offers'] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'offer', id] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'applications'] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'periods'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

// ── Waitlist ───────────────────────────────────────────────

export function useWaitlist(args: ListWaitlistArgs = {}, enabled = true) {
  const params = new URLSearchParams();
  if (args.enrollmentPeriodId) params.set('enrollmentPeriodId', args.enrollmentPeriodId);
  if (args.gradeLevel) params.set('gradeLevel', args.gradeLevel);
  if (args.status) params.set('status', args.status);
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'enrollment',
      'waitlist',
      {
        enrollmentPeriodId: args.enrollmentPeriodId ?? null,
        gradeLevel: args.gradeLevel ?? null,
        status: args.status ?? null,
      },
    ],
    queryFn: () => apiFetch<WaitlistEntryDto[]>(`/api/v1/waitlist${qs ? `?${qs}` : ''}`),
    enabled,
  });
}

export function useOfferFromWaitlist(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: OfferFromWaitlistPayload) =>
      apiFetch<WaitlistEntryDto>(`/api/v1/waitlist/${id}/offer`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['enrollment', 'waitlist'] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'applications'] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'offers'] });
      void qc.invalidateQueries({ queryKey: ['enrollment', 'periods'] });
    },
  });
}
