import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ItApproveSelectionPayload,
  ItAssetCategoryDto,
  ItAssetDocumentDto,
  ItAssetDto,
  ItAssetStatus,
  ItAssignAssetPayload,
  ItAssignLicencePayload,
  ItAssignmentDto,
  ItCreateAssetCategoryPayload,
  ItCreateAssetDocumentPayload,
  ItCreateAssetPayload,
  ItCreateCredentialPayload,
  ItCreateDamageReportPayload,
  ItCreateDeviceOptionPayload,
  ItCreateDeviceSelectionPayload,
  ItCreateInfrastructureItemPayload,
  ItCreateLicencePayload,
  ItCreateMdmAlertPayload,
  ItCreateMdmSyncPayload,
  ItCreateProcurementOrderPayload,
  ItCreateRepairPayload,
  ItCredentialAccessLogDto,
  ItCredentialDetailDto,
  ItCredentialSummaryDto,
  ItDamageReportDto,
  ItDeviceOptionDto,
  ItDeviceSelectionDto,
  ItInfrastructureItemDto,
  ItLicenceAssignmentDto,
  ItLicenceDto,
  ItMarkDeliveredPayload,
  ItMdmAlertDto,
  ItMdmSyncDto,
  ItProcurementOrderDto,
  ItRepairRecordDto,
  ItResolveMdmAlertPayload,
  ItReturnAssetPayload,
  ItUpdateAssetCategoryPayload,
  ItUpdateAssetPayload,
  ItUpdateCredentialPayload,
  ItUpdateDeviceOptionPayload,
  ItUpdateInfrastructureItemPayload,
  ItUpdateLicencePayload,
  ItUpdateProcurementOrderPayload,
  ItUpdateRepairPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ── Asset Categories ──
export function useItAssetCategories(includeInactive = false) {
  return useQuery({
    queryKey: ['it', 'asset-categories', includeInactive],
    queryFn: () =>
      apiFetch<ItAssetCategoryDto[]>(
        `${PREFIX}/it/asset-categories${includeInactive ? '?includeInactive=true' : ''}`,
      ),
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateItAssetCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateAssetCategoryPayload) =>
      apiFetch<ItAssetCategoryDto>(`${PREFIX}/it/asset-categories`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'asset-categories'] }),
  });
}

export function useUpdateItAssetCategory(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItUpdateAssetCategoryPayload) =>
      apiFetch<ItAssetCategoryDto>(`${PREFIX}/it/asset-categories/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'asset-categories'] }),
  });
}

// ── Assets ──
export function useItAssets(filters: { status?: ItAssetStatus; categoryId?: string } = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.categoryId) params.set('categoryId', filters.categoryId);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['it', 'assets', filters],
    queryFn: () => apiFetch<ItAssetDto[]>(`${PREFIX}/it/assets${qs}`),
    refetchOnWindowFocus: true,
  });
}

export function useItAsset(id: string | null) {
  return useQuery({
    queryKey: ['it', 'asset', id],
    queryFn: () => apiFetch<ItAssetDto>(`${PREFIX}/it/assets/${id}`),
    enabled: !!id,
  });
}

export function useCreateItAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateAssetPayload) =>
      apiFetch<ItAssetDto>(`${PREFIX}/it/assets`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'assets'] }),
  });
}

export function useUpdateItAsset(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItUpdateAssetPayload) =>
      apiFetch<ItAssetDto>(`${PREFIX}/it/assets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it', 'assets'] });
      qc.invalidateQueries({ queryKey: ['it', 'asset', id] });
    },
  });
}

// ── Assignments ──
export function useItAssetAssignments(assetId: string | null) {
  return useQuery({
    queryKey: ['it', 'assignments', assetId],
    queryFn: () => apiFetch<ItAssignmentDto[]>(`${PREFIX}/it/assets/${assetId}/assignments`),
    enabled: !!assetId,
  });
}

export function useMyItAssignments(enabled = true) {
  return useQuery({
    queryKey: ['it', 'me', 'assignments'],
    queryFn: () => apiFetch<ItAssignmentDto[]>(`${PREFIX}/it/me/assignments`),
    enabled,
  });
}

export function useAssignItAsset(assetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItAssignAssetPayload) =>
      apiFetch<ItAssignmentDto>(`${PREFIX}/it/assets/${assetId}/assign`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it', 'assets'] });
      qc.invalidateQueries({ queryKey: ['it', 'assignments', assetId] });
    },
  });
}

export function useReturnItAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ItReturnAssetPayload }) =>
      apiFetch<ItAssignmentDto>(`${PREFIX}/it/assignments/${id}/return`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it'] }),
  });
}

// ── Documents ──
export function useItAssetDocuments(assetId: string | null) {
  return useQuery({
    queryKey: ['it', 'documents', assetId],
    queryFn: () => apiFetch<ItAssetDocumentDto[]>(`${PREFIX}/it/assets/${assetId}/documents`),
    enabled: !!assetId,
  });
}

