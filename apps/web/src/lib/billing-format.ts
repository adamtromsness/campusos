import type {
  EntryType,
  FamilyAccountStatus,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  Recurrence,
  RefundCategory,
  RefundStatus,
} from '@/lib/types';

export const RECURRENCE_OPTIONS: Recurrence[] = [
  'ONE_TIME',
  'MONTHLY',
  'QUARTERLY',
  'SEMESTER',
  'ANNUAL',
];

export const RECURRENCE_LABELS: Record<Recurrence, string> = {
  ONE_TIME: 'One-time',
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  SEMESTER: 'Per semester',
  ANNUAL: 'Annual',
};

export const INVOICE_STATUSES: InvoiceStatus[] = [
  'DRAFT',
  'SENT',
  'PARTIAL',
  'PAID',
  'OVERDUE',
  'CANCELLED',
];

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  PARTIAL: 'Partially paid',
  PAID: 'Paid',
  OVERDUE: 'Overdue',
  CANCELLED: 'Cancelled',
};

export const INVOICE_STATUS_PILL: Record<InvoiceStatus, string> = {
  DRAFT: 'bg-gray-200 text-gray-700',
  SENT: 'bg-sky-100 text-sky-800',
  PARTIAL: 'bg-amber-100 text-amber-800',
  PAID: 'bg-emerald-100 text-emerald-800',
  OVERDUE: 'bg-rose-100 text-rose-800',
  CANCELLED: 'bg-gray-200 text-gray-500 line-through',
};

export const PAYMENT_METHODS: PaymentMethod[] = [
  'CARD',
  'BANK_TRANSFER',
  'CASH',
  'CHEQUE',
  'WAIVER',
];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  CASH: 'Cash',
  CHEQUE: 'Cheque',
  WAIVER: 'Waiver',
};

export const PAYMENT_STATUSES: PaymentStatus[] = ['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED'];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  PENDING: 'Pending',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  REFUNDED: 'Refunded',
};

export const PAYMENT_STATUS_PILL: Record<PaymentStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  FAILED: 'bg-rose-100 text-rose-800',
  REFUNDED: 'bg-violet-100 text-violet-800',
};

export const FAMILY_ACCOUNT_STATUS_LABELS: Record<FamilyAccountStatus, string> = {
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  CLOSED: 'Closed',
};

export const FAMILY_ACCOUNT_STATUS_PILL: Record<FamilyAccountStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-800',
  SUSPENDED: 'bg-amber-100 text-amber-800',
  CLOSED: 'bg-gray-200 text-gray-700',
};

export const REFUND_CATEGORIES: RefundCategory[] = [
  'OVERPAYMENT',
  'WITHDRAWAL',
  'PROGRAMME_CANCELLED',
  'ERROR_CORRECTION',
  'GOODWILL',
  'OTHER',
];

export const REFUND_CATEGORY_LABELS: Record<RefundCategory, string> = {
  OVERPAYMENT: 'Overpayment',
  WITHDRAWAL: 'Withdrawal',
  PROGRAMME_CANCELLED: 'Programme cancelled',
  ERROR_CORRECTION: 'Error correction',
  GOODWILL: 'Goodwill',
  OTHER: 'Other',
};

export const REFUND_STATUS_LABELS: Record<RefundStatus, string> = {
  PENDING: 'Pending',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

export const REFUND_STATUS_PILL: Record<RefundStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  FAILED: 'bg-rose-100 text-rose-800',
};

export const ENTRY_TYPE_LABELS: Record<EntryType, string> = {
  CHARGE: 'Charge',
  PAYMENT: 'Payment',
  REFUND: 'Refund',
  CREDIT: 'Credit',
  ADJUSTMENT: 'Adjustment',
};

export const ENTRY_TYPE_PILL: Record<EntryType, string> = {
  CHARGE: 'bg-rose-100 text-rose-800',
  PAYMENT: 'bg-emerald-100 text-emerald-800',
  REFUND: 'bg-violet-100 text-violet-800',
  CREDIT: 'bg-sky-100 text-sky-800',
  ADJUSTMENT: 'bg-gray-200 text-gray-700',
};

