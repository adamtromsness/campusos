'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

const PREFIX = '/api/v1';

export type PayPeriodStatus = 'OPEN' | 'PROCESSING' | 'PAID' | 'CLOSED';
export type PayrollRecordStatus = 'DRAFT' | 'APPROVED' | 'PAID';

export interface PayPeriodDto {
  id: string;
  schoolId: string;
  periodLabel: string;
  startDate: string;
  endDate: string;
  payDate: string;
  status: PayPeriodStatus;
  processedAt: string | null;
  paidAt: string | null;
  recordCount: number;
  totalGross: number;
  totalDeductions: number;
  totalNet: number;
}

export interface PayrollDeductionDto {
  id: string;
  payrollRecordId: string;
  deductionType: string;
  description: string | null;
  amount: number;
  isPretax: boolean;
}

export interface PayrollRecordDto {
  id: string;
  schoolId: string;
  employeeId: string;
  employeeName: string | null;
  payPeriodId: string;
  payPeriodLabel: string;
  payDate: string;
  salaryScaleId: string | null;
  grossPay: number;
  totalDeductions: number;
  totalAdjustments: number;
  netPay: number;
  status: PayrollRecordStatus;
  notes: string | null;
  deductions: PayrollDeductionDto[];
  createdAt: string;
}

export interface PayGradeDto {
  id: string;
  schoolId: string;
  gradeName: string;
  description: string | null;
  minSalary: number | null;
  maxSalary: number | null;
  isActive: boolean;
  scales: Array<{
    id: string;
    payGradeId: string;
    step: number;
    annualSalary: number;
    notes: string | null;
  }>;
}

export function usePayPeriods(args?: { status?: PayPeriodStatus }) {
  const params = new URLSearchParams();
  if (args?.status) params.set('status', args.status);
  const qs = params.toString();
  return useQuery({
    queryKey: ['payroll-periods', args ?? null],
    queryFn: () => apiFetch<PayPeriodDto[]>(`${PREFIX}/hr/pay-periods${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
  });
}

export function usePayrollRecords(args?: {
  payPeriodId?: string;
  employeeId?: string;
  status?: PayrollRecordStatus;
}) {
  const params = new URLSearchParams();
  if (args?.payPeriodId) params.set('payPeriodId', args.payPeriodId);
  if (args?.employeeId) params.set('employeeId', args.employeeId);
  if (args?.status) params.set('status', args.status);
  const qs = params.toString();
  return useQuery({
    queryKey: ['payroll-records', args ?? null],
    queryFn: () =>
      apiFetch<PayrollRecordDto[]>(`${PREFIX}/hr/payroll/records${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
  });
}

export function useMyPayslips() {
  return useQuery({
    queryKey: ['payroll-me-payslips'],
    queryFn: () => apiFetch<PayrollRecordDto[]>(`${PREFIX}/hr/payroll/me/payslips`),
    staleTime: 30_000,
  });
}

export function useCreatePayPeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      periodLabel: string;
      startDate: string;
      endDate: string;
      payDate: string;
    }) =>
      apiFetch<PayPeriodDto>(`${PREFIX}/hr/pay-periods`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payroll-periods'] }),
  });
}

export function useProcessPayPeriod(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ processed: number; skipped: number }>(`${PREFIX}/hr/pay-periods/${id}/process`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payroll-periods'] });
      void qc.invalidateQueries({ queryKey: ['payroll-records'] });
    },
  });
}

export function useApprovePayPeriod(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<PayPeriodDto>(`${PREFIX}/hr/pay-periods/${id}/approve`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payroll-periods'] });
      void qc.invalidateQueries({ queryKey: ['payroll-records'] });
    },
  });
}

export function useMarkPaid(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<PayPeriodDto>(`${PREFIX}/hr/pay-periods/${id}/mark-paid`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payroll-periods'] });
      void qc.invalidateQueries({ queryKey: ['payroll-records'] });
    },
  });
}

export function usePayGrades() {
  return useQuery({
    queryKey: ['payroll-pay-grades'],
    queryFn: () => apiFetch<PayGradeDto[]>(`${PREFIX}/hr/pay-grades`),
    staleTime: 60_000,
  });
}

export const PAY_PERIOD_STATUS_LABEL: Record<PayPeriodStatus, string> = {
  OPEN: 'Open',
  PROCESSING: 'Processing',
  PAID: 'Paid',
  CLOSED: 'Closed',
};

export const PAY_PERIOD_STATUS_PILL: Record<PayPeriodStatus, string> = {
  OPEN: 'bg-sky-100 text-sky-800',
  PROCESSING: 'bg-amber-100 text-amber-800',
  PAID: 'bg-emerald-100 text-emerald-800',
  CLOSED: 'bg-slate-200 text-slate-700',
};

export function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(n);
}
