import type {
  ItConfigDocCategory,
  ItInventoryAuditStatus,
  ItMonitoringAlertType,
  ItMonitoringCheckType,
  ItMonitoringLastStatus,
  ItPhoneExtensionType,
  ItRemoteActionStatus,
  ItRemoteActionType,
} from './types';

export const IT_REMOTE_ACTION_LABELS: Record<ItRemoteActionType, string> = {
  LOCK: 'Lock device',
  WIPE: 'Wipe device',
  RESTART: 'Restart',
  LOCATE: 'Locate',
  UNENROLL: 'Unenroll',
  ENABLE_LOST_MODE: 'Enable lost mode',
  DISABLE_LOST_MODE: 'Disable lost mode',
};

export const IT_REMOTE_ACTION_PILL: Record<ItRemoteActionType, string> = {
  LOCK: 'bg-amber-100 text-amber-700',
  WIPE: 'bg-rose-700 text-white',
  RESTART: 'bg-sky-100 text-sky-700',
  LOCATE: 'bg-violet-100 text-violet-700',
  UNENROLL: 'bg-gray-100 text-gray-700',
  ENABLE_LOST_MODE: 'bg-orange-100 text-orange-700',
  DISABLE_LOST_MODE: 'bg-emerald-100 text-emerald-700',
};

export const IT_REMOTE_ACTION_STATUS_LABELS: Record<ItRemoteActionStatus, string> = {
  PENDING: 'Pending',
  SENT: 'Sent',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

export const IT_REMOTE_ACTION_STATUS_PILL: Record<ItRemoteActionStatus, string> = {
  PENDING: 'bg-gray-100 text-gray-700',
  SENT: 'bg-sky-100 text-sky-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-rose-100 text-rose-700',
};

export const IT_AUDIT_STATUS_LABELS: Record<ItInventoryAuditStatus, string> = {
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
};

export const IT_AUDIT_STATUS_PILL: Record<ItInventoryAuditStatus, string> = {
  IN_PROGRESS: 'bg-sky-100 text-sky-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
};

export const IT_PHONE_EXTENSION_LABELS: Record<ItPhoneExtensionType, string> = {
  DESK: 'Desk',
  CLASSROOM: 'Classroom',
  OFFICE: 'Office',
  COMMON_AREA: 'Common area',
  FAX: 'Fax',
};

export const IT_PHONE_EXTENSION_PILL: Record<ItPhoneExtensionType, string> = {
  DESK: 'bg-sky-100 text-sky-700',
  CLASSROOM: 'bg-violet-100 text-violet-700',
  OFFICE: 'bg-amber-100 text-amber-700',
  COMMON_AREA: 'bg-emerald-100 text-emerald-700',
  FAX: 'bg-gray-100 text-gray-700',
};

export const IT_DOC_CATEGORY_LABELS: Record<ItConfigDocCategory, string> = {
  NETWORK_TOPOLOGY: 'Network topology',
  SERVER_CONFIG: 'Server config',
  WIFI: 'WiFi',
  VOIP: 'VOIP',
  FIREWALL: 'Firewall',
  BACKUP: 'Backup',
  OTHER: 'Other',
};

export const IT_DOC_CATEGORY_PILL: Record<ItConfigDocCategory, string> = {
  NETWORK_TOPOLOGY: 'bg-sky-100 text-sky-700',
  SERVER_CONFIG: 'bg-violet-100 text-violet-700',
  WIFI: 'bg-emerald-100 text-emerald-700',
  VOIP: 'bg-amber-100 text-amber-700',
  FIREWALL: 'bg-rose-100 text-rose-700',
  BACKUP: 'bg-orange-100 text-orange-700',
  OTHER: 'bg-gray-100 text-gray-700',
};

export const IT_MONITORING_CHECK_TYPE_LABELS: Record<ItMonitoringCheckType, string> = {
  HTTP: 'HTTP',
  PING: 'Ping',
  TCP: 'TCP',
  MANUAL: 'Manual',
};

export const IT_MONITORING_STATUS_LABELS: Record<ItMonitoringLastStatus, string> = {
  HEALTHY: 'Healthy',
  DEGRADED: 'Degraded',
  DOWN: 'Down',
  UNKNOWN: 'Unknown',
};

export const IT_MONITORING_STATUS_PILL: Record<ItMonitoringLastStatus, string> = {
  HEALTHY: 'bg-emerald-100 text-emerald-700',
  DEGRADED: 'bg-amber-100 text-amber-700',
  DOWN: 'bg-rose-700 text-white',
  UNKNOWN: 'bg-gray-100 text-gray-700',
};

export const IT_ALERT_TYPE_LABELS: Record<ItMonitoringAlertType, string> = {
  DOWN: 'Down',
  DEGRADED: 'Degraded',
  RECOVERED: 'Recovered',
};

export const IT_ALERT_TYPE_PILL: Record<ItMonitoringAlertType, string> = {
  DOWN: 'bg-rose-700 text-white',
  DEGRADED: 'bg-amber-100 text-amber-700',
  RECOVERED: 'bg-emerald-100 text-emerald-700',
};

export function formatItDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString();
}

export function formatItDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function formatItCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatItRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function warrantyExpiryTone(daysUntilExpiry: number): string {
  if (daysUntilExpiry <= 0) return 'bg-rose-100 text-rose-700';
  if (daysUntilExpiry <= 14) return 'bg-amber-100 text-amber-700';
  return 'bg-emerald-100 text-emerald-700';
}

export const IT_REMOTE_ACTION_TYPES: ItRemoteActionType[] = [
  'LOCK',
  'WIPE',
  'RESTART',
  'LOCATE',
  'UNENROLL',
  'ENABLE_LOST_MODE',
  'DISABLE_LOST_MODE',
];

export const IT_PHONE_EXTENSION_TYPES: ItPhoneExtensionType[] = [
  'DESK',
  'CLASSROOM',
  'OFFICE',
  'COMMON_AREA',
  'FAX',
];

export const IT_DOC_CATEGORIES: ItConfigDocCategory[] = [
  'NETWORK_TOPOLOGY',
  'SERVER_CONFIG',
  'WIFI',
  'VOIP',
  'FIREWALL',
  'BACKUP',
  'OTHER',
];

export const IT_MONITORING_CHECK_TYPES: ItMonitoringCheckType[] = ['HTTP', 'PING', 'TCP', 'MANUAL'];
