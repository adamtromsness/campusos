import type {
  ApprovalRequestStatus,
  ApprovalStepStatus,
  ApproverType,
} from './types';

export const REQUEST_STATUSES: ApprovalRequestStatus[] = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'WITHDRAWN',
];

export const STEP_STATUSES: ApprovalStepStatus[] = [
  'AWAITING',
  'APPROVED',
  'REJECTED',
  'SKIPPED',
];

export const REQUEST_STATUS_LABELS: Record<ApprovalRequestStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  WITHDRAWN: 'Withdrawn',
};

export const STEP_STATUS_LABELS: Record<ApprovalStepStatus, string> = {
  AWAITING: 'Awaiting',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  SKIPPED: 'Skipped',
};

export const REQUEST_STATUS_PILL: Record<ApprovalRequestStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-rose-100 text-rose-800',
  CANCELLED: 'bg-gray-200 text-gray-600',
  WITHDRAWN: 'bg-gray-200 text-gray-600',
};

export const STEP_STATUS_PILL: Record<ApprovalStepStatus, string> = {
  AWAITING: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-rose-100 text-rose-800',
  SKIPPED: 'bg-gray-200 text-gray-500',
};

export const APPROVER_TYPE_LABELS: Record<ApproverType, string> = {
  SPECIFIC_USER: 'Specific user',
  ROLE: 'Role',
  MANAGER: 'Manager (auto-resolved)',
  DEPARTMENT_HEAD: 'Department head (auto-resolved)',
};

/**
 * Lookup the active step (the one currently AWAITING) on an approval
 * request and return a "Step N of M" phrase. When the request is
 * resolved, returns the final-step phrase.
 */
export function formatStepPosition(
  steps: Array<{ stepOrder: number; status: ApprovalStepStatus }>,
  totalSteps: number,
): string {
  const awaiting = steps.find((s) => s.status === 'AWAITING');
  if (awaiting) return 'Step ' + awaiting.stepOrder + ' of ' + totalSteps;
  // No awaiting step — request resolved or skipped.
  const last = steps.reduce<typeof steps[number] | null>((acc, s) => {
    if (acc === null) return s;
    return s.stepOrder > acc.stepOrder ? s : acc;
  }, null);
  if (last) return 'Step ' + last.stepOrder + ' of ' + totalSteps;
  return 'No steps';
}
