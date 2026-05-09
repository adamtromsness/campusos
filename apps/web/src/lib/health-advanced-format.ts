// P2C3 Health Advanced — labels, pill class maps, formatters.

import type {
  ComplianceStatus,
  ScreeningReferralOutcome,
  ScreeningReferralStatus,
  ScreeningReferralType,
  TelehealthDocumentType,
  TelehealthSessionStatus,
} from './types';

export const TELEHEALTH_SESSION_STATUSES: TelehealthSessionStatus[] = [
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
];

export const TELEHEALTH_SESSION_STATUS_LABEL: Record<TelehealthSessionStatus, string> = {
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  NO_SHOW: 'No-show',
  CANCELLED: 'Cancelled',
};

export const TELEHEALTH_SESSION_STATUS_PILL: Record<TelehealthSessionStatus, string> = {
  SCHEDULED: 'bg-sky-100 text-sky-800',
  IN_PROGRESS: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  NO_SHOW: 'bg-slate-200 text-slate-700',
  CANCELLED: 'bg-slate-100 text-slate-600',
};

export const TELEHEALTH_DOCUMENT_TYPE_LABEL: Record<TelehealthDocumentType, string> = {
  SESSION_NOTES: 'Session notes',
  TREATMENT_PLAN: 'Treatment plan',
  REFERRAL_LETTER: 'Referral letter',
  CONSENT: 'Consent',
  OTHER: 'Other',
};

export const COMPLIANCE_STATUSES: ComplianceStatus[] = [
  'COMPLIANT',
  'NON_COMPLIANT',
  'EXEMPT',
  'PROVISIONAL',
];

export const COMPLIANCE_STATUS_LABEL: Record<ComplianceStatus, string> = {
  COMPLIANT: 'Compliant',
  NON_COMPLIANT: 'Non-compliant',
  EXEMPT: 'Exempt',
  PROVISIONAL: 'Provisional',
};

export const COMPLIANCE_STATUS_PILL: Record<ComplianceStatus, string> = {
  COMPLIANT: 'bg-emerald-100 text-emerald-800',
  NON_COMPLIANT: 'bg-rose-100 text-rose-800',
  EXEMPT: 'bg-violet-100 text-violet-800',
  PROVISIONAL: 'bg-amber-100 text-amber-800',
};

export const REFERRAL_TYPES: ScreeningReferralType[] = ['VISION', 'HEARING', 'SCOLIOSIS', 'OTHER'];

export const REFERRAL_TYPE_LABEL: Record<ScreeningReferralType, string> = {
  VISION: 'Vision',
  HEARING: 'Hearing',
  SCOLIOSIS: 'Scoliosis',
  OTHER: 'Other',
};

export const REFERRAL_STATUSES: ScreeningReferralStatus[] = [
  'REFERRED',
  'FOLLOW_UP_COMPLETE',
  'LOST_TO_FOLLOW_UP',
];

export const REFERRAL_STATUS_LABEL: Record<ScreeningReferralStatus, string> = {
  REFERRED: 'Referred',
  FOLLOW_UP_COMPLETE: 'Follow-up complete',
  LOST_TO_FOLLOW_UP: 'Lost to follow-up',
};

export const REFERRAL_STATUS_PILL: Record<ScreeningReferralStatus, string> = {
  REFERRED: 'bg-amber-100 text-amber-800',
  FOLLOW_UP_COMPLETE: 'bg-emerald-100 text-emerald-800',
  LOST_TO_FOLLOW_UP: 'bg-rose-100 text-rose-800',
};

export const REFERRAL_OUTCOMES: ScreeningReferralOutcome[] = [
  'NORMAL',
  'TREATMENT_REQUIRED',
  'GLASSES_PRESCRIBED',
  'HEARING_AID',
  'OTHER',
];

export const REFERRAL_OUTCOME_LABEL: Record<ScreeningReferralOutcome, string> = {
  NORMAL: 'Normal',
  TREATMENT_REQUIRED: 'Treatment required',
  GLASSES_PRESCRIBED: 'Glasses prescribed',
  HEARING_AID: 'Hearing aid',
  OTHER: 'Other',
};

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function formatDateOnly(s: string | null | undefined): string {
  if (!s) return '';
  return s.length > 10 ? s.slice(0, 10) : s;
}

export function isOverdue(followUpDate: string | null, status: ScreeningReferralStatus): boolean {
  if (status !== 'REFERRED' || !followUpDate) return false;
  return followUpDate < new Date().toISOString().slice(0, 10);
}
