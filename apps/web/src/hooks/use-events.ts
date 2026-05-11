import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AddEvtCompEntryPayload,
  CreateEvtEventPayload,
  CreateEvtSeasonPassPayload,
  CreateEvtTierPayload,
  CreateEvtVolunteerPayload,
  EvtCompCheckPayload,
  EvtCompCheckResultDto,
  EvtCompEntryDto,
  EvtEventDto,
  EvtEventStatus,
  EvtEventType,
  EvtGateScanResultDto,
  EvtOrderDto,
  EvtOrderStatus,
  EvtPurchasePayload,
  EvtRefundDto,
  EvtRefundPayload,
  EvtRevenueReportDto,
  EvtRevenueSummaryDto,
  EvtScanPayload,
  EvtSeasonPassDto,
  EvtSeasonPassGateCheckPayload,
  EvtSeasonPassGateResultDto,
  EvtTierDto,
  EvtVolunteerDto,
  UpdateEvtEventPayload,
  UpdateEvtTierPayload,
  UpdateEvtVolunteerPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ─── Events ───

interface EventFilters {
  status?: EvtEventStatus;
  eventType?: EvtEventType;
  fromDate?: string;
}

function eventQuery(args: EventFilters | undefined) {
  const qs = new URLSearchParams();
  if (args?.status) qs.set('status', args.status);
  if (args?.eventType) qs.set('eventType', args.eventType);
  if (args?.fromDate) qs.set('fromDate', args.fromDate);
  return qs.toString();
}

export function useEvents(filters?: EventFilters) {
  const qs = eventQuery(filters);
  return useQuery({
    queryKey: ['events', 'list', filters ?? {}],
    queryFn: () => apiFetch<EvtEventDto[]>(`${PREFIX}/events${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useEvent(id: string | null) {
  return useQuery({
    queryKey: ['events', 'event', id],
    queryFn: () => apiFetch<EvtEventDto>(`${PREFIX}/events/${id}`),
    enabled: !!id,
  });
}

export function useCreateEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEvtEventPayload) =>
      apiFetch<EvtEventDto>(`${PREFIX}/events`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events'] }),
  });
}

export function useUpdateEvent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateEvtEventPayload) =>
      apiFetch<EvtEventDto>(`${PREFIX}/events/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events'] }),
  });
}

export function useCompleteEvent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<EvtEventDto>(`${PREFIX}/events/${id}/complete`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events'] }),
  });
}

// ─── Tiers ───

export function useEventTiers(eventId: string | null) {
  return useQuery({
    queryKey: ['events', 'tiers', eventId],
    queryFn: () => apiFetch<EvtTierDto[]>(`${PREFIX}/events/${eventId}/tiers`),
    enabled: !!eventId,
  });
}

export function useCreateTier(eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEvtTierPayload) =>
      apiFetch<EvtTierDto>(`${PREFIX}/events/${eventId}/tiers`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['events', 'tiers', eventId] });
      qc.invalidateQueries({ queryKey: ['events', 'event', eventId] });
    },
  });
}

export function useUpdateTier(eventId: string, tierId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateEvtTierPayload) =>
      apiFetch<EvtTierDto>(`${PREFIX}/events/tiers/${tierId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['events', 'tiers', eventId] });
      qc.invalidateQueries({ queryKey: ['events', 'event', eventId] });
    },
  });
}

// ─── Orders ───

interface OrderFilters {
  eventId?: string;
  status?: EvtOrderStatus;
  mine?: boolean;
}

function orderQuery(args: OrderFilters | undefined) {
  const qs = new URLSearchParams();
  if (args?.eventId) qs.set('eventId', args.eventId);
  if (args?.status) qs.set('status', args.status);
  if (args?.mine) qs.set('mine', 'true');
  return qs.toString();
}

export function useOrders(filters?: OrderFilters) {
  const qs = orderQuery(filters);
  return useQuery({
    queryKey: ['events', 'orders', filters ?? {}],
    queryFn: () => apiFetch<EvtOrderDto[]>(`${PREFIX}/events/orders${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useMyOrders() {
  return useQuery({
    queryKey: ['events', 'orders', 'my'],
    queryFn: () => apiFetch<EvtOrderDto[]>(`${PREFIX}/events/orders/my`),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useOrder(id: string | null) {
  return useQuery({
    queryKey: ['events', 'order', id],
    queryFn: () => apiFetch<EvtOrderDto>(`${PREFIX}/events/orders/${id}`),
    enabled: !!id,
  });
}

export function usePurchase(eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EvtPurchasePayload) =>
      apiFetch<EvtOrderDto>(`${PREFIX}/events/${eventId}/purchase`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['events', 'orders'] });
      qc.invalidateQueries({ queryKey: ['events', 'event', eventId] });
      qc.invalidateQueries({ queryKey: ['events', 'tiers', eventId] });
    },
  });
}

export function useConfirmOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { orderId: string; stripePaymentIntentId?: string }) =>
      apiFetch<EvtOrderDto>(`${PREFIX}/events/orders/${vars.orderId}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ stripePaymentIntentId: vars.stripePaymentIntentId }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events'] }),
  });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { orderId: string; cancellationReason?: string }) =>
      apiFetch<EvtOrderDto>(`${PREFIX}/events/orders/${vars.orderId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ cancellationReason: vars.cancellationReason }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events'] }),
  });
}

