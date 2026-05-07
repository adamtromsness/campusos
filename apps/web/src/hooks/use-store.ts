import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  StrAdjustInventoryPayload,
  StrCreateOrderPayload,
  StrCreateProductPayload,
  StrCreateShippingOptionPayload,
  StrExternalCustomerDto,
  StrFulfilOrderPayload,
  StrInventoryDashboardRow,
  StrMaterialiseRevenuePayload,
  StrOrderApprovalDto,
  StrOrderDto,
  StrProductDto,
  StrRevenueRowDto,
  StrShippingOptionDto,
  StrStoreDto,
  StrUpdateProductPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ─── Stores ───
export function useStores(includeInactive = false) {
  return useQuery({
    queryKey: ['store', 'stores', includeInactive],
    queryFn: () =>
      apiFetch<StrStoreDto[]>(
        `${PREFIX}/store/stores${includeInactive ? '?includeInactive=true' : ''}`,
      ),
    staleTime: 60_000,
  });
}

export function useStore(id: string | null) {
  return useQuery({
    queryKey: ['store', 'store', id],
    queryFn: () => apiFetch<StrStoreDto>(`${PREFIX}/store/stores/${id}`),
    enabled: !!id,
  });
}

// ─── Products ───
export function useProducts(
  storeId: string | null,
  args?: { category?: string; includeInactive?: boolean },
) {
  const qs = new URLSearchParams();
  if (args?.category) qs.set('category', args.category);
  if (args?.includeInactive) qs.set('includeInactive', 'true');
  const qstr = qs.toString();
  return useQuery({
    queryKey: [
      'store',
      'products',
      storeId,
      args?.category ?? null,
      args?.includeInactive ?? false,
    ],
    queryFn: () =>
      apiFetch<StrProductDto[]>(
        `${PREFIX}/store/stores/${storeId}/products${qstr ? `?${qstr}` : ''}`,
      ),
    enabled: !!storeId,
    staleTime: 30_000,
  });
}

export function useProduct(id: string | null) {
  return useQuery({
    queryKey: ['store', 'product', id],
    queryFn: () => apiFetch<StrProductDto>(`${PREFIX}/store/products/${id}`),
    enabled: !!id,
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: StrCreateProductPayload) =>
      apiFetch<StrProductDto>(`${PREFIX}/store/products`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['store', 'products'] });
    },
  });
}

export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; payload: StrUpdateProductPayload }) =>
      apiFetch<StrProductDto>(`${PREFIX}/store/products/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify(vars.payload),
      }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['store', 'products'] });
      qc.invalidateQueries({ queryKey: ['store', 'product', v.id] });
    },
  });
}

// ─── Inventory ───
export function useInventoryDashboard() {
  return useQuery({
    queryKey: ['store', 'inventory'],
    queryFn: () => apiFetch<StrInventoryDashboardRow[]>(`${PREFIX}/store/inventory`),
    refetchOnWindowFocus: true,
  });
}

export function useAdjustInventory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; payload: StrAdjustInventoryPayload }) =>
      apiFetch<{ ok: boolean }>(`${PREFIX}/store/inventory/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify(vars.payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['store', 'inventory'] });
      qc.invalidateQueries({ queryKey: ['store', 'products'] });
    },
  });
}

// ─── Orders ───
export function useOrders(args?: { storeId?: string; status?: string; orderType?: string }) {
  const qs = new URLSearchParams();
  if (args?.storeId) qs.set('storeId', args.storeId);
  if (args?.status) qs.set('status', args.status);
  if (args?.orderType) qs.set('orderType', args.orderType);
  const qstr = qs.toString();
  return useQuery({
    queryKey: [
      'store',
      'orders',
      args?.storeId ?? null,
      args?.status ?? null,
      args?.orderType ?? null,
    ],
    queryFn: () => apiFetch<StrOrderDto[]>(`${PREFIX}/store/orders${qstr ? `?${qstr}` : ''}`),
    refetchOnWindowFocus: true,
  });
}

