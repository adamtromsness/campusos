import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ItAcknowledgeAlertPayload,
  ItAssignPhoneExtensionPayload,
  ItConfigDocCategory,
  ItConfigDocDto,
  ItCreateConfigDocPayload,
  ItCreateDeviceUsagePayload,
  ItCreateInventoryAuditPayload,
  ItCreateLicenceRenewalPayload,
  ItCreateMonitoringCheckPayload,
  ItCreatePhoneExtensionPayload,
  ItCreateRemoteActionPayload,
  ItDeviceUsageDto,
  ItInfrastructureWarrantyDto,
  ItInventoryAuditDto,
  ItInventoryAuditItemDto,
  ItInventoryAuditReportDto,
  ItLicenceRenewalDto,
  ItMonitoringAlertDto,
  ItMonitoringCheckDto,
  ItPatchInfrastructureItemPayload,
  ItPhoneExtensionDto,
  ItRecordCheckResultPayload,
  ItRemoteActionDto,
  ItScanAuditItemPayload,
  ItUpdateConfigDocPayload,
  ItUpdateMonitoringCheckPayload,
  ItUpdatePhoneExtensionPayload,
  ItUpdateRemoteActionStatusPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ── Remote actions (IMMUTABLE) ──
export function useItRemoteActions(assetId: string | null) {
  return useQuery({
    queryKey: ['it', 'remote-actions', assetId],
    queryFn: () => apiFetch<ItRemoteActionDto[]>(`${PREFIX}/it/devices/${assetId}/remote-actions`),
    enabled: !!assetId,
    staleTime: 30 * 1000,
  });
}

export function useCreateItRemoteAction(assetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateRemoteActionPayload) =>
      apiFetch<ItRemoteActionDto>(`${PREFIX}/it/devices/${assetId}/remote-action`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it', 'remote-actions', assetId] });
      qc.invalidateQueries({ queryKey: ['it', 'asset', assetId] });
      qc.invalidateQueries({ queryKey: ['it', 'assets'] });
    },
  });
}

export function useUpdateItRemoteActionStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ItUpdateRemoteActionStatusPayload }) =>
      apiFetch<ItRemoteActionDto>(`${PREFIX}/it/remote-actions/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it'] }),
  });
}

// ── Inventory audits ──
export function useItInventoryAudits() {
  return useQuery({
    queryKey: ['it', 'inventory-audits'],
    queryFn: () => apiFetch<ItInventoryAuditDto[]>(`${PREFIX}/it/inventory-audits`),
    refetchOnWindowFocus: true,
  });
}

export function useItInventoryAudit(id: string | null) {
  return useQuery({
    queryKey: ['it', 'inventory-audit', id],
    queryFn: () => apiFetch<ItInventoryAuditDto>(`${PREFIX}/it/inventory-audits/${id}`),
    enabled: !!id,
  });
}

export function useItInventoryAuditItems(id: string | null) {
  return useQuery({
    queryKey: ['it', 'inventory-audit-items', id],
    queryFn: () => apiFetch<ItInventoryAuditItemDto[]>(`${PREFIX}/it/inventory-audits/${id}/items`),
    enabled: !!id,
  });
}

export function useItInventoryAuditReport(id: string | null) {
  return useQuery({
    queryKey: ['it', 'inventory-audit-report', id],
    queryFn: () =>
      apiFetch<ItInventoryAuditReportDto>(`${PREFIX}/it/inventory-audits/${id}/report`),
    enabled: !!id,
  });
}

export function useCreateItInventoryAudit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateInventoryAuditPayload) =>
      apiFetch<ItInventoryAuditDto>(`${PREFIX}/it/inventory-audits`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'inventory-audits'] }),
  });
}

export function useScanItInventoryAudit(auditId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItScanAuditItemPayload) =>
      apiFetch<ItInventoryAuditItemDto>(`${PREFIX}/it/inventory-audits/${auditId}/scan`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it', 'inventory-audit-items', auditId] });
      qc.invalidateQueries({ queryKey: ['it', 'inventory-audit', auditId] });
    },
  });
}

export function useCompleteItInventoryAudit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (auditId: string) =>
      apiFetch<ItInventoryAuditDto>(`${PREFIX}/it/inventory-audits/${auditId}/complete`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it'] }),
  });
}

// ── Licence renewals ──
export function useItLicenceRenewals(licenceId: string | null) {
  return useQuery({
    queryKey: ['it', 'licence-renewals', licenceId],
    queryFn: () => apiFetch<ItLicenceRenewalDto[]>(`${PREFIX}/it/licences/${licenceId}/renewals`),
    enabled: !!licenceId,
  });
}

export function useRenewItLicence(licenceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateLicenceRenewalPayload) =>
      apiFetch<ItLicenceRenewalDto>(`${PREFIX}/it/licences/${licenceId}/renew`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it', 'licence-renewals', licenceId] });
      qc.invalidateQueries({ queryKey: ['it', 'licence', licenceId] });
      qc.invalidateQueries({ queryKey: ['it', 'licences'] });
    },
  });
}

// ── Device usage (flagged activity) ──
export function useItDeviceUsage(assetId: string | null) {
  return useQuery({
    queryKey: ['it', 'device-usage', assetId],
    queryFn: () => apiFetch<ItDeviceUsageDto[]>(`${PREFIX}/it/devices/${assetId}/usage`),
    enabled: !!assetId,
  });
}

export function useItFlaggedDeviceUsage(enabled = true) {
  return useQuery({
    queryKey: ['it', 'device-usage', 'flagged'],
    queryFn: () => apiFetch<ItDeviceUsageDto[]>(`${PREFIX}/it/device-usage/flagged`),
    refetchOnWindowFocus: true,
    enabled,
  });
}

export function useRecordItDeviceUsage(assetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateDeviceUsagePayload) =>
      apiFetch<ItDeviceUsageDto>(`${PREFIX}/it/devices/${assetId}/usage`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it', 'device-usage', assetId] });
      qc.invalidateQueries({ queryKey: ['it', 'device-usage', 'flagged'] });
    },
  });
}

// ── Phone extensions ──
export function useItPhoneExtensions(
  filters: {
    search?: string;
    department?: string;
    includeInactive?: boolean;
  } = {},
) {
  const params = new URLSearchParams();
  if (filters.search) params.set('search', filters.search);
  if (filters.department) params.set('department', filters.department);
  if (filters.includeInactive) params.set('includeInactive', 'true');
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['it', 'phone-extensions', filters],
    queryFn: () => apiFetch<ItPhoneExtensionDto[]>(`${PREFIX}/it/phone-extensions${qs}`),
  });
}

export function useCreateItPhoneExtension() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreatePhoneExtensionPayload) =>
      apiFetch<ItPhoneExtensionDto>(`${PREFIX}/it/phone-extensions`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'phone-extensions'] }),
  });
}

export function useUpdateItPhoneExtension(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItUpdatePhoneExtensionPayload) =>
      apiFetch<ItPhoneExtensionDto>(`${PREFIX}/it/phone-extensions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'phone-extensions'] }),
  });
}

