import type {
  AcknowledgementSourceType,
  AcknowledgementStatus,
  TaskCategory,
  TaskPriority,
  TaskSource,
  TaskStatus,
} from './types';

export const TASK_CATEGORIES: TaskCategory[] = [
  'ACADEMIC',
  'PERSONAL',
  'ADMINISTRATIVE',
  'ACKNOWLEDGEMENT',
];

export const TASK_PRIORITIES: TaskPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

export const TASK_STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'];

export const TASK_CATEGORY_LABELS: Record<TaskCategory, string> = {
  ACADEMIC: 'Academic',
  PERSONAL: 'Personal',
  ADMINISTRATIVE: 'Administrative',
  ACKNOWLEDGEMENT: 'Acknowledgements',
};

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  LOW: 'Low',
  NORMAL: 'Normal',
  HIGH: 'High',
  URGENT: 'Urgent',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
};

export const TASK_PRIORITY_PILL: Record<TaskPriority, string> = {
  LOW: 'bg-gray-100 text-gray-700',
  NORMAL: 'bg-sky-100 text-sky-800',
  HIGH: 'bg-amber-100 text-amber-800',
  URGENT: 'bg-rose-100 text-rose-800',
};

export const TASK_STATUS_PILL: Record<TaskStatus, string> = {
  TODO: 'bg-gray-100 text-gray-700',
  IN_PROGRESS: 'bg-sky-100 text-sky-800',
  DONE: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-gray-200 text-gray-500',
};

export const TASK_SOURCE_LABELS: Record<TaskSource, string> = {
  MANUAL: 'Manual',
  AUTO: 'Auto-generated',
  SYSTEM: 'System',
};

export const TASK_CATEGORY_ACCENT: Record<TaskCategory, string> = {
  ACADEMIC: 'border-l-campus-500',
  PERSONAL: 'border-l-violet-500',
  ADMINISTRATIVE: 'border-l-amber-500',
  ACKNOWLEDGEMENT: 'border-l-rose-500',
};

export const ACKNOWLEDGEMENT_SOURCE_LABELS: Record<AcknowledgementSourceType, string> = {
  ANNOUNCEMENT: 'Announcement',
  DISCIPLINE_RECORD: 'Discipline record',
  POLICY_DOCUMENT: 'Policy document',
  SIGNED_FORM: 'Signed form',
  CONSENT_REQUEST: 'Consent request',
  CUSTOM: 'Custom',
};

export const ACKNOWLEDGEMENT_STATUS_LABELS: Record<AcknowledgementStatus, string> = {
  PENDING: 'Pending',
  ACKNOWLEDGED: 'Acknowledged',
  ACKNOWLEDGED_WITH_DISPUTE: 'Acknowledged with dispute',
  EXPIRED: 'Expired',
};

/**
 * Returns true when the task's `due_at` is before now and the task is
 * still open (TODO or IN_PROGRESS). Used by the list view to flag
 * overdue rows in red.
 */
export function isTaskOverdue(dueAt: string | null, status: TaskStatus): boolean {
  if (!dueAt) return false;
  if (status !== 'TODO' && status !== 'IN_PROGRESS') return false;
  return new Date(dueAt).getTime() < Date.now();
}

/**
 * Render a task's due date as a relative phrase ("Due in 2 days", "Due
 * tomorrow", "Overdue 3 days"). Returns null when due_at is null.
 */
export function formatRelativeDue(dueAt: string | null): string | null {
  if (!dueAt) return null;
  const due = new Date(dueAt).getTime();
  const now = Date.now();
  const diffMs = due - now;
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Due today';
  if (diffDays === 1) return 'Due tomorrow';
  if (diffDays === -1) return 'Overdue 1 day';
  if (diffDays > 0) return 'Due in ' + diffDays + ' days';
  return 'Overdue ' + Math.abs(diffDays) + ' days';
}

/**
 * Returns true when the task counts toward the "Tasks" badge — TODO or
 * IN_PROGRESS with `due_at <= today` (overdue or due today).
 */
export function isTaskBadgeWorthy(status: TaskStatus, dueAt: string | null): boolean {
  if (status !== 'TODO' && status !== 'IN_PROGRESS') return false;
  if (!dueAt) return false;
  const due = new Date(dueAt);
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  return due.getTime() <= today.getTime();
}
