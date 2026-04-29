'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CreateFeeCategoryPayload,
  CreateFeeSchedulePayload,
  CreateInvoicePayload,
  CreatePaymentPlanPayload,
  FamilyAccountDto,
  FeeCategoryDto,
  FeeScheduleDto,
  GenerateFromSchedulePayload,
  GenerateFromScheduleResponse,
  InvoiceDto,
  IssueRefundPayload,
  LedgerBalanceDto,
  LedgerEntryDto,
  ListInvoicesArgs,
  ListLedgerArgs,
  ListPaymentsArgs,
  ListRefundsArgs,
  PayInvoicePayload,
  PaymentDto,
  PaymentPlanDto,
  RefundDto,
  UpdateFeeSchedulePayload,
} from '@/lib/types';

// ── Fee Categories + Schedules ─────────────────────────────

export function useFeeCategories(enabled = true) {
  return useQuery({
    queryKey: ['billing', 'fee-categories'],
    queryFn: () => apiFetch<FeeCategoryDto[]>('/api/v1/fee-categories'),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useCreateFeeCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateFeeCategoryPayload) =>
      apiFetch<FeeCategoryDto>('/api/v1/fee-categories', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing', 'fee-categories'] });
    },
  });
}

export function useFeeSchedules(enabled = true) {
  return useQuery({
    queryKey: ['billing', 'fee-schedules'],
    queryFn: () => apiFetch<FeeScheduleDto[]>('/api/v1/fee-schedules'),
    enabled,
  });
}

export function useFeeSchedule(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['billing', 'fee-schedule', id],
    queryFn: () => apiFetch<FeeScheduleDto>(`/api/v1/fee-schedules/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useCreateFeeSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateFeeSchedulePayload) =>
      apiFetch<FeeScheduleDto>('/api/v1/fee-schedules', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing', 'fee-schedules'] });
    },
  });
}

export function useUpdateFeeSchedule(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateFeeSchedulePayload) =>
      apiFetch<FeeScheduleDto>(`/api/v1/fee-schedules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing', 'fee-schedules'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'fee-schedule', id] });
    },
  });
}

// ── Family Accounts ────────────────────────────────────────

