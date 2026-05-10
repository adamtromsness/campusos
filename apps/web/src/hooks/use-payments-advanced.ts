'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AllocatePaymentPayload,
  AutoInvoiceRuleDto,
  CreateAutoInvoiceRulePayload,
  CreateDiscountRulePayload,
  CreateFinancialAidApplicationPayload,
  CreateFinancialAidProgramPayload,
  CreateSavedPaymentMethodPayload,
  CreditNoteDto,
  DepositLunchAccountPayload,
  DiscountRuleDto,
  FinancialAidApplicationDto,
  FinancialAidAwardDto,
  FinancialAidProgramDto,
  InvoiceGenerationRunDto,
  IssueCreditNotePayload,
  LateFeesScanResponseDto,
  LatePaymentPolicyDto,
  LunchAccountDto,
  LunchAccountWithTransactionsDto,
  LunchTransactionDto,
  LunchTransferDto,
  PaymentAllocationDto,
  PaymentReversalDto,
  ReversePaymentPayload,
  ReviewFinancialAidApplicationPayload,
  InvoiceGenerationRunStatus,
  SavedPaymentMethodDto,
  TransferLunchBalancePayload,
  TriggerAutoInvoiceRulePayload,
  UpdateAutoInvoiceRulePayload,
  UpdateDiscountRulePayload,
  UpdateFinancialAidApplicationPayload,
  UpdateFinancialAidProgramPayload,
  UpdateLunchAccountPayload,
  UpsertLatePaymentPolicyPayload,
} from '@/lib/types';

const PFX = '/api/v1/payments';

// ── Financial Aid ──

export function useFinancialAidPrograms(args: { includeInactive?: boolean } = {}, enabled = true) {
  return useQuery({
    queryKey: ['payments-advanced', 'financial-aid', 'programs', args],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (args.includeInactive) qs.set('includeInactive', 'true');
      const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
      return apiFetch<FinancialAidProgramDto[]>(`${PFX}/financial-aid/programs${suffix}`);
    },
    enabled,
    staleTime: 60_000,
  });
}

export function useFinancialAidProgram(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['payments-advanced', 'financial-aid', 'program', id],
    queryFn: () => apiFetch<FinancialAidProgramDto>(`${PFX}/financial-aid/programs/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useCreateFinancialAidProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateFinancialAidProgramPayload) =>
      apiFetch<FinancialAidProgramDto>(`${PFX}/financial-aid/programs`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'financial-aid', 'programs'] });
    },
  });
}

export function useUpdateFinancialAidProgram(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateFinancialAidProgramPayload) =>
      apiFetch<FinancialAidProgramDto>(`${PFX}/financial-aid/programs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'financial-aid', 'programs'] });
      void qc.invalidateQueries({
        queryKey: ['payments-advanced', 'financial-aid', 'program', id],
      });
    },
  });
}

export function useFinancialAidApplications(
  args: { status?: string; academicYearId?: string; studentId?: string } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: ['payments-advanced', 'financial-aid', 'applications', args],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (args.status) qs.set('status', args.status);
      if (args.academicYearId) qs.set('academicYearId', args.academicYearId);
      if (args.studentId) qs.set('studentId', args.studentId);
      const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
      return apiFetch<FinancialAidApplicationDto[]>(`${PFX}/financial-aid/applications${suffix}`);
    },
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useFinancialAidApplication(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['payments-advanced', 'financial-aid', 'application', id],
    queryFn: () => apiFetch<FinancialAidApplicationDto>(`${PFX}/financial-aid/applications/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useCreateFinancialAidApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateFinancialAidApplicationPayload) =>
      apiFetch<FinancialAidApplicationDto>(`${PFX}/financial-aid/applications`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ['payments-advanced', 'financial-aid', 'applications'],
      });
    },
  });
}

export function useUpdateFinancialAidApplication(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateFinancialAidApplicationPayload) =>
      apiFetch<FinancialAidApplicationDto>(`${PFX}/financial-aid/applications/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ['payments-advanced', 'financial-aid', 'applications'],
      });
      void qc.invalidateQueries({
        queryKey: ['payments-advanced', 'financial-aid', 'application', id],
      });
    },
  });
}

export function useSubmitFinancialAidApplication(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<FinancialAidApplicationDto>(`${PFX}/financial-aid/applications/${id}/submit`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ['payments-advanced', 'financial-aid', 'applications'],
      });
      void qc.invalidateQueries({
        queryKey: ['payments-advanced', 'financial-aid', 'application', id],
      });
    },
  });
}

