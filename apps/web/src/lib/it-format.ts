import type {
  ItAccessTier,
  ItAssetCondition,
  ItAssetStatus,
  ItDamageSeverity,
  ItInfraItemType,
  ItLicenceType,
  ItMdmAlertType,
  ItProcurementStatus,
  ItRepairStatus,
  ItSelectionContext,
  ItSelectionStatus,
} from './types';

export const IT_ASSET_STATUS_LABELS: Record<ItAssetStatus, string> = {
  AVAILABLE: 'Available',
  ASSIGNED: 'Assigned',
  REPAIR: 'In repair',
  LOST: 'Lost',
  RETIRED: 'Retired',
};

export const IT_ASSET_STATUS_PILL: Record<ItAssetStatus, string> = {
  AVAILABLE: 'bg-emerald-100 text-emerald-700',
  ASSIGNED: 'bg-sky-100 text-sky-700',
  REPAIR: 'bg-amber-100 text-amber-700',
  LOST: 'bg-rose-100 text-rose-700',
  RETIRED: 'bg-gray-100 text-gray-600',
};

export const IT_CONDITIONS: ItAssetCondition[] = ['EXCELLENT', 'GOOD', 'FAIR', 'DAMAGED'];

export const IT_LICENCE_TYPE_LABELS: Record<ItLicenceType, string> = {
  PER_SEAT: 'Per-seat',
  SITE: 'Site licence',
  SUBSCRIPTION: 'Subscription',
};

export const IT_TIER_LABELS: Record<ItAccessTier, string> = {
  STANDARD: 'Standard',
  ELEVATED: 'Elevated',
  CRITICAL: 'Critical',
};

export const IT_TIER_PILL: Record<ItAccessTier, string> = {
  STANDARD: 'bg-sky-100 text-sky-700',
  ELEVATED: 'bg-amber-100 text-amber-700',
  CRITICAL: 'bg-rose-700 text-white',
};

export const IT_DAMAGE_SEVERITY_LABELS: Record<ItDamageSeverity, string> = {
  MINOR: 'Minor',
  MODERATE: 'Moderate',
  SEVERE: 'Severe',
  TOTAL_LOSS: 'Total loss',
};

export const IT_DAMAGE_PILL: Record<ItDamageSeverity, string> = {
  MINOR: 'bg-gray-100 text-gray-700',
  MODERATE: 'bg-amber-100 text-amber-700',
  SEVERE: 'bg-orange-100 text-orange-700',
  TOTAL_LOSS: 'bg-rose-100 text-rose-700',
};

export const IT_REPAIR_STATUS_LABELS: Record<ItRepairStatus, string> = {
  PENDING: 'Pending',
  IN_REPAIR: 'In repair',
  COMPLETED: 'Completed',
  UNREPAIRABLE: 'Unrepairable',
};

export const IT_REPAIR_STATUS_PILL: Record<ItRepairStatus, string> = {
  PENDING: 'bg-gray-100 text-gray-700',
  IN_REPAIR: 'bg-amber-100 text-amber-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  UNREPAIRABLE: 'bg-rose-100 text-rose-700',
};

export const IT_MDM_ALERT_LABELS: Record<ItMdmAlertType, string> = {
  NON_COMPLIANT: 'Non-compliant',
  STALE_CHECKIN: 'Stale check-in',
  OS_OUTDATED: 'OS outdated',
  POLICY_VIOLATION: 'Policy violation',
  JAILBREAK_DETECTED: 'Jailbreak detected',
  OTHER: 'Other',
};

export const IT_MDM_ALERT_PILL: Record<ItMdmAlertType, string> = {
  NON_COMPLIANT: 'bg-rose-100 text-rose-700',
  STALE_CHECKIN: 'bg-amber-100 text-amber-700',
  OS_OUTDATED: 'bg-amber-100 text-amber-700',
  POLICY_VIOLATION: 'bg-orange-100 text-orange-700',
  JAILBREAK_DETECTED: 'bg-rose-700 text-white',
  OTHER: 'bg-gray-100 text-gray-700',
};

export const IT_INFRA_LABELS: Record<ItInfraItemType, string> = {
  SWITCH: 'Switch',
  ROUTER: 'Router',
  ACCESS_POINT: 'Access point',
  FIREWALL: 'Firewall',
  SERVER: 'Server',
  STORAGE_ARRAY: 'Storage',
  UPS: 'UPS',
  PRINTER: 'Printer',
  OTHER: 'Other',
};

export const IT_PROCUREMENT_STATUS_LABELS: Record<ItProcurementStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  ORDERED: 'Ordered',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

export const IT_PROCUREMENT_PILL: Record<ItProcurementStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-sky-100 text-sky-700',
  ORDERED: 'bg-violet-100 text-violet-700',
  DELIVERED: 'bg-emerald-100 text-emerald-700',
  CANCELLED: 'bg-gray-100 text-gray-500',
};

export const IT_SELECTION_STATUS_LABELS: Record<ItSelectionStatus, string> = {
  PENDING: 'Pending',
  SELECTED: 'Selected',
  APPROVED: 'Approved',
  PROVISIONED: 'Provisioned',
  REJECTED: 'Rejected',
};

export const IT_SELECTION_STATUS_PILL: Record<ItSelectionStatus, string> = {
  PENDING: 'bg-gray-100 text-gray-700',
  SELECTED: 'bg-sky-100 text-sky-700',
  APPROVED: 'bg-violet-100 text-violet-700',
  PROVISIONED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-rose-100 text-rose-700',
};

export const IT_CONTEXT_LABELS: Record<ItSelectionContext, string> = {
  ENROLMENT: 'Enrolment',
  REFRESH: 'Refresh',
  REPLACEMENT: 'Replacement',
};

export function formatItDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString();
}

export function formatItDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}

export function formatItCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatItUtilisation(pct: number | null): string {
  if (pct === null) return '—';
  return `${pct}%`;
}

export function utilisationPill(pct: number | null): string {
  if (pct === null) return 'bg-gray-100 text-gray-700';
  if (pct >= 90) return 'bg-rose-100 text-rose-700';
  if (pct >= 80) return 'bg-amber-100 text-amber-700';
  return 'bg-emerald-100 text-emerald-700';
}
