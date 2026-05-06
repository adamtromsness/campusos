import type {
  CredentialStatus,
  CredentialType,
  DocumentType,
  InspectionItemStatus,
  InspectionStatus,
  NoShowResolution,
  PassType,
  RouteChangeLogType,
  RouteDirection,
  RouteStatus,
  RunStatus,
  ScanDirection,
  TransportChangeRequestStatus,
  TransportChangeRequestType,
  VehicleStatus,
  VehicleType,
} from './types';

export const ROUTE_DIRECTION_LABEL: Record<RouteDirection, string> = {
  AM: 'Morning',
  PM: 'Afternoon',
};

export const ROUTE_STATUS_LABEL: Record<RouteStatus, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  ARCHIVED: 'Archived',
};

export const ROUTE_STATUS_PILL: Record<RouteStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  INACTIVE: 'bg-amber-100 text-amber-700',
  ARCHIVED: 'bg-gray-100 text-gray-700',
};

export const VEHICLE_TYPE_LABEL: Record<VehicleType, string> = {
  BUS: 'Bus',
  MINIBUS: 'Minibus',
  VAN: 'Van',
};

export const VEHICLE_STATUS_LABEL: Record<VehicleStatus, string> = {
  ACTIVE: 'Active',
  MAINTENANCE: 'In maintenance',
  RETIRED: 'Retired',
};

export const VEHICLE_STATUS_PILL: Record<VehicleStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  MAINTENANCE: 'bg-amber-100 text-amber-700',
  RETIRED: 'bg-gray-100 text-gray-700',
};

export const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  INSURANCE: 'Insurance',
  REGISTRATION: 'Registration',
  MOT: 'MOT',
  INSPECTION: 'Inspection certificate',
};

export const INSPECTION_STATUS_LABEL: Record<InspectionStatus, string> = {
  PASS: 'Pass',
  FAIL: 'Fail',
  CONDITIONAL: 'Conditional',
};

export const INSPECTION_STATUS_PILL: Record<InspectionStatus, string> = {
  PASS: 'bg-emerald-100 text-emerald-700',
  FAIL: 'bg-rose-100 text-rose-700',
  CONDITIONAL: 'bg-amber-100 text-amber-700',
};

export const INSPECTION_ITEM_LABEL: Record<InspectionItemStatus, string> = {
  PASS: 'Pass',
  FAIL: 'Fail',
  NOT_APPLICABLE: 'N/A',
};

export const INSPECTION_ITEM_PILL: Record<InspectionItemStatus, string> = {
  PASS: 'bg-emerald-100 text-emerald-700',
  FAIL: 'bg-rose-100 text-rose-700',
  NOT_APPLICABLE: 'bg-gray-100 text-gray-700',
};

export const CREDENTIAL_TYPE_LABEL: Record<CredentialType, string> = {
  CDL: 'CDL',
  MEDICAL_CERTIFICATE: 'Medical certificate',
  BACKGROUND_CHECK: 'Background check',
  FIRST_AID: 'First aid',
};

export const CREDENTIAL_STATUS_LABEL: Record<CredentialStatus, string> = {
  VALID: 'Valid',
  EXPIRING_SOON: 'Expiring soon',
  EXPIRED: 'Expired',
};

export const CREDENTIAL_STATUS_PILL: Record<CredentialStatus, string> = {
  VALID: 'bg-emerald-100 text-emerald-700',
  EXPIRING_SOON: 'bg-amber-100 text-amber-700',
  EXPIRED: 'bg-rose-100 text-rose-700',
};

export const PASS_TYPE_LABEL: Record<PassType, string> = {
  ANNUAL: 'Annual',
  TERM: 'Term',
  DAILY: 'Daily',
};

export const SCAN_DIRECTION_LABEL: Record<ScanDirection, string> = {
  BOARDING: 'Boarding',
  ALIGHTING: 'Alighting',
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const RUN_STATUS_PILL: Record<RunStatus, string> = {
  IN_PROGRESS: 'bg-sky-100 text-sky-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  CANCELLED: 'bg-gray-100 text-gray-700',
};

export const NO_SHOW_RESOLUTION_LABEL: Record<NoShowResolution, string> = {
  ABSENT_CONFIRMED: 'Absent confirmed',
  LATE_ARRIVAL: 'Late arrival',
  PARENT_NOTIFIED: 'Parent notified',
  FALSE_ALARM: 'False alarm',
};

export const CHANGE_REQUEST_TYPE_LABEL: Record<TransportChangeRequestType, string> = {
  DIFFERENT_STOP: 'Different stop',
  NO_BUS: 'No bus',
  DIFFERENT_ROUTE: 'Different route',
};

export const CHANGE_REQUEST_STATUS_LABEL: Record<TransportChangeRequestStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export const CHANGE_REQUEST_STATUS_PILL: Record<TransportChangeRequestStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-rose-100 text-rose-700',
};

export const CHANGE_LOG_TYPE_LABEL: Record<RouteChangeLogType, string> = {
  STOP_ADDED: 'Stop added',
  STOP_REMOVED: 'Stop removed',
  STOP_REORDERED: 'Stop reordered',
  STOP_TIME_CHANGED: 'Stop time changed',
  STUDENT_ADDED: 'Student added',
  STUDENT_REMOVED: 'Student removed',
  ROUTE_ACTIVATED: 'Route activated',
  ROUTE_DEACTIVATED: 'Route deactivated',
};

export function expiryUrgency(daysUntilExpiry: number, isExpired: boolean): string {
  if (isExpired) return 'bg-rose-100 text-rose-700';
  if (daysUntilExpiry <= 30) return 'bg-amber-100 text-amber-700';
  return 'bg-emerald-100 text-emerald-700';
}

export function formatTimeOfDay(hhmmss: string | null | undefined): string {
  if (!hhmmss) return '—';
  const m = hhmmss.match(/^(\d{2}):(\d{2})/);
  if (!m) return hhmmss;
  return `${m[1]}:${m[2]}`;
}

export function formatDateOnly(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}
