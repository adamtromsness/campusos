import type {
  EngConferenceEventStatus,
  EngConferenceSlotStatus,
  EngagementLevel,
  SurveyQuestionType,
  SurveyStatus,
} from './types';

export const CONFERENCE_EVENT_STATUS_LABEL: Record<EngConferenceEventStatus, string> = {
  DRAFT: 'Draft',
  BOOKING_OPEN: 'Booking Open',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
};

export const CONFERENCE_EVENT_STATUS_PILL: Record<EngConferenceEventStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  BOOKING_OPEN: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  IN_PROGRESS: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  COMPLETED: 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-200',
};

export const CONFERENCE_SLOT_STATUS_LABEL: Record<EngConferenceSlotStatus, string> = {
  AVAILABLE: 'Available',
  BOOKED: 'Booked',
  BLOCKED: 'Blocked',
};

export const CONFERENCE_SLOT_STATUS_PILL: Record<EngConferenceSlotStatus, string> = {
  AVAILABLE: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  BOOKED: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  BLOCKED: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
};

export const ENGAGEMENT_LEVEL_LABEL: Record<EngagementLevel, string> = {
  HIGHLY_ENGAGED: 'Highly Engaged',
  ENGAGED: 'Engaged',
  MINIMAL: 'Minimal',
  AT_RISK: 'At Risk',
};

/**
 * Warming-tone progression matching the engagement-score severity:
 * green (highest engagement) → blue → amber → rose (at risk).
 */
export const ENGAGEMENT_LEVEL_PILL: Record<EngagementLevel, string> = {
  HIGHLY_ENGAGED: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  ENGAGED: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  MINIMAL: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  AT_RISK: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
};

export const ENGAGEMENT_LEVEL_BAR: Record<EngagementLevel, string> = {
  HIGHLY_ENGAGED: 'bg-emerald-500',
  ENGAGED: 'bg-sky-500',
  MINIMAL: 'bg-amber-500',
  AT_RISK: 'bg-rose-500',
};

export const SURVEY_STATUS_LABEL: Record<SurveyStatus, string> = {
  DRAFT: 'Draft',
  OPEN: 'Open',
  CLOSED: 'Closed',
};

export const SURVEY_STATUS_PILL: Record<SurveyStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  OPEN: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  CLOSED: 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-200',
};

export const SURVEY_QUESTION_TYPE_LABEL: Record<SurveyQuestionType, string> = {
  RATING_1_5: 'Rating 1–5',
  RATING_1_10: 'Rating 1–10',
  YES_NO: 'Yes / No',
  FREE_TEXT: 'Free text',
  MULTIPLE_CHOICE: 'Multiple choice',
};

/** Score tone — drives gauge colour on the engagement dashboard. */
export function engagementScoreTone(score: number): 'emerald' | 'sky' | 'amber' | 'rose' {
  if (score >= 75) return 'emerald';
  if (score >= 50) return 'sky';
  if (score >= 25) return 'amber';
  return 'rose';
}

export function engagementScoreToneText(score: number): string {
  switch (engagementScoreTone(score)) {
    case 'emerald':
      return 'text-emerald-700';
    case 'sky':
      return 'text-sky-700';
    case 'amber':
      return 'text-amber-700';
    default:
      return 'text-rose-700';
  }
}

export function engagementScoreToneBar(score: number): string {
  switch (engagementScoreTone(score)) {
    case 'emerald':
      return 'bg-emerald-500';
    case 'sky':
      return 'bg-sky-500';
    case 'amber':
      return 'bg-amber-500';
    default:
      return 'bg-rose-500';
  }
}

export function formatDateOnly(iso: string | null | undefined): string {
  if (!iso) return '—';
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

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return (
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    );
  } catch {
    return iso;
  }
}

/** Trim PostgreSQL `HH:MM:SS` → `HH:MM` for slot timeslot rendering. */
export function formatTime(raw: string | null | undefined): string {
  if (!raw) return '—';
  // PG returns TIME as HH:MM:SS or HH:MM:SS.ffffff
  return raw.length >= 5 ? raw.slice(0, 5) : raw;
}

export function formatTimeRange(start: string, end: string): string {
  return `${formatTime(start)} – ${formatTime(end)}`;
}

/** Days/hours until — useful for booking window countdown copy. */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  try {
    const target = new Date(iso).getTime();
    const today = Date.now();
    return Math.round((target - today) / (1000 * 60 * 60 * 24));
  } catch {
    return null;
  }
}

/** True when `now` is between bookingOpensAt and bookingClosesAt. */
export function isBookingWindowOpen(opensAt: string, closesAt: string): boolean {
  const now = Date.now();
  return now >= Date.parse(opensAt) && now <= Date.parse(closesAt);
}

export interface EngagementComponentRow {
  key: 'attendance' | 'communication' | 'conference' | 'volunteer' | 'payment';
  label: string;
  weight: number;
  value: number | null;
}

export function buildComponentRows(
  weights: {
    attendance: number;
    communication: number;
    conference: number;
    volunteer: number;
    payment: number;
  },
  values: {
    attendance: number | null;
    communication: number | null;
    conference: number | null;
    volunteer: number | null;
    payment: number | null;
  },
): EngagementComponentRow[] {
  return [
    {
      key: 'attendance',
      label: 'Attendance at school events',
      weight: weights.attendance,
      value: values.attendance,
    },
    {
      key: 'communication',
      label: 'Communications read rate',
      weight: weights.communication,
      value: values.communication,
    },
    {
      key: 'conference',
      label: 'Conferences attended',
      weight: weights.conference,
      value: values.conference,
    },
    {
      key: 'volunteer',
      label: 'Volunteer hours',
      weight: weights.volunteer,
      value: values.volunteer,
    },
    {
      key: 'payment',
      label: 'On-time payments',
      weight: weights.payment,
      value: values.payment,
    },
  ];
}
