'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  BookEngSlotPayload,
  CancelEngBookingPayload,
  EngConferenceBookingDto,
  EngConferenceEventDto,
  EngConferenceEventStatus,
  EngConferenceSlotDto,
  CreateEngConferenceEventPayload,
  CreateSurveyPayload,
  EngagementLevel,
  EngagementScoreConfigDto,
  EngagementScoreDto,
  EngagementSummaryDto,
  GenerateEngSlotsPayload,
  SubmitSurveyResponsePayload,
  SubmitSurveyResponseResult,
  SurveyDto,
  UpdateEngBookingPayload,
  UpdateEngConferenceEventPayload,
  UpdateScoreConfigPayload,
  UpdateEngSlotPayload,
  UpdateSurveyPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ─── Conference Events ──────────────────────────────────────────

export function useConferenceEvents(status?: EngConferenceEventStatus, enabled: boolean = true) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return useQuery({
    queryKey: ['engagement', 'conferences', status ?? 'ALL'],
    queryFn: () => apiFetch<EngConferenceEventDto[]>(`${PREFIX}/engagement/conferences${qs}`),
    staleTime: 30_000,
    enabled,
  });
}

export function useConferenceEvent(id: string | undefined) {
  return useQuery({
    queryKey: ['engagement', 'conference', id],
    queryFn: () => apiFetch<EngConferenceEventDto>(`${PREFIX}/engagement/conferences/${id}`),
    enabled: !!id,
  });
}

export function useCreateConferenceEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEngConferenceEventPayload) =>
      apiFetch<EngConferenceEventDto>(`${PREFIX}/engagement/conferences`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['engagement', 'conferences'] });
    },
  });
}

export function useUpdateConferenceEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateEngConferenceEventPayload }) =>
      apiFetch<EngConferenceEventDto>(`${PREFIX}/engagement/conferences/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: ['engagement', 'conferences'] });
      void qc.invalidateQueries({ queryKey: ['engagement', 'conference', vars.id] });
    },
  });
}

// ─── Conference Slots ───────────────────────────────────────────

export function useConferenceSlots(
  eventId: string | undefined,
  filters: { teacherId?: string; availableOnly?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (filters.teacherId) params.set('teacherId', filters.teacherId);
  if (filters.availableOnly) params.set('availableOnly', 'true');
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: [
      'engagement',
      'slots',
      eventId,
      filters.teacherId ?? '',
      filters.availableOnly ?? false,
    ],
    queryFn: () =>
      apiFetch<EngConferenceSlotDto[]>(`${PREFIX}/engagement/conferences/${eventId}/slots${qs}`),
    enabled: !!eventId,
    staleTime: 15_000,
  });
}

export function useGenerateSlots() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, body }: { eventId: string; body: GenerateEngSlotsPayload }) =>
      apiFetch<EngConferenceSlotDto[]>(
        `${PREFIX}/engagement/conferences/${eventId}/slots/generate`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      ),
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: ['engagement', 'slots', vars.eventId] });
    },
  });
}

export function useUpdateSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateEngSlotPayload }) =>
      apiFetch<EngConferenceSlotDto>(`${PREFIX}/engagement/slots/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['engagement', 'slots'] });
    },
  });
}

// ─── Conference Bookings ────────────────────────────────────────

export function useMyBookings(enabled: boolean = true) {
  return useQuery({
    queryKey: ['engagement', 'bookings', 'mine'],
    queryFn: () => apiFetch<EngConferenceBookingDto[]>(`${PREFIX}/engagement/bookings/my`),
    staleTime: 15_000,
    enabled,
  });
}

export function useBookings(
  filters: { slotId?: string; parentId?: string; studentId?: string } = {},
  enabled: boolean = true,
) {
  const params = new URLSearchParams();
  if (filters.slotId) params.set('slotId', filters.slotId);
  if (filters.parentId) params.set('parentId', filters.parentId);
  if (filters.studentId) params.set('studentId', filters.studentId);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: [
      'engagement',
      'bookings',
      filters.slotId ?? '',
      filters.parentId ?? '',
      filters.studentId ?? '',
    ],
    queryFn: () => apiFetch<EngConferenceBookingDto[]>(`${PREFIX}/engagement/bookings${qs}`),
    enabled,
    staleTime: 15_000,
  });
}

