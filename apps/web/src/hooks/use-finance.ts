import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  FinAPPaymentDto,
  FinAPStatus,
  FinAPVoucherDto,
  FinAccountDto,
  FinAccountType,
  FinBatchType,
  FinBoardReportDto,
  FinBudgetDto,
  FinFundDto,
  FinGrantDto,
  FinJournalBatchDto,
  FinNormalBalance,
  FinPaymentMethod,
  FinPeriodDto,
  FinPeriodStatus,
  FinReconciliationDto,
  FinReportType,
  FinSupplierDto,
  FinTrialBalanceDto,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ─── Funds ───
export function useFunds() {
  return useQuery({
    queryKey: ['finance', 'funds'],
    queryFn: () => apiFetch<FinFundDto[]>(`${PREFIX}/finance/funds`),
  });
}

// ─── Chart of Accounts ───
export function useAccounts(includeInactive = false) {
  return useQuery({
    queryKey: ['finance', 'accounts', includeInactive],
    queryFn: () =>
      apiFetch<FinAccountDto[]>(
        `${PREFIX}/finance/accounts${includeInactive ? '?includeInactive=true' : ''}`,
      ),
    refetchOnWindowFocus: true,
  });
}

export function useAccount(id: string | null) {
  return useQuery({
    queryKey: ['finance', 'account', id],
    queryFn: () => apiFetch<FinAccountDto>(`${PREFIX}/finance/accounts/${id}`),
    enabled: !!id,
  });
}

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      accountCode: string;
      accountName: string;
      accountType: FinAccountType;
      normalBalance: FinNormalBalance;
      parentAccountId?: string;
      fundId?: string;
      description?: string;
      isSystem?: boolean;
    }) =>
      apiFetch<FinAccountDto>(`${PREFIX}/finance/accounts`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['finance', 'accounts'] });
      qc.invalidateQueries({ queryKey: ['finance', 'trial-balance'] });
    },
  });
}

export function useUpdateAccount(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<FinAccountDto>(`${PREFIX}/finance/accounts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['finance', 'accounts'] });
      qc.invalidateQueries({ queryKey: ['finance', 'account', id] });
    },
  });
}

// ─── Trial Balance ───
export function useTrialBalance(periodId?: string) {
  return useQuery({
    queryKey: ['finance', 'trial-balance', periodId ?? 'all'],
    queryFn: () =>
      apiFetch<FinTrialBalanceDto>(
        `${PREFIX}/finance/trial-balance${periodId ? `?periodId=${periodId}` : ''}`,
      ),
  });
}

// ─── Periods ───
export function usePeriods(fiscalYear?: string) {
  return useQuery({
    queryKey: ['finance', 'periods', fiscalYear ?? 'all'],
    queryFn: () =>
      apiFetch<FinPeriodDto[]>(
        `${PREFIX}/finance/periods${fiscalYear ? `?fiscalYear=${fiscalYear}` : ''}`,
      ),
  });
}

export function useUpdatePeriodStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: FinPeriodStatus) =>
      apiFetch<FinPeriodDto>(`${PREFIX}/finance/periods/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['finance', 'periods'] });
    },
  });
}

// ─── Journal Batches ───
export function useJournalBatches(filter?: {
  status?: string;
  periodId?: string;
  sourceModule?: string;
}) {
  const search = new URLSearchParams();
  if (filter?.status) search.set('status', filter.status);
  if (filter?.periodId) search.set('periodId', filter.periodId);
  if (filter?.sourceModule) search.set('sourceModule', filter.sourceModule);
  const qs = search.toString();
  return useQuery({
    queryKey: ['finance', 'journal-batches', qs],
    queryFn: () =>
      apiFetch<FinJournalBatchDto[]>(`${PREFIX}/finance/journal-batches${qs ? `?${qs}` : ''}`),
    refetchOnWindowFocus: true,
  });
}

