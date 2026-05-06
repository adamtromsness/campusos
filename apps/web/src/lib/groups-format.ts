import type {
  GroupEventType,
  GroupMemberRole,
  GroupMemberStatus,
  GroupRsvpStatus,
  GroupScopeType,
  GroupStatus,
  GroupTransferStatus,
  JoinPolicy,
} from './types';

export const SCOPE_LABEL: Record<GroupScopeType, string> = {
  CLASS: 'Class',
  YEAR_GROUP: 'Year group',
  SCHOOL: 'School-wide',
  CUSTOM: 'Custom',
  ACTIVITY: 'Activity',
};

export const SCOPE_PILL: Record<GroupScopeType, string> = {
  CLASS: 'bg-sky-100 text-sky-700',
  YEAR_GROUP: 'bg-violet-100 text-violet-700',
  SCHOOL: 'bg-emerald-100 text-emerald-700',
  CUSTOM: 'bg-amber-100 text-amber-700',
  ACTIVITY: 'bg-rose-100 text-rose-700',
};

export const STATUS_LABEL: Record<GroupStatus, string> = {
  ACTIVE: 'Active',
  ARCHIVED: 'Archived',
  DISSOLVED: 'Dissolved',
};

export const STATUS_PILL: Record<GroupStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  ARCHIVED: 'bg-gray-100 text-gray-700',
  DISSOLVED: 'bg-rose-100 text-rose-700',
};

export const POLICY_LABEL: Record<JoinPolicy, string> = {
  OPEN: 'Open',
  APPROVAL_REQUIRED: 'Approval required',
  INVITE_ONLY: 'Invite only',
};

export const POLICY_PILL: Record<JoinPolicy, string> = {
  OPEN: 'bg-emerald-100 text-emerald-700',
  APPROVAL_REQUIRED: 'bg-amber-100 text-amber-700',
  INVITE_ONLY: 'bg-violet-100 text-violet-700',
};

export const ROLE_LABEL: Record<GroupMemberRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
};

export const ROLE_PILL: Record<GroupMemberRole, string> = {
  OWNER: 'bg-violet-100 text-violet-700',
  ADMIN: 'bg-sky-100 text-sky-700',
  MEMBER: 'bg-gray-100 text-gray-700',
};

export const MEMBER_STATUS_LABEL: Record<GroupMemberStatus, string> = {
  ACTIVE: 'Active',
  INVITED: 'Invited',
  PENDING_APPROVAL: 'Pending approval',
  SUSPENDED: 'Suspended',
  LEFT: 'Left',
  REMOVED: 'Removed',
};

export const MEMBER_STATUS_PILL: Record<GroupMemberStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  INVITED: 'bg-sky-100 text-sky-700',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-700',
  SUSPENDED: 'bg-orange-100 text-orange-700',
  LEFT: 'bg-gray-100 text-gray-700',
  REMOVED: 'bg-rose-100 text-rose-700',
};

export const TRANSFER_STATUS_LABEL: Record<GroupTransferStatus, string> = {
  PENDING: 'Pending',
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
};

export const TRANSFER_STATUS_PILL: Record<GroupTransferStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-700',
  ACCEPTED: 'bg-emerald-100 text-emerald-700',
  DECLINED: 'bg-rose-100 text-rose-700',
  EXPIRED: 'bg-gray-100 text-gray-700',
  CANCELLED: 'bg-gray-100 text-gray-700',
};

export const EVENT_TYPES: GroupEventType[] = [
  'PRACTICE',
  'MATCH',
  'MEETING',
  'SOCIAL',
  'PERFORMANCE',
  'COMPETITION',
  'OTHER',
];

export const EVENT_TYPE_LABEL: Record<GroupEventType, string> = {
  PRACTICE: 'Practice',
  MATCH: 'Match',
  MEETING: 'Meeting',
  SOCIAL: 'Social',
  PERFORMANCE: 'Performance',
  COMPETITION: 'Competition',
  OTHER: 'Other',
};

export const EVENT_TYPE_PILL: Record<GroupEventType, string> = {
  PRACTICE: 'bg-sky-100 text-sky-700',
  MATCH: 'bg-orange-100 text-orange-700',
  MEETING: 'bg-gray-100 text-gray-700',
  SOCIAL: 'bg-emerald-100 text-emerald-700',
  PERFORMANCE: 'bg-violet-100 text-violet-700',
  COMPETITION: 'bg-rose-100 text-rose-700',
  OTHER: 'bg-gray-100 text-gray-700',
};

export const RSVP_LABEL: Record<GroupRsvpStatus, string> = {
  GOING: 'Going',
  NOT_GOING: 'Not going',
  MAYBE: 'Maybe',
};

export const RSVP_PILL: Record<GroupRsvpStatus, string> = {
  GOING: 'bg-emerald-100 text-emerald-700',
  NOT_GOING: 'bg-rose-100 text-rose-700',
  MAYBE: 'bg-amber-100 text-amber-700',
};

export function formatRelativeDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  const now = Date.now();
  const ms = t - now;
  const abs = Math.abs(ms);
  const day = 86_400_000;
  if (abs < day) {
    const hours = Math.round(abs / 3_600_000);
    return ms >= 0 ? `in ${hours}h` : `${hours}h ago`;
  }
  const days = Math.round(abs / day);
  if (days < 60) return ms >= 0 ? `in ${days}d` : `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
