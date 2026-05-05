import type {
  CareAuthorRole as _CareAuthorRole,
  CaseloadStatus,
  InterventionStatus as _InterventionStatus,
  InterventionType as _InterventionType,
  MeetingOutcome as _MeetingOutcome,
  MtssDomain as _MtssDomain,
  MtssTier as _MtssTier,
  MtssTierStatus as _MtssTierStatus,
  PrimaryConcern,
  ReferralActivityType,
  ReferralPriority,
  ReferralStatus,
  ReportStatus as _ReportStatus,
  ReportType as _ReportType,
  SessionAttendanceStatus,
  SessionStatus,
  SessionType,
} from './types';

// ─── Const arrays (UI-driven order) ───────────────────────────

export const PRIMARY_CONCERNS: PrimaryConcern[] = [
  'ACADEMIC',
  'BEHAVIORAL',
  'SOCIAL_EMOTIONAL',
  'ATTENDANCE',
  'CRISIS',
  'TRANSITION',
  'GENERAL',
];

export const CASELOAD_STATUSES: CaseloadStatus[] = ['ACTIVE', 'CLOSED', 'TRANSFERRED'];

export const REFERRAL_PRIORITIES: ReferralPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

export const REFERRAL_STATUSES: ReferralStatus[] = [
  'SUBMITTED',
  'TRIAGED',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'DECLINED',
  'CANCELLED',
];

export const SESSION_TYPES: SessionType[] = [
  'INDIVIDUAL',
  'GROUP',
  'CRISIS',
  'CHECK_IN',
  'PARENT_MEETING',
  'CONSULTATION',
];

export const SESSION_STATUSES: SessionStatus[] = ['SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'];

export const ATTENDANCE_STATUSES: SessionAttendanceStatus[] = ['ATTENDED', 'NO_SHOW', 'LATE'];

// ─── Labels ───────────────────────────────────────────────────

export const PRIMARY_CONCERN_LABELS: Record<PrimaryConcern, string> = {
  ACADEMIC: 'Academic',
  BEHAVIORAL: 'Behavioural',
  SOCIAL_EMOTIONAL: 'Social / Emotional',
  ATTENDANCE: 'Attendance',
  CRISIS: 'Crisis',
  TRANSITION: 'Transition',
  GENERAL: 'General',
};

export const CASELOAD_STATUS_LABELS: Record<CaseloadStatus, string> = {
  ACTIVE: 'Active',
  CLOSED: 'Closed',
  TRANSFERRED: 'Transferred',
};

export const REFERRAL_PRIORITY_LABELS: Record<ReferralPriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

export const REFERRAL_STATUS_LABELS: Record<ReferralStatus, string> = {
  SUBMITTED: 'Submitted',
  TRIAGED: 'Triaged',
  ACCEPTED: 'Accepted',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  DECLINED: 'Declined',
  CANCELLED: 'Cancelled',
};

export const REFERRAL_ACTIVITY_LABELS: Record<ReferralActivityType, string> = {
  STATUS_CHANGE: 'Status change',
  ASSIGNMENT_CHANGE: 'Assignment',
  NOTE_ADDED: 'Note',
  PARENT_NOTIFIED: 'Parent notified',
  ESCALATED: 'Escalated',
  EXTERNAL_CONTACT_MADE: 'External contact',
};

export const SESSION_TYPE_LABELS: Record<SessionType, string> = {
  INDIVIDUAL: 'Individual',
  GROUP: 'Group',
  CRISIS: 'Crisis',
  CHECK_IN: 'Check-in',
  PARENT_MEETING: 'Parent meeting',
  CONSULTATION: 'Consultation',
};

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  SCHEDULED: 'Scheduled',
  COMPLETED: 'Completed',
  NO_SHOW: 'No-show',
  CANCELLED: 'Cancelled',
};

export const ATTENDANCE_STATUS_LABELS: Record<SessionAttendanceStatus, string> = {
  ATTENDED: 'Attended',
  NO_SHOW: 'No-show',
  LATE: 'Late',
};

// ─── Pill class maps ──────────────────────────────────────────

export const PRIMARY_CONCERN_PILL: Record<PrimaryConcern, string> = {
  ACADEMIC: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  BEHAVIORAL: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  SOCIAL_EMOTIONAL: 'bg-violet-100 text-violet-700 ring-1 ring-violet-200',
  ATTENDANCE: 'bg-orange-100 text-orange-700 ring-1 ring-orange-200',
  CRISIS: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
  TRANSITION: 'bg-teal-100 text-teal-700 ring-1 ring-teal-200',
  GENERAL: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
};

export const CASELOAD_STATUS_PILL: Record<CaseloadStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  CLOSED: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  TRANSFERRED: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
};

/**
 * Referral priority pills follow the warming-tone progression used
 * across Cycle 8 ticket priority + Cycle 9 incident severity.
 */
