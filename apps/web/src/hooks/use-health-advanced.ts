'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ComplianceDashboardDto,
  ComplianceStatus,
  CreateScreeningReferralPayload,
  CreateTelehealthProviderPayload,
  CreateTelehealthSessionPayload,
  ImmunisationComplianceDto,
  ImmunisationRequirementDto,
  ScreeningReferralDto,
  TelehealthDocumentDto,
  TelehealthProviderDto,
  TelehealthSessionDto,
  TelehealthSessionStatus,
  ScreeningReferralStatus,
  ScreeningReferralType,
  UpdateScreeningReferralPayload,
  UpdateTelehealthProviderPayload,
  UpdateTelehealthSessionPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ----- Telehealth providers ------------------------------------------------

export function useTelehealthProviders(includeInactive = false) {
  return useQuery({
    queryKey: ['telehealth-providers', includeInactive],
    queryFn: () =>
      apiFetch<TelehealthProviderDto[]>(
        `${PREFIX}/health/telehealth/providers${includeInactive ? '?includeInactive=true' : ''}`,
      ),
    staleTime: 60_000,
  });
}

export function useCreateTelehealthProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTelehealthProviderPayload) =>
      apiFetch<TelehealthProviderDto>(`${PREFIX}/health/telehealth/providers`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telehealth-providers'] }),
  });
}

export function useUpdateTelehealthProvider(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateTelehealthProviderPayload) =>
      apiFetch<TelehealthProviderDto>(`${PREFIX}/health/telehealth/providers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telehealth-providers'] }),
  });
}

// ----- Telehealth sessions -------------------------------------------------

export function useTelehealthSessions(args?: {
  studentId?: string;
  status?: TelehealthSessionStatus;
}) {
  const params = new URLSearchParams();
  if (args?.studentId) params.set('studentId', args.studentId);
  if (args?.status) params.set('status', args.status);
  const qs = params.toString();
  return useQuery({
    queryKey: ['telehealth-sessions', args ?? null],
    queryFn: () =>
      apiFetch<TelehealthSessionDto[]>(`${PREFIX}/health/telehealth/sessions${qs ? `?${qs}` : ''}`),
    refetchInterval: 30_000,
  });
}

export function useTelehealthSession(id: string | null) {
  return useQuery({
    queryKey: ['telehealth-session', id],
    queryFn: () => apiFetch<TelehealthSessionDto>(`${PREFIX}/health/telehealth/sessions/${id}`),
    enabled: !!id,
  });
}

export function useScheduleTelehealthSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTelehealthSessionPayload) =>
      apiFetch<TelehealthSessionDto>(`${PREFIX}/health/telehealth/sessions`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telehealth-sessions'] }),
  });
}

export function useUpdateTelehealthSession(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateTelehealthSessionPayload) =>
      apiFetch<TelehealthSessionDto>(`${PREFIX}/health/telehealth/sessions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['telehealth-sessions'] });
      void qc.invalidateQueries({ queryKey: ['telehealth-session', id] });
    },
  });
}

export function useRecordConsent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (signatureRequestId?: string) =>
      apiFetch<TelehealthSessionDto>(`${PREFIX}/health/telehealth/sessions/${id}/consent`, {
        method: 'POST',
        body: JSON.stringify({ signatureRequestId }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['telehealth-sessions'] });
      void qc.invalidateQueries({ queryKey: ['telehealth-session', id] });
    },
  });
}

export function useTelehealthDocuments(sessionId: string | null) {
  return useQuery({
    queryKey: ['telehealth-documents', sessionId],
    queryFn: () =>
      apiFetch<TelehealthDocumentDto[]>(
        `${PREFIX}/health/telehealth/sessions/${sessionId}/documents`,
      ),
    enabled: !!sessionId,
  });
}

// ----- Immunisation compliance --------------------------------------------

export function useImmunisationRequirements(stateCode?: string) {
  const qs = stateCode ? `?stateCode=${stateCode}` : '';
  return useQuery({
    queryKey: ['immunisation-requirements', stateCode ?? null],
    queryFn: () =>
      apiFetch<ImmunisationRequirementDto[]>(`${PREFIX}/health/immunisation/requirements${qs}`),
    staleTime: 60_000,
  });
}

export function useComplianceDashboard() {
  return useQuery({
    queryKey: ['immunisation-compliance-dashboard'],
    queryFn: () =>
      apiFetch<ComplianceDashboardDto>(`${PREFIX}/health/immunisation/compliance/dashboard`),
    refetchInterval: 60_000,
  });
}

export function useComplianceList(args?: { status?: ComplianceStatus; grade?: string }) {
  const params = new URLSearchParams();
  if (args?.status) params.set('status', args.status);
  if (args?.grade) params.set('grade', args.grade);
  const qs = params.toString();
  return useQuery({
    queryKey: ['immunisation-compliance-list', args ?? null],
    queryFn: () =>
      apiFetch<ImmunisationComplianceDto[]>(
        `${PREFIX}/health/immunisation/compliance${qs ? `?${qs}` : ''}`,
      ),
    staleTime: 30_000,
  });
}

export function useStudentCompliance(studentId: string | null) {
  return useQuery({
    queryKey: ['immunisation-compliance-student', studentId],
    queryFn: () =>
      apiFetch<ImmunisationComplianceDto>(`${PREFIX}/health/immunisation/compliance/${studentId}`),
    enabled: !!studentId,
  });
}

export function useRunCompliance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { studentId?: string }) =>
      apiFetch<{ computed: number; newlyNonCompliant: number }>(
        `${PREFIX}/health/immunisation/compliance/run`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['immunisation-compliance-list'] });
      void qc.invalidateQueries({ queryKey: ['immunisation-compliance-dashboard'] });
    },
  });
}

// ----- Screening referrals -------------------------------------------------

export function useScreeningReferrals(args?: {
  status?: ScreeningReferralStatus;
  referralType?: ScreeningReferralType;
  studentId?: string;
}) {
  const params = new URLSearchParams();
  if (args?.status) params.set('status', args.status);
  if (args?.referralType) params.set('referralType', args.referralType);
  if (args?.studentId) params.set('studentId', args.studentId);
  const qs = params.toString();
  return useQuery({
    queryKey: ['screening-referrals', args ?? null],
    queryFn: () =>
      apiFetch<ScreeningReferralDto[]>(`${PREFIX}/health/screening-referrals${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
  });
}

export function useOverdueReferrals() {
  return useQuery({
    queryKey: ['screening-referrals-overdue'],
    queryFn: () => apiFetch<ScreeningReferralDto[]>(`${PREFIX}/health/screening-referrals/overdue`),
    staleTime: 60_000,
  });
}

export function useCreateReferralFromScreening(screeningId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateScreeningReferralPayload) =>
      apiFetch<ScreeningReferralDto>(`${PREFIX}/health/screenings/${screeningId}/referrals`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['screening-referrals'] }),
  });
}

export function useUpdateReferral(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateScreeningReferralPayload) =>
      apiFetch<ScreeningReferralDto>(`${PREFIX}/health/screening-referrals/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['screening-referrals'] });
      void qc.invalidateQueries({ queryKey: ['screening-referrals-overdue'] });
    },
  });
}