export function useCreateItAssetDocument(assetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateAssetDocumentPayload) =>
      apiFetch<ItAssetDocumentDto>(`${PREFIX}/it/assets/${assetId}/documents`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'documents', assetId] }),
  });
}

// ── Damage + Repair ──
export function useItDamageReports(filters: { assetId?: string } = {}) {
  const qs = filters.assetId ? `?assetId=${filters.assetId}` : '';
  return useQuery({
    queryKey: ['it', 'damage-reports', filters],
    queryFn: () => apiFetch<ItDamageReportDto[]>(`${PREFIX}/it/damage-reports${qs}`),
  });
}

export function useCreateItDamageReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateDamageReportPayload) =>
      apiFetch<ItDamageReportDto>(`${PREFIX}/it/damage-reports`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it'] }),
  });
}

export function useItRepairs(filters: { assetId?: string } = {}) {
  const qs = filters.assetId ? `?assetId=${filters.assetId}` : '';
  return useQuery({
    queryKey: ['it', 'repairs', filters],
    queryFn: () => apiFetch<ItRepairRecordDto[]>(`${PREFIX}/it/repairs${qs}`),
  });
}

export function useCreateItRepair() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateRepairPayload) =>
      apiFetch<ItRepairRecordDto>(`${PREFIX}/it/repairs`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it'] }),
  });
}

export function useUpdateItRepair() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ItUpdateRepairPayload }) =>
      apiFetch<ItRepairRecordDto>(`${PREFIX}/it/repairs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it'] }),
  });
}

// ── Licences ──
export function useItLicences(includeInactive = false) {
  return useQuery({
    queryKey: ['it', 'licences', includeInactive],
    queryFn: () =>
      apiFetch<ItLicenceDto[]>(
        `${PREFIX}/it/licences${includeInactive ? '?includeInactive=true' : ''}`,
      ),
  });
}

export function useItLicence(id: string | null) {
  return useQuery({
    queryKey: ['it', 'licence', id],
    queryFn: () => apiFetch<ItLicenceDto>(`${PREFIX}/it/licences/${id}`),
    enabled: !!id,
  });
}

export function useCreateItLicence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateLicencePayload) =>
      apiFetch<ItLicenceDto>(`${PREFIX}/it/licences`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'licences'] }),
  });
}

export function useUpdateItLicence(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItUpdateLicencePayload) =>
      apiFetch<ItLicenceDto>(`${PREFIX}/it/licences/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it', 'licences'] });
      qc.invalidateQueries({ queryKey: ['it', 'licence', id] });
    },
  });
}

export function useItLicenceAssignments(licenceId: string | null) {
  return useQuery({
    queryKey: ['it', 'licence-assignments', licenceId],
    queryFn: () =>
      apiFetch<ItLicenceAssignmentDto[]>(`${PREFIX}/it/licences/${licenceId}/assignments`),
    enabled: !!licenceId,
  });
}

export function useAssignItLicence(licenceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItAssignLicencePayload) =>
      apiFetch<ItLicenceAssignmentDto>(`${PREFIX}/it/licences/${licenceId}/assign`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it'] }),
  });
}

export function useUnassignItLicence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`${PREFIX}/it/licence-assignments/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it'] }),
  });
}

// ── Vault ──
export function useItVault() {
  return useQuery({
    queryKey: ['it', 'vault'],
    queryFn: () => apiFetch<ItCredentialSummaryDto[]>(`${PREFIX}/it/vault`),
    staleTime: 30 * 1000,
  });
}

export function useItVaultEntry(id: string | null) {
  return useQuery({
    queryKey: ['it', 'vault', id],
    queryFn: () => apiFetch<ItCredentialDetailDto>(`${PREFIX}/it/vault/${id}`),
    enabled: !!id,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

export function useCreateItVault() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateCredentialPayload) =>
      apiFetch<ItCredentialSummaryDto>(`${PREFIX}/it/vault`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'vault'] }),
  });
}

export function useUpdateItVault(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItUpdateCredentialPayload) =>
      apiFetch<ItCredentialSummaryDto>(`${PREFIX}/it/vault/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it', 'vault'] });
      qc.invalidateQueries({ queryKey: ['it', 'vault', id] });
    },
  });
}

