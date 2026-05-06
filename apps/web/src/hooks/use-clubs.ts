'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ActivityDto,
  ActivityMemberDto,
  ActivityScheduleDto,
  ActivityTypeDto,
  ApproveHourPayload,
  CanVoteDto,
  CastVotePayload,
  ConsentRecordDto,
  CreateActivityPayload,
  ElectionDto,
  ElectionResultsDto,
  FieldTripChaperoneDto,
  FieldTripDto,
  FieldTripParticipantDto,
  JoinActivityPayload,
  LogServiceHourPayload,
  ServiceHourDto,
  ServiceProgrammeDto,
  ServiceProgressDto,
  SignConsentPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ── Activities ──

export function useActivityTypes(enabled = true) {
  return useQuery({
    queryKey: ['clubs', 'activity-types'],
    queryFn: () => apiFetch<ActivityTypeDto[]>(`${PREFIX}/clubs/activity-types`),
    enabled,
  });
}

export function useActivities(
  args: { category?: string; status?: string; academicYearId?: string } = {},
  enabled = true,
) {
  const qs = new URLSearchParams();
  if (args.category) qs.set('category', args.category);
  if (args.status) qs.set('status', args.status);
  if (args.academicYearId) qs.set('academicYearId', args.academicYearId);
  const query = qs.toString();
  return useQuery({
    queryKey: ['clubs', 'activities', args],
    queryFn: () => apiFetch<ActivityDto[]>(`${PREFIX}/clubs/activities${query ? '?' + query : ''}`),
    enabled,
  });
}

export function useActivity(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['clubs', 'activity', id],
    queryFn: () => apiFetch<ActivityDto>(`${PREFIX}/clubs/activities/${id}`),
    enabled: enabled && !!id,
  });
}

export function useCreateActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateActivityPayload) =>
      apiFetch<ActivityDto>(`${PREFIX}/clubs/activities`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['clubs', 'activities'] });
    },
  });
}

export function useJoinActivity(activityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: JoinActivityPayload = {}) =>
      apiFetch<ActivityMemberDto>(`${PREFIX}/clubs/activities/${activityId}/join`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['clubs', 'activity', activityId] });
      void qc.invalidateQueries({ queryKey: ['clubs', 'my-activities'] });
      void qc.invalidateQueries({ queryKey: ['clubs', 'activities'] });
    },
  });
}

export function useAddMember(activityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { studentId: string; role?: string }) =>
      apiFetch<ActivityMemberDto>(`${PREFIX}/clubs/activities/${activityId}/members`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['clubs', 'activity', activityId] });
    },
  });
}

export function useMyActivities(enabled = true) {
  return useQuery({
    queryKey: ['clubs', 'my-activities'],
    queryFn: () => apiFetch<ActivityMemberDto[]>(`${PREFIX}/clubs/my-activities`),
    enabled,
  });
}

export function useActivitySchedule(activityId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['clubs', 'schedule', activityId],
    queryFn: () =>
      apiFetch<ActivityScheduleDto[]>(`${PREFIX}/clubs/activities/${activityId}/schedule`),
    enabled: enabled && !!activityId,
  });
}

// ── Field Trips ──

export function useFieldTrips(enabled = true) {
  return useQuery({
    queryKey: ['clubs', 'field-trips'],
    queryFn: () => apiFetch<FieldTripDto[]>(`${PREFIX}/clubs/field-trips`),
    enabled,
  });
}

export function useFieldTrip(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['clubs', 'field-trip', id],
    queryFn: () => apiFetch<FieldTripDto>(`${PREFIX}/clubs/field-trips/${id}`),
    enabled: enabled && !!id,
  });
}

export function useCreateFieldTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch<FieldTripDto>(`${PREFIX}/clubs/field-trips`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['clubs', 'field-trips'] }),
  });
}

export function useAddTripParticipant(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { studentId: string }) =>
      apiFetch<FieldTripParticipantDto>(`${PREFIX}/clubs/field-trips/${tripId}/participants`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['clubs', 'field-trip', tripId] }),
  });
}

export function useSignConsent(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SignConsentPayload) =>
      apiFetch<ConsentRecordDto>(`${PREFIX}/clubs/field-trips/${tripId}/consent`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['clubs', 'field-trip', tripId] });
      void qc.invalidateQueries({ queryKey: ['clubs', 'field-trips'] });
      void qc.invalidateQueries({ queryKey: ['clubs', 'my-consent', tripId] });
    },
  });
}

