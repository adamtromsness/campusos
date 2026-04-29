import type {
  ApplicationStatus,
  EnrollmentPeriodStatus,
  OfferStatus,
  WaitlistStatus,
} from '@/lib/types';

export const PERIOD_STATUS_LABELS: Record<EnrollmentPeriodStatus, string> = {
  UPCOMING: 'Upcoming',
  OPEN: 'Open',
  CLOSED: 'Closed',
};

export const PERIOD_STATUS_PILL: Record<EnrollmentPeriodStatus, string> = {
  UPCOMING: 'bg-amber-100 text-amber-800',
  OPEN: 'bg-emerald-100 text-emerald-800',
  CLOSED: 'bg-gray-200 text-gray-700',
};

export const APPLICATION_STATUSES: ApplicationStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'ACCEPTED',
  'REJECTED',
  'WAITLISTED',
  'WITHDRAWN',
  'ENROLLED',
];

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  WAITLISTED: 'Waitlisted',
  WITHDRAWN: 'Withdrawn',
  ENROLLED: 'Enrolled',
};

export const APPLICATION_STATUS_PILL: Record<ApplicationStatus, string> = {
  DRAFT: 'bg-gray-200 text-gray-700',
  SUBMITTED: 'bg-sky-100 text-sky-800',
  UNDER_REVIEW: 'bg-amber-100 text-amber-800',
  ACCEPTED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-rose-100 text-rose-800',
  WAITLISTED: 'bg-violet-100 text-violet-800',
  WITHDRAWN: 'bg-gray-200 text-gray-700',
  ENROLLED: 'bg-campus-100 text-campus-800',
};

export const PIPELINE_GROUPS: ApplicationStatus[] = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'ACCEPTED',
  'WAITLISTED',
  'REJECTED',
  'ENROLLED',
];

export const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  ISSUED: 'Issued',
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  EXPIRED: 'Expired',
  WITHDRAWN: 'Withdrawn',
  CONDITIONS_NOT_MET: 'Conditions not met',
};

export const OFFER_STATUS_PILL: Record<OfferStatus, string> = {
  ISSUED: 'bg-sky-100 text-sky-800',
  ACCEPTED: 'bg-emerald-100 text-emerald-800',
  DECLINED: 'bg-rose-100 text-rose-800',
  EXPIRED: 'bg-gray-200 text-gray-700',
  WITHDRAWN: 'bg-gray-200 text-gray-700',
  CONDITIONS_NOT_MET: 'bg-amber-100 text-amber-800',
};

export const WAITLIST_STATUS_LABELS: Record<WaitlistStatus, string> = {
  ACTIVE: 'Active',
  OFFERED: 'Offered',
  ENROLLED: 'Enrolled',
  EXPIRED: 'Expired',
  WITHDRAWN: 'Withdrawn',
};

export const WAITLIST_STATUS_PILL: Record<WaitlistStatus, string> = {
  ACTIVE: 'bg-violet-100 text-violet-800',
  OFFERED: 'bg-sky-100 text-sky-800',
  ENROLLED: 'bg-campus-100 text-campus-800',
  EXPIRED: 'bg-gray-200 text-gray-700',
  WITHDRAWN: 'bg-gray-200 text-gray-700',
};

export const NOTE_TYPE_LABELS: Record<string, string> = {
  INTERVIEW_NOTES: 'Interview',
  ASSESSMENT_RESULT: 'Assessment',
  STAFF_OBSERVATION: 'Observation',
  REFERENCE_CHECK: 'Reference check',
  VISIT_NOTES: 'Campus visit',
  GENERAL: 'General',
};

export function formatStudentName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim();
}

export function formatDateOnly(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function formatRelativeDeadline(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return `expired ${formatDateOnly(iso)}`;
  const days = Math.ceil(ms / 86_400_000);
  if (days === 1) return 'in 1 day';
  if (days < 7) return `in ${days} days`;
  if (days < 30) return `in ${Math.floor(days / 7)} week${Math.floor(days / 7) === 1 ? '' : 's'}`;
  return `on ${formatDateOnly(iso)}`;
}
