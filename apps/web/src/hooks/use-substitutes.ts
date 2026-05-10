'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AddToPoolPayload,
  AssignmentPayDto,
  CancelAssignmentPayload,
  CreateAvailabilityPayload,
  CreatePayRatePayload,
  CreatePreferencePayload,
  CreateRatingPayload,
  CreateSessionNotePayload,
  CreateSubstituteProfilePayload,
  PostJobPayload,
  SchoolPoolMemberDto,
  SubAssignmentDto,
  SubAvailabilityDto,
  SubCancellationPolicyDto,
  SubJobPostingDto,
  SubJobStatus,
  SubPayRateDto,
  SubPreferenceDto,
  SubRatingDto,
  SubSessionNoteDto,
  SubstituteProfileDto,
  SubstituteSearchArgs,
  UpdatePoolMemberPayload,
  UpsertCancellationPolicyPayload,
} from '@/lib/types';

const PREFIX = '/api/v1/substitutes';

// ── Profile + Search ─────────────────────────────────────────────

export function useMySubstituteProfile(enabled = true) {
  return useQuery({
    queryKey: ['substitutes', 'profile', 'me'],
    queryFn: () => apiFetch<SubstituteProfileDto | null>(`${PREFIX}/profile/me`),
    enabled,
    staleTime: 30_000,
  });
}

export function useSubstituteProfile(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['substitutes', 'profile', id],
    queryFn: () => apiFetch<SubstituteProfileDto>(`${PREFIX}/profile/${id}`),
    enabled: enabled && !!id,
  });
}

export function useSubstituteProfiles(enabled = true) {
  return useQuery({
    queryKey: ['substitutes', 'profiles'],
    queryFn: () => apiFetch<SubstituteProfileDto[]>(`${PREFIX}/profiles`),
    enabled,
  });
}

export function useCreateSubstituteProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSubstituteProfilePayload) =>
      apiFetch<SubstituteProfileDto>(`${PREFIX}/profile`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes'] });
    },
  });
}

export function useSubstituteSearch(args: SubstituteSearchArgs, enabled = true) {
  const qs = new URLSearchParams();
  if (args.gradeLevels) args.gradeLevels.forEach((g) => qs.append('gradeLevels', g));
  if (args.subjectAreas) args.subjectAreas.forEach((s) => qs.append('subjectAreas', s));
  if (args.schoolId) qs.set('schoolId', args.schoolId);
  if (args.availableOn) qs.set('availableOn', args.availableOn);
  if (args.verifiedOnly) qs.set('verifiedOnly', 'true');
  const query = qs.toString();
  return useQuery({
    queryKey: ['substitutes', 'search', args],
    queryFn: () => apiFetch<SubstituteProfileDto[]>(`${PREFIX}/search${query ? '?' + query : ''}`),
    enabled,
  });
}

// ── Availability ─────────────────────────────────────────────────

export function useMyAvailability(enabled = true) {
  return useQuery({
    queryKey: ['substitutes', 'availability', 'me'],
    queryFn: () => apiFetch<SubAvailabilityDto[]>(`${PREFIX}/availability/me`),
    enabled,
  });
}

export function useCreateAvailability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAvailabilityPayload) =>
      apiFetch<SubAvailabilityDto>(`${PREFIX}/availability`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes', 'availability'] });
    },
  });
}

export function useDeleteAvailability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: true }>(`${PREFIX}/availability/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes', 'availability'] });
    },
  });
}

// ── Preferences ──────────────────────────────────────────────────

export function useMyPreferences(enabled = true) {
  return useQuery({
    queryKey: ['substitutes', 'preferences', 'me'],
    queryFn: () => apiFetch<SubPreferenceDto[]>(`${PREFIX}/preferences/me`),
    enabled,
  });
}

export function useCreatePreference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePreferencePayload) =>
      apiFetch<SubPreferenceDto>(`${PREFIX}/preferences`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes', 'preferences'] });
    },
  });
}

export function useDeletePreference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: true }>(`${PREFIX}/preferences/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes', 'preferences'] });
    },
  });
}

// ── School Pool ──────────────────────────────────────────────────

export function useSchoolPool(enabled = true) {
  return useQuery({
    queryKey: ['substitutes', 'pool'],
    queryFn: () => apiFetch<SchoolPoolMemberDto[]>(`${PREFIX}/pool`),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useAddToPool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AddToPoolPayload) =>
      apiFetch<SchoolPoolMemberDto>(`${PREFIX}/pool`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes', 'pool'] });
    },
  });
}

