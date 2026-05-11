// Events & Ticketing (Phase 2 Cycle 12) — formatting helpers.
import type {
  EvtCompType,
  EvtEventStatus,
  EvtEventType,
  EvtOrderStatus,
  EvtPassStatus,
  EvtScanResult,
  EvtTicketStatus,
  EvtVolunteerStatus,
} from './types';

export const EVT_EVENT_TYPES: readonly EvtEventType[] = [
  'ATHLETIC_GAME',
  'PERFORMANCE',
  'DANCE',
  'FUNDRAISER',
  'GRADUATION',
  'ASSEMBLY',
  'COMMUNITY',
  'OTHER',
];

export const EVT_EVENT_STATUSES: readonly EvtEventStatus[] = [
  'DRAFT',
  'ON_SALE',
  'SOLD_OUT',
  'COMPLETED',
  'CANCELLED',
];

export const EVT_ORDER_STATUSES: readonly EvtOrderStatus[] = [
  'PENDING',
  'CONFIRMED',
  'CANCELLED',
  'REFUNDED',
];

export const EVT_COMP_TYPES: readonly EvtCompType[] = [
  'ATHLETE',
  'COACH',
  'OFFICIAL',
  'MEDIA',
  'STAFF',
  'STUDENT',
  'VIP',
  'OTHER',
];

export const EVT_VOLUNTEER_STATUSES: readonly EvtVolunteerStatus[] = [
  'SIGNED_UP',
  'CONFIRMED',
  'CANCELLED',
];

export const EVT_EVENT_TYPE_LABELS: Record<EvtEventType, string> = {
  ATHLETIC_GAME: 'Athletic game',
  PERFORMANCE: 'Performance',
  DANCE: 'Dance',
  FUNDRAISER: 'Fundraiser',
  GRADUATION: 'Graduation',
  ASSEMBLY: 'Assembly',
  COMMUNITY: 'Community',
  OTHER: 'Other',
};

export const EVT_EVENT_STATUS_LABELS: Record<EvtEventStatus, string> = {
  DRAFT: 'Draft',
  ON_SALE: 'On sale',
  SOLD_OUT: 'Sold out',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const EVT_ORDER_STATUS_LABELS: Record<EvtOrderStatus, string> = {
  PENDING: 'Pending payment',
  CONFIRMED: 'Confirmed',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};

export const EVT_TICKET_STATUS_LABELS: Record<EvtTicketStatus, string> = {
  VALID: 'Valid',
  USED: 'Used',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};

export const EVT_SCAN_RESULT_LABELS: Record<EvtScanResult, string> = {
  VALID: 'Admit',
  ALREADY_SCANNED: 'Already scanned',
  INVALID: 'Invalid',
  EXPIRED: 'Expired',
};

export const EVT_PASS_STATUS_LABELS: Record<EvtPassStatus, string> = {
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  REVOKED: 'Revoked',
};

export const EVT_COMP_TYPE_LABELS: Record<EvtCompType, string> = {
  ATHLETE: 'Athlete',
  COACH: 'Coach',
  OFFICIAL: 'Official',
  MEDIA: 'Media',
  STAFF: 'Staff',
  STUDENT: 'Student',
  VIP: 'VIP',
  OTHER: 'Other',
};

export const EVT_VOLUNTEER_STATUS_LABELS: Record<EvtVolunteerStatus, string> = {
  SIGNED_UP: 'Signed up',
  CONFIRMED: 'Confirmed',
  CANCELLED: 'Cancelled',
};

export const EVT_EVENT_TYPE_PILL: Record<EvtEventType, string> = {
  ATHLETIC_GAME: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  PERFORMANCE: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
  DANCE: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  FUNDRAISER: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
  GRADUATION: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  ASSEMBLY: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200',
  COMMUNITY: 'bg-teal-50 text-teal-700 ring-1 ring-teal-200',
  OTHER: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
};

export const EVT_EVENT_STATUS_PILL: Record<EvtEventStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  ON_SALE: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  SOLD_OUT: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  COMPLETED: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200',
  CANCELLED: 'bg-gray-100 text-gray-600 ring-1 ring-gray-300 line-through',
};

export const EVT_ORDER_STATUS_PILL: Record<EvtOrderStatus, string> = {
  PENDING: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  CONFIRMED: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  CANCELLED: 'bg-gray-100 text-gray-600 ring-1 ring-gray-200',
  REFUNDED: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
};

export const EVT_TICKET_STATUS_PILL: Record<EvtTicketStatus, string> = {
  VALID: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  USED: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200',
  CANCELLED: 'bg-gray-100 text-gray-600 ring-1 ring-gray-200',
  REFUNDED: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
};

export const EVT_SCAN_RESULT_PILL: Record<EvtScanResult, string> = {
  VALID: 'bg-emerald-600 text-white',
  ALREADY_SCANNED: 'bg-amber-500 text-white',
  INVALID: 'bg-rose-600 text-white',
  EXPIRED: 'bg-gray-600 text-white',
};

export const EVT_PASS_STATUS_PILL: Record<EvtPassStatus, string> = {
  ACTIVE: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  EXPIRED: 'bg-gray-100 text-gray-600 ring-1 ring-gray-200',
  REVOKED: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
};

export const EVT_COMP_TYPE_PILL: Record<EvtCompType, string> = {
  ATHLETE: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  COACH: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
  OFFICIAL: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
  MEDIA: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  STAFF: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200',
  STUDENT: 'bg-teal-50 text-teal-700 ring-1 ring-teal-200',
  VIP: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  OTHER: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
};

export function formatCurrency(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatEventDate(date: string, time?: string | null): string {
  const d = new Date(`${date}T${time ?? '00:00'}`);
  if (Number.isNaN(d.getTime())) return date;
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  };
  return d.toLocaleDateString('en-US', opts);
}

export function formatEventTime(time: string | null): string {
  if (!time) return '';
  const [hh = '0', mm = '00'] = time.split(':');
  const h = Number(hh);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${mm} ${period}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function tierAvailabilityLabel(remaining: number, quantity: number): string {
  if (remaining <= 0) return 'Sold out';
  if (remaining <= Math.max(5, Math.floor(quantity * 0.1))) {
    return `Only ${remaining} left`;
  }
  return `${remaining} of ${quantity} remaining`;
}

export function tierAvailabilityTone(remaining: number, quantity: number): string {
  if (remaining <= 0) return 'text-rose-700';
  if (remaining <= Math.max(5, Math.floor(quantity * 0.1))) return 'text-amber-700';
  return 'text-emerald-700';
}