export function useReviewFinancialAidApplication(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReviewFinancialAidApplicationPayload) =>
      apiFetch<FinancialAidApplicationDto>(`${PFX}/financial-aid/applications/${id}/review`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'financial-aid'] });
    },
  });
}

export function useFinancialAidAwardsForStudent(
  studentId: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ['payments-advanced', 'financial-aid', 'awards', studentId],
    queryFn: () => apiFetch<FinancialAidAwardDto[]>(`${PFX}/financial-aid/awards/${studentId}`),
    enabled: enabled && typeof studentId === 'string' && studentId.length > 0,
  });
}

// ── Discount Rules ──

export function useDiscountRules(
  args: { discountType?: string; includeInactive?: boolean } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: ['payments-advanced', 'discount-rules', args],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (args.discountType) qs.set('discountType', args.discountType);
      if (args.includeInactive) qs.set('includeInactive', 'true');
      const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
      return apiFetch<DiscountRuleDto[]>(`${PFX}/discount-rules${suffix}`);
    },
    enabled,
  });
}

export function useCreateDiscountRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateDiscountRulePayload) =>
      apiFetch<DiscountRuleDto>(`${PFX}/discount-rules`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'discount-rules'] });
    },
  });
}

export function useUpdateDiscountRule(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateDiscountRulePayload) =>
      apiFetch<DiscountRuleDto>(`${PFX}/discount-rules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'discount-rules'] });
    },
  });
}

// ── Auto-Invoice Rules + Generation Runs ──

export function useAutoInvoiceRules(includeInactive = false, enabled = true) {
  return useQuery({
    queryKey: ['payments-advanced', 'auto-invoice-rules', includeInactive],
    queryFn: () =>
      apiFetch<AutoInvoiceRuleDto[]>(
        `${PFX}/auto-invoice-rules${includeInactive ? '?includeInactive=true' : ''}`,
      ),
    enabled,
  });
}

export function useCreateAutoInvoiceRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAutoInvoiceRulePayload) =>
      apiFetch<AutoInvoiceRuleDto>(`${PFX}/auto-invoice-rules`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'auto-invoice-rules'] });
    },
  });
}

export function useUpdateAutoInvoiceRule(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateAutoInvoiceRulePayload) =>
      apiFetch<AutoInvoiceRuleDto>(`${PFX}/auto-invoice-rules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'auto-invoice-rules'] });
    },
  });
}

export function useTriggerAutoInvoiceRule(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: TriggerAutoInvoiceRulePayload) =>
      apiFetch<InvoiceGenerationRunDto>(`${PFX}/auto-invoice-rules/${id}/trigger`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'auto-invoice-rules'] });
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'invoice-generation-runs'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'invoices'] });
    },
  });
}

export function useGenerateInvoicesFromFeeSchedule(feeScheduleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: TriggerAutoInvoiceRulePayload) =>
      apiFetch<InvoiceGenerationRunDto>(`${PFX}/fee-schedules/${feeScheduleId}/generate-invoices`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'invoice-generation-runs'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'invoices'] });
    },
  });
}

export function useInvoiceGenerationRuns(
  args: { status?: InvoiceGenerationRunStatus; autoRuleId?: string } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: ['payments-advanced', 'invoice-generation-runs', args],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (args.status) qs.set('status', args.status);
      if (args.autoRuleId) qs.set('autoRuleId', args.autoRuleId);
      const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
      return apiFetch<InvoiceGenerationRunDto[]>(`${PFX}/invoice-generation-runs${suffix}`);
    },
    enabled,
  });
}

// ── Lunch Accounts ──

export function useLunchAccountForStudent(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['payments-advanced', 'lunch-account', 'student', studentId],
    queryFn: () =>
      apiFetch<LunchAccountWithTransactionsDto>(`${PFX}/lunch-accounts/student/${studentId}`),
    enabled: enabled && typeof studentId === 'string' && studentId.length > 0,
    refetchOnWindowFocus: true,
  });
}

export function useLunchLowBalance(enabled = true) {
  return useQuery({
    queryKey: ['payments-advanced', 'lunch-account', 'low-balance'],
    queryFn: () => apiFetch<LunchAccountDto[]>(`${PFX}/lunch-accounts/low-balance`),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useDepositLunchAccount(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: DepositLunchAccountPayload) =>
      apiFetch<LunchTransactionDto>(`${PFX}/lunch-accounts/${accountId}/deposit`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'lunch-account'] });
    },
  });
}