export function useUpdatePoolMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdatePoolMemberPayload }) =>
      apiFetch<SchoolPoolMemberDto>(`${PREFIX}/pool/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes', 'pool'] });
    },
  });
}

// ── Jobs ─────────────────────────────────────────────────────────

export function useSubJobs(args: { status?: SubJobStatus } = {}, enabled = true) {
  const qs = new URLSearchParams();
  if (args.status) qs.set('status', args.status);
  const query = qs.toString();
  return useQuery({
    queryKey: ['substitutes', 'jobs', args],
    queryFn: () => apiFetch<SubJobPostingDto[]>(`${PREFIX}/jobs${query ? '?' + query : ''}`),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
}

export function useSubJob(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['substitutes', 'job', id],
    queryFn: () => apiFetch<SubJobPostingDto>(`${PREFIX}/jobs/${id}`),
    enabled: enabled && !!id,
  });
}

export function usePostJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: PostJobPayload) =>
      apiFetch<SubJobPostingDto>(`${PREFIX}/jobs`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes', 'jobs'] });
    },
  });
}

export function useAcceptJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      apiFetch<SubAssignmentDto>(`${PREFIX}/jobs/${jobId}/accept`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes'] });
    },
  });
}

export function useDeclineJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      apiFetch<{ jobId: string; response: 'DECLINED' }>(`${PREFIX}/jobs/${jobId}/decline`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes', 'jobs'] });
    },
  });
}

// ── Assignments ──────────────────────────────────────────────────

export function useSubAssignments(args: { status?: string } = {}, enabled = true) {
  const qs = new URLSearchParams();
  if (args.status) qs.set('status', args.status);
  const query = qs.toString();
  return useQuery({
    queryKey: ['substitutes', 'assignments', args],
    queryFn: () => apiFetch<SubAssignmentDto[]>(`${PREFIX}/assignments${query ? '?' + query : ''}`),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useSubAssignment(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['substitutes', 'assignment', id],
    queryFn: () => apiFetch<SubAssignmentDto>(`${PREFIX}/assignments/${id}`),
    enabled: enabled && !!id,
  });
}

export function useCheckIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<SubAssignmentDto>(`${PREFIX}/assignments/${id}/check-in`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes', 'assignments'] });
      qc.invalidateQueries({ queryKey: ['substitutes', 'assignment'] });
    },
  });
}

export function useCheckOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<SubAssignmentDto>(`${PREFIX}/assignments/${id}/check-out`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes'] });
    },
  });
}

export function useCancelAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: CancelAssignmentPayload }) =>
      apiFetch<SubAssignmentDto>(`${PREFIX}/assignments/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes'] });
    },
  });
}

// ── Ratings ──────────────────────────────────────────────────────

export function useAssignmentRatings(assignmentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['substitutes', 'ratings', assignmentId],
    queryFn: () => apiFetch<SubRatingDto[]>(`${PREFIX}/assignments/${assignmentId}/ratings`),
    enabled: enabled && !!assignmentId,
  });
}

export function useSubmitRating() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      assignmentId,
      payload,
    }: {
      assignmentId: string;
      payload: CreateRatingPayload;
    }) =>
      apiFetch<SubRatingDto>(`${PREFIX}/assignments/${assignmentId}/ratings`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes', 'ratings'] });
      qc.invalidateQueries({ queryKey: ['substitutes', 'profile'] });
    },
  });
}

// ── Session Notes ────────────────────────────────────────────────

export function useSessionNote(assignmentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['substitutes', 'session-note', assignmentId],
    queryFn: () =>
      apiFetch<SubSessionNoteDto | null>(`${PREFIX}/assignments/${assignmentId}/session-note`),
    enabled: enabled && !!assignmentId,
  });
}

export function useCreateSessionNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      assignmentId,
      payload,
    }: {
      assignmentId: string;
      payload: CreateSessionNotePayload;
    }) =>
      apiFetch<SubSessionNoteDto>(`${PREFIX}/assignments/${assignmentId}/session-note`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes', 'session-note'] });
    },
  });
}

// ── Pay Rates ────────────────────────────────────────────────────

export function usePayRates(enabled = true) {
  return useQuery({
    queryKey: ['substitutes', 'pay-rates'],
    queryFn: () => apiFetch<SubPayRateDto[]>(`${PREFIX}/pay-rates`),
    enabled,
  });
}

export function useCreatePayRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePayRatePayload) =>
      apiFetch<SubPayRateDto>(`${PREFIX}/pay-rates`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes', 'pay-rates'] });
    },
  });
}

export function useClosePayRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, effectiveTo }: { id: string; effectiveTo: string }) =>
      apiFetch<SubPayRateDto>(`${PREFIX}/pay-rates/${id}/close`, {
        method: 'PATCH',
        body: JSON.stringify({ effectiveTo }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes', 'pay-rates'] });
    },
  });
}

export function useAssignmentPay(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['substitutes', 'assignment-pay', id],
    queryFn: () => apiFetch<AssignmentPayDto>(`${PREFIX}/assignments/${id}/pay`),
    enabled: enabled && !!id,
  });
}

// ── Cancellation Policy ──────────────────────────────────────────

export function useCancellationPolicy(enabled = true) {
  return useQuery({
    queryKey: ['substitutes', 'cancellation-policy'],
    queryFn: () => apiFetch<SubCancellationPolicyDto | null>(`${PREFIX}/cancellation-policy`),
    enabled,
  });
}

export function useUpsertCancellationPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpsertCancellationPolicyPayload) =>
      apiFetch<SubCancellationPolicyDto>(`${PREFIX}/cancellation-policy`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['substitutes', 'cancellation-policy'] });
    },
  });
}