export function useFamilyAccounts(enabled = true) {
  return useQuery({
    queryKey: ['billing', 'family-accounts'],
    queryFn: () => apiFetch<FamilyAccountDto[]>('/api/v1/family-accounts'),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useFamilyAccount(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['billing', 'family-account', id],
    queryFn: () => apiFetch<FamilyAccountDto>(`/api/v1/family-accounts/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useFamilyAccountBalance(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['billing', 'family-account', id, 'balance'],
    queryFn: () => apiFetch<LedgerBalanceDto>(`/api/v1/family-accounts/${id}/balance`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
    staleTime: 30_000,
  });
}

export function useFamilyAccountLedger(
  id: string | null | undefined,
  args: ListLedgerArgs = {},
  enabled = true,
) {
  const params = new URLSearchParams();
  if (args.limit) params.set('limit', String(args.limit));
  if (args.before) params.set('before', args.before);
  if (args.referenceId) params.set('referenceId', args.referenceId);
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'billing',
      'family-account',
      id,
      'ledger',
      {
        limit: args.limit ?? null,
        before: args.before ?? null,
        referenceId: args.referenceId ?? null,
      },
    ],
    queryFn: () =>
      apiFetch<LedgerEntryDto[]>(`/api/v1/family-accounts/${id}/ledger${qs ? `?${qs}` : ''}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

// ── Invoices ───────────────────────────────────────────────

export function useInvoices(args: ListInvoicesArgs = {}, enabled = true) {
  const params = new URLSearchParams();
  if (args.familyAccountId) params.set('familyAccountId', args.familyAccountId);
  if (args.status) params.set('status', args.status);
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'billing',
      'invoices',
      { familyAccountId: args.familyAccountId ?? null, status: args.status ?? null },
    ],
    queryFn: () => apiFetch<InvoiceDto[]>(`/api/v1/invoices${qs ? `?${qs}` : ''}`),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useInvoice(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['billing', 'invoice', id],
    queryFn: () => apiFetch<InvoiceDto>(`/api/v1/invoices/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateInvoicePayload) =>
      apiFetch<InvoiceDto>('/api/v1/invoices', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing', 'invoices'] });
    },
  });
}

export function useSendInvoice(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<InvoiceDto>(`/api/v1/invoices/${id}/send`, { method: 'PATCH' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing', 'invoices'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'invoice', id] });
      void qc.invalidateQueries({ queryKey: ['billing', 'family-accounts'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'family-account'] });
    },
  });
}

export function useCancelInvoice(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<InvoiceDto>(`/api/v1/invoices/${id}/cancel`, { method: 'PATCH' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing', 'invoices'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'invoice', id] });
    },
  });
}

export function useGenerateFromSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: GenerateFromSchedulePayload) =>
      apiFetch<GenerateFromScheduleResponse>('/api/v1/invoices/generate-from-schedule', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing', 'invoices'] });
    },
  });
}

// ── Payments ───────────────────────────────────────────────

export function usePayments(args: ListPaymentsArgs = {}, enabled = true) {
  const params = new URLSearchParams();
  if (args.familyAccountId) params.set('familyAccountId', args.familyAccountId);
  if (args.invoiceId) params.set('invoiceId', args.invoiceId);
  if (args.status) params.set('status', args.status);
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'billing',
      'payments',
      {
        familyAccountId: args.familyAccountId ?? null,
        invoiceId: args.invoiceId ?? null,
        status: args.status ?? null,
      },
    ],
    queryFn: () => apiFetch<PaymentDto[]>(`/api/v1/payments${qs ? `?${qs}` : ''}`),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function usePayment(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['billing', 'payment', id],
    queryFn: () => apiFetch<PaymentDto>(`/api/v1/payments/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function usePayInvoice(invoiceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: PayInvoicePayload) =>
      apiFetch<PaymentDto>(`/api/v1/invoices/${invoiceId}/pay`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing', 'invoices'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'invoice', invoiceId] });
      void qc.invalidateQueries({ queryKey: ['billing', 'payments'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'family-accounts'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'family-account'] });
    },
  });
}

// ── Refunds ────────────────────────────────────────────────

export function useRefunds(args: ListRefundsArgs = {}, enabled = true) {
  const params = new URLSearchParams();
  if (args.familyAccountId) params.set('familyAccountId', args.familyAccountId);
  if (args.paymentId) params.set('paymentId', args.paymentId);
  if (args.status) params.set('status', args.status);
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'billing',
      'refunds',
      {
        familyAccountId: args.familyAccountId ?? null,
        paymentId: args.paymentId ?? null,
        status: args.status ?? null,
      },
    ],
    queryFn: () => apiFetch<RefundDto[]>(`/api/v1/refunds${qs ? `?${qs}` : ''}`),
    enabled,
  });
}

export function useIssueRefund(paymentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: IssueRefundPayload) =>
      apiFetch<RefundDto>(`/api/v1/payments/${paymentId}/refund`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing', 'payments'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'payment', paymentId] });
      void qc.invalidateQueries({ queryKey: ['billing', 'refunds'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'family-accounts'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'family-account'] });
    },
  });
}

// ── Payment Plans ──────────────────────────────────────────

export function usePaymentPlan(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['billing', 'payment-plan', id],
    queryFn: () => apiFetch<PaymentPlanDto>(`/api/v1/payment-plans/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useCreatePaymentPlan(invoiceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePaymentPlanPayload) =>
      apiFetch<PaymentPlanDto>(`/api/v1/invoices/${invoiceId}/payment-plan`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing', 'invoice', invoiceId] });
    },
  });
}