export function useDeleteItVault() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`${PREFIX}/it/vault/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'vault'] }),
  });
}

export function useItVaultAccessLog(id: string | null) {
  return useQuery({
    queryKey: ['it', 'vault-log', id],
    queryFn: () => apiFetch<ItCredentialAccessLogDto[]>(`${PREFIX}/it/vault/${id}/access-log`),
    enabled: !!id,
  });
}

// ── MDM ──
export function useItMdmSyncs(filters: { assetId?: string } = {}) {
  const qs = filters.assetId ? `?assetId=${filters.assetId}` : '';
  return useQuery({
    queryKey: ['it', 'mdm', 'syncs', filters],
    queryFn: () => apiFetch<ItMdmSyncDto[]>(`${PREFIX}/it/mdm/syncs${qs}`),
  });
}

export function useCreateItMdmSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateMdmSyncPayload) =>
      apiFetch<ItMdmSyncDto>(`${PREFIX}/it/mdm/syncs`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'mdm'] }),
  });
}

export function useItMdmAlerts(unresolvedOnly = true) {
  return useQuery({
    queryKey: ['it', 'mdm', 'alerts', unresolvedOnly],
    queryFn: () =>
      apiFetch<ItMdmAlertDto[]>(
        `${PREFIX}/it/mdm/alerts${unresolvedOnly ? '' : '?unresolved=false'}`,
      ),
  });
}

export function useCreateItMdmAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateMdmAlertPayload) =>
      apiFetch<ItMdmAlertDto>(`${PREFIX}/it/mdm/alerts`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'mdm'] }),
  });
}

export function useResolveItMdmAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ItResolveMdmAlertPayload }) =>
      apiFetch<ItMdmAlertDto>(`${PREFIX}/it/mdm/alerts/${id}/resolve`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'mdm'] }),
  });
}

// ── Infrastructure ──
export function useItInfrastructure(filters: { itemType?: string } = {}) {
  const qs = filters.itemType ? `?itemType=${filters.itemType}` : '';
  return useQuery({
    queryKey: ['it', 'infrastructure', filters],
    queryFn: () => apiFetch<ItInfrastructureItemDto[]>(`${PREFIX}/it/infrastructure${qs}`),
  });
}

export function useCreateItInfrastructure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateInfrastructureItemPayload) =>
      apiFetch<ItInfrastructureItemDto>(`${PREFIX}/it/infrastructure`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'infrastructure'] }),
  });
}

export function useUpdateItInfrastructure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ItUpdateInfrastructureItemPayload }) =>
      apiFetch<ItInfrastructureItemDto>(`${PREFIX}/it/infrastructure/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'infrastructure'] }),
  });
}

// ── Procurement ──
export function useItProcurement(filters: { status?: string } = {}) {
  const qs = filters.status ? `?status=${filters.status}` : '';
  return useQuery({
    queryKey: ['it', 'procurement', filters],
    queryFn: () => apiFetch<ItProcurementOrderDto[]>(`${PREFIX}/it/procurement${qs}`),
  });
}

export function useCreateItProcurement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateProcurementOrderPayload) =>
      apiFetch<ItProcurementOrderDto>(`${PREFIX}/it/procurement`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'procurement'] }),
  });
}

export function useUpdateItProcurement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ItUpdateProcurementOrderPayload }) =>
      apiFetch<ItProcurementOrderDto>(`${PREFIX}/it/procurement/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'procurement'] }),
  });
}

export function useDeliverItProcurement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ItMarkDeliveredPayload }) =>
      apiFetch<ItProcurementOrderDto>(`${PREFIX}/it/procurement/${id}/deliver`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'procurement'] }),
  });
}

// ── Device Selection ──
export function useItDeviceOptions(includeInactive = false) {
  return useQuery({
    queryKey: ['it', 'device-options', includeInactive],
    queryFn: () =>
      apiFetch<ItDeviceOptionDto[]>(
        `${PREFIX}/it/device-options${includeInactive ? '?includeInactive=true' : ''}`,
      ),
  });
}

export function useCreateItDeviceOption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateDeviceOptionPayload) =>
      apiFetch<ItDeviceOptionDto>(`${PREFIX}/it/device-options`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'device-options'] }),
  });
}

export function useUpdateItDeviceOption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ItUpdateDeviceOptionPayload }) =>
      apiFetch<ItDeviceOptionDto>(`${PREFIX}/it/device-options/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'device-options'] }),
  });
}

export function useItDeviceSelections(filters: { status?: string; personId?: string } = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.personId) params.set('personId', filters.personId);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['it', 'device-selections', filters],
    queryFn: () => apiFetch<ItDeviceSelectionDto[]>(`${PREFIX}/it/device-selections${qs}`),
  });
}

export function useCreateItDeviceSelection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ItCreateDeviceSelectionPayload) =>
      apiFetch<ItDeviceSelectionDto>(`${PREFIX}/it/device-selections`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it', 'device-selections'] }),
  });
}

export function useApproveItDeviceSelection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ItApproveSelectionPayload }) =>
      apiFetch<ItDeviceSelectionDto>(`${PREFIX}/it/device-selections/${id}/approve`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it'] }),
  });
}

export function useRejectItDeviceSelection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ItDeviceSelectionDto>(`${PREFIX}/it/device-selections/${id}/reject`, {
        method: 'PATCH',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['it'] }),
  });
}
