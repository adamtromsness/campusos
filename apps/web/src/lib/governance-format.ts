// Cycle 30 — Data Governance & Compliance pill / colour helpers.

export const LEGAL_BASIS_LABELS: Record<string, string> = {
  LEGAL_OBLIGATION: 'Legal obligation',
  PUBLIC_TASK: 'Public task',
  LEGITIMATE_INTERESTS: 'Legitimate interests',
  VITAL_INTERESTS: 'Vital interests',
  CONTRACT: 'Contract',
  CONSENT: 'Consent',
};

export const PROCESSOR_TYPE_LABELS: Record<string, string> = {
  CLOUD_INFRASTRUCTURE: 'Cloud infrastructure',
  PAYMENT_PROCESSOR: 'Payment processor',
  AI_PROVIDER: 'AI provider',
  MDM_PROVIDER: 'MDM provider',
  VIDEO_CONFERENCING: 'Video conferencing',
  EMAIL_PROVIDER: 'Email provider',
  IDENTITY_PROVIDER: 'Identity provider',
  ANALYTICS: 'Analytics',
  OTHER: 'Other',
};

export const TRANSFER_MECHANISM_LABELS: Record<string, string> = {
  ADEQUACY_DECISION: 'Adequacy decision',
  SCCs: 'Standard Contractual Clauses',
  BCRs: 'Binding Corporate Rules',
  DEROGATION: 'Derogation',
};

export const DPA_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  TERMINATED: 'Terminated',
};

export const DPA_STATUS_PILL: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  EXPIRED: 'bg-rose-100 text-rose-700',
  TERMINATED: 'bg-rose-100 text-rose-700',
};

export const BREACH_TYPE_LABELS: Record<string, string> = {
  UNAUTHORISED_ACCESS: 'Unauthorised access',
  ACCIDENTAL_DISCLOSURE: 'Accidental disclosure',
  RANSOMWARE: 'Ransomware',
  THEFT: 'Theft',
  LOSS_OF_DEVICE: 'Loss of device',
  SYSTEM_MISCONFIGURATION: 'System misconfiguration',
  THIRD_PARTY_BREACH: 'Third-party breach',
  OTHER: 'Other',
};

export const BREACH_RISK_PILL: Record<string, string> = {
  LOW: 'bg-emerald-100 text-emerald-700',
  MEDIUM: 'bg-amber-100 text-amber-700',
  HIGH: 'bg-orange-100 text-orange-700',
  VERY_HIGH: 'bg-rose-100 text-rose-700',
};

export const BREACH_STATUS_LABELS: Record<string, string> = {
  UNDER_INVESTIGATION: 'Under investigation',
  NOTIFIED: 'Notified',
  CONTAINED: 'Contained',
  RESOLVED: 'Resolved',
};

export const BREACH_STATUS_PILL: Record<string, string> = {
  UNDER_INVESTIGATION: 'bg-rose-100 text-rose-700',
  NOTIFIED: 'bg-amber-100 text-amber-700',
  CONTAINED: 'bg-sky-100 text-sky-700',
  RESOLVED: 'bg-emerald-100 text-emerald-700',
};

export const SAR_STATUS_LABELS: Record<string, string> = {
  RECEIVED: 'Received',
  IN_PROGRESS: 'In progress',
  EXTENSION_REQUESTED: 'Extension requested',
  COMPLETED: 'Completed',
  DENIED: 'Denied',
  OVERDUE: 'Overdue',
};

export const SAR_STATUS_PILL: Record<string, string> = {
  RECEIVED: 'bg-sky-100 text-sky-700',
  IN_PROGRESS: 'bg-amber-100 text-amber-700',
  EXTENSION_REQUESTED: 'bg-violet-100 text-violet-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  DENIED: 'bg-gray-100 text-gray-700',
  OVERDUE: 'bg-rose-100 text-rose-700',
};

export const ERASURE_STATUS_LABELS: Record<string, string> = {
  RECEIVED: 'Received',
  REVIEWING: 'Reviewing',
  PARTIALLY_COMPLETED: 'Partially completed',
  COMPLETED: 'Completed',
  DENIED: 'Denied',
};

export const ERASURE_STATUS_PILL: Record<string, string> = {
  RECEIVED: 'bg-sky-100 text-sky-700',
  REVIEWING: 'bg-amber-100 text-amber-700',
  PARTIALLY_COMPLETED: 'bg-amber-100 text-amber-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  DENIED: 'bg-gray-100 text-gray-700',
};

export const DPIA_STATUS_LABELS: Record<string, string> = {
  SCOPING: 'Scoping',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export const DPIA_STATUS_PILL: Record<string, string> = {
  SCOPING: 'bg-gray-100 text-gray-700',
  IN_PROGRESS: 'bg-amber-100 text-amber-700',
  COMPLETED: 'bg-sky-100 text-sky-700',
  APPROVED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-rose-100 text-rose-700',
};

export const DPIA_RESIDUAL_PILL: Record<string, string> = {
  LOW: 'bg-emerald-100 text-emerald-700',
  MEDIUM: 'bg-amber-100 text-amber-700',
  HIGH: 'bg-rose-100 text-rose-700',
};

export function formatDate(d: string | null | undefined): string {
  if (!d) return '—';
  // Accept date-only or ISO timestamps; format as YYYY-MM-DD locale
  const onlyDate = String(d).slice(0, 10);
  return onlyDate;
}

export function formatDateTime(d: string | null | undefined): string {
  if (!d) return '—';
  try {
    return new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  } catch {
    return String(d);
  }
}

/**
 * Format the 72-hour breach countdown. Returns a colour-coded
 * { label, tone } pair.
 */
export function formatBreachCountdown(hoursRemaining: number | null): {
  label: string;
  tone: 'good' | 'warn' | 'bad' | 'muted';
} {
  if (hoursRemaining === null) return { label: 'No notification required', tone: 'muted' };
  if (hoursRemaining <= 0) return { label: `Overdue by ${Math.abs(hoursRemaining)}h`, tone: 'bad' };
  if (hoursRemaining <= 12) return { label: `${hoursRemaining}h left`, tone: 'bad' };
  if (hoursRemaining <= 36) return { label: `${hoursRemaining}h left`, tone: 'warn' };
  return { label: `${hoursRemaining}h left`, tone: 'good' };
}

export function formatHours(n: number): string {
  return `${n}h`;
}

export function tonePill(tone: 'good' | 'warn' | 'bad' | 'muted'): string {
  switch (tone) {
    case 'good':
      return 'bg-emerald-100 text-emerald-700';
    case 'warn':
      return 'bg-amber-100 text-amber-700';
    case 'bad':
      return 'bg-rose-100 text-rose-700';
    default:
      return 'bg-gray-100 text-gray-700';
  }
}
