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