export function formatCurrency(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatSignedCurrency(amount: number | string): string {
  // Ledger amounts are signed: CHARGE positive, PAYMENT/REFUND negative.
  // Render with explicit sign for the running-balance view.
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (Number.isNaN(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  const abs = Math.abs(n);
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(abs);
  return sign ? `${sign}${formatted}` : formatted;
}

export function formatDateOnly(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

// ────────── P2-6 — Payments Advanced ──────────

import type {
  FinancialAidApplicationStatus,
  AwardStatus,
  CreditCategory,
  DiscountType,
  IncomeBand,
  LateFeeType,
  LunchTransactionType,
  LunchTransferType,
  ReductionType,
  ReversalType,
  InvoiceGenerationRunStatus,
  InvoiceGenerationRunType,
  TriggerType,
} from './types';

export const REDUCTION_TYPE_LABELS: Record<ReductionType, string> = {
  PERCENTAGE: 'Percentage',
  FIXED_AMOUNT: 'Fixed amount',
};

export const APPLICATION_STATUSES: FinancialAidApplicationStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
];

export const APPLICATION_STATUS_LABELS: Record<FinancialAidApplicationStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

export const APPLICATION_STATUS_PILL: Record<FinancialAidApplicationStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  SUBMITTED: 'bg-sky-100 text-sky-700',
  UNDER_REVIEW: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-rose-100 text-rose-700',
  WITHDRAWN: 'bg-gray-100 text-gray-500',
};

export const AWARD_STATUS_LABELS: Record<AwardStatus, string> = {
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  REVOKED: 'Revoked',
};

export const AWARD_STATUS_PILL: Record<AwardStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  EXPIRED: 'bg-gray-100 text-gray-700',
  REVOKED: 'bg-rose-100 text-rose-700',
};

export const INCOME_BANDS: IncomeBand[] = ['BAND_A', 'BAND_B', 'BAND_C', 'BAND_D', 'BAND_E'];

export const INCOME_BAND_LABELS: Record<IncomeBand, string> = {
  BAND_A: 'Band A (highest income)',
  BAND_B: 'Band B',
  BAND_C: 'Band C (median)',
  BAND_D: 'Band D',
  BAND_E: 'Band E (lowest income)',
};

export const DISCOUNT_TYPES: DiscountType[] = [
  'SIBLING',
  'EARLY_PAYMENT',
  'LOYALTY',
  'BURSARY',
  'STAFF_CHILD',
  'CUSTOM',
];

export const DISCOUNT_TYPE_LABELS: Record<DiscountType, string> = {
  SIBLING: 'Sibling',
  EARLY_PAYMENT: 'Early payment',
  LOYALTY: 'Loyalty',
  BURSARY: 'Bursary',
  STAFF_CHILD: 'Staff child',
  CUSTOM: 'Custom',
};

export const TRIGGER_TYPES: TriggerType[] = [
  'ENROLMENT_CONFIRMED',
  'TERM_START',
  'DATE_OF_MONTH',
  'ACADEMIC_YEAR_START',
];

export const TRIGGER_TYPE_LABELS: Record<TriggerType, string> = {
  ENROLMENT_CONFIRMED: 'On enrolment confirmed',
  TERM_START: 'Term start',
  DATE_OF_MONTH: 'Day of month',
  ACADEMIC_YEAR_START: 'Academic year start',
};

export const RUN_TYPE_LABELS: Record<InvoiceGenerationRunType, string> = {
  MANUAL_BATCH: 'Manual batch',
  AUTO_RULE_TRIGGERED: 'Auto-rule triggered',
  FEE_SCHEDULE_BULK: 'Fee schedule bulk',
};

export const RUN_STATUS_PILL: Record<InvoiceGenerationRunStatus, string> = {
  QUEUED: 'bg-gray-100 text-gray-700',
  RUNNING: 'bg-sky-100 text-sky-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-rose-100 text-rose-700',
};

export const LUNCH_TX_TYPE_LABELS: Record<LunchTransactionType, string> = {
  MEAL_CHARGE: 'Meal charge',
  DEPOSIT: 'Deposit',
  REFUND: 'Refund',
  ADJUSTMENT: 'Adjustment',
};

export const LUNCH_TX_TYPE_PILL: Record<LunchTransactionType, string> = {
  MEAL_CHARGE: 'bg-rose-100 text-rose-700',
  DEPOSIT: 'bg-emerald-100 text-emerald-700',
  REFUND: 'bg-amber-100 text-amber-700',
  ADJUSTMENT: 'bg-gray-100 text-gray-700',
};

export const LUNCH_TRANSFER_TYPE_LABELS: Record<LunchTransferType, string> = {
  SIBLING_TRANSFER: 'Sibling transfer',
  NEXT_YEAR_ROLLOVER: 'Next-year rollover',
  REFUND_TO_FAMILY: 'Refund to family',
};

export const CREDIT_CATEGORIES: CreditCategory[] = [
  'GOODWILL',
  'BILLING_ERROR',
  'PROGRAMME_CANCELLED',
  'OVERPAYMENT',
  'OTHER',
];

export const CREDIT_CATEGORY_LABELS: Record<CreditCategory, string> = {
  GOODWILL: 'Goodwill',
  BILLING_ERROR: 'Billing error',
  PROGRAMME_CANCELLED: 'Programme cancelled',
  OVERPAYMENT: 'Overpayment',
  OTHER: 'Other',
};

export const REVERSAL_TYPES: ReversalType[] = [
  'BOUNCED_CHEQUE',
  'RECALLED_TRANSFER',
  'CHARGEBACK',
  'DUPLICATE_PAYMENT',
  'OTHER',
];

export const REVERSAL_TYPE_LABELS: Record<ReversalType, string> = {
  BOUNCED_CHEQUE: 'Bounced cheque',
  RECALLED_TRANSFER: 'Recalled transfer',
  CHARGEBACK: 'Chargeback',
  DUPLICATE_PAYMENT: 'Duplicate payment',
  OTHER: 'Other',
};

export const LATE_FEE_TYPE_LABELS: Record<LateFeeType, string> = {
  FIXED: 'Fixed',
  PERCENTAGE_MONTHLY: 'Percentage monthly',
};

export function isLowBalance(account: { balance: number; lowBalanceThreshold: number }): boolean {
  return account.balance <= account.lowBalanceThreshold;
}

export function lunchBalanceTone(account: {
  balance: number;
  lowBalanceThreshold: number;
}): string {
  if (account.balance <= 0) return 'text-rose-700';
  if (account.balance <= account.lowBalanceThreshold) return 'text-amber-700';
  return 'text-emerald-700';
}

export function fundRemainingPct(program: {
  totalFundAmount: number | null;
  fundRemaining: number | null;
}): number | null {
  if (program.totalFundAmount === null || program.fundRemaining === null) return null;
  if (program.totalFundAmount === 0) return 0;
  return Math.max(0, Math.min(100, (program.fundRemaining / program.totalFundAmount) * 100));
}

export function fundRemainingTone(pct: number | null): string {
  if (pct === null) return 'bg-sky-500';
  if (pct >= 50) return 'bg-emerald-500';
  if (pct >= 20) return 'bg-amber-500';
  return 'bg-rose-500';
}
