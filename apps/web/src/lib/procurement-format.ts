import type {
  PrcCommitmentStatus,
  PrcDestinationModule,
  PrcInspectionOutcome,
  PrcPOStatus,
  PrcReceiptCondition,
  PrcReqStatus,
  PrcReturnResolution,
  PrcReturnStatus,
  PrcReturnType,
  PrcUrgency,
} from './types';

export const PRC_URGENCIES: PrcUrgency[] = ['ROUTINE', 'URGENT', 'EMERGENCY'];
export const PRC_REQ_STATUSES: PrcReqStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'DEPT_APPROVED',
  'ADMIN_APPROVED',
  'DISTRICT_APPROVED',
  'ORDERED',
  'RECEIVED',
  'DISTRIBUTED',
  'CLOSED',
  'REJECTED',
];
export const PRC_DESTINATION_MODULES: PrcDestinationModule[] = [
  'tech',
  'trn',
  'fds',
  'lib',
  'ath',
  'ext',
  'fac',
  'str',
  'general',
];
export const PRC_PO_STATUSES: PrcPOStatus[] = [
  'DRAFT',
  'ISSUED',
  'ACKNOWLEDGED',
  'SHIPPED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
];
export const PRC_INSPECTION_OUTCOMES: PrcInspectionOutcome[] = [
  'ACCEPTED',
  'ACCEPTED_WITH_DISCREPANCY',
  'REJECTED',
];
export const PRC_RECEIPT_CONDITIONS: PrcReceiptCondition[] = ['GOOD', 'DAMAGED', 'DEFECTIVE'];
export const PRC_RETURN_TYPES: PrcReturnType[] = ['DAMAGED', 'DEFECTIVE', 'WARRANTY_CLAIM'];
export const PRC_RETURN_STATUSES: PrcReturnStatus[] = [
  'INITIATED',
  'SHIPPED_TO_VENDOR',
  'RESOLVED',
  'CANCELLED',
];
export const PRC_RETURN_RESOLUTIONS: PrcReturnResolution[] = ['REPLACED', 'REFUNDED', 'CREDITED'];

export const URGENCY_LABELS: Record<PrcUrgency, string> = {
  ROUTINE: 'Routine',
  URGENT: 'Urgent',
  EMERGENCY: 'Emergency',
};

export const URGENCY_PILL: Record<PrcUrgency, string> = {
  ROUTINE: 'bg-gray-100 text-gray-700',
  URGENT: 'bg-amber-100 text-amber-700',
  EMERGENCY: 'bg-rose-700 text-white',
};

export const REQ_STATUS_LABELS: Record<PrcReqStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  DEPT_APPROVED: 'Dept approved',
  ADMIN_APPROVED: 'Admin approved',
  DISTRICT_APPROVED: 'District approved',
  ORDERED: 'Ordered',
  RECEIVED: 'Received',
  DISTRIBUTED: 'Distributed',
  CLOSED: 'Closed',
  REJECTED: 'Rejected',
};

export const REQ_STATUS_PILL: Record<PrcReqStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  SUBMITTED: 'bg-sky-100 text-sky-700',
  DEPT_APPROVED: 'bg-violet-100 text-violet-700',
  ADMIN_APPROVED: 'bg-violet-100 text-violet-700',
  DISTRICT_APPROVED: 'bg-violet-100 text-violet-700',
  ORDERED: 'bg-amber-100 text-amber-700',
  RECEIVED: 'bg-emerald-100 text-emerald-700',
  DISTRIBUTED: 'bg-emerald-200 text-emerald-800',
  CLOSED: 'bg-gray-200 text-gray-800',
  REJECTED: 'bg-rose-100 text-rose-700',
};