// ─── Refunds ───

export function useOrderRefunds(orderId: string | null) {
  return useQuery({
    queryKey: ['events', 'refunds', orderId],
    queryFn: () => apiFetch<EvtRefundDto[]>(`${PREFIX}/events/orders/${orderId}/refunds`),
    enabled: !!orderId,
  });
}

export function useIssueRefund(orderId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EvtRefundPayload) =>
      apiFetch<EvtRefundDto>(`${PREFIX}/events/orders/${orderId}/refund`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['events', 'refunds', orderId] });
      qc.invalidateQueries({ queryKey: ['events', 'order', orderId] });
      qc.invalidateQueries({ queryKey: ['events', 'orders'] });
    },
  });
}

// ─── Gate scan ───

export function useGateScan() {
  return useMutation({
    mutationFn: (body: EvtScanPayload) =>
      apiFetch<EvtGateScanResultDto>(`${PREFIX}/events/gate/scan`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

// ─── Season passes ───

export function useSeasonPasses() {
  return useQuery({
    queryKey: ['events', 'season-passes'],
    queryFn: () => apiFetch<EvtSeasonPassDto[]>(`${PREFIX}/events/season-passes`),
  });
}

export function useMySeasonPasses() {
  return useQuery({
    queryKey: ['events', 'season-passes', 'my'],
    queryFn: () => apiFetch<EvtSeasonPassDto[]>(`${PREFIX}/events/season-passes/my`),
  });
}

export function useCreateSeasonPass() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEvtSeasonPassPayload) =>
      apiFetch<EvtSeasonPassDto>(`${PREFIX}/events/season-passes`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events', 'season-passes'] }),
  });
}

export function useRevokeSeasonPass() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<EvtSeasonPassDto>(`${PREFIX}/events/season-passes/${id}/revoke`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events', 'season-passes'] }),
  });
}

export function useSeasonPassGateCheck() {
  return useMutation({
    mutationFn: (body: EvtSeasonPassGateCheckPayload) =>
      apiFetch<EvtSeasonPassGateResultDto>(`${PREFIX}/events/gate/season-pass-check`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

// ─── Comp lists ───

export function useCompList(eventId: string | null) {
  return useQuery({
    queryKey: ['events', 'comp-list', eventId],
    queryFn: () => apiFetch<EvtCompEntryDto[]>(`${PREFIX}/events/${eventId}/comp-list`),
    enabled: !!eventId,
  });
}

export function useAddCompEntry(eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddEvtCompEntryPayload) =>
      apiFetch<EvtCompEntryDto>(`${PREFIX}/events/${eventId}/comp-list`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events', 'comp-list', eventId] }),
  });
}

export function useRemoveCompEntry(eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entryId: string) =>
      apiFetch<{ ok: boolean }>(`${PREFIX}/events/${eventId}/comp-list/${entryId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events', 'comp-list', eventId] }),
  });
}

export function useCompGateCheck() {
  return useMutation({
    mutationFn: (body: EvtCompCheckPayload) =>
      apiFetch<EvtCompCheckResultDto>(`${PREFIX}/events/gate/comp-check`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

// ─── Volunteers ───

export function useVolunteers(eventId: string | null) {
  return useQuery({
    queryKey: ['events', 'volunteers', eventId],
    queryFn: () => apiFetch<EvtVolunteerDto[]>(`${PREFIX}/events/${eventId}/volunteers`),
    enabled: !!eventId,
  });
}

export function useSignUpVolunteer(eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEvtVolunteerPayload) =>
      apiFetch<EvtVolunteerDto>(`${PREFIX}/events/${eventId}/volunteers`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events', 'volunteers', eventId] }),
  });
}

export function useUpdateVolunteer(eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { volunteerId: string; patch: UpdateEvtVolunteerPayload }) =>
      apiFetch<EvtVolunteerDto>(`${PREFIX}/events/volunteers/${vars.volunteerId}`, {
        method: 'PATCH',
        body: JSON.stringify(vars.patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events', 'volunteers', eventId] }),
  });
}

// ─── Revenue (Step 10) ───

export function useEventRevenue(eventId: string | null) {
  return useQuery({
    queryKey: ['events', 'revenue', 'event', eventId],
    queryFn: () => apiFetch<EvtRevenueReportDto>(`${PREFIX}/events/${eventId}/revenue`),
    enabled: !!eventId,
  });
}

export function useRevenueSummary(args?: { from?: string; to?: string }) {
  const qs = new URLSearchParams();
  if (args?.from) qs.set('from', args.from);
  if (args?.to) qs.set('to', args.to);
  const q = qs.toString();
  return useQuery({
    queryKey: ['events', 'revenue', 'summary', args ?? {}],
    queryFn: () =>
      apiFetch<EvtRevenueSummaryDto>(`${PREFIX}/events/revenue/summary${q ? `?${q}` : ''}`),
  });
}
