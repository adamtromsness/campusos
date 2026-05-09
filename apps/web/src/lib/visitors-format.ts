import type {
  BanType,
  DrillType,
  MusterEntryStatus,
  SafeguardingStatus,
  ScheduleDay,
  VisitorBadgeColor,
} from './types';

export const BADGE_COLORS: VisitorBadgeColor[] = [
  'blue',
  'green',
  'amber',
  'rose',
  'purple',
  'gray',
];

export const BADGE_COLOR_PILL: Record<VisitorBadgeColor, string> = {
  blue: 'bg-sky-100 text-sky-800 ring-1 ring-sky-200',
  green: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200',
  amber: 'bg-amber-100 text-amber-800 ring-1 ring-amber-200',
  rose: 'bg-rose-100 text-rose-800 ring-1 ring-rose-200',
  purple: 'bg-violet-100 text-violet-800 ring-1 ring-violet-200',
  gray: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
};

export const SAFEGUARDING_STATUS_LABEL: Record<SafeguardingStatus, string> = {
  PASSED: 'Passed',
  FLAGGED: 'Flagged',
  BYPASSED_BY_ADMIN: 'Admin bypass',
  NOT_REQUIRED: 'Not required',
};

export const SAFEGUARDING_STATUS_PILL: Record<SafeguardingStatus, string> = {
  PASSED: 'bg-emerald-100 text-emerald-800',
  FLAGGED: 'bg-amber-100 text-amber-800',
  BYPASSED_BY_ADMIN: 'bg-violet-100 text-violet-800',
  NOT_REQUIRED: 'bg-gray-100 text-gray-700',
};

export const BAN_TYPES: BanType[] = [
  'COURT_ORDER',
  'SCHOOL_DECISION',
  'SAFEGUARDING',
  'RESTRAINING_ORDER',
  'OTHER',
];

export const BAN_TYPE_LABEL: Record<BanType, string> = {
  COURT_ORDER: 'Court order',
  SCHOOL_DECISION: 'School decision',
  SAFEGUARDING: 'Safeguarding',
  RESTRAINING_ORDER: 'Restraining order',
  OTHER: 'Other',
};

export const DRILL_TYPES: DrillType[] = [
  'FIRE_DRILL',
  'LOCKDOWN',
  'EVACUATION',
  'BOMB_THREAT',
  'WEATHER',
  'OTHER',
];

export const DRILL_TYPE_LABEL: Record<DrillType, string> = {
  FIRE_DRILL: 'Fire drill',
  LOCKDOWN: 'Lockdown',
  EVACUATION: 'Evacuation',
  BOMB_THREAT: 'Bomb threat',
  WEATHER: 'Weather',
  OTHER: 'Other',
};

export const MUSTER_ENTRY_STATUSES: MusterEntryStatus[] = [
  'UNKNOWN',
  'ACCOUNTED_FOR',
  'EVACUATED',
  'ASSISTANCE_NEEDED',
];

export const MUSTER_ENTRY_STATUS_LABEL: Record<MusterEntryStatus, string> = {
  UNKNOWN: 'Unknown',
  ACCOUNTED_FOR: 'Accounted for',
  EVACUATED: 'Evacuated',
  ASSISTANCE_NEEDED: 'Assistance needed',
};

export const MUSTER_ENTRY_STATUS_PILL: Record<MusterEntryStatus, string> = {
  UNKNOWN: 'bg-rose-100 text-rose-800',
  ACCOUNTED_FOR: 'bg-emerald-100 text-emerald-800',
  EVACUATED: 'bg-sky-100 text-sky-800',
  ASSISTANCE_NEEDED: 'bg-amber-100 text-amber-800',
};

export const SCHEDULE_DAYS: ScheduleDay[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  );
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  const now = Date.now();
  const diff = now - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const day = Math.floor(hr / 24);
  if (day < 30) return day + 'd ago';
  return formatDate(iso);
}
