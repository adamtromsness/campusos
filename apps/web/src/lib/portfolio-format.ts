// Cycle 24 — Student Portfolio formatting helpers.

export type PortfolioVisibility = 'PRIVATE' | 'TEACHER' | 'PARENT' | 'PUBLIC';
export const PORTFOLIO_VISIBILITIES: readonly PortfolioVisibility[] = [
  'PRIVATE',
  'TEACHER',
  'PARENT',
  'PUBLIC',
] as const;

export type PortfolioItemType =
  | 'SUBMISSION'
  | 'GRADE'
  | 'ACHIEVEMENT'
  | 'REFLECTION'
  | 'EXTERNAL_FILE'
  | 'CERTIFICATE';
export const PORTFOLIO_ITEM_TYPES: readonly PortfolioItemType[] = [
  'SUBMISSION',
  'GRADE',
  'ACHIEVEMENT',
  'REFLECTION',
  'EXTERNAL_FILE',
  'CERTIFICATE',
] as const;

export type ShareStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export type AchievementType =
  | 'ACADEMIC'
  | 'SPORTING'
  | 'MUSICAL'
  | 'LEADERSHIP'
  | 'COMMUNITY'
  | 'CUSTOM';
export const ACHIEVEMENT_TYPES: readonly AchievementType[] = [
  'ACADEMIC',
  'SPORTING',
  'MUSICAL',
  'LEADERSHIP',
  'COMMUNITY',
  'CUSTOM',
] as const;

export type AchievementSharePlatform = 'EMAIL' | 'SOCIAL' | 'PORTFOLIO';
export const ACHIEVEMENT_SHARE_PLATFORMS: readonly AchievementSharePlatform[] = [
  'EMAIL',
  'SOCIAL',
  'PORTFOLIO',
] as const;

export const VISIBILITY_LABELS: Record<PortfolioVisibility, string> = {
  PRIVATE: 'Private — only you',
  TEACHER: 'Teachers — your assigned teachers',
  PARENT: 'Parents — your linked guardians + teachers',
  PUBLIC: 'Public — everyone in your school',
};

export const VISIBILITY_PILL: Record<PortfolioVisibility, string> = {
  PRIVATE: 'bg-gray-100 text-gray-700',
  TEACHER: 'bg-sky-100 text-sky-700',
  PARENT: 'bg-violet-100 text-violet-700',
  PUBLIC: 'bg-emerald-100 text-emerald-700',
};

export const ITEM_TYPE_LABELS: Record<PortfolioItemType, string> = {
  SUBMISSION: 'Submission',
  GRADE: 'Grade',
  ACHIEVEMENT: 'Achievement',
  REFLECTION: 'Reflection',
  EXTERNAL_FILE: 'External file',
  CERTIFICATE: 'Certificate',
};

export const ITEM_TYPE_PILL: Record<PortfolioItemType, string> = {
  SUBMISSION: 'bg-sky-100 text-sky-700',
  GRADE: 'bg-emerald-100 text-emerald-700',
  ACHIEVEMENT: 'bg-amber-100 text-amber-700',
  REFLECTION: 'bg-violet-100 text-violet-700',
  EXTERNAL_FILE: 'bg-gray-100 text-gray-700',
  CERTIFICATE: 'bg-rose-100 text-rose-700',
};

export const ACHIEVEMENT_TYPE_LABELS: Record<AchievementType, string> = {
  ACADEMIC: 'Academic',
  SPORTING: 'Sporting',
  MUSICAL: 'Musical',
  LEADERSHIP: 'Leadership',
  COMMUNITY: 'Community',
  CUSTOM: 'Custom',
};

export const ACHIEVEMENT_TYPE_PILL: Record<AchievementType, string> = {
  ACADEMIC: 'bg-sky-100 text-sky-700',
  SPORTING: 'bg-emerald-100 text-emerald-700',
  MUSICAL: 'bg-violet-100 text-violet-700',
  LEADERSHIP: 'bg-amber-100 text-amber-700',
  COMMUNITY: 'bg-rose-100 text-rose-700',
  CUSTOM: 'bg-gray-100 text-gray-700',
};

export const SHARE_STATUS_LABELS: Record<ShareStatus, string> = {
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  REVOKED: 'Revoked',
};

export const SHARE_STATUS_PILL: Record<ShareStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  EXPIRED: 'bg-amber-100 text-amber-700',
  REVOKED: 'bg-rose-100 text-rose-700',
};

export const SHARE_PLATFORM_LABELS: Record<AchievementSharePlatform, string> = {
  EMAIL: 'Email',
  SOCIAL: 'Social',
  PORTFOLIO: 'Pinned to portfolio',
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

export function formatRelativeShareExpiry(expiresAt: string | null): string {
  if (!expiresAt) return 'Never expires';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms < 0) {
    const days = Math.round(-ms / 86400000);
    return days === 0 ? 'Expired today' : `Expired ${days}d ago`;
  }
  const days = Math.round(ms / 86400000);
  if (days < 1) return 'Expires today';
  if (days < 30) return `Expires in ${days}d`;
  return `Expires ${formatDate(expiresAt)}`;
}