export function useJournalBatch(id: string | null) {
  return useQuery({
    queryKey: ['finance', 'journal-batch', id],
    queryFn: () => apiFetch<FinJournalBatchDto>(`${PREFIX}/finance/journal-batches/${id}`),
    enabled: !!id,
  });
}

export function useCreateJournalBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      batchNumber: string;
      description: string;
      batchType: FinBatchType;
      sourceModule?: string;
      accountingPeriodId: string;
      entries: Array<{
        accountId: string;
        fundId: string;
        debit: number;
        credit: number;
        description?: string;
      }>;
    }) =>
      apiFetch<FinJournalBatchDto>(`${PREFIX}/finance/journal-batches`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['finance', 'journal-batches'] });
    },
  });
}

export function usePostJournalBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<FinJournalBatchDto>(`${PREFIX}/finance/journal-batches/${id}/post`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['finance', 'journal-batches'] });
      qc.invalidateQueries({ queryKey: ['finance', 'trial-balance'] });
      qc.invalidateQueries({ queryKey: ['finance', 'accounts'] });
      qc.invalidateQueries({ queryKey: ['finance', 'budgets'] });
    },
  });
}

export function useVoidJournalBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiFetch<FinJournalBatchDto>(`${PREFIX}/finance/journal-batches/${id}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['finance', 'journal-batches'] });
      qc.invalidateQueries({ queryKey: ['finance', 'trial-balance'] });
      qc.invalidateQueries({ queryKey: ['finance', 'accounts'] });
      qc.invalidateQueries({ queryKey: ['finance', 'budgets'] });
    },
  });
}

// ─── Suppliers ───
export function useSuppliers(includeInactive = false) {
  return useQuery({
    queryKey: ['finance', 'suppliers', includeInactive],
    queryFn: () =>
      apiFetch<FinSupplierDto[]>(
        `${PREFIX}/finance/suppliers${includeInactive ? '?includeInactive=true' : ''}`,
      ),
  });
}

export function useCreateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { supplierCode: string; supplierName: string; paymentTerms?: string }) =>
      apiFetch<FinSupplierDto>(`${PREFIX}/finance/suppliers`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['finance', 'suppliers'] });
    },
  });
}

// ─── Budgets ───
export function useBudgets(fiscalYear?: string) {
  return useQuery({
    queryKey: ['finance', 'budgets', fiscalYear ?? 'all'],
    queryFn: () =>
      apiFetch<FinBudgetDto[]>(
        `${PREFIX}/finance/budgets${fiscalYear ? `?fiscalYear=${fiscalYear}` : ''}`,
      ),
  });
}

export function useBudget(id: string | null) {
  return useQuery({
    queryKey: ['finance', 'budget', id],
    queryFn: () => apiFetch<FinBudgetDto>(`${PREFIX}/finance/budgets/${id}`),
    enabled: !!id,
  });
}

// ─── AP ───
export function useAPVouchers(filter?: { status?: FinAPStatus; supplierId?: string }) {
  const search = new URLSearchParams();
  if (filter?.status) search.set('status', filter.status);
  if (filter?.supplierId) search.set('supplierId', filter.supplierId);
  const qs = search.toString();
  return useQuery({
    queryKey: ['finance', 'ap-vouchers', qs],
    queryFn: () =>
      apiFetch<FinAPVoucherDto[]>(`${PREFIX}/finance/ap-vouchers${qs ? `?${qs}` : ''}`),
  });
}

export function useAPVoucher(id: string | null) {
  return useQuery({
    queryKey: ['finance', 'ap-voucher', id],
    queryFn: () => apiFetch<FinAPVoucherDto>(`${PREFIX}/finance/ap-vouchers/${id}`),
    enabled: !!id,
  });
}

export function useCreateAPVoucher() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      supplierId: string;
      voucherNumber: string;
      invoiceNumber?: string;
      invoiceDate: string;
      dueDate: string;
      totalAmount: number;
      description?: string;
      glAccountId?: string;
      fundId?: string;
    }) =>
      apiFetch<FinAPVoucherDto>(`${PREFIX}/finance/ap-vouchers`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['finance', 'ap-vouchers'] });
    },
  });
}

export function useTransitionAPVoucher() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      reason,
    }: {
      id: string;
      action: 'APPROVE' | 'HOLD' | 'RELEASE' | 'VOID';
      reason?: string;
    }) =>
      apiFetch<FinAPVoucherDto>(`${PREFIX}/finance/ap-vouchers/${id}/transition`, {
        method: 'PATCH',
        body: JSON.stringify({ action, reason }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['finance', 'ap-vouchers'] });
    },
  });
}

export function useAPPayments(voucherId: string | null) {
  return useQuery({
    queryKey: ['finance', 'ap-payments', voucherId],
    queryFn: () =>
      apiFetch<FinAPPaymentDto[]>(`${PREFIX}/finance/ap-vouchers/${voucherId}/payments`),
    enabled: !!voucherId,
  });
}

export function usePayAPVoucher() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      paymentMethod,
      amount,
      paymentReference,
      notes,
    }: {
      id: string;
      paymentMethod: FinPaymentMethod;
      amount: number;
      paymentReference?: string;
      notes?: string;
    }) =>
      apiFetch<FinAPPaymentDto>(`${PREFIX}/finance/ap-vouchers/${id}/pay`, {
        method: 'POST',
        body: JSON.stringify({ paymentMethod, amount, paymentReference, notes }),
      }),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['finance', 'ap-vouchers'] });
      qc.invalidateQueries({ queryKey: ['finance', 'ap-voucher', id] });
      qc.invalidateQueries({ queryKey: ['finance', 'ap-payments', id] });
      qc.invalidateQueries({ queryKey: ['finance', 'journal-batches'] });
      qc.invalidateQueries({ queryKey: ['finance', 'trial-balance'] });
    },
  });
}

// ─── Reconciliation ───
export function useReconciliations() {
  return useQuery({
    queryKey: ['finance', 'reconciliations'],
    queryFn: () => apiFetch<FinReconciliationDto[]>(`${PREFIX}/finance/reconciliation`),
  });
}

export function useStartReconciliation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      accountId: string;
      periodId: string;
      bankBalance: number;
      outstandingItems?: unknown[];
      notes?: string;
    }) =>
      apiFetch<FinReconciliationDto>(`${PREFIX}/finance/reconciliation`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['finance', 'reconciliations'] }),
  });
}

export function useFinalizeReconciliation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      bankBalance,
      outstandingItems,
      notes,
    }: {
      id: string;
      bankBalance: number;
      outstandingItems?: unknown[];
      notes?: string;
    }) =>
      apiFetch<FinReconciliationDto>(`${PREFIX}/finance/reconciliation/${id}/finalize`, {
        method: 'PATCH',
        body: JSON.stringify({ bankBalance, outstandingItems, notes }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['finance', 'reconciliations'] }),
  });
}

// ─── Board Reports ───
export function useBoardReports() {
  return useQuery({
    queryKey: ['finance', 'board-reports'],
    queryFn: () => apiFetch<FinBoardReportDto[]>(`${PREFIX}/finance/board-reports`),
  });
}

export function useBoardReport(id: string | null) {
  return useQuery({
    queryKey: ['finance', 'board-report', id],
    queryFn: () => apiFetch<FinBoardReportDto>(`${PREFIX}/finance/board-reports/${id}`),
    enabled: !!id,
  });
}

export function useGenerateBoardReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { reportType: FinReportType; periodId?: string }) =>
      apiFetch<FinBoardReportDto>(`${PREFIX}/finance/board-reports`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['finance', 'board-reports'] }),
  });
}

// ─── Grants ───
export function useGrants() {
  return useQuery({
    queryKey: ['finance', 'grants'],
    queryFn: () => apiFetch<FinGrantDto[]>(`${PREFIX}/finance/grants`),
  });
}
