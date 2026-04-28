'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CertificationDto,
  ComplianceDashboardDto,
  EmployeeComplianceDto,
  EmployeeDocumentDto,
  EmployeeDto,
  LeaveBalanceDto,
  LeaveRequestDto,
  LeaveTypeDto,
  PositionDto,
  ReviewLeaveRequestPayload,
  SubmitLeaveRequestPayload,
} from '@/lib/types';

// ── Employees ──────────────────────────────────────────────

interface EmployeesListArgs {
  search?: string;
  includeInactive?: boolean;
}

export function useEmployees(args: EmployeesListArgs = {}, enabled = true) {
  const params = new URLSearchParams();
  if (args.search) params.set('search', args.search);
  if (args.includeInactive) params.set('includeInactive', 'true');
  const qs = params.toString();
  return useQuery({
    queryKey: ['hr', 'employees', { search: args.search ?? null, includeInactive: !!args.includeInactive }],
    queryFn: () => apiFetch<EmployeeDto[]>(`/api/v1/employees${qs ? `?${qs}` : ''}`),
    refetchOnWindowFocus: true,
    enabled,
  });
}

export function useEmployee(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['hr', 'employee', id],
    queryFn: () => apiFetch<EmployeeDto>(`/api/v1/employees/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useMyEmployee(enabled = true) {
  return useQuery({
    queryKey: ['hr', 'employee', 'me'],
    queryFn: () => apiFetch<EmployeeDto>(`/api/v1/employees/me`),
    enabled,
    retry: false,
  });
}

// ── Positions ──────────────────────────────────────────────

export function usePositions(enabled = true) {
  return useQuery({
    queryKey: ['hr', 'positions'],
    queryFn: () => apiFetch<PositionDto[]>(`/api/v1/positions`),
    enabled,
    staleTime: 5 * 60_000,
  });
}

// ── Documents ──────────────────────────────────────────────

export function useEmployeeDocuments(employeeId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['hr', 'documents', employeeId],
    queryFn: () =>
      apiFetch<EmployeeDocumentDto[]>(`/api/v1/employees/${employeeId}/documents`),
    enabled: enabled && typeof employeeId === 'string' && employeeId.length > 0,
  });
}

// ── Certifications ─────────────────────────────────────────

export function useEmployeeCertifications(
  employeeId: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ['hr', 'certifications', employeeId],
    queryFn: () =>
      apiFetch<CertificationDto[]>(`/api/v1/employees/${employeeId}/certifications`),
    enabled: enabled && typeof employeeId === 'string' && employeeId.length > 0,
  });
}

export function useExpiringCertifications(enabled = true) {
  return useQuery({
    queryKey: ['hr', 'certifications', 'expiring-soon'],
    queryFn: () => apiFetch<CertificationDto[]>(`/api/v1/certifications/expiring-soon`),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useVerifyCertification(certificationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { status: 'VERIFIED' | 'REVOKED' | 'EXPIRED'; notes?: string }) =>
      apiFetch<CertificationDto>(`/api/v1/certifications/${certificationId}/verify`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: (cert) => {
      void qc.invalidateQueries({ queryKey: ['hr', 'certifications', cert.employeeId] });
      void qc.invalidateQueries({ queryKey: ['hr', 'certifications', 'expiring-soon'] });
      void qc.invalidateQueries({ queryKey: ['hr', 'compliance'] });
    },
  });
}

// ── Compliance ─────────────────────────────────────────────

export function useEmployeeCompliance(employeeId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['hr', 'compliance', 'employee', employeeId],
    queryFn: () =>
      apiFetch<EmployeeComplianceDto>(`/api/v1/employees/${employeeId}/compliance`),
    enabled: enabled && typeof employeeId === 'string' && employeeId.length > 0,
  });
}

export function useComplianceDashboard(enabled = true) {
  return useQuery({
    queryKey: ['hr', 'compliance', 'dashboard'],
    queryFn: () => apiFetch<ComplianceDashboardDto>(`/api/v1/compliance/dashboard`),
    enabled,
    refetchInterval: 60_000,
  });
}

// ── Leave ──────────────────────────────────────────────────

export function useLeaveTypes(enabled = true) {
  return useQuery({
    queryKey: ['hr', 'leave-types'],
    queryFn: () => apiFetch<LeaveTypeDto[]>(`/api/v1/leave-types`),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useMyLeaveBalances(enabled = true) {
  return useQuery({
    queryKey: ['hr', 'leave-balances', 'me'],
    queryFn: () => apiFetch<LeaveBalanceDto[]>(`/api/v1/leave/me/balances`),
    enabled,
  });
}

interface LeaveRequestsArgs {
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  employeeId?: string;
}

export function useLeaveRequests(args: LeaveRequestsArgs = {}, enabled = true) {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.employeeId) params.set('employeeId', args.employeeId);
  const qs = params.toString();
  return useQuery({
    queryKey: ['hr', 'leave-requests', { status: args.status ?? null, employeeId: args.employeeId ?? null }],
    queryFn: () => apiFetch<LeaveRequestDto[]>(`/api/v1/leave-requests${qs ? `?${qs}` : ''}`),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useSubmitLeaveRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SubmitLeaveRequestPayload) =>
      apiFetch<LeaveRequestDto>(`/api/v1/leave-requests`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hr', 'leave-requests'] });
      void qc.invalidateQueries({ queryKey: ['hr', 'leave-balances', 'me'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useApproveLeaveRequest(requestId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReviewLeaveRequestPayload = {}) =>
      apiFetch<LeaveRequestDto>(`/api/v1/leave-requests/${requestId}/approve`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hr', 'leave-requests'] });
      void qc.invalidateQueries({ queryKey: ['hr', 'leave-balances', 'me'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useRejectLeaveRequest(requestId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReviewLeaveRequestPayload = {}) =>
      apiFetch<LeaveRequestDto>(`/api/v1/leave-requests/${requestId}/reject`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hr', 'leave-requests'] });
      void qc.invalidateQueries({ queryKey: ['hr', 'leave-balances', 'me'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useCancelLeaveRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) =>
      apiFetch<LeaveRequestDto>(`/api/v1/leave-requests/${requestId}/cancel`, {
        method: 'PATCH',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hr', 'leave-requests'] });
      void qc.invalidateQueries({ queryKey: ['hr', 'leave-balances', 'me'] });
    },
  });
}
