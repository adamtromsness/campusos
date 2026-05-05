import type {
  DeploymentStatus,
  DeploymentTargetType,
  FrequencyRecommendation,
  WellbeingAlertStatus,
  WellbeingAlertType,
  WellbeingDomain,
  WellbeingQuestionType,
} from './types';

// ─── Const arrays (UI-driven order) ───────────────────────────

export const FREQUENCY_RECOMMENDATIONS: FrequencyRecommendation[] = [
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'AS_NEEDED',
];

export const QUESTION_TYPES: WellbeingQuestionType[] = [
  'SCALE_1_5',
  'SCALE_1_10',
  'YES_NO',
  'FREE_TEXT',
  'EMOJI_SCALE',
];

export const WELLBEING_DOMAINS: WellbeingDomain[] = [
  'ACADEMIC',
  'SOCIAL',
  'EMOTIONAL',
  'PHYSICAL',
  'SAFETY',
];

export const DEPLOYMENT_TARGET_TYPES: DeploymentTargetType[] = [
  'CASELOAD',
  'CLASS',
  'YEAR_GROUP',
  'SCHOOL',
  'CUSTOM_LIST',
];

export const DEPLOYMENT_STATUSES: DeploymentStatus[] = [
  'SCHEDULED',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
];

export const ALERT_TYPES: WellbeingAlertType[] = [
  'SELF_HARM_INDICATOR',
  'FEELS_UNSAFE',
  'WANTS_TO_TALK',
  'SIGNIFICANT_SCORE_DROP',
  'PERSISTENT_LOW_SCORE',
];

export const ALERT_STATUSES: WellbeingAlertStatus[] = [
  'NEW',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'RESOLVED',
];

// ─── Label maps ───────────────────────────────────────────────

export const FREQUENCY_LABELS: Record<FrequencyRecommendation, string> = {
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
  AS_NEEDED: 'As needed',
};

export const QUESTION_TYPE_LABELS: Record<WellbeingQuestionType, string> = {
  SCALE_1_5: 'Scale 1–5',
  SCALE_1_10: 'Scale 1–10',
  YES_NO: 'Yes / No',
  FREE_TEXT: 'Free text',
  EMOJI_SCALE: 'Emoji scale',
};

export const DOMAIN_LABELS: Record<WellbeingDomain, string> = {
  ACADEMIC: 'Academic',
  SOCIAL: 'Social',
  EMOTIONAL: 'Emotional',
  PHYSICAL: 'Physical',
  SAFETY: 'Safety',
};

export const DEPLOYMENT_TARGET_LABELS: Record<DeploymentTargetType, string> = {
  CASELOAD: 'Caseload',
  CLASS: 'Class',
  YEAR_GROUP: 'Year group',
  SCHOOL: 'School-wide',
  CUSTOM_LIST: 'Custom list',
};

export const DEPLOYMENT_STATUS_LABELS: Record<DeploymentStatus, string> = {
  SCHEDULED: 'Scheduled',
  ACTIVE: 'Active',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const ALERT_TYPE_LABELS: Record<WellbeingAlertType, string> = {
  SELF_HARM_INDICATOR: 'Self-harm indicator',
  FEELS_UNSAFE: 'Feels unsafe',
  WANTS_TO_TALK: 'Wants to talk',
  SIGNIFICANT_SCORE_DROP: 'Significant score drop',
  PERSISTENT_LOW_SCORE: 'Persistent low score',
};

export const ALERT_STATUS_LABELS: Record<WellbeingAlertStatus, string> = {
  NEW: 'New',
  ACKNOWLEDGED: 'Acknowledged',
  IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved',
};

// ─── Pill class maps ──────────────────────────────────────────

export const DOMAIN_PILL: Record<WellbeingDomain, string> = {
  ACADEMIC: 'bg-sky-100 text-sky-800 ring-1 ring-sky-200',
  SOCIAL: 'bg-violet-100 text-violet-800 ring-1 ring-violet-200',
  EMOTIONAL: 'bg-amber-100 text-amber-800 ring-1 ring-amber-200',
  PHYSICAL: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200',
  SAFETY: 'bg-rose-100 text-rose-800 ring-1 ring-rose-200',
};

export const QUESTION_TYPE_PILL: Record<WellbeingQuestionType, string> = {
  SCALE_1_5: 'bg-gray-100 text-gray-800 ring-1 ring-gray-200',
  SCALE_1_10: 'bg-gray-100 text-gray-800 ring-1 ring-gray-200',
  YES_NO: 'bg-indigo-100 text-indigo-800 ring-1 ring-indigo-200',
  FREE_TEXT: 'bg-stone-100 text-stone-800 ring-1 ring-stone-200',
  EMOJI_SCALE: 'bg-pink-100 text-pink-800 ring-1 ring-pink-200',
};

export const DEPLOYMENT_STATUS_PILL: Record<DeploymentStatus, string> = {
  SCHEDULED: 'bg-amber-100 text-amber-800 ring-1 ring-amber-200',
  ACTIVE: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200',
  COMPLETED: 'bg-sky-100 text-sky-800 ring-1 ring-sky-200',
  CANCELLED: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
};

// Severity progression — SHI deepest red, then bright rose, then amber, gray for the deferred types.
export const ALERT_TYPE_PILL: Record<WellbeingAlertType, string> = {
  SELF_HARM_INDICATOR: 'bg-rose-700 text-white ring-1 ring-rose-900',
  FEELS_UNSAFE: 'bg-rose-100 text-rose-800 ring-1 ring-rose-200',
  WANTS_TO_TALK: 'bg-amber-100 text-amber-800 ring-1 ring-amber-200',
  SIGNIFICANT_SCORE_DROP: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  PERSISTENT_LOW_SCORE: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
};

export const ALERT_STATUS_PILL: Record<WellbeingAlertStatus, string> = {
  NEW: 'bg-rose-100 text-rose-800 ring-1 ring-rose-200',
  ACKNOWLEDGED: 'bg-amber-100 text-amber-800 ring-1 ring-amber-200',
  IN_PROGRESS: 'bg-sky-100 text-sky-800 ring-1 ring-sky-200',
  RESOLVED: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200',
};

// ─── Helpers ──────────────────────────────────────────────────

export function alertSeverityRank(t: WellbeingAlertType): number {
  switch (t) {
    case 'SELF_HARM_INDICATOR':
      return 0;
    case 'FEELS_UNSAFE':
      return 1;
    case 'WANTS_TO_TALK':
      return 2;
    case 'SIGNIFICANT_SCORE_DROP':
      return 3;
    case 'PERSISTENT_LOW_SCORE':
      return 4;
  }
}

export function isOpenAlert(s: WellbeingAlertStatus): boolean {
  return s === 'NEW' || s === 'ACKNOWLEDGED' || s === 'IN_PROGRESS';
}

export function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString();
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}
