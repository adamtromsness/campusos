import type {
  AccActionPlanStatus,
  AccEvidenceStatus,
  AccEvidenceType,
  AccSelfStudyRating,
  AccSiteVisitStatus,
  AccSubActionStatus,
} from './types';

export const ACC_EVIDENCE_TYPE_LABEL: Record<AccEvidenceType, string> = {
  DOCUMENT: 'Document',
  URL: 'URL',
  METRIC: 'Metric',
  OBSERVATION: 'Observation',
  SURVEY: 'Survey',
};

export const ACC_EVIDENCE_TYPE_PILL: Record<AccEvidenceType, string> = {
  DOCUMENT: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  URL: 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-200',
  METRIC: 'bg-violet-100 text-violet-700 ring-1 ring-violet-200',
  OBSERVATION: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  SURVEY: 'bg-teal-100 text-teal-700 ring-1 ring-teal-200',
};

export const ACC_EVIDENCE_STATUS_LABEL: Record<AccEvidenceStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export const ACC_EVIDENCE_STATUS_PILL: Record<AccEvidenceStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  SUBMITTED: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  APPROVED: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  REJECTED: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
};

export const ACC_RATING_LABEL: Record<AccSelfStudyRating, string> = {
  EXEMPLARY: 'Exemplary',
  ACCOMPLISHED: 'Accomplished',
  DEVELOPING: 'Developing',
  NOT_MET: 'Not Met',
};

/** Warming-tone progression: green → blue → amber → rose. */
export const ACC_RATING_PILL: Record<AccSelfStudyRating, string> = {
  EXEMPLARY: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  ACCOMPLISHED: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  DEVELOPING: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  NOT_MET: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
};

export const ACC_ACTION_PLAN_STATUS_LABEL: Record<AccActionPlanStatus, string> = {
  PLANNED: 'Planned',
  IN_PROGRESS: 'In Progress',
  COMPLETE: 'Complete',
  OVERDUE: 'Overdue',
};

export const ACC_ACTION_PLAN_STATUS_PILL: Record<AccActionPlanStatus, string> = {
  PLANNED: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  IN_PROGRESS: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  COMPLETE: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  OVERDUE: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
};

export const ACC_SUB_ACTION_STATUS_LABEL: Record<AccSubActionStatus, string> = {
  PENDING: 'Pending',
  COMPLETED: 'Completed',
  OVERDUE: 'Overdue',
};

export const ACC_SUB_ACTION_STATUS_PILL: Record<AccSubActionStatus, string> = {
  PENDING: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  COMPLETED: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  OVERDUE: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
};

export const ACC_SITE_VISIT_STATUS_LABEL: Record<AccSiteVisitStatus, string> = {
  PREPARING: 'Preparing',
  READY: 'Ready',
  VISIT_COMPLETE: 'Visit Complete',
};

export const ACC_SITE_VISIT_STATUS_PILL: Record<AccSiteVisitStatus, string> = {
  PREPARING: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  READY: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  VISIT_COMPLETE: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
};

/**
 * Readiness tone helper — used by the dashboard gauge + per-row card
 * to colour-code the score. Green ≥ 80, amber ≥ 50, rose < 50.
 */
export function readinessTone(score: number | null): 'emerald' | 'amber' | 'rose' | 'gray' {
  if (score === null) return 'gray';
  if (score >= 80) return 'emerald';
  if (score >= 50) return 'amber';
  return 'rose';
}

export function readinessToneBar(score: number | null): string {
  switch (readinessTone(score)) {
    case 'emerald':
      return 'bg-emerald-500';
    case 'amber':
      return 'bg-amber-500';
    case 'rose':
      return 'bg-rose-500';
    default:
      return 'bg-gray-300';
  }
}

export function readinessToneText(score: number | null): string {
  switch (readinessTone(score)) {
    case 'emerald':
      return 'text-emerald-700';
    case 'amber':
      return 'text-amber-700';
    case 'rose':
      return 'text-rose-700';
    default:
      return 'text-gray-500';
  }
}

export function formatDateOnly(iso: string | null | undefined): string {
  if (!iso) return '—';
  // Already YYYY-MM-DD style from the API
  const dateOnly = iso.length >= 10 ? iso.slice(0, 10) : iso;
  try {
    const d = new Date(dateOnly + 'T00:00:00Z');
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  } catch {
    return dateOnly;
  }
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const ms = Date.now() - d.getTime();
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return formatDateOnly(iso);
  } catch {
    return '—';
  }
}

/** Returns `2025-2026` style cycle id derived from today. */
export function currentCycleId(): string {
  const yr = new Date().getFullYear();
  return `${yr}-${yr + 1}`;
}

/** Compute days until a target date — negative when overdue. */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  try {
    const target = new Date(iso.slice(0, 10) + 'T00:00:00Z').getTime();
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
    return Math.round((target - today) / (1000 * 60 * 60 * 24));
  } catch {
    return null;
  }
}
