import type {
  TicketActivityType,
  TicketPriority,
  TicketSlaSnapshotDto,
  TicketStatus,
  VendorType,
} from './types';

export const TICKET_PRIORITIES: TicketPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export const TICKET_STATUSES: TicketStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'VENDOR_ASSIGNED',
  'PENDING_REQUESTER',
  'RESOLVED',
  'CLOSED',
  'CANCELLED',
];

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  VENDOR_ASSIGNED: 'Vendor assigned',
  PENDING_REQUESTER: 'Awaiting reply',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

/**
 * Priority pill colours mirror the Cycle 6 / Cycle 7 conventions: cool tones
 * for low-urgency rows, warm tones at HIGH, rose at CRITICAL.
 */
export const TICKET_PRIORITY_PILL: Record<TicketPriority, string> = {
  LOW: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  MEDIUM: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200',
  HIGH: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
  CRITICAL: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
};

export const TICKET_STATUS_PILL: Record<TicketStatus, string> = {
  OPEN: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  IN_PROGRESS: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200',
  VENDOR_ASSIGNED: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
  PENDING_REQUESTER: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  RESOLVED: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  CLOSED: 'bg-gray-100 text-gray-600 ring-1 ring-gray-200',
  CANCELLED: 'bg-gray-100 text-gray-600 ring-1 ring-gray-200 line-through',
};

export const VENDOR_TYPE_LABELS: Record<VendorType, string> = {
  IT_REPAIR: 'IT repair',
  FACILITIES_MAINTENANCE: 'Facilities maintenance',
  CLEANING: 'Cleaning',
  ELECTRICAL: 'Electrical',
  PLUMBING: 'Plumbing',
  HVAC: 'HVAC',
  SECURITY: 'Security',
  GROUNDS: 'Grounds',
  OTHER: 'Other',
};

export const ACTIVITY_TYPE_LABELS: Record<TicketActivityType, string> = {
  STATUS_CHANGE: 'Status change',
  REASSIGNMENT: 'Reassignment',
  COMMENT: 'Comment',
  ATTACHMENT: 'Attachment',
  ESCALATION: 'Escalation',
  VENDOR_ASSIGNMENT: 'Vendor assignment',
  SLA_BREACH: 'SLA breach',
};

export type SlaUrgency = 'green' | 'amber' | 'red' | 'none';

/**
 * Compute a 4-state SLA urgency from the response + resolution remaining
 * hours. Red when either window is breached (negative remaining); amber
 * when either is within 25% of expiring; green when both are healthy;
 * none when there is no policy linked or both windows are already
 * satisfied (firstResponseAt + resolvedAt populated → resolutionHoursRemaining
 * is null because the window is closed).
 */
export function slaUrgency(sla: TicketSlaSnapshotDto): SlaUrgency {
  if (sla.responseBreached || sla.resolutionBreached) return 'red';
  const responseHours = sla.responseHours;
  const responseRemaining = sla.responseHoursRemaining;
  const resolutionHours = sla.resolutionHours;
  const resolutionRemaining = sla.resolutionHoursRemaining;
  if (responseHours === null && resolutionHours === null) return 'none';
  // Amber when either active window has used >75% of its budget.
  if (
    responseHours !== null &&
    responseRemaining !== null &&
    responseRemaining < responseHours * 0.25
  ) {
    return 'amber';
  }
  if (
    resolutionHours !== null &&
    resolutionRemaining !== null &&
    resolutionRemaining < resolutionHours * 0.25
  ) {
    return 'amber';
  }
  // Both windows closed (firstResponseAt + resolvedAt populated) → both
  // remaining values null → no live clock to display. Use 'none'.
  if (responseRemaining === null && resolutionRemaining === null) return 'none';
  return 'green';
}

export const SLA_URGENCY_DOT: Record<SlaUrgency, string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-rose-500',
  none: 'bg-gray-300',
};

export const SLA_URGENCY_LABEL: Record<SlaUrgency, string> = {
  green: 'On track',
  amber: 'Approaching SLA',
  red: 'Breached',
  none: 'No SLA',
};

/**
 * Render a short remaining-time blurb. Returns "2h left" / "30m left" /
 * "Overdue 4h" / null when nothing useful to show.
 */
export function formatSlaRemaining(sla: TicketSlaSnapshotDto): string | null {
  const remaining =
    sla.responseHoursRemaining !== null
      ? sla.responseHoursRemaining
      : sla.resolutionHoursRemaining;
  if (remaining === null) return null;
  const abs = Math.abs(remaining);
  if (remaining < 0) {
    if (abs >= 24) return `Overdue ${Math.round(abs / 24)}d`;
    if (abs >= 1) return `Overdue ${Math.round(abs)}h`;
    return `Overdue ${Math.round(abs * 60)}m`;
  }
  if (abs >= 24) return `${Math.round(abs / 24)}d left`;
  if (abs >= 1) return `${Math.round(abs)}h left`;
  return `${Math.round(abs * 60)}m left`;
}

const TERMINAL: TicketStatus[] = ['CLOSED', 'CANCELLED'];

/**
 * Whether a ticket should still appear on the requester's working
 * Helpdesk list. Used by the badge counter and the default `/helpdesk`
 * filter.
 */
export function isTicketLive(status: TicketStatus): boolean {
  return !TERMINAL.includes(status);
}

/**
 * Short relative timestamp helper for ticket lists. Matches the style
 * of the tasks-format `formatRelativeDue` pattern.
 */
export function formatTicketAge(createdAt: string): string {
  const now = Date.now();
  const ts = Date.parse(createdAt);
  const diffMs = now - ts;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}