export function useMyConsent(tripId: string, studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['clubs', 'my-consent', tripId, studentId],
    queryFn: () =>
      apiFetch<ConsentRecordDto | null>(
        `${PREFIX}/clubs/field-trips/${tripId}/my-consent?studentId=${studentId}`,
      ),
    enabled: enabled && !!studentId,
  });
}

export function useAddChaperone(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { personId: string; role?: string }) =>
      apiFetch<FieldTripChaperoneDto>(`${PREFIX}/clubs/field-trips/${tripId}/chaperones`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['clubs', 'field-trip', tripId] }),
  });
}

// ── Elections ──

export function useElections(enabled = true) {
  return useQuery({
    queryKey: ['clubs', 'elections'],
    queryFn: () => apiFetch<ElectionDto[]>(`${PREFIX}/clubs/elections`),
    enabled,
  });
}

export function useElection(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['clubs', 'election', id],
    queryFn: () => apiFetch<ElectionDto>(`${PREFIX}/clubs/elections/${id}`),
    enabled: enabled && !!id,
  });
}

export function useElectionResults(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['clubs', 'election-results', id],
    queryFn: () => apiFetch<ElectionResultsDto>(`${PREFIX}/clubs/elections/${id}/results`),
    enabled: enabled && !!id,
  });
}

export function useCanVote(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['clubs', 'can-vote', id],
    queryFn: () => apiFetch<CanVoteDto>(`${PREFIX}/clubs/elections/${id}/can-vote`),
    enabled: enabled && !!id,
  });
}

export function useCastVote(electionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CastVotePayload) =>
      apiFetch<{ status: string; votedAt: string }>(
        `${PREFIX}/clubs/elections/${electionId}/vote`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['clubs', 'can-vote', electionId] });
      void qc.invalidateQueries({ queryKey: ['clubs', 'election', electionId] });
    },
  });
}

export function useCreateElection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch<ElectionDto>(`${PREFIX}/clubs/elections`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['clubs', 'elections'] }),
  });
}

export function useUpdateElection(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { status?: string; title?: string; description?: string }) =>
      apiFetch<ElectionDto>(`${PREFIX}/clubs/elections/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['clubs', 'election', id] });
      void qc.invalidateQueries({ queryKey: ['clubs', 'elections'] });
      void qc.invalidateQueries({ queryKey: ['clubs', 'election-results', id] });
    },
  });
}

// ── Service Programmes / Hours ──

export function useServiceProgrammes(enabled = true) {
  return useQuery({
    queryKey: ['clubs', 'service-programmes'],
    queryFn: () => apiFetch<ServiceProgrammeDto[]>(`${PREFIX}/clubs/service-programmes`),
    enabled,
  });
}

export function useServiceLeaderboard(programmeId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['clubs', 'service-leaderboard', programmeId],
    queryFn: () =>
      apiFetch<ServiceProgressDto[]>(
        `${PREFIX}/clubs/service-programmes/${programmeId}/leaderboard`,
      ),
    enabled: enabled && !!programmeId,
  });
}

export function useServiceHours(enabled = true) {
  return useQuery({
    queryKey: ['clubs', 'service-hours'],
    queryFn: () => apiFetch<ServiceHourDto[]>(`${PREFIX}/clubs/service-hours`),
    enabled,
  });
}

export function useLogServiceHour() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: LogServiceHourPayload) =>
      apiFetch<ServiceHourDto>(`${PREFIX}/clubs/service-hours`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['clubs', 'service-hours'] });
      void qc.invalidateQueries({ queryKey: ['clubs', 'my-service-progress'] });
    },
  });
}

export function useReviewApproval(approvalId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ApproveHourPayload) =>
      apiFetch<ServiceHourDto>(`${PREFIX}/clubs/service-hour-approvals/${approvalId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['clubs', 'service-hours'] });
      void qc.invalidateQueries({ queryKey: ['clubs', 'my-service-progress'] });
      void qc.invalidateQueries({ queryKey: ['clubs', 'service-leaderboard'] });
    },
  });
}

export function useMyServiceProgress(enabled = true) {
  return useQuery({
    queryKey: ['clubs', 'my-service-progress'],
    queryFn: () => apiFetch<ServiceProgressDto[]>(`${PREFIX}/clubs/my-service-progress`),
    enabled,
  });
}