export function useBookSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slotId, body }: { slotId: string; body: BookEngSlotPayload }) =>
      apiFetch<EngConferenceBookingDto>(`${PREFIX}/engagement/slots/${slotId}/book`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['engagement', 'slots'] });
      void qc.invalidateQueries({ queryKey: ['engagement', 'bookings'] });
    },
  });
}

export function useCancelBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CancelEngBookingPayload }) =>
      apiFetch<EngConferenceBookingDto>(`${PREFIX}/engagement/bookings/${id}`, {
        method: 'DELETE',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['engagement', 'slots'] });
      void qc.invalidateQueries({ queryKey: ['engagement', 'bookings'] });
    },
  });
}

export function useUpdateBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateEngBookingPayload }) =>
      apiFetch<EngConferenceBookingDto>(`${PREFIX}/engagement/bookings/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['engagement', 'bookings'] });
    },
  });
}

// ─── Engagement Scores ──────────────────────────────────────────

export function useEngagementScores(
  filters: { level?: EngagementLevel; scoreDate?: string } = {},
  enabled: boolean = true,
) {
  const params = new URLSearchParams();
  if (filters.level) params.set('level', filters.level);
  if (filters.scoreDate) params.set('scoreDate', filters.scoreDate);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['engagement', 'scores', filters.level ?? 'ALL', filters.scoreDate ?? 'LATEST'],
    queryFn: () => apiFetch<EngagementScoreDto[]>(`${PREFIX}/engagement/scores${qs}`),
    staleTime: 60_000,
    enabled,
  });
}

export function useEngagementSummary(enabled: boolean = true) {
  return useQuery({
    queryKey: ['engagement', 'scores', 'summary'],
    queryFn: () => apiFetch<EngagementSummaryDto>(`${PREFIX}/engagement/scores/summary`),
    staleTime: 60_000,
    enabled,
  });
}

export function useFamilyEngagement(familyId: string | undefined, enabled: boolean = true) {
  return useQuery({
    queryKey: ['engagement', 'scores', 'family', familyId],
    queryFn: () => apiFetch<EngagementScoreDto[]>(`${PREFIX}/engagement/scores/${familyId}`),
    enabled: enabled && !!familyId,
  });
}

export function useScoreConfig(enabled: boolean = true) {
  return useQuery({
    queryKey: ['engagement', 'score-config'],
    queryFn: () => apiFetch<EngagementScoreConfigDto>(`${PREFIX}/engagement/score-config`),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useUpdateScoreConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateScoreConfigPayload) =>
      apiFetch<EngagementScoreConfigDto>(`${PREFIX}/engagement/score-config`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['engagement', 'score-config'] });
    },
  });
}

// ─── Parent Surveys ─────────────────────────────────────────────

export function useSurveys(enabled: boolean = true) {
  return useQuery({
    queryKey: ['engagement', 'surveys'],
    queryFn: () => apiFetch<SurveyDto[]>(`${PREFIX}/engagement/surveys`),
    staleTime: 30_000,
    enabled,
  });
}

export function useSurvey(id: string | undefined) {
  return useQuery({
    queryKey: ['engagement', 'survey', id],
    queryFn: () => apiFetch<SurveyDto>(`${PREFIX}/engagement/surveys/${id}`),
    enabled: !!id,
  });
}

export function useSurveyResults(id: string | undefined, enabled: boolean = true) {
  return useQuery({
    queryKey: ['engagement', 'survey', id, 'results'],
    queryFn: () => apiFetch<SurveyDto>(`${PREFIX}/engagement/surveys/${id}/results`),
    enabled: enabled && !!id,
  });
}

export function useCreateSurvey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSurveyPayload) =>
      apiFetch<SurveyDto>(`${PREFIX}/engagement/surveys`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['engagement', 'surveys'] });
    },
  });
}

export function useUpdateSurvey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateSurveyPayload }) =>
      apiFetch<SurveyDto>(`${PREFIX}/engagement/surveys/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: ['engagement', 'surveys'] });
      void qc.invalidateQueries({ queryKey: ['engagement', 'survey', vars.id] });
    },
  });
}

export function useSubmitSurveyResponse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: SubmitSurveyResponsePayload }) =>
      apiFetch<SubmitSurveyResponseResult>(`${PREFIX}/engagement/surveys/${id}/respond`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: ['engagement', 'surveys'] });
      void qc.invalidateQueries({ queryKey: ['engagement', 'survey', vars.id] });
    },
  });
}