export const REFERRAL_PRIORITY_PILL: Record<ReferralPriority, string> = {
  LOW: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  MEDIUM: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  HIGH: 'bg-orange-100 text-orange-700 ring-1 ring-orange-200',
  URGENT: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
};

export const REFERRAL_STATUS_PILL: Record<ReferralStatus, string> = {
  SUBMITTED: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  TRIAGED: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  ACCEPTED: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200',
  IN_PROGRESS: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
  COMPLETED: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  DECLINED: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  CANCELLED: 'bg-gray-100 text-gray-500 ring-1 ring-gray-200',
};

export const SESSION_TYPE_PILL: Record<SessionType, string> = {
  INDIVIDUAL: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  GROUP: 'bg-violet-100 text-violet-700 ring-1 ring-violet-200',
  CRISIS: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
  CHECK_IN: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  PARENT_MEETING: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  CONSULTATION: 'bg-teal-100 text-teal-700 ring-1 ring-teal-200',
};

export const SESSION_STATUS_PILL: Record<SessionStatus, string> = {
  SCHEDULED: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  COMPLETED: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  NO_SHOW: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  CANCELLED: 'bg-gray-100 text-gray-500 ring-1 ring-gray-200',
};

export const ATTENDANCE_STATUS_PILL: Record<SessionAttendanceStatus, string> = {
  ATTENDED: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  NO_SHOW: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
  LATE: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
};

// ─── Helpers ──────────────────────────────────────────────────

export function studentDisplay(first: string | null, last: string | null): string {
  if (!first && !last) return 'Unknown student';
  return [first, last].filter(Boolean).join(' ');
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function priorityRank(p: ReferralPriority): number {
  switch (p) {
    case 'URGENT':
      return 0;
    case 'HIGH':
      return 1;
    case 'MEDIUM':
      return 2;
    default:
      return 3;
  }
}

/**
 * Triage queue = SUBMITTED + TRIAGED rows; counsellors work this list
 * top-down by priority then by oldest-first (older referrals waiting
 * the longest).
 */
export function isTriageWorthy(s: ReferralStatus): boolean {
  return s === 'SUBMITTED' || s === 'TRIAGED';
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

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return diffMin + ' min ago';
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return diffH + 'h ago';
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) return diffD + 'd ago';
  if (diffD < 60) return Math.round(diffD / 7) + 'w ago';
  return Math.round(diffD / 30) + 'mo ago';
}

// ─── Step 7 — MTSS / Care / Reporting ─────────────────────────

export const MTSS_TIERS: _MtssTier[] = ['TIER_1', 'TIER_2', 'TIER_3'];

export const MTSS_DOMAINS: _MtssDomain[] = [
  'ACADEMIC',
  'BEHAVIORAL',
  'SOCIAL_EMOTIONAL',
  'ATTENDANCE',
];

export const MTSS_TIER_STATUSES: _MtssTierStatus[] = ['ACTIVE', 'EXITED', 'PROMOTED', 'DEMOTED'];

export const INTERVENTION_TYPES: _InterventionType[] = [
  'ACADEMIC_SUPPORT',
  'BEHAVIORAL_SUPPORT',
  'SOCIAL_EMOTIONAL_LEARNING',
  'ATTENDANCE_SUPPORT',
  'COUNSELING',
  'EXTERNAL_SERVICE',
];

export const INTERVENTION_STATUSES: _InterventionStatus[] = ['ACTIVE', 'COMPLETED', 'DISCONTINUED'];

export const MEETING_OUTCOMES: _MeetingOutcome[] = [
  'NO_CHANGE',
  'TIER_UP',
  'TIER_DOWN',
  'EXIT',
  'CONTINUE_WITH_ADJUSTMENT',
];

export const CARE_AUTHOR_ROLES: _CareAuthorRole[] = ['NURSE', 'COUNSELLOR'];

export const REPORT_TYPES: _ReportType[] = [
  'SUSPECTED_ABUSE',
  'SUSPECTED_NEGLECT',
  'IMMINENT_DANGER',
  'OTHER',
];

export const REPORT_STATUSES: _ReportStatus[] = [
  'FILED',
  'CPS_CONTACTED',
  'INVESTIGATION_ACTIVE',
  'CLOSED',
];

// Labels

export const MTSS_TIER_LABELS: Record<_MtssTier, string> = {
  TIER_1: 'Tier 1',
  TIER_2: 'Tier 2',
  TIER_3: 'Tier 3',
};

export const MTSS_DOMAIN_LABELS: Record<_MtssDomain, string> = {
  ACADEMIC: 'Academic',
  BEHAVIORAL: 'Behavioural',
  SOCIAL_EMOTIONAL: 'Social / Emotional',
  ATTENDANCE: 'Attendance',
};

export const MTSS_TIER_STATUS_LABELS: Record<_MtssTierStatus, string> = {
  ACTIVE: 'Active',
  EXITED: 'Exited',
  PROMOTED: 'Promoted',
  DEMOTED: 'Demoted',
};

