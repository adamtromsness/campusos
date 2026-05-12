'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

const PREFIX = '/api/v1/internal';

/**
 * P2-21b — Internal Ops + Pricing hooks.
 *
 * All endpoints under /api/v1/internal/{ops,employees,permissions,
 * account-assignments,tenant-access,tickets,pricing}/* are platform-
 * scoped. No tenant header required; permissions resolve against the
 * PLATFORM IAM scope. Platform Admin sees everything; everyone else
 * 403s at the gate.
 */

export type OpsDepartment =
  | 'ENGINEERING'
  | 'PRODUCT'
  | 'SALES'
  | 'CUSTOMER_SUCCESS'
  | 'SUPPORT'
  | 'OPERATIONS';

export type OpsPermissionScope =
  | 'CRM_READ'
  | 'CRM_WRITE'
  | 'TENANT_ACCESS'
  | 'INTERNAL_ADMIN'
  | 'SUPPORT';

export type AssignmentRole = 'CSM' | 'TAM' | 'AE';

export type TenantAccessType = 'READ_ONLY' | 'READ_WRITE';

export type TicketCategory = 'BUG' | 'FEATURE_REQUEST' | 'DATA_FIX' | 'INFRASTRUCTURE' | 'OTHER';

export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'BLOCKED' | 'RESOLVED' | 'CLOSED';

export interface OpsEmployeeDto {
  id: string;
  personId: string;
  department: OpsDepartment;
  role: string;
  hireDate: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OpsPermissionDto {
  id: string;
  employeeId: string;
  scope: OpsPermissionScope;
  grantedBy: string;
  grantedAt: string;
}

export interface TenantAccessGrantDto {
  id: string;
  employeeId: string;
  tenantSchema: string;
  justification: string;
  accessType: TenantAccessType;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  approvedBy: string;
  isActive: boolean;
  remainingMinutes: number;
}

export interface InternalTicketDto {
  id: string;
  title: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  createdBy: string;
  assignedTo: string | null;
  relatedAccountId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InternalTicketCommentDto {
  id: string;
  ticketId: string;
  authorId: string;
  commentText: string;
  createdAt: string;
}

export interface PricingBandDto {
  id: string;
  name: string;
  studentRangeMin: number;
  studentRangeMax: number | null;
  monthlyPriceCents: number;
  annualPriceCents: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PricingHistoryDto {
  id: string;
  bandId: string;
  previousMonthlyCents: number | null;
  newMonthlyCents: number;
  previousAnnualCents: number | null;
  newAnnualCents: number;
  effectiveDate: string;
  changedBy: string;
  createdAt: string;
}

export interface SupportTierDto {
  id: string;
  name: string;
  responseTimeHours: number;
  includesPhone: boolean;
  includesDedicatedCsm: boolean;
  monthlyAddonCents: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Format helpers ───────────────────────────────────────────────────

export function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function formatRemaining(minutes: number): string {
  if (minutes < 1) return 'expiring';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export const TICKET_PRIORITY_PILL: Record<TicketPriority, string> = {
  LOW: 'bg-gray-100 text-gray-700',
  MEDIUM: 'bg-sky-100 text-sky-700',
  HIGH: 'bg-amber-100 text-amber-700',
  CRITICAL: 'bg-rose-100 text-rose-700',
};

export const TICKET_STATUS_PILL: Record<TicketStatus, string> = {
  OPEN: 'bg-blue-100 text-blue-700',
  IN_PROGRESS: 'bg-amber-100 text-amber-700',
  BLOCKED: 'bg-rose-100 text-rose-700',
  RESOLVED: 'bg-emerald-100 text-emerald-700',
  CLOSED: 'bg-gray-100 text-gray-700',
};

// ── Employees ───────────────────────────────────────────────────────

export function useOpsEmployees(
  args: { department?: OpsDepartment; includeInactive?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (args.department) params.set('department', args.department);
  if (args.includeInactive) params.set('includeInactive', 'true');
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery<OpsEmployeeDto[]>({
    queryKey: ['ops-employees', args],
    queryFn: () => apiFetch<OpsEmployeeDto[]>(`${PREFIX}/employees${qs}`),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useOpsEmployee(id: string | null) {
  return useQuery<OpsEmployeeDto>({
    queryKey: ['ops-employees', id],
    queryFn: () => apiFetch<OpsEmployeeDto>(`${PREFIX}/employees/${id}`),
    enabled: !!id,
  });
}

export function useCreateOpsEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      personId: string;
      department: OpsDepartment;
      role: string;
      hireDate: string;
    }) =>
      apiFetch<OpsEmployeeDto>(`${PREFIX}/employees`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ops-employees'] }),
  });
}

export function useEmployeePermissions(employeeId: string | null) {
  return useQuery<OpsPermissionDto[]>({
    queryKey: ['ops-employees', employeeId, 'permissions'],
    queryFn: () => apiFetch<OpsPermissionDto[]>(`${PREFIX}/employees/${employeeId}/permissions`),
    enabled: !!employeeId,
  });
}

export function useGrantPermission(employeeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { scope: OpsPermissionScope }) =>
      apiFetch<OpsPermissionDto>(`${PREFIX}/employees/${employeeId}/permissions`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['ops-employees', employeeId, 'permissions'] }),
  });
}

// ── Tenant access ────────────────────────────────────────────────────

export function useActiveTenantAccess() {
  return useQuery<TenantAccessGrantDto[]>({
    queryKey: ['ops-tenant-access', 'active'],
    queryFn: () => apiFetch<TenantAccessGrantDto[]>(`${PREFIX}/tenant-access/active`),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useTenantAccessAuditLog(args: { employeeId?: string; tenantSchema?: string } = {}) {
  const params = new URLSearchParams();
  if (args.employeeId) params.set('employeeId', args.employeeId);
  if (args.tenantSchema) params.set('tenantSchema', args.tenantSchema);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery<TenantAccessGrantDto[]>({
    queryKey: ['ops-tenant-access', 'audit', args],
    queryFn: () => apiFetch<TenantAccessGrantDto[]>(`${PREFIX}/tenant-access/audit-log${qs}`),
    staleTime: 60_000,
  });
}

export function useGrantTenantAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      employeeId: string;
      tenantSchema: string;
      justification: string;
      accessType: TenantAccessType;
      durationHours?: number;
      approvedBy: string;
    }) =>
      apiFetch<TenantAccessGrantDto>(`${PREFIX}/tenant-access`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ops-tenant-access'] }),
  });
}

