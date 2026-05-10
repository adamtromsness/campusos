import type {
  AvailabilityType,
  NotificationResponse,
  NotificationTier,
  PoolStatus,
  PreferenceType,
  SubAssignmentStatus,
  SubCancelConsequence,
  SubJobStatus,
  SubJobType,
  SubRateType,
  SubRaterType,
  SubVerificationStatus,
} from './types';

// ── Pool ─────────────────────────────────────────────────────────────

export const POOL_STATUS_LABEL: Record<PoolStatus, string> = {
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  REMOVED: 'Removed',
};
export const POOL_STATUS_PILL: Record<PoolStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  SUSPENDED: 'bg-amber-100 text-amber-700',
  REMOVED: 'bg-gray-100 text-gray-700',
};

// ── Job ──────────────────────────────────────────────────────────────

export const JOB_STATUS_LABEL: Record<SubJobStatus, string> = {
  OPEN: 'Open',
  FILLED: 'Filled',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  UNFILLED: 'Unfilled',
};
export const JOB_STATUS_PILL: Record<SubJobStatus, string> = {
  OPEN: 'bg-amber-100 text-amber-700',
  FILLED: 'bg-emerald-100 text-emerald-700',
  CANCELLED: 'bg-gray-100 text-gray-700',
  EXPIRED: 'bg-rose-100 text-rose-700',
  UNFILLED: 'bg-rose-100 text-rose-700',
};
export const JOB_TYPE_LABEL: Record<SubJobType, string> = {
  FULL_DAY: 'Full day',
  HALF_DAY: 'Half day',
  SPECIFIC_PERIODS: 'Specific periods',
};

export const NOTIFICATION_TIER_LABEL: Record<NotificationTier, string> = {
  POOL: 'Pool',
  MARKETPLACE: 'Marketplace',
};

export const NOTIFICATION_RESPONSE_LABEL: Record<NotificationResponse, string> = {
  PENDING: 'Pending',
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  EXPIRED: 'Expired',
};
export const NOTIFICATION_RESPONSE_PILL: Record<NotificationResponse, string> = {
  PENDING: 'bg-sky-100 text-sky-700',
  ACCEPTED: 'bg-emerald-100 text-emerald-700',
  DECLINED: 'bg-gray-100 text-gray-700',
  EXPIRED: 'bg-rose-100 text-rose-700',
};

// ── Assignment ───────────────────────────────────────────────────────

export const ASSIGNMENT_STATUS_LABEL: Record<SubAssignmentStatus, string> = {
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked in',
  CHECKED_OUT: 'Checked out',
  NO_SHOW: 'No show',
  CANCELLED: 'Cancelled',
};
export const ASSIGNMENT_STATUS_PILL: Record<SubAssignmentStatus, string> = {
  CONFIRMED: 'bg-sky-100 text-sky-700',
  CHECKED_IN: 'bg-amber-100 text-amber-700',
  CHECKED_OUT: 'bg-emerald-100 text-emerald-700',
  NO_SHOW: 'bg-rose-100 text-rose-700',
  CANCELLED: 'bg-gray-100 text-gray-700',
};

export const RATER_TYPE_LABEL: Record<SubRaterType, string> = {
  SCHOOL_RATES_SUB: 'School → Substitute',
  SUB_RATES_SCHOOL: 'Substitute → School',
};

// ── Credentials + Availability + Preferences ─────────────────────────

export const VERIFICATION_LABEL: Record<SubVerificationStatus, string> = {
  PENDING: 'Pending verification',
  VERIFIED: 'Verified',
  EXPIRED: 'Expired',
};
export const VERIFICATION_PILL: Record<SubVerificationStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-700',
  VERIFIED: 'bg-emerald-100 text-emerald-700',
  EXPIRED: 'bg-rose-100 text-rose-700',
};

export const AVAILABILITY_TYPE_LABEL: Record<AvailabilityType, string> = {
  RECURRING: 'Recurring',
  SPECIFIC: 'Specific date',
  BLOCKED: 'Blocked',
};
export const AVAILABILITY_TYPE_PILL: Record<AvailabilityType, string> = {
  RECURRING: 'bg-emerald-100 text-emerald-700',
  SPECIFIC: 'bg-sky-100 text-sky-700',
  BLOCKED: 'bg-rose-100 text-rose-700',
};

export const PREFERENCE_TYPE_LABEL: Record<PreferenceType, string> = {
  PREFERRED: 'Preferred',
  BLOCKED: 'Blocked',
};
export const PREFERENCE_TYPE_PILL: Record<PreferenceType, string> = {
  PREFERRED: 'bg-emerald-100 text-emerald-700',
  BLOCKED: 'bg-rose-100 text-rose-700',
};

export const DAY_OF_WEEK_LABEL: Record<number, string> = {
  0: 'Sun',
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
};

// ── Pay Rates + Cancellation Policy ──────────────────────────────────

export const RATE_TYPE_LABEL: Record<SubRateType, string> = {
  HOURLY: 'Hourly',
  DAILY: 'Daily',
  HALF_DAY: 'Half day',
};

export const CANCEL_CONSEQUENCE_LABEL: Record<SubCancelConsequence, string> = {
  WARNING_ONLY: 'Warning only',
  TEMPORARY_POOL_SUSPENSION: 'Temporary pool suspension',
  PERMANENT_POOL_REMOVAL: 'Permanent pool removal',
  RATING_PENALTY: 'Rating penalty',
};

// ── Helpers ──────────────────────────────────────────────────────────

export const SCHOOL_DEFAULT_SUB_ID = '00000000-0000-0000-0000-000000000000';

export function isSchoolDefaultRate(substituteId: string): boolean {
  return substituteId === SCHOOL_DEFAULT_SUB_ID;
}

export function formatRating(rating: string | null): string {
  if (!rating) return '—';
  return `${parseFloat(rating).toFixed(1)} / 5.0`;
}

export function formatRate(rate: string, rateType: SubRateType): string {
  const amount = parseFloat(rate).toFixed(2);
  const suffix = rateType === 'HOURLY' ? '/hr' : rateType === 'HALF_DAY' ? '/half-day' : '/day';
  return `$${amount}${suffix}`;
}

export function formatTimeRange(start: string | null, end: string | null): string {
  if (!start || !end) return 'All day';
  return `${start.slice(0, 5)} – ${end.slice(0, 5)}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeWindow(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} min left`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h left`;
  return `${Math.floor(hrs / 24)}d left`;
}

export function isJobLive(status: SubJobStatus): boolean {
  return status === 'OPEN' || status === 'FILLED';
}