export function useOrder(id: string | null) {
  return useQuery({
    queryKey: ['store', 'order', id],
    queryFn: () => apiFetch<StrOrderDto>(`${PREFIX}/store/orders/${id}`),
    enabled: !!id,
  });
}

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: StrCreateOrderPayload) =>
      apiFetch<StrOrderDto>(`${PREFIX}/store/orders`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['store', 'orders'] });
      qc.invalidateQueries({ queryKey: ['store', 'approvals'] });
      qc.invalidateQueries({ queryKey: ['store', 'inventory'] });
    },
  });
}

export function useFulfilOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; payload: StrFulfilOrderPayload }) =>
      apiFetch<StrOrderDto>(`${PREFIX}/store/orders/${vars.id}/fulfil`, {
        method: 'PATCH',
        body: JSON.stringify(vars.payload),
      }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['store', 'orders'] });
      qc.invalidateQueries({ queryKey: ['store', 'order', v.id] });
    },
  });
}

export function useCompleteOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<StrOrderDto>(`${PREFIX}/store/orders/${id}/complete`, { method: 'PATCH' }),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['store', 'orders'] });
      qc.invalidateQueries({ queryKey: ['store', 'order', id] });
      qc.invalidateQueries({ queryKey: ['store', 'inventory'] });
      qc.invalidateQueries({ queryKey: ['store', 'products'] });
    },
  });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; reason?: string }) =>
      apiFetch<StrOrderDto>(`${PREFIX}/store/orders/${vars.id}/cancel`, {
        method: 'PATCH',
        body: JSON.stringify({ reason: vars.reason }),
      }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['store', 'orders'] });
      qc.invalidateQueries({ queryKey: ['store', 'order', v.id] });
      qc.invalidateQueries({ queryKey: ['store', 'inventory'] });
    },
  });
}

// ─── Approvals ───
export function useApprovals() {
  return useQuery({
    queryKey: ['store', 'approvals'],
    queryFn: () => apiFetch<StrOrderApprovalDto[]>(`${PREFIX}/store/approvals`),
    refetchOnWindowFocus: true,
  });
}

export function useApproveApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<StrOrderApprovalDto>(`${PREFIX}/store/approvals/${id}/approve`, {
        method: 'PATCH',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['store', 'approvals'] });
      qc.invalidateQueries({ queryKey: ['store', 'orders'] });
    },
  });
}

export function useDeclineApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; reason: string }) =>
      apiFetch<StrOrderApprovalDto>(`${PREFIX}/store/approvals/${vars.id}/decline`, {
        method: 'PATCH',
        body: JSON.stringify({ reason: vars.reason }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['store', 'approvals'] });
      qc.invalidateQueries({ queryKey: ['store', 'orders'] });
      qc.invalidateQueries({ queryKey: ['store', 'inventory'] });
    },
  });
}

// ─── External customers + Shipping + Revenue ───
export function useShippingOptions(storeId: string | null) {
  return useQuery({
    queryKey: ['store', 'shipping', storeId],
    queryFn: () =>
      apiFetch<StrShippingOptionDto[]>(`${PREFIX}/store/stores/${storeId}/shipping-options`),
    enabled: !!storeId,
    staleTime: 5 * 60_000,
  });
}

export function useCreateShippingOption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: StrCreateShippingOptionPayload) =>
      apiFetch<StrShippingOptionDto>(`${PREFIX}/store/shipping-options`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['store', 'shipping'] });
    },
  });
}

export function useExternalCustomers() {
  return useQuery({
    queryKey: ['store', 'external-customers'],
    queryFn: () => apiFetch<StrExternalCustomerDto[]>(`${PREFIX}/store/external-customers`),
  });
}

export function useRevenue(storeId?: string | null) {
  return useQuery({
    queryKey: ['store', 'revenue', storeId ?? null],
    queryFn: () =>
      apiFetch<StrRevenueRowDto[]>(
        `${PREFIX}/store/revenue${storeId ? `?storeId=${storeId}` : ''}`,
      ),
  });
}

export function useMaterialiseRevenue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: StrMaterialiseRevenuePayload) =>
      apiFetch<StrRevenueRowDto>(`${PREFIX}/store/revenue/materialise`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['store', 'revenue'] });
    },
  });
}
