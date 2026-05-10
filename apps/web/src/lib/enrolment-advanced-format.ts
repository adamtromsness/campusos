import type {
  BookingStatus,
  GuestType,
  MidYearReason,
  MidYearStatus,
  ExitTaskCategory,
  ExitTaskStatus,
  TourType,
  WithdrawalReason,
  WithdrawalStatus,
} from './types';

export const TOUR_TYPE_LABEL: Record<TourType, string> = {
  GENERAL_OPEN_DAY: 'Open Day',
  INDIVIDUAL_FAMILY_TOUR: 'Family tour',
  VIRTUAL_TOUR: 'Virtual tour',
  SPECIALIST_TOUR: 'Specialist tour',
};

export const TOUR_TYPES: TourType[] = [
  'GENERAL_OPEN_DAY',
  'INDIVIDUAL_FAMILY_TOUR',
  'VIRTUAL_TOUR',
  'SPECIALIST_TOUR',
];

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  CONFIRMED: 'Confirmed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
  COMPLETED: 'Completed',
};

export const BOOKING_STATUS_PILL: Record<BookingStatus, string> = {
  CONFIRMED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-rose-100 text-rose-800',
  NO_SHOW: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-slate-100 text-slate-700',
};

export const GUEST_TYPE_LABEL: Record<GuestType, string> = {
  ADULT: 'Adult',
  CHILD: 'Child',
  PROSPECTIVE_STUDENT: 'Prospective student',
};

export const WITHDRAWAL_REASON_LABEL: Record<WithdrawalReason, string> = {
  FAMILY_RELOCATION: 'Family relocation',
  TRANSFER_TO_OTHER_SCHOOL: 'Transfer to other school',
  HOME_EDUCATION: 'Home education',
  EXCLUSION: 'Exclusion',
  MEDICAL: 'Medical',
  FEE_DEFAULT: 'Fee default',
  SAFEGUARDING: 'Safeguarding',
  GRADUATION: 'Graduation',
  DECEASED: 'Deceased',
  OTHER: 'Other',
};

export const WITHDRAWAL_REASONS: WithdrawalReason[] = [
  'FAMILY_RELOCATION',
  'TRANSFER_TO_OTHER_SCHOOL',
  'HOME_EDUCATION',
  'EXCLUSION',
  'MEDICAL',
  'FEE_DEFAULT',
  'SAFEGUARDING',
  'GRADUATION',
  'DECEASED',
  'OTHER',
];

export const WITHDRAWAL_STATUS_LABEL: Record<WithdrawalStatus, string> = {
  REQUESTED: 'Requested',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const WITHDRAWAL_STATUS_PILL: Record<WithdrawalStatus, string> = {
  REQUESTED: 'bg-sky-100 text-sky-800',
  IN_PROGRESS: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-slate-100 text-slate-700',
};

export const TASK_CATEGORY_LABEL: Record<ExitTaskCategory, string> = {
  ADMINISTRATIVE: 'Administrative',
  FINANCE: 'Finance',
  IT: 'IT',
  FACILITIES: 'Facilities',
  TRANSPORT: 'Transport',
  RECORDS: 'Records',
};

export const TASK_CATEGORIES: ExitTaskCategory[] = [
  'ADMINISTRATIVE',
  'FINANCE',
  'IT',
  'FACILITIES',
  'TRANSPORT',
  'RECORDS',
];

export const TASK_STATUS_LABEL: Record<ExitTaskStatus, string> = {
  PENDING: 'Pending',
  COMPLETED: 'Completed',
  WAIVED: 'Waived',
  NOT_APPLICABLE: 'Not applicable',
};

export const TASK_STATUS_PILL: Record<ExitTaskStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  WAIVED: 'bg-slate-100 text-slate-700',
  NOT_APPLICABLE: 'bg-slate-100 text-slate-500',
};

export const MID_YEAR_REASON_LABEL: Record<MidYearReason, string> = {
  FAMILY_RELOCATION: 'Family relocation',
  TRANSFER_FROM_OTHER_SCHOOL: 'Transfer from other school',
  RETURNING_FROM_ABROAD: 'Returning from abroad',
  HOME_EDUCATION_ENDING: 'Home education ending',
  LOOKED_AFTER_CHILD: 'Looked-after child',
  OTHER: 'Other',
};

export const MID_YEAR_REASONS: MidYearReason[] = [
  'FAMILY_RELOCATION',
  'TRANSFER_FROM_OTHER_SCHOOL',
  'RETURNING_FROM_ABROAD',
  'HOME_EDUCATION_ENDING',
  'LOOKED_AFTER_CHILD',
  'OTHER',
];

export const MID_YEAR_STATUS_LABEL: Record<MidYearStatus, string> = {
  RECEIVED: 'Received',
  CAPACITY_CHECKED: 'Capacity checked',
  OFFER_MADE: 'Offer made',
  ENROLLED: 'Enrolled',
  DECLINED: 'Declined',
  WITHDRAWN: 'Withdrawn',
};

export const MID_YEAR_STATUS_PILL: Record<MidYearStatus, string> = {
  RECEIVED: 'bg-sky-100 text-sky-800',
  CAPACITY_CHECKED: 'bg-amber-100 text-amber-800',
  OFFER_MADE: 'bg-violet-100 text-violet-800',
  ENROLLED: 'bg-emerald-100 text-emerald-800',
  DECLINED: 'bg-rose-100 text-rose-800',
  WITHDRAWN: 'bg-slate-100 text-slate-700',
};

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const trimmed = iso.length >= 10 ? iso.slice(0, 10) : iso;
  return trimmed;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function formatTime(t: string | null | undefined): string {
  if (!t) return '—';
  return t.length > 5 ? t.slice(0, 5) : t;
}

export function studentName(
  first: string | null | undefined,
  last: string | null | undefined,
): string {
  if (!first && !last) return '—';
  return [first, last].filter(Boolean).join(' ');
}
