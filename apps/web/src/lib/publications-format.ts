// Cycle 25 — Publications formatting helpers.

export type PublicationType =
  | 'NEWSLETTER'
  | 'BULLETIN'
  | 'ANNOUNCEMENT'
  | 'MAGAZINE'
  | 'PROGRAM'
  | 'REPORT';
export const PUBLICATION_TYPES: readonly PublicationType[] = [
  'NEWSLETTER',
  'BULLETIN',
  'ANNOUNCEMENT',
  'MAGAZINE',
  'PROGRAM',
  'REPORT',
] as const;

export type SeriesFrequency =
  | 'DAILY'
  | 'WEEKLY'
  | 'FORTNIGHTLY'
  | 'MONTHLY'
  | 'TERMLY'
  | 'ANNUAL'
  | 'IRREGULAR';
export const SERIES_FREQUENCIES: readonly SeriesFrequency[] = [
  'DAILY',
  'WEEKLY',
  'FORTNIGHTLY',
  'MONTHLY',
  'TERMLY',
  'ANNUAL',
  'IRREGULAR',
] as const;

export type PublicationStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'PUBLISHED' | 'ARCHIVED';
export const PUBLICATION_STATUSES: readonly PublicationStatus[] = [
  'DRAFT',
  'IN_REVIEW',
  'APPROVED',
  'PUBLISHED',
  'ARCHIVED',
] as const;

export type CollaboratorRole = 'EDITOR' | 'CONTRIBUTOR' | 'REVIEWER' | 'VIEWER';

export type SectionType = 'ARTICLE' | 'ANNOUNCEMENT' | 'PHOTO_GALLERY' | 'CALENDAR' | 'CUSTOM';

export type DistributionRuleType = 'ROLE' | 'GRADE' | 'CLASS' | 'GROUP_MEMBERSHIP';

export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'OPENED' | 'BOUNCED';

export type SubscriptionStatus = 'SUBSCRIBED' | 'UNSUBSCRIBED';

export const PUBLICATION_TYPE_LABELS: Record<PublicationType, string> = {
  NEWSLETTER: 'Newsletter',
  BULLETIN: 'Bulletin',
  ANNOUNCEMENT: 'Announcement',
  MAGAZINE: 'Magazine',
  PROGRAM: 'Programme',
  REPORT: 'Report',
};

export const FREQUENCY_LABELS: Record<SeriesFrequency, string> = {
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  FORTNIGHTLY: 'Fortnightly',
  MONTHLY: 'Monthly',
  TERMLY: 'Termly',
  ANNUAL: 'Annual',
  IRREGULAR: 'Irregular',
};

export const STATUS_PILL: Record<PublicationStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  IN_REVIEW: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-sky-100 text-sky-700',
  PUBLISHED: 'bg-emerald-100 text-emerald-700',
  ARCHIVED: 'bg-rose-100 text-rose-700',
};

export const ROLE_PILL: Record<CollaboratorRole, string> = {
  EDITOR: 'bg-violet-100 text-violet-700',
  CONTRIBUTOR: 'bg-sky-100 text-sky-700',
  REVIEWER: 'bg-amber-100 text-amber-700',
  VIEWER: 'bg-gray-100 text-gray-700',
};

export const SECTION_TYPE_LABELS: Record<SectionType, string> = {
  ARTICLE: 'Article',
  ANNOUNCEMENT: 'Announcement',
  PHOTO_GALLERY: 'Photo gallery',
  CALENDAR: 'Calendar',
  CUSTOM: 'Custom',
};

export const SUBSCRIPTION_STATUS_PILL: Record<SubscriptionStatus, string> = {
  SUBSCRIBED: 'bg-emerald-100 text-emerald-700',
  UNSUBSCRIBED: 'bg-gray-100 text-gray-600',
};

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── Phase 2 Cycle 26 — Publications Advanced helpers ───

import type { PubScheduledStatus, PubVersionTrigger } from '@/lib/types';

export const VERSION_TRIGGER_LABELS: Record<PubVersionTrigger, string> = {
  STATUS_CHANGE: 'Status change',
  MANUAL_CHECKPOINT: 'Manual checkpoint',
  REVERT: 'Reverted',
};

export const VERSION_TRIGGER_PILL: Record<PubVersionTrigger, string> = {
  STATUS_CHANGE: 'bg-sky-100 text-sky-700',
  MANUAL_CHECKPOINT: 'bg-emerald-100 text-emerald-700',
  REVERT: 'bg-amber-100 text-amber-700',
};

export const SCHEDULED_STATUS_LABELS: Record<PubScheduledStatus, string> = {
  SCHEDULED: 'Scheduled',
  PUBLISHED: 'Published',
  CANCELLED: 'Cancelled',
};

export const SCHEDULED_STATUS_PILL: Record<PubScheduledStatus, string> = {
  SCHEDULED: 'bg-amber-100 text-amber-700',
  PUBLISHED: 'bg-emerald-100 text-emerald-700',
  CANCELLED: 'bg-gray-100 text-gray-600',
};

export function formatCountdown(iso: string | null): string {
  if (!iso) return '—';
  const target = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = target - now;
  if (diffMs <= 0) return 'now';
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((diffMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

export function formatEngagement(numerator: number, denominator: number): string {
  if (denominator === 0) return '0%';
  const pct = Math.round((numerator / denominator) * 100);
  return `${pct}%`;
}
