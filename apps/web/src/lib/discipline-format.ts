import type {
  BehaviorPlanStatus,
  BehaviorPlanType,
  DisciplineIncidentDto,
  FeedbackEffectiveness,
  GoalProgress,
  IncidentStatus,
  Severity,
} from './types';

export const SEVERITIES: Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export const INCIDENT_STATUSES: IncidentStatus[] = ['OPEN', 'UNDER_REVIEW', 'RESOLVED'];

export const SEVERITY_LABELS: Record<Severity, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

/**
 * Severity pill colours: cool grey at LOW, amber at MEDIUM, orange at
 * HIGH, rose at CRITICAL — same warming-tone progression as Cycle 8
 * ticket priority pills (which sit beside this catalogue in the staff
 * UI when admins triage cross-cycle).
 */
export const SEVERITY_PILL: Record<Severity, string> = {
  LOW: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  MEDIUM: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  HIGH: 'bg-orange-100 text-orange-700 ring-1 ring-orange-200',
  CRITICAL: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
};

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  OPEN: 'Open',
  UNDER_REVIEW: 'Under review',
  RESOLVED: 'Resolved',
};

export const INCIDENT_STATUS_PILL: Record<IncidentStatus, string> = {
  OPEN: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  UNDER_REVIEW: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  RESOLVED: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
};

/**
 * Whether an incident is still open business — drives the badge counter
 * on the Behaviour app tile and the default queue filter.
 */
export function isIncidentLive(status: IncidentStatus): boolean {
  return status !== 'RESOLVED';
}

/**
 * Render the incident date as a short month-day-year. The schema stores
 * the date as YYYY-MM-DD so we can construct the Date directly without
 * timezone shifts.
 */
export function formatIncidentDate(iso: string): string {
  if (!iso) return '';
  // Avoid Date timezone parsing surprises on YYYY-MM-DD by appending T00.
  const ts = Date.parse(iso.length === 10 ? iso + 'T00:00:00' : iso);
  if (Number.isNaN(ts)) return iso;
  return new Date(ts).toLocaleDateString();
}

export function formatIncidentDateTime(date: string, time: string | null): string {
  if (!date) return '';
  if (!time) return formatIncidentDate(date);
  // The time is HH:MM or HH:MM:SS in the row's local context.
  const trimmed = time.length > 5 ? time.slice(0, 5) : time;
  return formatIncidentDate(date) + ' · ' + trimmed;
}

/**
 * Sort comparator for the queue: CRITICAL first, then HIGH/MEDIUM/LOW,
 * then OPEN before UNDER_REVIEW before RESOLVED, then incident_date
 * descending (newest first).
 */
export function sortIncidents(a: DisciplineIncidentDto, b: DisciplineIncidentDto): number {
  const sevRank: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const statusRank: Record<IncidentStatus, number> = {
    OPEN: 0,
    UNDER_REVIEW: 1,
    RESOLVED: 2,
  };
  const sevDiff = sevRank[a.severity] - sevRank[b.severity];
  if (sevDiff !== 0) return sevDiff;
  const statusDiff = statusRank[a.status] - statusRank[b.status];
  if (statusDiff !== 0) return statusDiff;
  // Newest first.
  return b.incidentDate.localeCompare(a.incidentDate);
}

/**
 * Compose the student's full name from the inlined first/last fields on
 * the incident row, falling back to the studentId when names are not
 * populated (shouldn't happen given the schema's NOT NULL JOIN, but
 * defence in depth).
 */
export function studentName(inc: DisciplineIncidentDto): string {
  if (inc.studentFirstName && inc.studentLastName) {
    return inc.studentFirstName + ' ' + inc.studentLastName;
  }
  return inc.studentFirstName || inc.studentLastName || inc.studentId.slice(0, 8);
}

// ─── Behaviour plan formatting (Step 5 schemas) ───────────────

export const PLAN_TYPES: BehaviorPlanType[] = ['BIP', 'BSP', 'SAFETY_PLAN'];

export const PLAN_STATUSES: BehaviorPlanStatus[] = ['DRAFT', 'ACTIVE', 'REVIEW', 'EXPIRED'];

export const PLAN_TYPE_LABELS: Record<BehaviorPlanType, string> = {
  BIP: 'BIP',
  BSP: 'BSP',
  SAFETY_PLAN: 'Safety plan',
};

export const PLAN_STATUS_LABELS: Record<BehaviorPlanStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  REVIEW: 'In review',
  EXPIRED: 'Expired',
};

export const PLAN_STATUS_PILL: Record<BehaviorPlanStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  ACTIVE: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  REVIEW: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  EXPIRED: 'bg-gray-100 text-gray-500 ring-1 ring-gray-200 line-through',
};

export const GOAL_PROGRESS_OPTIONS: GoalProgress[] = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'MET',
  'NOT_MET',
];

export const GOAL_PROGRESS_LABELS: Record<GoalProgress, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  MET: 'Met',
  NOT_MET: 'Not met',
};

export const GOAL_PROGRESS_PILL: Record<GoalProgress, string> = {
  NOT_STARTED: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  IN_PROGRESS: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200',
  MET: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  NOT_MET: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
};

export const FEEDBACK_EFFECTIVENESS_OPTIONS: FeedbackEffectiveness[] = [
  'NOT_EFFECTIVE',
  'SOMEWHAT_EFFECTIVE',
  'EFFECTIVE',
  'VERY_EFFECTIVE',
];

export const FEEDBACK_EFFECTIVENESS_LABELS: Record<FeedbackEffectiveness, string> = {
  NOT_EFFECTIVE: 'Not effective',
  SOMEWHAT_EFFECTIVE: 'Somewhat effective',
  EFFECTIVE: 'Effective',
  VERY_EFFECTIVE: 'Very effective',
};

export const FEEDBACK_EFFECTIVENESS_PILL: Record<FeedbackEffectiveness, string> = {
  NOT_EFFECTIVE: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  SOMEWHAT_EFFECTIVE: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  EFFECTIVE: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  VERY_EFFECTIVE: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300',
};