export function useRevokeTenantAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<TenantAccessGrantDto>(`${PREFIX}/tenant-access/${id}/revoke`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ops-tenant-access'] }),
  });
}

// ── Internal tickets ─────────────────────────────────────────────────

export function useInternalTickets(
  args: { status?: TicketStatus; priority?: TicketPriority } = {},
) {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.priority) params.set('priority', args.priority);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery<InternalTicketDto[]>({
    queryKey: ['ops-tickets', args],
    queryFn: () => apiFetch<InternalTicketDto[]>(`${PREFIX}/tickets${qs}`),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useInternalTicket(id: string | null) {
  return useQuery<InternalTicketDto>({
    queryKey: ['ops-tickets', id],
    queryFn: () => apiFetch<InternalTicketDto>(`${PREFIX}/tickets/${id}`),
    enabled: !!id,
  });
}

export function useCreateInternalTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      title: string;
      description: string;
      category: TicketCategory;
      priority?: TicketPriority;
      assignedTo?: string;
      relatedAccountId?: string;
    }) =>
      apiFetch<InternalTicketDto>(`${PREFIX}/tickets`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ops-tickets'] }),
  });
}

export function usePatchInternalTicket(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<InternalTicketDto>) =>
      apiFetch<InternalTicketDto>(`${PREFIX}/tickets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ops-tickets'] }),
  });
}

export function useTicketComments(ticketId: string | null) {
  return useQuery<InternalTicketCommentDto[]>({
    queryKey: ['ops-tickets', ticketId, 'comments'],
    queryFn: () => apiFetch<InternalTicketCommentDto[]>(`${PREFIX}/tickets/${ticketId}/comments`),
    enabled: !!ticketId,
  });
}

export function useAddTicketComment(ticketId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { commentText: string }) =>
      apiFetch<InternalTicketCommentDto>(`${PREFIX}/tickets/${ticketId}/comments`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ops-tickets', ticketId, 'comments'] }),
  });
}

// ── Pricing ─────────────────────────────────────────────────────────

export function usePricingBands(includeInactive = false) {
  const qs = includeInactive ? '?includeInactive=true' : '';
  return useQuery<PricingBandDto[]>({
    queryKey: ['ops-pricing', 'bands', includeInactive],
    queryFn: () => apiFetch<PricingBandDto[]>(`${PREFIX}/pricing/bands${qs}`),
    staleTime: 60_000,
  });
}

export function usePricingHistory(bandId: string | null) {
  return useQuery<PricingHistoryDto[]>({
    queryKey: ['ops-pricing', 'history', bandId],
    queryFn: () => apiFetch<PricingHistoryDto[]>(`${PREFIX}/pricing/bands/${bandId}/history`),
    enabled: !!bandId,
  });
}

export function useCreatePricingBand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      studentRangeMin: number;
      studentRangeMax?: number;
      monthlyPriceCents: number;
      annualPriceCents: number;
    }) =>
      apiFetch<PricingBandDto>(`${PREFIX}/pricing/bands`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ops-pricing'] }),
  });
}

export function useUpdatePricingBand(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name?: string;
      studentRangeMin?: number;
      studentRangeMax?: number;
      monthlyPriceCents?: number;
      annualPriceCents?: number;
      effectiveDate?: string;
      isActive?: boolean;
      changedBy?: string;
    }) =>
      apiFetch<PricingBandDto>(`${PREFIX}/pricing/bands/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ops-pricing'] }),
  });
}

export function useSupportTiers(includeInactive = false) {
  const qs = includeInactive ? '?includeInactive=true' : '';
  return useQuery<SupportTierDto[]>({
    queryKey: ['ops-pricing', 'support-tiers', includeInactive],
    queryFn: () => apiFetch<SupportTierDto[]>(`${PREFIX}/pricing/support-tiers${qs}`),
    staleTime: 60_000,
  });
}

export function useCreateSupportTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      responseTimeHours: number;
      includesPhone?: boolean;
      includesDedicatedCsm?: boolean;
      monthlyAddonCents?: number;
    }) =>
      apiFetch<SupportTierDto>(`${PREFIX}/pricing/support-tiers`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ops-pricing', 'support-tiers'] }),
  });
}
