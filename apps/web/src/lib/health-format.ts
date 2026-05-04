import type {
  ConditionSeverity,
  ImmunisationStatus,
  IepGoalStatus,
  IepPlanStatus,
  MedicationRoute,
  MissedReason,
  NurseVisitStatus,
  ScreeningResult,
} from './types';

/* Cycle 10 Step 8 — Health UI formatting helpers.
 *
 * Label maps + pill class maps mirroring the warming-tone palette
 * Cycle 8 / 9 use for severity / status. Severity uses cool gray at
 * MILD, amber at MODERATE, rose at SEVERE. Immunisation status:
 * emerald CURRENT, rose OVERDUE, gray WAIVED. Medication dashboard
 * status: emerald ADMINISTERED, rose MISSED, amber PENDING.
 */

export const SEVERITIES: ConditionSeverity[] = ['MILD', 'MODERATE', 'SEVERE'];

export const SEVERITY_LABELS: Record<ConditionSeverity, string> = {
  MILD: 'Mild',
  MODERATE: 'Moderate',
  SEVERE: 'Severe',
};

export const SEVERITY_PILL: Record<ConditionSeverity, string> = {
  MILD: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  MODERATE: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  SEVERE: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
};

export const IMMUNISATION_STATUSES: ImmunisationStatus[] = ['CURRENT', 'OVERDUE', 'WAIVED'];

export const IMMUNISATION_STATUS_LABELS: Record<ImmunisationStatus, string> = {
  CURRENT: 'Current',
  OVERDUE: 'Overdue',
  WAIVED: 'Waived',
};

export const IMMUNISATION_STATUS_PILL: Record<ImmunisationStatus, string> = {
  CURRENT: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  OVERDUE: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  WAIVED: 'bg-gray-100 text-gray-600 ring-1 ring-gray-200',
};

export const MEDICATION_ROUTES: MedicationRoute[] = [
  'ORAL',
  'TOPICAL',
  'INHALER',
  'INJECTION',
  'OTHER',
];

export const MEDICATION_ROUTE_LABELS: Record<MedicationRoute, string> = {
  ORAL: 'Oral',
  TOPICAL: 'Topical',
  INHALER: 'Inhaler',
  INJECTION: 'Injection',
  OTHER: 'Other',
};

export const MISSED_REASONS: MissedReason[] = [
  'STUDENT_ABSENT',
  'STUDENT_REFUSED',
  'MEDICATION_UNAVAILABLE',
  'PARENT_CANCELLED',
  'OTHER',
];

export const MISSED_REASON_LABELS: Record<MissedReason, string> = {
  STUDENT_ABSENT: 'Student absent',
  STUDENT_REFUSED: 'Student refused',
  MEDICATION_UNAVAILABLE: 'Medication unavailable',
  PARENT_CANCELLED: 'Parent cancelled',
  OTHER: 'Other',
};

export type DashboardStatus = 'ADMINISTERED' | 'MISSED' | 'PENDING';

export const DASHBOARD_STATUS_LABELS: Record<DashboardStatus, string> = {
  ADMINISTERED: 'Administered',
  MISSED: 'Missed',
  PENDING: 'Pending',
};

export const DASHBOARD_STATUS_PILL: Record<DashboardStatus, string> = {
  ADMINISTERED: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  MISSED: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  PENDING: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
};

export const NURSE_VISIT_STATUSES: NurseVisitStatus[] = ['IN_PROGRESS', 'COMPLETED'];

export const NURSE_VISIT_STATUS_LABELS: Record<NurseVisitStatus, string> = {
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
};

export const NURSE_VISIT_STATUS_PILL: Record<NurseVisitStatus, string> = {
  IN_PROGRESS: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  COMPLETED: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
};

export const IEP_PLAN_STATUSES: IepPlanStatus[] = ['DRAFT', 'ACTIVE', 'REVIEW', 'EXPIRED'];

export const IEP_PLAN_STATUS_LABELS: Record<IepPlanStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  REVIEW: 'In review',
  EXPIRED: 'Expired',
};

export const IEP_PLAN_STATUS_PILL: Record<IepPlanStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  ACTIVE: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  REVIEW: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  EXPIRED: 'bg-gray-100 text-gray-500 ring-1 ring-gray-200 line-through',
};

export const IEP_GOAL_STATUSES: IepGoalStatus[] = ['ACTIVE', 'MET', 'NOT_MET', 'DISCONTINUED'];

export const IEP_GOAL_STATUS_LABELS: Record<IepGoalStatus, string> = {
  ACTIVE: 'Active',
  MET: 'Met',
  NOT_MET: 'Not met',
  DISCONTINUED: 'Discontinued',
};

export const IEP_GOAL_STATUS_PILL: Record<IepGoalStatus, string> = {
  ACTIVE: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200',
  MET: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  NOT_MET: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  DISCONTINUED: 'bg-gray-100 text-gray-500 ring-1 ring-gray-200',
};

export const SCREENING_RESULTS: ScreeningResult[] = ['PASS', 'REFER', 'RESCREEN', 'ABSENT'];

export const SCREENING_RESULT_LABELS: Record<ScreeningResult, string> = {
  PASS: 'Pass',
  REFER: 'Refer',
  RESCREEN: 'Rescreen',
  ABSENT: 'Absent',
};

export const SCREENING_RESULT_PILL: Record<ScreeningResult, string> = {
  PASS: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  REFER: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  RESCREEN: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  ABSENT: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
};

/** Format a stored 'HH:MM:SS' time as 'HH:MM' for display. */
export function formatTime(t: string | null | undefined): string {
  if (!t) return '';
  return t.length > 5 ? t.slice(0, 5) : t;
}

/** YYYY-MM-DD without timezone shifts. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const ts = Date.parse(iso.length === 10 ? iso + 'T00:00:00' : iso);
  if (Number.isNaN(ts)) return iso;
  return new Date(ts).toLocaleDateString();
}

/** ISO timestamp → locale 'YYYY-MM-DD HH:MM' display. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const d = new Date(ts);
  return (
    d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
}

/** Compose a student name from first + last with a UUID prefix fallback. */
export function studentDisplayName(
  first: string | null | undefined,
  last: string | null | undefined,
  fallback: string,
): string {
  if (first && last) return first + ' ' + last;
  return first || last || fallback.slice(0, 8);
}
