import type {
  FinAPStatus,
  FinAccountType,
  FinBatchStatus,
  FinBatchType,
  FinBudgetStatus,
  FinFundType,
  FinGrantStatus,
  FinPeriodStatus,
  FinReconStatus,
  FinReportType,
} from './types';

export const ACCOUNT_TYPE_LABELS: Record<FinAccountType, string> = {
  ASSET: 'Asset',
  LIABILITY: 'Liability',
  EQUITY: 'Equity',
  REVENUE: 'Revenue',
  EXPENSE: 'Expense',
};

export const ACCOUNT_TYPE_PILL: Record<FinAccountType, string> = {
  ASSET: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  LIABILITY: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  EQUITY: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
  REVENUE: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200',
  EXPENSE: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
};

export const FUND_TYPE_LABELS: Record<FinFundType, string> = {
  GENERAL: 'General Fund',
  SPECIAL_REVENUE: 'Special Revenue',
  CAPITAL_PROJECTS: 'Capital Projects',
  DEBT_SERVICE: 'Debt Service',
  PERMANENT: 'Permanent',
  ENTERPRISE: 'Enterprise',
};

export const PERIOD_STATUS_LABELS: Record<FinPeriodStatus, string> = {
  FUTURE: 'Future',
  OPEN: 'Open',
  CLOSED: 'Closed',
  LOCKED: 'Locked',
};

export const PERIOD_STATUS_PILL: Record<FinPeriodStatus, string> = {
  FUTURE: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  OPEN: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  CLOSED: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  LOCKED: 'bg-rose-100 text-rose-800 ring-1 ring-rose-300',
};

export const BATCH_STATUS_LABELS: Record<FinBatchStatus, string> = {
  DRAFT: 'Draft',
  POSTED: 'Posted',
  VOIDED: 'Voided',
};

export const BATCH_STATUS_PILL: Record<FinBatchStatus, string> = {
  DRAFT: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  POSTED: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  VOIDED: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
};

export const BATCH_TYPE_LABELS: Record<FinBatchType, string> = {
  MANUAL: 'Manual',
  AUTO_PAYMENT: 'Auto · Payment',
  AUTO_INVOICE: 'Auto · Invoice',
  AUTO_REFUND: 'Auto · Refund',
  ADJUSTMENT: 'Adjustment',
};

export const BUDGET_STATUS_LABELS: Record<FinBudgetStatus, string> = {
  DRAFT: 'Draft',
  APPROVED: 'Approved',
  AMENDED: 'Amended',
};

export const BUDGET_STATUS_PILL: Record<FinBudgetStatus, string> = {
  DRAFT: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  APPROVED: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  AMENDED: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200',
};

export const AP_STATUS_LABELS: Record<FinAPStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  PAID: 'Paid',
  VOIDED: 'Voided',
  ON_HOLD: 'On Hold',
};

export const AP_STATUS_PILL: Record<FinAPStatus, string> = {
  PENDING: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  APPROVED: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200',
  PAID: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  VOIDED: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  ON_HOLD: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
};

export const RECON_STATUS_LABELS: Record<FinReconStatus, string> = {
  IN_PROGRESS: 'In progress',
  RECONCILED: 'Reconciled',
  VARIANCE_FLAGGED: 'Variance',
};

export const RECON_STATUS_PILL: Record<FinReconStatus, string> = {
  IN_PROGRESS: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  RECONCILED: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  VARIANCE_FLAGGED: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
};

export const REPORT_TYPE_LABELS: Record<FinReportType, string> = {
  BALANCE_SHEET: 'Balance Sheet',
  INCOME_STATEMENT: 'Income Statement',
  BUDGET_VS_ACTUAL: 'Budget vs Actual',
  CASH_FLOW: 'Cash Flow',
};

export const GRANT_STATUS_LABELS: Record<FinGrantStatus, string> = {
  ACTIVE: 'Active',
  CLOSED: 'Closed',
  REPORTING: 'Reporting',
};

export const GRANT_STATUS_PILL: Record<FinGrantStatus, string> = {
  ACTIVE: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  CLOSED: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  REPORTING: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
};

const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export function formatCurrency(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return fmt.format(n);
}

export function formatSignedCurrency(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  if (n === 0) return fmt.format(0);
  if (n > 0) return `+${fmt.format(n)}`;
  return `−${fmt.format(Math.abs(n))}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function variancePct(budgeted: number, actual: number): number {
  if (budgeted === 0) return 0;
  return Math.round((actual / budgeted) * 100 * 10) / 10;
}
