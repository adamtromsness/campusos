import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  PrcCreateDistributionPayload,
  PrcCreateGoodsReceiptPayload,
  PrcCreatePurchaseOrderPayload,
  PrcCreateRequisitionPayload,
  PrcCreateReturnPayload,
  PrcDistributionDto,
  PrcGoodsReceiptDto,
  PrcProcurementSettingsDto,
  PrcPurchaseOrderDto,
  PrcRequisitionDto,
  PrcReturnDto,
  PrcUpdateReturnPayload,
  PrcUpdateSettingsPayload,
  PrcVendorPerformanceDto,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ─── Requisitions ───
export function useRequisitions(filter?: { status?: string }) {
  const qs = filter?.status ? `?status=${filter.status}` : '';
  return useQuery({
    queryKey: ['procurement', 'requisitions', filter?.status ?? null],
    queryFn: () => apiFetch<PrcRequisitionDto[]>(`${PREFIX}/procurement/requisitions${qs}`),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export function useRequisition(id: string | null) {
  return useQuery({
    queryKey: ['procurement', 'requisition', id],
    queryFn: () => apiFetch<PrcRequisitionDto>(`${PREFIX}/procurement/requisitions/${id}`),
    enabled: !!id,
  });
}

export function useCreateRequisition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: PrcCreateRequisitionPayload) =>
      apiFetch<PrcRequisitionDto>(`${PREFIX}/procurement/requisitions`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['procurement', 'requisitions'] });
    },
  });
}

export function useSubmitRequisition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<PrcRequisitionDto>(`${PREFIX}/procurement/requisitions/${id}/submit`, {
        method: 'PATCH',
      }),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['procurement', 'requisitions'] });
      qc.invalidateQueries({ queryKey: ['procurement', 'requisition', id] });
    },
  });
}

export function useApproveRequisition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      toStatus: 'DEPT_APPROVED' | 'ADMIN_APPROVED' | 'DISTRICT_APPROVED';
    }) =>
      apiFetch<PrcRequisitionDto>(`${PREFIX}/procurement/requisitions/${vars.id}/approve`, {
        method: 'PATCH',
        body: JSON.stringify({ toStatus: vars.toStatus }),
      }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['procurement', 'requisitions'] });
      qc.invalidateQueries({ queryKey: ['procurement', 'requisition', v.id] });
    },
  });
}

export function useRejectRequisition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; reason: string }) =>
      apiFetch<PrcRequisitionDto>(`${PREFIX}/procurement/requisitions/${vars.id}/reject`, {
        method: 'PATCH',
        body: JSON.stringify({ reason: vars.reason }),
      }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['procurement', 'requisitions'] });
      qc.invalidateQueries({ queryKey: ['procurement', 'requisition', v.id] });
    },
  });
}

// ─── Purchase Orders ───
export function usePurchaseOrders(filter?: { status?: string; vendorId?: string }) {
  const qs = new URLSearchParams();
  if (filter?.status) qs.set('status', filter.status);
  if (filter?.vendorId) qs.set('vendorId', filter.vendorId);
  const qstr = qs.toString();
  return useQuery({
    queryKey: ['procurement', 'pos', filter?.status ?? null, filter?.vendorId ?? null],
    queryFn: () =>
      apiFetch<PrcPurchaseOrderDto[]>(
        `${PREFIX}/procurement/purchase-orders${qstr ? `?${qstr}` : ''}`,
      ),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export function usePurchaseOrder(id: string | null) {
  return useQuery({
    queryKey: ['procurement', 'po', id],
    queryFn: () => apiFetch<PrcPurchaseOrderDto>(`${PREFIX}/procurement/purchase-orders/${id}`),
    enabled: !!id,
  });
}

export function useCreatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: PrcCreatePurchaseOrderPayload) =>
      apiFetch<PrcPurchaseOrderDto>(`${PREFIX}/procurement/purchase-orders`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['procurement', 'pos'] });
      qc.invalidateQueries({ queryKey: ['procurement', 'requisitions'] });
    },
  });
}

export function useTransitionPO() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      action: 'ISSUE' | 'ACKNOWLEDGE' | 'SHIP' | 'CLOSE' | 'CANCEL';
      reason?: string;
      budgetLineId?: string;
    }) =>
      apiFetch<PrcPurchaseOrderDto>(`${PREFIX}/procurement/purchase-orders/${vars.id}/transition`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: vars.action,
          reason: vars.reason,
          budgetLineId: vars.budgetLineId,
        }),
      }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['procurement', 'pos'] });
      qc.invalidateQueries({ queryKey: ['procurement', 'po', v.id] });
      qc.invalidateQueries({ queryKey: ['procurement', 'requisitions'] });
      qc.invalidateQueries({ queryKey: ['finance', 'budgets'] });
    },
  });
}

