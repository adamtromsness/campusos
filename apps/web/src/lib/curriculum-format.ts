import type { CurFrameworkSource, CurGapType, CurMapStatus, CurResourceType } from './types';

export const CUR_MAP_STATUS_LABELS: Record<CurMapStatus, string> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

export const CUR_MAP_STATUS_PILL: Record<CurMapStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  PUBLISHED: 'bg-emerald-100 text-emerald-700',
  ARCHIVED: 'bg-amber-100 text-amber-700',
};

export const CUR_FRAMEWORK_SOURCE_LABELS: Record<CurFrameworkSource, string> = {
  PLATFORM: 'Platform',
  SCHOOL: 'School',
};

export const CUR_FRAMEWORK_SOURCE_PILL: Record<CurFrameworkSource, string> = {
  PLATFORM: 'bg-sky-100 text-sky-700',
  SCHOOL: 'bg-violet-100 text-violet-700',
};

export const CUR_GAP_TYPE_LABELS: Record<CurGapType, string> = {
  NOT_STARTED: 'Not started',
  PARTIAL: 'Partial',
  COMPLETE: 'Complete',
};

export const CUR_GAP_TYPE_PILL: Record<CurGapType, string> = {
  NOT_STARTED: 'bg-rose-100 text-rose-700',
  PARTIAL: 'bg-amber-100 text-amber-700',
  COMPLETE: 'bg-emerald-100 text-emerald-700',
};

export const CUR_GAP_TYPE_BG: Record<CurGapType, string> = {
  NOT_STARTED: 'bg-rose-200',
  PARTIAL: 'bg-amber-200',
  COMPLETE: 'bg-emerald-200',
};

export const CUR_RESOURCE_TYPE_LABELS: Record<CurResourceType, string> = {
  FILE: 'File',
  URL: 'Link',
  VIDEO: 'Video',
  TEXTBOOK: 'Textbook',
};

export const CUR_RESOURCE_TYPE_PILL: Record<CurResourceType, string> = {
  FILE: 'bg-sky-100 text-sky-700',
  URL: 'bg-emerald-100 text-emerald-700',
  VIDEO: 'bg-violet-100 text-violet-700',
  TEXTBOOK: 'bg-amber-100 text-amber-700',
};

export function formatCurDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

export function formatCurDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function gapTotal(summary: {
  complete: number;
  partial: number;
  notStarted: number;
}): number {
  return summary.complete + summary.partial + summary.notStarted;
}

export function gapPct(
  summary: { complete: number; partial: number; notStarted: number },
  type: CurGapType,
): number {
  const total = gapTotal(summary);
  if (total === 0) return 0;
  const num =
    type === 'COMPLETE'
      ? summary.complete
      : type === 'PARTIAL'
        ? summary.partial
        : summary.notStarted;
  return Math.round((num / total) * 100);
}