export function useAssignItPhoneExtension(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItAssignPhoneExtensionPayload) =>
      apiFetch<ItPhoneExtensionDto>(`${PREFIX}/it/phone-extensions/${id}/assign`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'phone-extensions'] }),
  });
}

export function useUnassignItPhoneExtension(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<ItPhoneExtensionDto>(`${PREFIX}/it/phone-extensions/${id}/unassign`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'phone-extensions'] }),
  });
}

// ── Documentation (versioned) ──
export function useItDocs(category?: ItConfigDocCategory) {
  const qs = category ? `?category=${category}` : '';
  return useQuery({
    queryKey: ['it', 'docs', category ?? 'all'],
    queryFn: () => apiFetch<ItConfigDocDto[]>(`${PREFIX}/it/documentation${qs}`),
  });
}

export function useItDoc(id: string | null) {
  return useQuery({
    queryKey: ['it', 'doc', id],
    queryFn: () => apiFetch<ItConfigDocDto>(`${PREFIX}/it/documentation/${id}`),
    enabled: !!id,
  });
}

export function useCreateItDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateConfigDocPayload) =>
      apiFetch<ItConfigDocDto>(`${PREFIX}/it/documentation`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'docs'] }),
  });
}

export function useUpdateItDoc(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItUpdateConfigDocPayload) =>
      apiFetch<ItConfigDocDto>(`${PREFIX}/it/documentation/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it', 'docs'] });
      qc.invalidateQueries({ queryKey: ['it', 'doc', id] });
    },
  });
}

// ── Monitoring ──
export function useItMonitoringChecks() {
  return useQuery({
    queryKey: ['it', 'monitoring', 'checks'],
    queryFn: () => apiFetch<ItMonitoringCheckDto[]>(`${PREFIX}/it/monitoring`),
    refetchOnWindowFocus: true,
    staleTime: 30 * 1000,
  });
}

export function useItMonitoringCheck(id: string | null) {
  return useQuery({
    queryKey: ['it', 'monitoring', 'check', id],
    queryFn: () => apiFetch<ItMonitoringCheckDto>(`${PREFIX}/it/monitoring/${id}`),
    enabled: !!id,
  });
}

export function useCreateItMonitoringCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateMonitoringCheckPayload) =>
      apiFetch<ItMonitoringCheckDto>(`${PREFIX}/it/monitoring`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'monitoring'] }),
  });
}

export function useUpdateItMonitoringCheck(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItUpdateMonitoringCheckPayload) =>
      apiFetch<ItMonitoringCheckDto>(`${PREFIX}/it/monitoring/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'monitoring'] }),
  });
}

export function useRecordItCheckResult(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItRecordCheckResultPayload) =>
      apiFetch<ItMonitoringCheckDto>(`${PREFIX}/it/monitoring/${id}/result`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it'] }),
  });
}

export function useItMonitoringAlerts(activeOnly = true) {
  const qs = activeOnly ? '?activeOnly=true' : '';
  return useQuery({
    queryKey: ['it', 'monitoring', 'alerts', activeOnly],
    queryFn: () => apiFetch<ItMonitoringAlertDto[]>(`${PREFIX}/it/monitoring-alerts${qs}`),
    refetchOnWindowFocus: true,
  });
}

export function useAcknowledgeItMonitoringAlert(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItAcknowledgeAlertPayload) =>
      apiFetch<ItMonitoringAlertDto>(`${PREFIX}/it/monitoring-alerts/${id}/acknowledge`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'monitoring'] }),
  });
}

// ── Infrastructure extension (P2-20 layer) ──
export function useItInfrastructureWarrantyExpiring(days = 30) {
  return useQuery({
    queryKey: ['it', 'infrastructure', 'warranty-expiring', days],
    queryFn: () =>
      apiFetch<ItInfrastructureWarrantyDto[]>(
        `${PREFIX}/it/infrastructure/warranty-expiring?days=${days}`,
      ),
  });
}

export function useMarkItInfrastructureChecked() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ id: string; lastCheckedAt: string }>(`${PREFIX}/it/infrastructure/${id}/check`, {
        method: 'PATCH',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'infrastructure'] }),
  });
}

export function usePatchItInfrastructureAdvanced(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItPatchInfrastructureItemPayload) =>
      apiFetch<{ id: string }>(`${PREFIX}/it/infrastructure/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'infrastructure'] }),
  });
}
