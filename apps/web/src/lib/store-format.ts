import type {
  StrApprovalStatus,
  StrLineStatus,
  StrOrderStatus,
  StrOrderType,
  StrPaymentStatus,
  StrStoreType,
} from './types';

export const STR_STORE_TYPES: StrStoreType[] = ['STUDENT', 'PUBLIC'];
export const STR_ORDER_STATUSES: StrOrderStatus[] = [
  'PENDING_APPROVAL',
  'APPROVED',
  'PROCESSING',
  'READY_FOR_PICKUP',
  'SHIPPED',
  'COMPLETED',
  'CANCELLED',
  'BACKORDERED',
];

export const ORDER_STATUS_LABELS: Record<StrOrderStatus, string> = {
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  PROCESSING: 'Processing',
  READY_FOR_PICKUP: 'Ready for pickup',
  SHIPPED: 'Shipped',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  BACKORDERED: 'Backordered',
};

export const ORDER_STATUS_PILL: Record<StrOrderStatus, string> = {
  PENDING_APPROVAL: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-violet-100 text-violet-700',
  PROCESSING: 'bg-sky-100 text-sky-700',
  READY_FOR_PICKUP: 'bg-emerald-100 text-emerald-700',
  SHIPPED: 'bg-emerald-100 text-emerald-700',
  COMPLETED: 'bg-emerald-200 text-emerald-800',
  CANCELLED: 'bg-rose-100 text-rose-700',
  BACKORDERED: 'bg-amber-200 text-amber-800',
};

export const ORDER_TYPE_LABELS: Record<StrOrderType, string> = {
  STUDENT: 'Student',
  PARENT: 'Parent',
  EXTERNAL: 'External',
};

export const PAYMENT_STATUS_LABELS: Record<StrPaymentStatus, string> = {
  PENDING: 'Pending',
  CHARGED: 'Charged',
  DEFERRED_BACKORDER: 'Deferred (backorder)',
  REFUNDED: 'Refunded',
};

export const PAYMENT_STATUS_PILL: Record<StrPaymentStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-700',
  CHARGED: 'bg-emerald-100 text-emerald-700',
  DEFERRED_BACKORDER: 'bg-sky-100 text-sky-700',
  REFUNDED: 'bg-rose-100 text-rose-700',
};

export const LINE_STATUS_LABELS: Record<StrLineStatus, string> = {
  IN_STOCK: 'In stock',
  BACKORDERED: 'Backordered',
  FULFILLED: 'Fulfilled',
  CANCELLED: 'Cancelled',
};

export const LINE_STATUS_PILL: Record<StrLineStatus, string> = {
  IN_STOCK: 'bg-sky-100 text-sky-700',
  BACKORDERED: 'bg-amber-100 text-amber-700',
  FULFILLED: 'bg-emerald-100 text-emerald-700',
  CANCELLED: 'bg-gray-200 text-gray-700',
};

export const APPROVAL_STATUS_LABELS: Record<StrApprovalStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  DECLINED: 'Declined',
};

export const APPROVAL_STATUS_PILL: Record<StrApprovalStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-emerald-100 text-emerald-700',
  DECLINED: 'bg-rose-100 text-rose-700',
};

export function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function stockBadge(qty: number, reorderPoint: number) {
  if (qty <= 0) {
    return { label: 'Out of stock', className: 'bg-rose-100 text-rose-700' };
  }
  if (reorderPoint > 0 && qty <= reorderPoint) {
    return { label: 'Low stock', className: 'bg-amber-100 text-amber-700' };
  }
  return { label: 'In stock', className: 'bg-emerald-100 text-emerald-700' };
}

export function isOpenOrder(status: StrOrderStatus): boolean {
  return !['COMPLETED', 'CANCELLED'].includes(status);
}
