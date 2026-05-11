'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type RjConferenceStatus =
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'AGREEMENT_REACHED'
  | 'RESOLVED_SUCCESSFULLY'
  | 'FAILED';

export type RjActionStatus = 'PENDING' | 'COMPLETED' | 'OVERDUE';

export type PeerMediationStatus = 'REFERRED' | 'SCHEDULED' | 'RESOLVED' | 'UNRESOLVED';

export type BehaviourTransactionType = 'AWARD' | 'REDEMPTION';
export type BehaviourRewardType = 'INDIVIDUAL' | 'CLASS' | 'DIGITAL' | 'PHYSICAL';

export interface RjActionDto {
  id: string;
  conferenceId: string;
  actionDescription: string;
  assignedToStudentId: string;
  assignedToStudentName: string | null;
  dueDate: string;
  status: RjActionStatus;
  completedAt: string | null;
  verifiedBy: string | null;
  verifiedByName: string | null;
  evidenceNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RjConferenceDto {
  id: string;
  schoolId: string;
  incidentId: string;
  facilitatorId: string | null;
  facilitatorName: string | null;
  offenderStudentId: string;
  offenderStudentName: string | null;
  harmedPartyIds: string[];
  parentNotifiedAt: string | null;
  conferenceDate: string | null;
  conferenceLocation: string | null;
  conferenceNotes: string | null;
  status: RjConferenceStatus;
  resolutionDate: string | null;
  actions?: RjActionDto[];
  createdAt: string;
  updatedAt: string;
}

export interface PeerMediationDto {
  id: string;
  schoolId: string;
  mediatorStudentId: string;
  mediatorStudentName: string | null;
  partyAStudentId: string;
  partyAStudentName: string | null;
  partyBStudentId: string;
  partyBStudentName: string | null;
  referredBy: string | null;
  referredByName: string | null;
  conflictDescription: string;
  mediationDate: string | null;
  outcome: string | null;
  status: PeerMediationStatus;
  isMediatorTrained: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BehaviourRewardDto {
  id: string;
  schoolId: string;
  rewardName: string;
  description: string | null;
  pointsCost: number;
  rewardType: BehaviourRewardType;
  quantityAvailable: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PositivePointsTxDto {
  id: string;
  studentId: string;
  studentName: string | null;
  awardedBy: string | null;
  awardedByName: string | null;
  transactionType: BehaviourTransactionType;
  category: string | null;
  points: number;
  reason: string;
  rewardId: string | null;
  rewardName: string | null;
  awardedAt: string;
}

export interface PositiveBalanceDto {
  studentId: string;
  awarded: number;
  redeemed: number;
  balance: number;
  history: PositivePointsTxDto[];
}

export interface RedemptionDto {
  transactionId: string;
  rewardId: string;
  rewardName: string;
  pointsSpent: number;
  newBalance: number;
}

export interface PositiveCategoryDto {
  name: string;
  description?: string;
  defaultPoints: number;
}

export interface BipFeedbackDto {
  id: string;
  planId: string;
  teacherId: string | null;
  teacherName: string | null;
  requestedBy: string | null;
  requestedByName: string | null;
  requestedAt: string;
  submittedAt: string | null;
  strategiesObserved: string[] | null;
  overallEffectiveness: string | null;
  classroomObservations: string | null;
  recommendedAdjustments: string | null;
}

const P = '/api/v1';

// ── RJ Conferences ────────────────────────────────────────────

export function useRjConferences() {
  return useQuery({
    queryKey: ['behaviour-advanced', 'rj-conferences'],
    queryFn: () => apiFetch<RjConferenceDto[]>(`${P}/behaviour/rj-conferences`),
    staleTime: 30000,
  });
}

export function useRjConference(id: string | null) {
  return useQuery({
    queryKey: ['behaviour-advanced', 'rj-conferences', id],
    queryFn: () => apiFetch<RjConferenceDto>(`${P}/behaviour/rj-conferences/${id}`),
    enabled: !!id,
  });
}

export function useCreateRjConference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      incidentId: string;
      offenderStudentId: string;
      harmedPartyIds: string[];
      conferenceDate?: string;
      conferenceLocation?: string;
      conferenceNotes?: string;
    }) =>
      apiFetch<RjConferenceDto>(`${P}/behaviour/rj-conferences`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['behaviour-advanced'] }),
  });
}

