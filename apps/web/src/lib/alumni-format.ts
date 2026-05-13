import type { AlumniNewsCategory, CampaignStatus, OutreachStatus, ReunionStatus } from './types';

export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const CAMPAIGN_STATUS_PILL: Record<CampaignStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  ACTIVE: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  COMPLETED: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  CANCELLED: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
};

export const OUTREACH_STATUS_LABEL: Record<OutreachStatus, string> = {
  PENDING: 'Pending',
  SENT: 'Sent',
  OPENED: 'Opened',
  RESPONDED: 'Responded',
  DONATED: 'Donated',
  UNSUBSCRIBED: 'Unsubscribed',
};

export const OUTREACH_STATUS_PILL: Record<OutreachStatus, string> = {
  PENDING: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  SENT: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  OPENED: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  RESPONDED: 'bg-violet-100 text-violet-700 ring-1 ring-violet-200',
  DONATED: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  UNSUBSCRIBED: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
};

export const ALUMNI_NEWS_CATEGORY_LABEL: Record<AlumniNewsCategory, string> = {
  ACHIEVEMENT: 'Achievement',
  EVENT: 'Event',
  OPPORTUNITY: 'Opportunity',
  GENERAL: 'General',
};

export const ALUMNI_NEWS_CATEGORY_PILL: Record<AlumniNewsCategory, string> = {
  ACHIEVEMENT: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  EVENT: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  OPPORTUNITY: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  GENERAL: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
};

export const REUNION_STATUS_LABEL: Record<ReunionStatus, string> = {
  PLANNING: 'Planning',
  CONFIRMED: 'Confirmed',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const REUNION_STATUS_PILL: Record<ReunionStatus, string> = {
  PLANNING: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  CONFIRMED: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  COMPLETED: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  CANCELLED: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
};

/**
 * Common alumni segmentation tags. Schools may coin their own — the
 * Step 5 AlumniTagService writes free-text TEXT with a CHECK that the
 * tag is non-empty. This list seeds the tag-picker autocomplete on the
 * portal + admin tag-segmentation modal.
 */
export const COMMON_ALUMNI_TAGS: readonly string[] = [
  'STEM_MENTOR',
  'DONOR',
  'INTERNATIONAL',
  'BOARD_MEMBER',
  'CAREER_SPEAKER',
  'VOLUNTEER',
  'INDUSTRY_ADVISOR',
];

/** ISO 4217 currency codes commonly seen in school fundraising. */
export const COMMON_CURRENCIES: readonly { code: string; label: string }[] = [
  { code: 'USD', label: 'US Dollar (USD)' },
  { code: 'GBP', label: 'Pound Sterling (GBP)' },
  { code: 'EUR', label: 'Euro (EUR)' },
  { code: 'CAD', label: 'Canadian Dollar (CAD)' },
  { code: 'AUD', label: 'Australian Dollar (AUD)' },
  { code: 'JPY', label: 'Japanese Yen (JPY)' },
];

export function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatCampaignProgress(raised: number, goal: number | null): string {
  if (!goal || goal <= 0) return 'no goal set';
  const pct = Math.min(100, Math.round((raised / goal) * 100));
  return `${pct}% of goal`;
}

export function formatDateOnly(value: string | null): string {
  if (!value) return '';
  try {
    return new Date(value).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return value;
  }
}

export function formatRelative(value: string | null): string {
  if (!value) return '';
  const then = new Date(value).getTime();
  const now = Date.now();
  const delta = Math.round((now - then) / 1000);
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  if (delta < 604800) return `${Math.round(delta / 86400)}d ago`;
  return formatDateOnly(value);
}
