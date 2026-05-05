'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AddAthleticsRosterMemberPayload,
  AthleticsCoachingAssignmentDto,
  AthleticsConcussionProtocolStepDto,
  AthleticsGameDto,
  AthleticsInjuryDto,
  AthleticsMedicalClearanceDto,
  AthleticsPlayerStatLineDto,
  AthleticsProgrammeDto,
  AthleticsRosterDto,
  AthleticsRosterMemberDto,
  AthleticsSeasonDto,
  AthleticsSeasonRecordDto,
  CreateAthleticsGamePayload,
  CreateAthleticsInjuryPayload,
  CreateAthleticsProgrammePayload,
  CreateAthleticsRosterPayload,
  CreateAthleticsSeasonPayload,
  EnterGameResultPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ─── Programmes ─────────────────────────────────────────────

export function useAthleticsProgrammes(filters?: {
  season?: string;
  sport?: string;
  includeInactive?: boolean;
}) {
  const qs = new URLSearchParams();
  if (filters?.season) qs.set('season', filters.season);
  if (filters?.sport) qs.set('sport', filters.sport);
  if (filters?.includeInactive) qs.set('includeInactive', 'true');
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return useQuery({
    queryKey: ['athletics', 'programmes', filters],
    queryFn: () => apiFetch<AthleticsProgrammeDto[]>(`${PREFIX}/athletics/programmes${suffix}`),
    staleTime: 30_000,
  });
}

export function useAthleticsProgramme(id: string | null) {
  return useQuery({
    queryKey: ['athletics', 'programmes', id],
    queryFn: () => apiFetch<AthleticsProgrammeDto>(`${PREFIX}/athletics/programmes/${id!}`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateAthleticsProgramme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAthleticsProgrammePayload) =>
      apiFetch<AthleticsProgrammeDto>(`${PREFIX}/athletics/programmes`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['athletics', 'programmes'] }),
  });
}

// ─── Seasons ────────────────────────────────────────────────

export function useAthleticsSeasonsForProgramme(programmeId: string | null) {
  return useQuery({
    queryKey: ['athletics', 'seasons', programmeId],
    queryFn: () =>
      apiFetch<AthleticsSeasonDto[]>(`${PREFIX}/athletics/programmes/${programmeId!}/seasons`),
    enabled: !!programmeId,
  });
}

export function useAthleticsSeason(id: string | null) {
  return useQuery({
    queryKey: ['athletics', 'season', id],
    queryFn: () => apiFetch<AthleticsSeasonDto>(`${PREFIX}/athletics/seasons/${id!}`),
    enabled: !!id,
  });
}

export function useCreateAthleticsSeason(programmeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAthleticsSeasonPayload) =>
      apiFetch<AthleticsSeasonDto>(`${PREFIX}/athletics/programmes/${programmeId}/seasons`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['athletics', 'seasons', programmeId] }),
  });
}

// ─── Rosters ────────────────────────────────────────────────

export function useAthleticsRostersForSeason(seasonId: string | null) {
  return useQuery({
    queryKey: ['athletics', 'rosters', seasonId],
    queryFn: () =>
      apiFetch<AthleticsRosterDto[]>(`${PREFIX}/athletics/seasons/${seasonId!}/rosters`),
    enabled: !!seasonId,
  });
}

export function useAthleticsRoster(id: string | null) {
  return useQuery({
    queryKey: ['athletics', 'roster', id],
    queryFn: () => apiFetch<AthleticsRosterDto>(`${PREFIX}/athletics/rosters/${id!}`),
    enabled: !!id,
  });
}

export function useAthleticsRosterMembers(rosterId: string | null) {
  return useQuery({
    queryKey: ['athletics', 'roster-members', rosterId],
    queryFn: () =>
      apiFetch<AthleticsRosterMemberDto[]>(`${PREFIX}/athletics/rosters/${rosterId!}/members`),
    enabled: !!rosterId,
  });
}

export function useCreateAthleticsRoster(seasonId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAthleticsRosterPayload) =>
      apiFetch<AthleticsRosterDto>(`${PREFIX}/athletics/seasons/${seasonId}/rosters`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['athletics', 'rosters', seasonId] }),
  });
}

export function useAddAthleticsRosterMember(rosterId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AddAthleticsRosterMemberPayload) =>
      apiFetch<AthleticsRosterMemberDto>(`${PREFIX}/athletics/rosters/${rosterId}/members`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics', 'roster-members', rosterId] });
      qc.invalidateQueries({ queryKey: ['athletics', 'roster', rosterId] });
    },
  });
}

export function useCertifyAthleticsRoster(rosterId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<AthleticsRosterDto>(`${PREFIX}/athletics/rosters/${rosterId}/certify`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['athletics', 'roster', rosterId] }),
  });
}

export function useCheckAthleticsEligibility(rosterId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<AthleticsRosterMemberDto[]>(
        `${PREFIX}/athletics/rosters/${rosterId}/check-eligibility`,
        { method: 'POST' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['athletics', 'roster-members', rosterId] }),
  });
}

// ─── Games ──────────────────────────────────────────────────

export function useAthleticsGames(filters?: {
  seasonId?: string;
  rosterId?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
}) {
  const qs = new URLSearchParams();
  if (filters?.seasonId) qs.set('seasonId', filters.seasonId);
  if (filters?.rosterId) qs.set('rosterId', filters.rosterId);
  if (filters?.status) qs.set('status', filters.status);
  if (filters?.fromDate) qs.set('fromDate', filters.fromDate);
  if (filters?.toDate) qs.set('toDate', filters.toDate);
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return useQuery({
    queryKey: ['athletics', 'games', filters],
    queryFn: () => apiFetch<AthleticsGameDto[]>(`${PREFIX}/athletics/games${suffix}`),
    staleTime: 30_000,
  });
}

