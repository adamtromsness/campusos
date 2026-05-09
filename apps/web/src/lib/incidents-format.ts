// P2C2 web format helpers — labels, pill class maps, value-derivation utilities.

export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_STATUSES = ['ACTIVE', 'RESOLVED', 'CANCELLED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const PROCEDURE_TYPES = [
  'FIRE_EVACUATION',
  'LOCKDOWN',
  'SHELTER_IN_PLACE',
  'MEDICAL_EMERGENCY',
  'BOMB_THREAT',
  'HAZMAT',
  'MISSING_STUDENT',
  'SAFEGUARDING_CRISIS',
  'GENERAL',
] as const;
export type ProcedureType = (typeof PROCEDURE_TYPES)[number];

export const ACCOUNTABILITY_PERSON_TYPES = ['STUDENT', 'STAFF', 'VISITOR'] as const;
export type AccountabilityPersonType = (typeof ACCOUNTABILITY_PERSON_TYPES)[number];

export const ACCOUNTABILITY_STATUSES = [
  'UNKNOWN',
  'ACCOUNTED_FOR',
  'EVACUATED',
  'MEDICAL_ASSISTANCE',
  'MISSING',
] as const;
export type AccountabilityStatus = (typeof ACCOUNTABILITY_STATUSES)[number];

export const DRILL_STATUSES = ['SCHEDULED', 'COMPLETED', 'CANCELLED'] as const;
export type DrillStatus = (typeof DRILL_STATUSES)[number];

export const NON_DISCIPLINE_INCIDENT_TYPES = [
  'STUDENT_INJURY',
  'STAFF_INJURY',
  'MEDICAL_EPISODE',
  'PROPERTY_DAMAGE',
  'ENVIRONMENTAL',
  'SECURITY',
  'OTHER',
] as const;
export type NonDisciplineIncidentType = (typeof NON_DISCIPLINE_INCIDENT_TYPES)[number];

export const NON_DISCIPLINE_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type NonDisciplineSeverity = (typeof NON_DISCIPLINE_SEVERITIES)[number];

export const NON_DISCIPLINE_STATUSES = ['OPEN', 'UNDER_REVIEW', 'CLOSED'] as const;
export type NonDisciplineStatus = (typeof NON_DISCIPLINE_STATUSES)[number];

export const SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

export const SEVERITY_PILL: Record<IncidentSeverity, string> = {
  LOW: 'bg-slate-100 text-slate-700',
  MEDIUM: 'bg-amber-100 text-amber-800',
  HIGH: 'bg-orange-100 text-orange-800',
  CRITICAL: 'bg-rose-100 text-rose-800',
};

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  ACTIVE: 'Active',
  RESOLVED: 'Resolved',
  CANCELLED: 'Cancelled',
};

export const INCIDENT_STATUS_PILL: Record<IncidentStatus, string> = {
  ACTIVE: 'bg-rose-100 text-rose-800 ring-2 ring-rose-300',
  RESOLVED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-slate-100 text-slate-700',
};

export const PROCEDURE_LABEL: Record<ProcedureType, string> = {
  FIRE_EVACUATION: 'Fire Evacuation',
  LOCKDOWN: 'Lockdown',
  SHELTER_IN_PLACE: 'Shelter in Place',
  MEDICAL_EMERGENCY: 'Medical Emergency',
  BOMB_THREAT: 'Bomb Threat',
  HAZMAT: 'Hazmat',
  MISSING_STUDENT: 'Missing Student',
  SAFEGUARDING_CRISIS: 'Safeguarding Crisis',
  GENERAL: 'General',
};

export const ACCOUNTABILITY_STATUS_LABEL: Record<AccountabilityStatus, string> = {
  UNKNOWN: 'Unknown',
  ACCOUNTED_FOR: 'Accounted for',
  EVACUATED: 'Evacuated',
  MEDICAL_ASSISTANCE: 'Medical assistance',
  MISSING: 'Missing',
};

export const ACCOUNTABILITY_STATUS_PILL: Record<AccountabilityStatus, string> = {
  UNKNOWN: 'bg-amber-100 text-amber-800',
  ACCOUNTED_FOR: 'bg-emerald-100 text-emerald-800',
  EVACUATED: 'bg-sky-100 text-sky-800',
  MEDICAL_ASSISTANCE: 'bg-violet-100 text-violet-800',
  MISSING: 'bg-rose-100 text-rose-800 ring-2 ring-rose-300',
};

export const ACCOUNTABILITY_PERSON_TYPE_LABEL: Record<AccountabilityPersonType, string> = {
  STUDENT: 'Student',
  STAFF: 'Staff',
  VISITOR: 'Visitor',
};

export const DRILL_STATUS_LABEL: Record<DrillStatus, string> = {
  SCHEDULED: 'Scheduled',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const DRILL_STATUS_PILL: Record<DrillStatus, string> = {
  SCHEDULED: 'bg-sky-100 text-sky-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-slate-100 text-slate-700',
};

export const NON_DISCIPLINE_TYPE_LABEL: Record<NonDisciplineIncidentType, string> = {
  STUDENT_INJURY: 'Student injury',
  STAFF_INJURY: 'Staff injury',
  MEDICAL_EPISODE: 'Medical episode',
  PROPERTY_DAMAGE: 'Property damage',
  ENVIRONMENTAL: 'Environmental',
  SECURITY: 'Security',
  OTHER: 'Other',
};

export const NON_DISCIPLINE_SEVERITY_PILL: Record<NonDisciplineSeverity, string> = {
  LOW: 'bg-slate-100 text-slate-700',
  MEDIUM: 'bg-amber-100 text-amber-800',
  HIGH: 'bg-rose-100 text-rose-800',
};

export const NON_DISCIPLINE_STATUS_LABEL: Record<NonDisciplineStatus, string> = {
  OPEN: 'Open',
  UNDER_REVIEW: 'Under review',
  CLOSED: 'Closed',
};

export const NON_DISCIPLINE_STATUS_PILL: Record<NonDisciplineStatus, string> = {
  OPEN: 'bg-amber-100 text-amber-800',
  UNDER_REVIEW: 'bg-sky-100 text-sky-800',
  CLOSED: 'bg-slate-100 text-slate-700',
};

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function formatTimeOnly(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return iso ?? '';
  const ms = Date.now() - d;
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export function formatElapsed(declaredAt: string): string {
  const ms = Date.now() - new Date(declaredAt).getTime();
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatPercent(rate: number | null | undefined): string {
  if (rate == null) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