export const INTERVENTION_TYPE_LABELS: Record<_InterventionType, string> = {
  ACADEMIC_SUPPORT: 'Academic support',
  BEHAVIORAL_SUPPORT: 'Behavioural support',
  SOCIAL_EMOTIONAL_LEARNING: 'SEL',
  ATTENDANCE_SUPPORT: 'Attendance support',
  COUNSELING: 'Counselling',
  EXTERNAL_SERVICE: 'External service',
};

export const INTERVENTION_STATUS_LABELS: Record<_InterventionStatus, string> = {
  ACTIVE: 'Active',
  COMPLETED: 'Completed',
  DISCONTINUED: 'Discontinued',
};

export const MEETING_OUTCOME_LABELS: Record<_MeetingOutcome, string> = {
  NO_CHANGE: 'No change',
  TIER_UP: 'Tier up',
  TIER_DOWN: 'Tier down',
  EXIT: 'Exit',
  CONTINUE_WITH_ADJUSTMENT: 'Continue with adjustment',
};

export const CARE_AUTHOR_ROLE_LABELS: Record<_CareAuthorRole, string> = {
  NURSE: 'Nurse',
  COUNSELLOR: 'Counsellor',
};

export const REPORT_TYPE_LABELS: Record<_ReportType, string> = {
  SUSPECTED_ABUSE: 'Suspected abuse',
  SUSPECTED_NEGLECT: 'Suspected neglect',
  IMMINENT_DANGER: 'Imminent danger',
  OTHER: 'Other',
};

export const REPORT_STATUS_LABELS: Record<_ReportStatus, string> = {
  FILED: 'Filed',
  CPS_CONTACTED: 'CPS contacted',
  INVESTIGATION_ACTIVE: 'Investigation active',
  CLOSED: 'Closed',
};

// Pill class maps

/**
 * Tier pills follow the warming-tone progression — TIER_1 is universal
 * support (green), TIER_2 is targeted (amber), TIER_3 is intensive
 * (rose). Echoes Cycle 8 ticket priority + Cycle 9 incident severity.
 */
export const MTSS_TIER_PILL: Record<_MtssTier, string> = {
  TIER_1: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  TIER_2: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  TIER_3: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
};

export const MTSS_DOMAIN_PILL: Record<_MtssDomain, string> = {
  ACADEMIC: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  BEHAVIORAL: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  SOCIAL_EMOTIONAL: 'bg-violet-100 text-violet-700 ring-1 ring-violet-200',
  ATTENDANCE: 'bg-orange-100 text-orange-700 ring-1 ring-orange-200',
};

export const MTSS_TIER_STATUS_PILL: Record<_MtssTierStatus, string> = {
  ACTIVE: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  EXITED: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  PROMOTED: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  DEMOTED: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
};

export const INTERVENTION_TYPE_PILL: Record<_InterventionType, string> = {
  ACADEMIC_SUPPORT: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  BEHAVIORAL_SUPPORT: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  SOCIAL_EMOTIONAL_LEARNING: 'bg-violet-100 text-violet-700 ring-1 ring-violet-200',
  ATTENDANCE_SUPPORT: 'bg-orange-100 text-orange-700 ring-1 ring-orange-200',
  COUNSELING: 'bg-teal-100 text-teal-700 ring-1 ring-teal-200',
  EXTERNAL_SERVICE: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
};

export const INTERVENTION_STATUS_PILL: Record<_InterventionStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  COMPLETED: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  DISCONTINUED: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
};

export const MEETING_OUTCOME_PILL: Record<_MeetingOutcome, string> = {
  NO_CHANGE: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  TIER_UP: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  TIER_DOWN: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  EXIT: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  CONTINUE_WITH_ADJUSTMENT: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
};

/**
 * Coordinated care role pills — teal NURSE / indigo COUNSELLOR per
 * the plan §09. Quick visual scan for who wrote what in the thread.
 */
export const CARE_AUTHOR_ROLE_PILL: Record<_CareAuthorRole, string> = {
  NURSE: 'bg-teal-100 text-teal-700 ring-1 ring-teal-200',
  COUNSELLOR: 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-200',
};

export const REPORT_TYPE_PILL: Record<_ReportType, string> = {
  SUSPECTED_ABUSE: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
  SUSPECTED_NEGLECT: 'bg-orange-100 text-orange-700 ring-1 ring-orange-200',
  IMMINENT_DANGER: 'bg-rose-200 text-rose-900 ring-1 ring-rose-300',
  OTHER: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
};

export const REPORT_STATUS_PILL: Record<_ReportStatus, string> = {
  FILED: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  CPS_CONTACTED: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  INVESTIGATION_ACTIVE: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
  CLOSED: 'bg-gray-100 text-gray-500 ring-1 ring-gray-200',
};
