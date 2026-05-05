import type {
  LibraryCheckoutStatus,
  LibraryCopyCondition,
  LibraryCopyLocationStatus,
  LibraryFineStatus,
  LibraryFineType,
  LibraryHoldStatus,
  LibraryLocationType,
  LibraryPatronType,
  ReadingListItemType,
  ReadingListType,
  ReadingProgrammeAudienceType,
} from './types';

// ─── Const arrays (UI-driven order) ───────────────────────────

export const LIBRARY_LOCATION_TYPES: LibraryLocationType[] = [
  'SHELF',
  'DISPLAY',
  'BOOK_DROP',
  'PROCESSING',
  'REPAIR',
  'STORAGE',
];

export const LIBRARY_COPY_CONDITIONS: LibraryCopyCondition[] = [
  'NEW',
  'GOOD',
  'FAIR',
  'POOR',
  'LOST',
];

export const LIBRARY_COPY_LOCATION_STATUSES: LibraryCopyLocationStatus[] = [
  'ON_SHELF',
  'IN_BOOK_DROP',
  'IN_PROCESSING',
  'CHECKED_OUT',
  'ON_HOLD_SHELF',
  'IN_REPAIR',
  'LOST',
];

export const LIBRARY_PATRON_TYPES: LibraryPatronType[] = ['STUDENT', 'STAFF'];

export const LIBRARY_CHECKOUT_STATUSES: LibraryCheckoutStatus[] = [
  'ACTIVE',
  'RETURNED',
  'OVERDUE',
  'LOST',
];

export const LIBRARY_HOLD_STATUSES: LibraryHoldStatus[] = [
  'PENDING',
  'READY',
  'COLLECTED',
  'EXPIRED',
  'CANCELLED',
];

export const LIBRARY_FINE_TYPES: LibraryFineType[] = ['OVERDUE', 'LOST', 'DAMAGE'];

export const LIBRARY_FINE_STATUSES: LibraryFineStatus[] = ['OUTSTANDING', 'PAID', 'WAIVED'];

export const READING_PROGRAMME_AUDIENCE_TYPES: ReadingProgrammeAudienceType[] = [
  'SCHOOL_WIDE',
  'YEAR_GROUP',
  'CLASS',
  'CUSTOM',
];

export const READING_LIST_TYPES: ReadingListType[] = [
  'CLASS',
  'YEAR_GROUP',
  'CURRICULUM_UNIT',
  'GENERAL',
  'NEW_ARRIVALS',
];

export const READING_LIST_ITEM_TYPES: ReadingListItemType[] = [
  'REQUIRED',
  'RECOMMENDED',
  'EXTENSION',
  'REFERENCE',
];

// ─── Label maps ───────────────────────────────────────────────

export const LIBRARY_LOCATION_TYPE_LABELS: Record<LibraryLocationType, string> = {
  SHELF: 'Shelf',
  DISPLAY: 'Display',
  BOOK_DROP: 'Book drop',
  PROCESSING: 'Processing',
  REPAIR: 'Repair',
  STORAGE: 'Storage',
};

export const LIBRARY_COPY_CONDITION_LABELS: Record<LibraryCopyCondition, string> = {
  NEW: 'New',
  GOOD: 'Good',
  FAIR: 'Fair',
  POOR: 'Poor',
  LOST: 'Lost',
};

export const LIBRARY_COPY_LOCATION_STATUS_LABELS: Record<LibraryCopyLocationStatus, string> = {
  ON_SHELF: 'On shelf',
  IN_BOOK_DROP: 'In book drop',
  IN_PROCESSING: 'In processing',
  CHECKED_OUT: 'Checked out',
  ON_HOLD_SHELF: 'On hold shelf',
  IN_REPAIR: 'In repair',
  LOST: 'Lost',
};

export const LIBRARY_CHECKOUT_STATUS_LABELS: Record<LibraryCheckoutStatus, string> = {
  ACTIVE: 'Active',
  RETURNED: 'Returned',
  OVERDUE: 'Overdue',
  LOST: 'Lost',
};

export const LIBRARY_HOLD_STATUS_LABELS: Record<LibraryHoldStatus, string> = {
  PENDING: 'Pending',
  READY: 'Ready for pickup',
  COLLECTED: 'Collected',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
};

export const LIBRARY_FINE_TYPE_LABELS: Record<LibraryFineType, string> = {
  OVERDUE: 'Overdue',
  LOST: 'Lost item',
  DAMAGE: 'Damage',
};

export const LIBRARY_FINE_STATUS_LABELS: Record<LibraryFineStatus, string> = {
  OUTSTANDING: 'Outstanding',
  PAID: 'Paid',
  WAIVED: 'Waived',
};

