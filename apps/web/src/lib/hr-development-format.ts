import type {
  AppraisalRating,
  AppraisalStatus,
  CertificationStatus,
  CycleStatus,
  CycleType,
  EventStatus,
  ExpenseStatus,
  AppraisalGoalProgress,
} from './types';

export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
  SCHEDULED: 'Scheduled',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const EVENT_STATUS_PILL: Record<EventStatus, string> = {
  SCHEDULED: 'bg-sky-100 text-sky-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-rose-100 text-rose-700',
};

export const CERT_STATUS_LABEL: Record<CertificationStatus, string> = {
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  REVOKED: 'Revoked',
};

export const CERT_STATUS_PILL: Record<CertificationStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-800',
  EXPIRED: 'bg-amber-100 text-amber-800',
  REVOKED: 'bg-rose-100 text-rose-700',
};

export const APPRAISAL_STATUS_LABEL: Record<AppraisalStatus, string> = {
  DRAFT: 'Draft',
  IN_REVIEW: 'In review',
  SIGNED_OFF: 'Signed off',
};

export const APPRAISAL_STATUS_PILL: Record<AppraisalStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700',
  IN_REVIEW: 'bg-amber-100 text-amber-800',
  SIGNED_OFF: 'bg-emerald-100 text-emerald-800',
};

export const RATING_LABEL: Record<AppraisalRating, string> = {
  OUTSTANDING: 'Outstanding',
  GOOD: 'Good',
  REQUIRES_IMPROVEMENT: 'Requires improvement',
  INADEQUATE: 'Inadequate',
};

export const RATING_PILL: Record<AppraisalRating, string> = {
  OUTSTANDING: 'bg-emerald-100 text-emerald-800',
  GOOD: 'bg-sky-100 text-sky-800',
  REQUIRES_IMPROVEMENT: 'bg-amber-100 text-amber-800',
  INADEQUATE: 'bg-rose-100 text-rose-700',
};

export const CYCLE_TYPE_LABEL: Record<CycleType, string> = {
  ANNUAL: 'Annual',
  MID_YEAR: 'Mid-year',
  PROBATIONARY: 'Probationary',
};

export const CYCLE_STATUS_LABEL: Record<CycleStatus, string> = {
  OPEN: 'Open',
  CLOSED: 'Closed',
  ARCHIVED: 'Archived',
};

export const CYCLE_STATUS_PILL: Record<CycleStatus, string> = {
  OPEN: 'bg-emerald-100 text-emerald-800',
  CLOSED: 'bg-slate-100 text-slate-700',
  ARCHIVED: 'bg-slate-200 text-slate-600',
};

export const GOAL_PROGRESS_LABEL: Record<AppraisalGoalProgress, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  ACHIEVED: 'Achieved',
  NOT_ACHIEVED: 'Not achieved',
};

export const GOAL_PROGRESS_PILL: Record<AppraisalGoalProgress, string> = {
  NOT_STARTED: 'bg-slate-100 text-slate-700',
  IN_PROGRESS: 'bg-sky-100 text-sky-800',
  ACHIEVED: 'bg-emerald-100 text-emerald-800',
  NOT_ACHIEVED: 'bg-rose-100 text-rose-700',
};

export const EXPENSE_STATUS_LABEL: Record<ExpenseStatus, string> = {
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  PAID: 'Paid',
};

export const EXPENSE_STATUS_PILL: Record<ExpenseStatus, string> = {
  SUBMITTED: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-sky-100 text-sky-800',
  REJECTED: 'bg-rose-100 text-rose-700',
  PAID: 'bg-emerald-100 text-emerald-800',
};

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

/** Days-until-expiry tone: <= 30 rose, <= 60 amber, > 60 emerald, null gray. */
export function expiryTone(days: number | null): string {
  if (days === null) return 'text-slate-500';
  if (days <= 0) return 'text-rose-700 font-semibold';
  if (days <= 30) return 'text-rose-700';
  if (days <= 60) return 'text-amber-700';
  return 'text-emerald-700';
}