export function useAthleticsSchedule() {
  return useQuery({
    queryKey: ['athletics', 'schedule'],
    queryFn: () => apiFetch<AthleticsGameDto[]>(`${PREFIX}/athletics/schedule`),
    staleTime: 60_000,
  });
}

export function useAthleticsGame(id: string | null) {
  return useQuery({
    queryKey: ['athletics', 'game', id],
    queryFn: () => apiFetch<AthleticsGameDto>(`${PREFIX}/athletics/games/${id!}`),
    enabled: !!id,
  });
}

export function useCreateAthleticsGame() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAthleticsGamePayload) =>
      apiFetch<AthleticsGameDto>(`${PREFIX}/athletics/games`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['athletics', 'games'] }),
  });
}

// ─── Results ────────────────────────────────────────────────

export function useEnterGameResult(gameId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EnterGameResultPayload) =>
      apiFetch<AthleticsGameDto>(`${PREFIX}/athletics/games/${gameId}/result`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['athletics', 'games'] });
      qc.invalidateQueries({ queryKey: ['athletics', 'game', gameId] });
      qc.invalidateQueries({ queryKey: ['athletics', 'season-records'] });
    },
  });
}

export function useAthleticsSeasonRecord(rosterId: string | null) {
  return useQuery({
    queryKey: ['athletics', 'season-records', rosterId],
    queryFn: () =>
      apiFetch<AthleticsSeasonRecordDto>(`${PREFIX}/athletics/season-records/${rosterId!}`),
    enabled: !!rosterId,
  });
}

// ─── Stats ──────────────────────────────────────────────────

export function useAthleticsGameStats(gameId: string | null) {
  return useQuery({
    queryKey: ['athletics', 'game-stats', gameId],
    queryFn: () =>
      apiFetch<AthleticsPlayerStatLineDto[]>(`${PREFIX}/athletics/games/${gameId!}/stats`),
    enabled: !!gameId,
  });
}

export function useAthleticsPlayerStats(studentId: string | null) {
  return useQuery({
    queryKey: ['athletics', 'player-stats', studentId],
    queryFn: () =>
      apiFetch<AthleticsPlayerStatLineDto[]>(`${PREFIX}/athletics/players/${studentId!}/stats`),
    enabled: !!studentId,
  });
}

// ─── Coaching ───────────────────────────────────────────────

export function useAthleticsCoaches(rosterId: string | null) {
  return useQuery({
    queryKey: ['athletics', 'coaches', rosterId],
    queryFn: () =>
      apiFetch<AthleticsCoachingAssignmentDto[]>(
        `${PREFIX}/athletics/rosters/${rosterId!}/coaches`,
      ),
    enabled: !!rosterId,
  });
}

// ─── Injuries ───────────────────────────────────────────────

export function useAthleticsInjuries(filters?: { status?: string; studentId?: string }) {
  const qs = new URLSearchParams();
  if (filters?.status) qs.set('status', filters.status);
  if (filters?.studentId) qs.set('studentId', filters.studentId);
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return useQuery({
    queryKey: ['athletics', 'injuries', filters],
    queryFn: () => apiFetch<AthleticsInjuryDto[]>(`${PREFIX}/athletics/injuries${suffix}`),
    staleTime: 30_000,
  });
}

export function useAthleticsInjury(id: string | null) {
  return useQuery({
    queryKey: ['athletics', 'injury', id],
    queryFn: () => apiFetch<AthleticsInjuryDto>(`${PREFIX}/athletics/injuries/${id!}`),
    enabled: !!id,
  });
}

export function useLogAthleticsInjury() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAthleticsInjuryPayload) =>
      apiFetch<AthleticsInjuryDto>(`${PREFIX}/athletics/injuries`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['athletics', 'injuries'] }),
  });
}

// ─── Concussion protocol ───────────────────────────────────

export function useStartProtocolStep(injuryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      stepNumber: number;
      stepName: string;
      minimumDurationHours?: number;
      notes?: string;
    }) =>
      apiFetch<AthleticsConcussionProtocolStepDto>(
        `${PREFIX}/athletics/injuries/${injuryId}/protocol/steps`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['athletics', 'injury', injuryId] }),
  });
}

export function useCompleteProtocolStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      stepId,
      symptomFree,
      notes,
    }: {
      stepId: string;
      symptomFree: boolean;
      notes?: string;
    }) =>
      apiFetch<AthleticsConcussionProtocolStepDto>(
        `${PREFIX}/athletics/concussion-steps/${stepId}`,
        { method: 'PATCH', body: JSON.stringify({ symptomFree, notes }) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['athletics', 'injury'] }),
  });
}

// ─── Medical clearances ────────────────────────────────────

export function useUploadClearance(injuryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      documentS3Key: string;
      physicianName?: string;
      physicianPhone?: string;
      clearanceDate: string;
      expiresAt?: string;
    }) =>
      apiFetch<AthleticsMedicalClearanceDto>(
        `${PREFIX}/athletics/injuries/${injuryId}/clearances`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['athletics', 'injury', injuryId] }),
  });
}

export function useReviewClearance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      clearanceId,
      decision,
      reviewNotes,
    }: {
      clearanceId: string;
      decision: 'ACCEPTED' | 'REJECTED';
      reviewNotes?: string;
    }) =>
      apiFetch<AthleticsMedicalClearanceDto>(
        `${PREFIX}/athletics/medical-clearances/${clearanceId}/review`,
        { method: 'PATCH', body: JSON.stringify({ decision, reviewNotes }) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['athletics'] }),
  });
}
