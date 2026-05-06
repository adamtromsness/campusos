// Cycle 21 Facilities formatting helpers — labels + pill class maps.

export type FacSpaceType =
  | 'CLASSROOM'
  | 'BATHROOM'
  | 'CORRIDOR'
  | 'STAIRWELL'
  | 'MECHANICAL'
  | 'STORAGE'
  | 'OFFICE'
  | 'GROUNDS'
  | 'COMMON_AREA'
  | 'GYM'
  | 'CAFETERIA'
  | 'OTHER';

export const FAC_SPACE_TYPE_LABEL: Record<FacSpaceType, string> = {
  CLASSROOM: 'Classroom',
  BATHROOM: 'Bathroom',
  CORRIDOR: 'Corridor',
  STAIRWELL: 'Stairwell',
  MECHANICAL: 'Mechanical',
  STORAGE: 'Storage',
  OFFICE: 'Office',
  GROUNDS: 'Grounds',
  COMMON_AREA: 'Common area',
  GYM: 'Gym',
  CAFETERIA: 'Cafeteria',
  OTHER: 'Other',
};

export const FAC_SPACE_TYPE_PILL: Record<FacSpaceType, string> = {
  CLASSROOM: 'bg-sky-100 text-sky-800',
  BATHROOM: 'bg-violet-100 text-violet-800',
  CORRIDOR: 'bg-gray-100 text-gray-800',
  STAIRWELL: 'bg-gray-100 text-gray-800',
  MECHANICAL: 'bg-amber-100 text-amber-800',
  STORAGE: 'bg-amber-100 text-amber-800',
  OFFICE: 'bg-indigo-100 text-indigo-800',
  GROUNDS: 'bg-emerald-100 text-emerald-800',
  COMMON_AREA: 'bg-teal-100 text-teal-800',
  GYM: 'bg-rose-100 text-rose-800',
  CAFETERIA: 'bg-orange-100 text-orange-800',
  OTHER: 'bg-gray-100 text-gray-800',
};

export type FacBookingStatus = 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';

export const FAC_BOOKING_STATUS_LABEL: Record<FacBookingStatus, string> = {
  CONFIRMED: 'Confirmed',
  CANCELLED: 'Cancelled',
  COMPLETED: 'Completed',
};

export const FAC_BOOKING_STATUS_PILL: Record<FacBookingStatus, string> = {
  CONFIRMED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-gray-200 text-gray-700',
  COMPLETED: 'bg-sky-100 text-sky-800',
};

export type FacWorkOrderType =
  | 'REPAIR'
  | 'INSTALLATION'
  | 'INSPECTION_PREP'
  | 'DEEP_CLEAN'
  | 'RENOVATION';

export const FAC_WO_TYPE_LABEL: Record<FacWorkOrderType, string> = {
  REPAIR: 'Repair',
  INSTALLATION: 'Installation',
  INSPECTION_PREP: 'Inspection prep',
  DEEP_CLEAN: 'Deep clean',
  RENOVATION: 'Renovation',
};

export type FacWorkOrderPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const FAC_WO_PRIORITY_LABEL: Record<FacWorkOrderPriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

export const FAC_WO_PRIORITY_PILL: Record<FacWorkOrderPriority, string> = {
  LOW: 'bg-gray-100 text-gray-700',
  MEDIUM: 'bg-sky-100 text-sky-800',
  HIGH: 'bg-amber-100 text-amber-800',
  CRITICAL: 'bg-rose-100 text-rose-800',
};

export type FacWorkOrderStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'VENDOR_ASSIGNED'
  | 'ON_HOLD'
  | 'COMPLETED'
  | 'CANCELLED';

export const FAC_WO_STATUS_LABEL: Record<FacWorkOrderStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  VENDOR_ASSIGNED: 'Vendor assigned',
  ON_HOLD: 'On hold',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const FAC_WO_STATUS_PILL: Record<FacWorkOrderStatus, string> = {
  OPEN: 'bg-rose-100 text-rose-800',
  IN_PROGRESS: 'bg-sky-100 text-sky-800',
  VENDOR_ASSIGNED: 'bg-violet-100 text-violet-800',
  ON_HOLD: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-gray-200 text-gray-700',
};

export type FacPmTaskStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'OVERDUE';

export const FAC_PM_STATUS_LABEL: Record<FacPmTaskStatus, string> = {
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  OVERDUE: 'Overdue',
};

export const FAC_PM_STATUS_PILL: Record<FacPmTaskStatus, string> = {
  SCHEDULED: 'bg-sky-100 text-sky-800',
  IN_PROGRESS: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  OVERDUE: 'bg-rose-100 text-rose-800',
};

export type FacInspectionOutcome = 'PENDING' | 'PASSED' | 'PASSED_WITH_CONDITIONS' | 'FAILED';

export const FAC_INSPECTION_OUTCOME_LABEL: Record<FacInspectionOutcome, string> = {
  PENDING: 'Pending',
  PASSED: 'Passed',
  PASSED_WITH_CONDITIONS: 'Passed with conditions',
  FAILED: 'Failed',
};

export const FAC_INSPECTION_OUTCOME_PILL: Record<FacInspectionOutcome, string> = {
  PENDING: 'bg-gray-100 text-gray-700',
  PASSED: 'bg-emerald-100 text-emerald-800',
  PASSED_WITH_CONDITIONS: 'bg-amber-100 text-amber-800',
  FAILED: 'bg-rose-100 text-rose-800',
};

export type FacViolationSeverity = 'MINOR' | 'MAJOR' | 'CRITICAL';

export const FAC_VIOL_SEVERITY_LABEL: Record<FacViolationSeverity, string> = {
  MINOR: 'Minor',
  MAJOR: 'Major',
  CRITICAL: 'Critical',
};

export const FAC_VIOL_SEVERITY_PILL: Record<FacViolationSeverity, string> = {
  MINOR: 'bg-amber-100 text-amber-800',
  MAJOR: 'bg-orange-100 text-orange-800',
  CRITICAL: 'bg-rose-100 text-rose-800',
};

export type FacZoneShift = 'MORNING' | 'AFTERNOON' | 'EVENING' | 'OVERNIGHT';

export const FAC_SHIFT_LABEL: Record<FacZoneShift, string> = {
  MORNING: 'Morning',
  AFTERNOON: 'Afternoon',
  EVENING: 'Evening',
  OVERNIGHT: 'Overnight',
};

export function formatDateOnly(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function isOverdue(dueDate: string | null): boolean {
  if (!dueDate) return false;
  const d = new Date(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d < today;
}

export function formatRelativeDue(dueDate: string | null): string {
  if (!dueDate) return '—';
  const d = new Date(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diff < 0) return `Overdue ${-diff}d`;
  if (diff === 0) return 'Due today';
  if (diff === 1) return 'Due tomorrow';
  if (diff < 30) return `Due in ${diff}d`;
  return `Due ${d.toLocaleDateString()}`;
}