export function useUpdateRjConference(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      status?: 'SCHEDULED' | 'IN_PROGRESS' | 'AGREEMENT_REACHED' | 'FAILED';
      conferenceDate?: string;
      conferenceLocation?: string;
      conferenceNotes?: string;
    }) =>
      apiFetch<RjConferenceDto>(`${P}/behaviour/rj-conferences/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['behaviour-advanced'] }),
  });
}

export function useAddRjAction(conferenceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      actionDescription: string;
      assignedToStudentId: string;
      dueDate: string;
    }) =>
      apiFetch<RjActionDto>(`${P}/behaviour/rj-conferences/${conferenceId}/actions`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['behaviour-advanced'] }),
  });
}

export function useCompleteRjAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, evidenceNotes }: { id: string; evidenceNotes?: string }) =>
      apiFetch<{ action: RjActionDto; conferenceResolved: boolean }>(
        `${P}/behaviour/rj-actions/${id}/complete`,
        { method: 'PATCH', body: JSON.stringify({ evidenceNotes }) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['behaviour-advanced'] }),
  });
}

// ── Peer Mediations ───────────────────────────────────────────

export function usePeerMediations(status?: PeerMediationStatus) {
  return useQuery({
    queryKey: ['behaviour-advanced', 'peer-mediations', status],
    queryFn: () => {
      const qs = status ? `?status=${status}` : '';
      return apiFetch<PeerMediationDto[]>(`${P}/behaviour/peer-mediations${qs}`);
    },
    staleTime: 30000,
  });
}

export function useCreatePeerMediation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      mediatorStudentId: string;
      partyAStudentId: string;
      partyBStudentId: string;
      conflictDescription: string;
    }) =>
      apiFetch<PeerMediationDto>(`${P}/behaviour/peer-mediations`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['behaviour-advanced'] }),
  });
}

export function useUpdatePeerMediation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      status?: PeerMediationStatus;
      mediationDate?: string;
      outcome?: string;
    }) =>
      apiFetch<PeerMediationDto>(`${P}/behaviour/peer-mediations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['behaviour-advanced'] }),
  });
}

export function usePeerMediators() {
  return useQuery({
    queryKey: ['behaviour-advanced', 'peer-mediators'],
    queryFn: () =>
      apiFetch<Array<{ studentId: string; studentName: string | null }>>(
        `${P}/behaviour/peer-mediators`,
      ),
    staleTime: 300000,
  });
}

// ── Positive Behaviour ───────────────────────────────────────

export function useAwardPoints() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      studentId: string;
      category: string;
      points: number;
      reason: string;
    }) =>
      apiFetch<PositivePointsTxDto>(`${P}/behaviour/positive-points`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['behaviour-advanced'] }),
  });
}

export function useStudentPointsBalance(studentId: string | null) {
  return useQuery({
    queryKey: ['behaviour-advanced', 'points', studentId],
    queryFn: () => apiFetch<PositiveBalanceDto>(`${P}/behaviour/positive-points/${studentId}`),
    enabled: !!studentId,
  });
}

export function useBehaviourRewards(includeInactive = false) {
  return useQuery({
    queryKey: ['behaviour-advanced', 'rewards', includeInactive],
    queryFn: () =>
      apiFetch<BehaviourRewardDto[]>(
        `${P}/behaviour/rewards${includeInactive ? '?includeInactive=true' : ''}`,
      ),
    staleTime: 60000,
  });
}

export function useCreateReward() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      rewardName: string;
      description?: string;
      pointsCost: number;
      rewardType: BehaviourRewardType;
      quantityAvailable?: number;
    }) =>
      apiFetch<BehaviourRewardDto>(`${P}/behaviour/rewards`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['behaviour-advanced'] }),
  });
}

export function useRedeemReward() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rewardId, studentId }: { rewardId: string; studentId: string }) =>
      apiFetch<RedemptionDto>(`${P}/behaviour/rewards/${rewardId}/redeem`, {
        method: 'POST',
        body: JSON.stringify({ studentId }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['behaviour-advanced'] }),
  });
}

// ── Category config ──────────────────────────────────────────

export function usePositiveCategories() {
  return useQuery({
    queryKey: ['behaviour-advanced', 'categories'],
    queryFn: () => apiFetch<PositiveCategoryDto[]>(`${P}/behaviour/positive-categories`),
    staleTime: 300000,
  });
}

export function useUpdatePositiveCategories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { categories: PositiveCategoryDto[] }) =>
      apiFetch<PositiveCategoryDto[]>(`${P}/behaviour/positive-categories`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['behaviour-advanced', 'categories'] }),
  });
}

// ── BIP feedback (extends Cycle 11) ──────────────────────────

export function useBipFeedbackForPlan(planId: string | null) {
  return useQuery({
    queryKey: ['behaviour-advanced', 'bip-feedback', planId],
    queryFn: () => apiFetch<BipFeedbackDto[]>(`${P}/behaviour/bip/${planId}/feedback`),
    enabled: !!planId,
  });
}

export function useRequestBipFeedback(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { teacherEmployeeId: string }) =>
      apiFetch<BipFeedbackDto>(`${P}/behaviour/bip/${planId}/request-feedback`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['behaviour-advanced'] }),
  });
}

export function useSubmitBipFeedback(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      strategiesObserved?: string[];
      overallEffectiveness?:
        | 'NOT_EFFECTIVE'
        | 'SOMEWHAT_EFFECTIVE'
        | 'EFFECTIVE'
        | 'VERY_EFFECTIVE';
      classroomObservations?: string;
      recommendedAdjustments?: string;
    }) =>
      apiFetch<BipFeedbackDto>(`${P}/behaviour/bip-feedback/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['behaviour-advanced'] }),
  });
}