export const READING_PROGRAMME_AUDIENCE_LABELS: Record<ReadingProgrammeAudienceType, string> = {
  SCHOOL_WIDE: 'School-wide',
  YEAR_GROUP: 'Year group',
  CLASS: 'Class',
  CUSTOM: 'Custom',
};

export const READING_LIST_TYPE_LABELS: Record<ReadingListType, string> = {
  CLASS: 'Class',
  YEAR_GROUP: 'Year group',
  CURRICULUM_UNIT: 'Curriculum unit',
  GENERAL: 'General',
  NEW_ARRIVALS: 'New arrivals',
};

export const READING_LIST_ITEM_TYPE_LABELS: Record<ReadingListItemType, string> = {
  REQUIRED: 'Required',
  RECOMMENDED: 'Recommended',
  EXTENSION: 'Extension',
  REFERENCE: 'Reference',
};

// ─── Pill class maps ──────────────────────────────────────────

export const COPY_CONDITION_PILL: Record<LibraryCopyCondition, string> = {
  NEW: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200',
  GOOD: 'bg-sky-100 text-sky-800 ring-1 ring-sky-200',
  FAIR: 'bg-amber-100 text-amber-800 ring-1 ring-amber-200',
  POOR: 'bg-orange-100 text-orange-800 ring-1 ring-orange-200',
  LOST: 'bg-rose-100 text-rose-800 ring-1 ring-rose-200',
};

export const COPY_LOCATION_STATUS_PILL: Record<LibraryCopyLocationStatus, string> = {
  ON_SHELF: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200',
  IN_BOOK_DROP: 'bg-sky-100 text-sky-800 ring-1 ring-sky-200',
  IN_PROCESSING: 'bg-violet-100 text-violet-800 ring-1 ring-violet-200',
  CHECKED_OUT: 'bg-amber-100 text-amber-800 ring-1 ring-amber-200',
  ON_HOLD_SHELF: 'bg-indigo-100 text-indigo-800 ring-1 ring-indigo-200',
  IN_REPAIR: 'bg-orange-100 text-orange-800 ring-1 ring-orange-200',
  LOST: 'bg-rose-100 text-rose-800 ring-1 ring-rose-200',
};

export const CHECKOUT_STATUS_PILL: Record<LibraryCheckoutStatus, string> = {
  ACTIVE: 'bg-sky-100 text-sky-800 ring-1 ring-sky-200',
  RETURNED: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200',
  OVERDUE: 'bg-rose-100 text-rose-800 ring-1 ring-rose-200',
  LOST: 'bg-gray-200 text-gray-800 ring-1 ring-gray-300',
};

export const HOLD_STATUS_PILL: Record<LibraryHoldStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-800 ring-1 ring-amber-200',
  READY: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200',
  COLLECTED: 'bg-sky-100 text-sky-800 ring-1 ring-sky-200',
  EXPIRED: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  CANCELLED: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
};

export const FINE_TYPE_PILL: Record<LibraryFineType, string> = {
  OVERDUE: 'bg-amber-100 text-amber-800 ring-1 ring-amber-200',
  LOST: 'bg-rose-100 text-rose-800 ring-1 ring-rose-200',
  DAMAGE: 'bg-orange-100 text-orange-800 ring-1 ring-orange-200',
};

export const FINE_STATUS_PILL: Record<LibraryFineStatus, string> = {
  OUTSTANDING: 'bg-rose-100 text-rose-800 ring-1 ring-rose-200',
  PAID: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200',
  WAIVED: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
};

export const READING_LIST_ITEM_PILL: Record<ReadingListItemType, string> = {
  REQUIRED: 'bg-rose-100 text-rose-800 ring-1 ring-rose-200',
  RECOMMENDED: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200',
  EXTENSION: 'bg-sky-100 text-sky-800 ring-1 ring-sky-200',
  REFERENCE: 'bg-violet-100 text-violet-800 ring-1 ring-violet-200',
};

// ─── Helpers ──────────────────────────────────────────────────

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

export function formatCurrency(value: number): string {
  return '$' + value.toFixed(2);
}

/**
 * Render the days-until-due as a friendly relative phrase, e.g.
 *   3  → "Due in 3 days"
 *   1  → "Due tomorrow"
 *   0  → "Due today"
 *  -1  → "1 day overdue"
 *  -3  → "3 days overdue"
 */
export function formatDaysUntilDue(days: number | null): string {
  if (days === null || days === undefined) return '—';
  if (days < 0) {
    const n = Math.abs(days);
    return n === 1 ? '1 day overdue' : n + ' days overdue';
  }
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return 'Due in ' + days + ' days';
}

export function isOverdue(days: number | null): boolean {
  return days !== null && days !== undefined && days < 0;
}

export function isCheckoutLive(status: LibraryCheckoutStatus): boolean {
  return status === 'ACTIVE' || status === 'OVERDUE';
}
