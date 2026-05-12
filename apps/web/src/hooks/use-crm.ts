'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

const PREFIX = '/api/v1/internal/crm';

/**
 * P2-21a — Internal CRM hooks.
 *
 * All endpoints under /api/v1/internal/crm/* are platform-scoped:
 * no tenant header required, permissions resolved against the
 * PLATFORM IAM scope. Platform Admin sees every account; everyone
 * else 403s at the gate.
 */

export type AccountStatus =
  | 'PROSPECT'
  | 'PILOT'
  | 'ONBOARDING'
  | 'ACTIVE'
  | 'CHURNED'
  | 'SUSPENDED';
export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED';
export type RenewalStage =
  | 'UPCOMING'
  | 'IN_DISCUSSION'
  | 'PROPOSAL_SENT'
  | 'COMMITTED'
  | 'CHURNING';
export type RiskLevel = 'HEALTHY' | 'AT_RISK' | 'CRITICAL';
export type ChecklistStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
export type TaskStatus = 'PENDING' | 'COMPLETED' | 'SKIPPED';

export interface AccountDto {
  id: string;
  schoolId: string | null;
  organisationId: string | null;
  accountName: string;
  pricingBandId: string | null;
  status: AccountStatus;
  billingEmail: string;
  billingAddressJson: Record<string, unknown> | null;
  stripeCustomerId: string | null;
  schoolChampionPersonId: string | null;
  signedDate: string | null;
  goLiveDate: string | null;
  renewalDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionDto {
  id: string;
  accountId: string;
  planName: string;
  stripeSubscriptionId: string | null;
  billingInterval: 'MONTHLY' | 'ANNUAL';
  mrrCents: number;
  studentCountAtSign: number | null;
  status: SubscriptionStatus;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContactDto {
  id: string;
  accountId: string;
  personId: string | null;
  name: string;
  email: string;
  phone: string | null;
  role:
    | 'DECISION_MAKER'
    | 'CHAMPION'
    | 'ADMIN_CONTACT'
    | 'BILLING_CONTACT'
    | 'TECHNICAL_CONTACT'
    | 'OTHER';
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InteractionDto {
  id: string;
  accountId: string;
  contactId: string | null;
  interactionType: 'CALL' | 'EMAIL' | 'MEETING' | 'DEMO' | 'SUPPORT' | 'NOTE' | 'OTHER';
  subject: string;
  notes: string | null;
  loggedBy: string;
  interactionAt: string;
  createdAt: string;
}

export interface OnboardingTaskDto {
  id: string;
  checklistId: string;
  taskName: string;
  taskCategory: 'TECHNICAL' | 'DATA_MIGRATION' | 'TRAINING' | 'CONFIGURATION' | 'GO_LIVE';
  sortOrder: number;
  status: TaskStatus;
  completedAt: string | null;
  completedBy: string | null;
}

export interface OnboardingChecklistDto {
  id: string;
  accountId: string;
  templateVersion: number;
  startedAt: string | null;
  completedAt: string | null;
  status: ChecklistStatus;
  tasks: OnboardingTaskDto[];
  taskCounts: { total: number; pending: number; completed: number; skipped: number };
}

export interface HealthScoreDto {
  id: string;
  accountId: string;
  scoreDate: string;
  overallScore: number;
  adoptionScore: number | null;
  engagementScore: number | null;
  supportTicketScore: number | null;
  npsScore: number | null;
  riskLevel: RiskLevel;
  createdAt: string;
}

export interface RenewalDto {
  id: string;
  accountId: string;
  renewalDate: string;
  currentMrrCents: number;
  proposedMrrCents: number | null;
  stage: RenewalStage;
  riskFactors: string[];
  assignedCsm: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MrrSummaryDto {
  totalMrrCents: number;
  activeSubscriptions: number;
  trialingSubscriptions: number;
  pastDueSubscriptions: number;
  cancelledSubscriptions: number;
}

export interface AccountTimelineDto {
  account: AccountDto;
  interactions: InteractionDto[];
  healthScores: HealthScoreDto[];
  onboardingChecklist: OnboardingChecklistDto | null;
  subscriptions: SubscriptionDto[];
  renewals: RenewalDto[];
}

export interface AtRiskEntry {
  account: AccountDto;
  score: HealthScoreDto;
}

// ── Hooks ────────────────────────────────────────────────────────

export function useCrmAccounts(args?: { status?: AccountStatus }) {
  const params = args?.status ? `?status=${encodeURIComponent(args.status)}` : '';
  return useQuery<AccountDto[]>({
    queryKey: ['crm', 'accounts', args],
    queryFn: () => apiFetch<AccountDto[]>(`${PREFIX}/accounts${params}`),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export function useCrmAccount(id: string | null | undefined) {
  return useQuery<AccountDto>({
    queryKey: ['crm', 'accounts', id],
    queryFn: () => apiFetch<AccountDto>(`${PREFIX}/accounts/${id}`),
    enabled: !!id,
  });
}

export function useCrmAccountTimeline(id: string | null | undefined) {
  return useQuery<AccountTimelineDto>({
    queryKey: ['crm', 'accounts', id, 'timeline'],
    queryFn: () => apiFetch<AccountTimelineDto>(`${PREFIX}/accounts/${id}/timeline`),
    enabled: !!id,
  });
}

export function useCrmMrrSummary() {
  return useQuery<MrrSummaryDto>({
    queryKey: ['crm', 'mrr-summary'],
    queryFn: () => apiFetch<MrrSummaryDto>(`${PREFIX}/mrr-summary`),
    refetchOnWindowFocus: true,
    staleTime: 60_000,
  });
}

export function useCrmAtRiskAccounts() {
  return useQuery<AtRiskEntry[]>({
    queryKey: ['crm', 'health', 'at-risk'],
    queryFn: () => apiFetch<AtRiskEntry[]>(`${PREFIX}/health/at-risk`),
    refetchOnWindowFocus: true,
    staleTime: 60_000,
  });
}

export function useCrmRenewals(stage?: RenewalStage) {
  const params = stage ? `?stage=${encodeURIComponent(stage)}` : '';
  return useQuery<RenewalDto[]>({
    queryKey: ['crm', 'renewals', stage],
    queryFn: () => apiFetch<RenewalDto[]>(`${PREFIX}/renewals${params}`),
    refetchOnWindowFocus: true,
  });
}

export function useCrmUpcomingRenewals(days = 90) {
  return useQuery<RenewalDto[]>({
    queryKey: ['crm', 'renewals', 'upcoming', days],
    queryFn: () => apiFetch<RenewalDto[]>(`${PREFIX}/renewals/upcoming?days=${days}`),
  });
}

export interface TransitionPayload {
  status: AccountStatus;
}

export function useTransitionAccountStatus(id: string) {
  const qc = useQueryClient();
  return useMutation<AccountDto, Error, TransitionPayload>({
    mutationFn: (body) =>
      apiFetch<AccountDto>(`${PREFIX}/accounts/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm', 'accounts'] });
      qc.invalidateQueries({ queryKey: ['crm', 'mrr-summary'] });
      qc.invalidateQueries({ queryKey: ['crm', 'renewals'] });
    },
  });
}

export function usePatchOnboardingTask(taskId: string) {
  const qc = useQueryClient();
  return useMutation<OnboardingChecklistDto, Error, { status: TaskStatus }>({
    mutationFn: (body) =>
      apiFetch<OnboardingChecklistDto>(`${PREFIX}/onboarding-tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm', 'accounts'] });
    },
  });
}

export function useInitOnboarding(accountId: string) {
  const qc = useQueryClient();
  return useMutation<OnboardingChecklistDto, Error, Record<string, unknown>>({
    mutationFn: (body) =>
      apiFetch<OnboardingChecklistDto>(`${PREFIX}/accounts/${accountId}/onboarding`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm', 'accounts', accountId] });
    },
  });
}

export function useLogInteraction(accountId: string) {
  const qc = useQueryClient();
  return useMutation<
    InteractionDto,
    Error,
    {
      interactionType: InteractionDto['interactionType'];
      subject: string;
      notes?: string;
      contactId?: string;
      interactionAt: string;
    }
  >({
    mutationFn: (body) =>
      apiFetch<InteractionDto>(`${PREFIX}/accounts/${accountId}/interactions`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm', 'accounts', accountId] });
    },
  });
}

export function useRecomputeHealth(accountId: string) {
  const qc = useQueryClient();
  return useMutation<HealthScoreDto, Error, void>({
    mutationFn: () =>
      apiFetch<HealthScoreDto>(`${PREFIX}/accounts/${accountId}/health/recompute`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm', 'accounts', accountId] });
      qc.invalidateQueries({ queryKey: ['crm', 'health', 'at-risk'] });
    },
  });
}

// ── Formatting helpers ───────────────────────────────────────────

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export const STATUS_PILL: Record<AccountStatus, string> = {
  PROSPECT: 'bg-gray-100 text-gray-700',
  PILOT: 'bg-sky-100 text-sky-700',
  ONBOARDING: 'bg-amber-100 text-amber-800',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  CHURNED: 'bg-rose-100 text-rose-700',
  SUSPENDED: 'bg-orange-100 text-orange-700',
};

export const RISK_PILL: Record<RiskLevel, string> = {
  HEALTHY: 'bg-emerald-100 text-emerald-700',
  AT_RISK: 'bg-amber-100 text-amber-700',
  CRITICAL: 'bg-rose-100 text-rose-700',
};

export const STAGE_PILL: Record<RenewalStage, string> = {
  UPCOMING: 'bg-gray-100 text-gray-700',
  IN_DISCUSSION: 'bg-sky-100 text-sky-700',
  PROPOSAL_SENT: 'bg-violet-100 text-violet-700',
  COMMITTED: 'bg-emerald-100 text-emerald-700',
  CHURNING: 'bg-rose-100 text-rose-700',
};

export const RENEWAL_STAGES: RenewalStage[] = [
  'UPCOMING',
  'IN_DISCUSSION',
  'PROPOSAL_SENT',
  'COMMITTED',
  'CHURNING',
];

export const ACCOUNT_STATUSES: AccountStatus[] = [
  'PROSPECT',
  'PILOT',
  'ONBOARDING',
  'ACTIVE',
  'CHURNED',
  'SUSPENDED',
];