// ─── Goods Receipts ───
export function useReceiptsForPO(poId: string | null) {
  return useQuery({
    queryKey: ['procurement', 'receipts', poId],
    queryFn: () =>
      apiFetch<PrcGoodsReceiptDto[]>(`${PREFIX}/procurement/purchase-orders/${poId}/receipts`),
    enabled: !!poId,
  });
}

export function useCreateReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { poId: string; payload: PrcCreateGoodsReceiptPayload }) =>
      apiFetch<PrcGoodsReceiptDto>(`${PREFIX}/procurement/purchase-orders/${vars.poId}/receipts`, {
        method: 'POST',
        body: JSON.stringify(vars.payload),
      }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['procurement', 'receipts', v.poId] });
      qc.invalidateQueries({ queryKey: ['procurement', 'po', v.poId] });
      qc.invalidateQueries({ queryKey: ['procurement', 'pos'] });
      qc.invalidateQueries({ queryKey: ['procurement', 'vendor-performance'] });
    },
  });
}

// ─── Distributions ───
export function useDistributionsForReceipt(receiptId: string | null) {
  return useQuery({
    queryKey: ['procurement', 'distributions', receiptId],
    queryFn: () =>
      apiFetch<PrcDistributionDto[]>(`${PREFIX}/procurement/receipts/${receiptId}/distributions`),
    enabled: !!receiptId,
  });
}

export function useCreateDistribution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { receiptId: string; payload: PrcCreateDistributionPayload }) =>
      apiFetch<PrcDistributionDto>(
        `${PREFIX}/procurement/receipts/${vars.receiptId}/distributions`,
        {
          method: 'POST',
          body: JSON.stringify(vars.payload),
        },
      ),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['procurement', 'distributions', v.receiptId] });
      qc.invalidateQueries({ queryKey: ['procurement', 'receipts'] });
      qc.invalidateQueries({ queryKey: ['procurement', 'requisitions'] });
    },
  });
}

// ─── Returns ───
export function useReturns(filter?: { status?: string }) {
  const qs = filter?.status ? `?status=${filter.status}` : '';
  return useQuery({
    queryKey: ['procurement', 'returns', filter?.status ?? null],
    queryFn: () => apiFetch<PrcReturnDto[]>(`${PREFIX}/procurement/returns${qs}`),
    refetchOnWindowFocus: true,
  });
}

export function useReturn(id: string | null) {
  return useQuery({
    queryKey: ['procurement', 'return', id],
    queryFn: () => apiFetch<PrcReturnDto>(`${PREFIX}/procurement/returns/${id}`),
    enabled: !!id,
  });
}

export function useReturnsForReceiptLine(receiptLineId: string | null) {
  return useQuery({
    queryKey: ['procurement', 'returns-line', receiptLineId],
    queryFn: () =>
      apiFetch<PrcReturnDto[]>(`${PREFIX}/procurement/receipt-lines/${receiptLineId}/returns`),
    enabled: !!receiptLineId,
  });
}

export function useCreateReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { receiptLineId: string; payload: PrcCreateReturnPayload }) =>
      apiFetch<PrcReturnDto>(`${PREFIX}/procurement/receipt-lines/${vars.receiptLineId}/returns`, {
        method: 'POST',
        body: JSON.stringify(vars.payload),
      }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['procurement', 'returns'] });
      qc.invalidateQueries({ queryKey: ['procurement', 'returns-line', v.receiptLineId] });
    },
  });
}

export function useUpdateReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; payload: PrcUpdateReturnPayload }) =>
      apiFetch<PrcReturnDto>(`${PREFIX}/procurement/returns/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify(vars.payload),
      }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['procurement', 'returns'] });
      qc.invalidateQueries({ queryKey: ['procurement', 'return', v.id] });
    },
  });
}

// ─── Vendor Performance ───
export function useVendorPerformance() {
  return useQuery({
    queryKey: ['procurement', 'vendor-performance'],
    queryFn: () => apiFetch<PrcVendorPerformanceDto[]>(`${PREFIX}/procurement/vendor-performance`),
    refetchOnWindowFocus: true,
  });
}

// ─── Settings ───
export function useProcurementSettings() {
  return useQuery({
    queryKey: ['procurement', 'settings'],
    queryFn: () => apiFetch<PrcProcurementSettingsDto>(`${PREFIX}/procurement/settings`),
    staleTime: 5 * 60_000,
  });
}

export function useUpdateProcurementSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: PrcUpdateSettingsPayload) =>
      apiFetch<PrcProcurementSettingsDto>(`${PREFIX}/procurement/settings`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['procurement', 'settings'] });
    },
  });
}