export function useUpdateLunchAccount(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateLunchAccountPayload) =>
      apiFetch<LunchAccountDto>(`${PFX}/lunch-accounts/${accountId}/settings`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'lunch-account'] });
    },
  });
}

export function useTransferLunchBalance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: TransferLunchBalancePayload) =>
      apiFetch<LunchTransferDto>(`${PFX}/lunch-accounts/transfer`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'lunch-account'] });
    },
  });
}

// ── Credit Notes (IMMUTABLE) ──

export function useCreditNotes(
  args: { invoiceId?: string; familyAccountId?: string } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: ['payments-advanced', 'credit-notes', args],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (args.invoiceId) qs.set('invoiceId', args.invoiceId);
      if (args.familyAccountId) qs.set('familyAccountId', args.familyAccountId);
      const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
      return apiFetch<CreditNoteDto[]>(`${PFX}/credit-notes${suffix}`);
    },
    enabled,
  });
}

export function useIssueCreditNote(invoiceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: IssueCreditNotePayload) =>
      apiFetch<CreditNoteDto>(`${PFX}/invoices/${invoiceId}/credit-note`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'credit-notes'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'invoice', invoiceId] });
      void qc.invalidateQueries({ queryKey: ['billing', 'family-accounts'] });
    },
  });
}

// ── Payment Reversals (IMMUTABLE) ──

export function useReversals(
  args: { familyAccountId?: string; invoiceId?: string } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: ['payments-advanced', 'reversals', args],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (args.familyAccountId) qs.set('familyAccountId', args.familyAccountId);
      if (args.invoiceId) qs.set('invoiceId', args.invoiceId);
      const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
      return apiFetch<PaymentReversalDto[]>(`${PFX}/reversals${suffix}`);
    },
    enabled,
  });
}

export function useReversePayment(paymentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReversePaymentPayload) =>
      apiFetch<PaymentReversalDto>(`${PFX}/payments/${paymentId}/reverse`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'reversals'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'payments'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'invoices'] });
      void qc.invalidateQueries({ queryKey: ['billing', 'family-accounts'] });
    },
  });
}

// ── Payment Allocations ──

export function usePaymentAllocations(paymentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['payments-advanced', 'payment-allocations', paymentId],
    queryFn: () => apiFetch<PaymentAllocationDto[]>(`${PFX}/payments/${paymentId}/allocations`),
    enabled: enabled && typeof paymentId === 'string' && paymentId.length > 0,
  });
}

export function useAllocatePayment(paymentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AllocatePaymentPayload) =>
      apiFetch<PaymentAllocationDto[]>(`${PFX}/payments/${paymentId}/allocate`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ['payments-advanced', 'payment-allocations', paymentId],
      });
      void qc.invalidateQueries({ queryKey: ['billing', 'payments'] });
    },
  });
}

// ── Late Payment Policy ──

export function useLatePaymentPolicy(enabled = true) {
  return useQuery({
    queryKey: ['payments-advanced', 'late-payment-policy'],
    queryFn: () => apiFetch<LatePaymentPolicyDto | null>(`${PFX}/late-payment-policy`),
    enabled,
  });
}

export function useUpsertLatePaymentPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpsertLatePaymentPolicyPayload) =>
      apiFetch<LatePaymentPolicyDto>(`${PFX}/late-payment-policy`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'late-payment-policy'] });
    },
  });
}

export function useRunLateFeesScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<LateFeesScanResponseDto>(`${PFX}/late-fees/scan`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing', 'invoices'] });
    },
  });
}

// ── Saved Payment Methods ──

export function useSavedPaymentMethods(familyAccountId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['payments-advanced', 'saved-payment-methods', familyAccountId],
    queryFn: () =>
      apiFetch<SavedPaymentMethodDto[]>(`${PFX}/saved-payment-methods/${familyAccountId}`),
    enabled: enabled && typeof familyAccountId === 'string' && familyAccountId.length > 0,
  });
}

export function useCreateSavedPaymentMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSavedPaymentMethodPayload) =>
      apiFetch<SavedPaymentMethodDto>(`${PFX}/saved-payment-methods`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'saved-payment-methods'] });
    },
  });
}

export function useRemoveSavedPaymentMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ id: string; removed: boolean }>(`${PFX}/saved-payment-methods/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payments-advanced', 'saved-payment-methods'] });
    },
  });
}