export const PO_STATUS_LABELS: Record<PrcPOStatus, string> = {
  DRAFT: 'Draft',
  ISSUED: 'Issued',
  ACKNOWLEDGED: 'Acknowledged',
  SHIPPED: 'Shipped',
  PARTIALLY_RECEIVED: 'Partially received',
  RECEIVED: 'Received',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

export const PO_STATUS_PILL: Record<PrcPOStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  ISSUED: 'bg-sky-100 text-sky-700',
  ACKNOWLEDGED: 'bg-sky-200 text-sky-800',
  SHIPPED: 'bg-amber-100 text-amber-700',
  PARTIALLY_RECEIVED: 'bg-amber-200 text-amber-800',
  RECEIVED: 'bg-emerald-100 text-emerald-700',
  CLOSED: 'bg-gray-200 text-gray-800',
  CANCELLED: 'bg-rose-100 text-rose-700',
};

export const DEST_MODULE_LABELS: Record<PrcDestinationModule, string> = {
  tech: 'IT / Technology',
  trn: 'Transportation',
  fds: 'Food Service',
  lib: 'Library',
  ath: 'Athletics',
  ext: 'Clubs & Activities',
  fac: 'Facilities',
  str: 'Storage / Reserve',
  general: 'General',
};

export const INSPECTION_LABELS: Record<PrcInspectionOutcome, string> = {
  ACCEPTED: 'Accepted',
  ACCEPTED_WITH_DISCREPANCY: 'Accepted with discrepancy',
  REJECTED: 'Rejected',
};

export const INSPECTION_PILL: Record<PrcInspectionOutcome, string> = {
  ACCEPTED: 'bg-emerald-100 text-emerald-700',
  ACCEPTED_WITH_DISCREPANCY: 'bg-amber-100 text-amber-700',
  REJECTED: 'bg-rose-100 text-rose-700',
};

export const RECEIPT_CONDITION_LABELS: Record<PrcReceiptCondition, string> = {
  GOOD: 'Good',
  DAMAGED: 'Damaged',
  DEFECTIVE: 'Defective',
};

export const RECEIPT_CONDITION_PILL: Record<PrcReceiptCondition, string> = {
  GOOD: 'bg-emerald-100 text-emerald-700',
  DAMAGED: 'bg-amber-100 text-amber-700',
  DEFECTIVE: 'bg-rose-100 text-rose-700',
};

export const COMMITMENT_LABELS: Record<PrcCommitmentStatus, string> = {
  COMMITTED: 'Committed',
  PARTIALLY_RELEASED: 'Partially released',
  RELEASED: 'Released',
};

export const COMMITMENT_PILL: Record<PrcCommitmentStatus, string> = {
  COMMITTED: 'bg-amber-100 text-amber-700',
  PARTIALLY_RELEASED: 'bg-amber-200 text-amber-800',
  RELEASED: 'bg-emerald-100 text-emerald-700',
};

export const RETURN_TYPE_LABELS: Record<PrcReturnType, string> = {
  DAMAGED: 'Damaged',
  DEFECTIVE: 'Defective',
  WARRANTY_CLAIM: 'Warranty claim',
};

export const RETURN_STATUS_LABELS: Record<PrcReturnStatus, string> = {
  INITIATED: 'Initiated',
  SHIPPED_TO_VENDOR: 'Shipped to vendor',
  RESOLVED: 'Resolved',
  CANCELLED: 'Cancelled',
};

export const RETURN_STATUS_PILL: Record<PrcReturnStatus, string> = {
  INITIATED: 'bg-amber-100 text-amber-700',
  SHIPPED_TO_VENDOR: 'bg-sky-100 text-sky-700',
  RESOLVED: 'bg-emerald-100 text-emerald-700',
  CANCELLED: 'bg-gray-200 text-gray-700',
};

export const RETURN_RESOLUTION_LABELS: Record<PrcReturnResolution, string> = {
  REPLACED: 'Replaced',
  REFUNDED: 'Refunded',
  CREDITED: 'Credited',
};

export function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function formatPercentage(score: number | null | undefined): string {
  if (score === null || score === undefined) return '—';
  return `${(score * 100).toFixed(1)}%`;
}

export function isOpenPo(status: PrcPOStatus): boolean {
  return !['CLOSED', 'CANCELLED'].includes(status);
}

export function isOpenReq(status: PrcReqStatus): boolean {
  return !['CLOSED', 'REJECTED'].includes(status);
}
