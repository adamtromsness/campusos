'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

// ─────────────────────────────────────────────────────────────────────────────
// Types (mirror apps/api DTO shapes)
// ─────────────────────────────────────────────────────────────────────────────

export interface RotationCycleDto {
  id: string;
  schoolId: string;
  name: string;
  cycleLength: number;
  academicYearId: string | null;
  isActive: boolean;
  description: string | null;
}

export interface CreateRotationCyclePayload {
  name: string;
  cycleLength: number;
  academicYearId?: string;
  description?: string;
  isActive?: boolean;
}

export interface UpdateRotationCyclePayload {
  name?: string;
  isActive?: boolean;
  description?: string;
}

export interface RotationCalendarEntryDto {
  id: string;
  rotationCycleId: string;
  calendarDate: string;
  rotationDay: number;
  isSchoolDay: boolean;
  notes: string | null;
}

export interface UpsertRotationCalendarPayload {
  calendarDate: string;
  rotationDay: number;
  isSchoolDay?: boolean;
  notes?: string;
}

export interface GenerateCalendarPayload {
  startDate: string;
  endDate: string;
  closureDates?: string[];
}

export interface RotationDayLookupDto {
  date: string;
  rotationCycleId: string;
  rotationDay: number;
  isSchoolDay: boolean;
}

export interface SubjectChoiceDto {
  id: string;
  studentId: string;
  academicYearId: string;
  courseId: string;
  courseName: string | null;
  preferenceRank: number | null;
  isRequired: boolean;
  submittedAt: string | null;
  notes: string | null;
}

export interface SubmitSubjectChoicePayload {
  studentId: string;
  academicYearId: string;
  courseId: string;
  preferenceRank?: number;
  isRequired?: boolean;
  notes?: string;
}

export interface SubjectChoiceDemandRowDto {
  courseId: string;
  courseName: string;
  totalStudents: number;
  requiredCount: number;
  rankedFirstCount: number;
}

export interface SubjectChoiceWindowDto {
  id: string;
  schoolId: string;
  academicYearId: string | null;
  name: string | null;
  opensAt: string;
  closesAt: string;
  targetGradeLevels: string[] | null;
  isActive: boolean;
  description: string | null;
}

export interface CreateSubjectChoiceWindowPayload {
  academicYearId?: string;
  name?: string;
  opensAt: string;
  closesAt: string;
  targetGradeLevels?: string[];
  isActive?: boolean;
  description?: string;
}

export interface SchedulingConstraintsDto {
  id: string;
  schoolId: string;
  academicYearId: string | null;
  name: string;
  hardConstraints: unknown[];
  softConstraints: unknown[];
  isActive: boolean;
  description: string | null;
}

export interface CreateSchedulingConstraintsPayload {
  name: string;
  academicYearId?: string;
  hardConstraints: unknown[];
  softConstraints: unknown[];
  isActive?: boolean;
  description?: string;
}

export type SchedulingRequestStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type SolverAlgorithm = 'CP_SAT' | 'HEURISTIC';
export type CandidateReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'MODIFIED';

export interface SchedulingRequestDto {
  id: string;
  schoolId: string;
  academicYearId: string | null;
  constraintId: string;
  sectionCountAtSubmission: number;
  solverAlgorithm: SolverAlgorithm;
  status: SchedulingRequestStatus;
  requestedBy: string;
  candidatesGenerated: number | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  candidates?: SchedulingCandidateDto[] | null;
}

export interface CreateSchedulingRequestPayload {
  constraintId: string;
  academicYearId?: string;
  sectionCount?: number;
  solverAlgorithm?: SolverAlgorithm;
}

export interface SchedulingCandidateDto {
  id: string;
  requestId: string;
  candidateName: string | null;
  solverSeed: string | null;
  totalSlots: number;
  totalClashes: number;
  allConstraintsSatisfied: boolean;
  constraintViolations: unknown[];
  softConstraintScore: number | null;
  reviewStatus: CandidateReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
}

export interface CandidateSlotDto {
  id: string;
  candidateId: string;
  classId: string | null;
  teacherId: string | null;
  roomId: string | null;
  periodId: string | null;
  dayOfWeek: number | null;
  rotationDay: number | null;
  hasClash: boolean;
  clashDescription: string | null;
}

export interface ReviewCandidatePayload {
  reviewNotes?: string;
}

export interface ResolveClashPayload {
  slotId: string;
  clashDescription?: string;
}

export interface ActivateCandidateResponseDto {
  candidateId: string;
  slotsPromoted: number;
  slotsSkipped: number;
  activationLogId: string;
}

export interface ActivationLogDto {
  id: string;
  candidateId: string;
  slotsPromoted: number;
  slotsSkipped: number;
  activatedBy: string;
  activatedAt: string;
  notes: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rotation cycles + calendar
// ─────────────────────────────────────────────────────────────────────────────

export function useRotationCycles(enabled = true) {
  return useQuery({
    queryKey: ['scheduling-advanced', 'rotation', 'cycles'],
    queryFn: () => apiFetch<RotationCycleDto[]>('/api/v1/scheduling/rotation/cycles'),
    enabled,
    staleTime: 60_000,
  });
}

export function useRotationCycle(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ['scheduling-advanced', 'rotation', 'cycle', id],
    queryFn: () => apiFetch<RotationCycleDto>(`/api/v1/scheduling/rotation/cycles/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useCreateRotationCycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateRotationCyclePayload) =>
      apiFetch<RotationCycleDto>('/api/v1/scheduling/rotation/cycles', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling-advanced', 'rotation'] });
    },
  });
}

export function useUpdateRotationCycle(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateRotationCyclePayload) =>
      apiFetch<RotationCycleDto>(`/api/v1/scheduling/rotation/cycles/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling-advanced', 'rotation'] });
    },
  });
}

export function useRotationCalendar(
  cycleId: string | null,
  fromDate?: string,
  toDate?: string,
  enabled = true,
) {
  const params = new URLSearchParams();
  if (fromDate) params.set('fromDate', fromDate);
  if (toDate) params.set('toDate', toDate);
  const qs = params.toString();
  return useQuery({
    queryKey: ['scheduling-advanced', 'rotation', 'calendar', cycleId, fromDate, toDate],
    queryFn: () =>
      apiFetch<RotationCalendarEntryDto[]>(
        `/api/v1/scheduling/rotation/cycles/${cycleId}/calendar${qs ? `?${qs}` : ''}`,
      ),
    enabled: enabled && typeof cycleId === 'string' && cycleId.length > 0,
  });
}

export function useUpsertRotationCalendarEntry(cycleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpsertRotationCalendarPayload) =>
      apiFetch<RotationCalendarEntryDto>(`/api/v1/scheduling/rotation/cycles/${cycleId}/calendar`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ['scheduling-advanced', 'rotation', 'calendar', cycleId],
      });
    },
  });
}

export function useGenerateRotationCalendar(cycleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: GenerateCalendarPayload) =>
      apiFetch<{ created: number; updated: number; closed: number }>(
        `/api/v1/scheduling/rotation/cycles/${cycleId}/generate`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ['scheduling-advanced', 'rotation', 'calendar', cycleId],
      });
    },
  });
}

export function useRotationDayLookup(date: string, enabled = true) {
  return useQuery({
    queryKey: ['scheduling-advanced', 'rotation', 'lookup', date],
    queryFn: () => apiFetch<RotationDayLookupDto>(`/api/v1/scheduling/rotation/lookup/${date}`),
    enabled: enabled && typeof date === 'string' && date.length > 0,
    retry: false,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Subject choices + windows
// ─────────────────────────────────────────────────────────────────────────────

export function useSubjectChoices(
  filters: { studentId?: string; academicYearId?: string; courseId?: string } = {},
  enabled = true,
) {
  const params = new URLSearchParams();
  if (filters.studentId) params.set('studentId', filters.studentId);
  if (filters.academicYearId) params.set('academicYearId', filters.academicYearId);
  if (filters.courseId) params.set('courseId', filters.courseId);
  const qs = params.toString();
  return useQuery({
    queryKey: ['scheduling-advanced', 'subject-choices', filters],
    queryFn: () =>
      apiFetch<SubjectChoiceDto[]>(`/api/v1/scheduling/subject-choices${qs ? `?${qs}` : ''}`),
    enabled,
    staleTime: 30_000,
  });
}

export function useSubmitSubjectChoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SubmitSubjectChoicePayload) =>
      apiFetch<SubjectChoiceDto>('/api/v1/scheduling/subject-choices', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling-advanced', 'subject-choices'] });
      void qc.invalidateQueries({ queryKey: ['scheduling-advanced', 'demand'] });
    },
  });
}

export function useSubjectChoiceDemand(academicYearId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['scheduling-advanced', 'demand', academicYearId],
    queryFn: () =>
      apiFetch<SubjectChoiceDemandRowDto[]>(
        `/api/v1/scheduling/subject-choices/demand?academicYearId=${academicYearId}`,
      ),
    enabled: enabled && typeof academicYearId === 'string' && academicYearId.length > 0,
  });
}

export function useSubjectChoiceWindows(enabled = true) {
  return useQuery({
    queryKey: ['scheduling-advanced', 'windows'],
    queryFn: () => apiFetch<SubjectChoiceWindowDto[]>('/api/v1/scheduling/subject-choice-windows'),
    enabled,
  });
}

export function useCreateSubjectChoiceWindow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSubjectChoiceWindowPayload) =>
      apiFetch<SubjectChoiceWindowDto>('/api/v1/scheduling/subject-choice-windows', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling-advanced', 'windows'] });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule generation
// ─────────────────────────────────────────────────────────────────────────────

export function useSchedulingConstraints(enabled = true) {
  return useQuery({
    queryKey: ['scheduling-advanced', 'constraints'],
    queryFn: () => apiFetch<SchedulingConstraintsDto[]>('/api/v1/scheduling/constraints'),
    enabled,
  });
}

export function useCreateSchedulingConstraints() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSchedulingConstraintsPayload) =>
      apiFetch<SchedulingConstraintsDto>('/api/v1/scheduling/constraints', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling-advanced', 'constraints'] });
    },
  });
}

export function useSchedulingRequests(status?: string, enabled = true) {
  const qs = status ? `?status=${status}` : '';
  return useQuery({
    queryKey: ['scheduling-advanced', 'requests', status ?? null],
    queryFn: () => apiFetch<SchedulingRequestDto[]>(`/api/v1/scheduling/requests${qs}`),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useSchedulingRequest(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ['scheduling-advanced', 'request', id],
    queryFn: () => apiFetch<SchedulingRequestDto>(`/api/v1/scheduling/requests/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useSubmitSchedulingRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSchedulingRequestPayload) =>
      apiFetch<SchedulingRequestDto>('/api/v1/scheduling/generate', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling-advanced', 'requests'] });
    },
  });
}

export function useCandidate(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ['scheduling-advanced', 'candidate', id],
    queryFn: () => apiFetch<SchedulingCandidateDto>(`/api/v1/scheduling/candidates/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useCandidateSlots(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ['scheduling-advanced', 'candidate', id, 'slots'],
    queryFn: () => apiFetch<CandidateSlotDto[]>(`/api/v1/scheduling/candidates/${id}/slots`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useApproveCandidate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReviewCandidatePayload) =>
      apiFetch<SchedulingCandidateDto>(`/api/v1/scheduling/candidates/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling-advanced', 'candidate', id] });
      void qc.invalidateQueries({ queryKey: ['scheduling-advanced', 'request'] });
      void qc.invalidateQueries({ queryKey: ['scheduling-advanced', 'requests'] });
    },
  });
}

export function useRejectCandidate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReviewCandidatePayload) =>
      apiFetch<SchedulingCandidateDto>(`/api/v1/scheduling/candidates/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling-advanced', 'candidate', id] });
      void qc.invalidateQueries({ queryKey: ['scheduling-advanced', 'request'] });
      void qc.invalidateQueries({ queryKey: ['scheduling-advanced', 'requests'] });
    },
  });
}

export function useResolveClash(candidateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ResolveClashPayload) =>
      apiFetch<CandidateSlotDto>(`/api/v1/scheduling/candidates/${candidateId}/resolve-clash`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ['scheduling-advanced', 'candidate', candidateId, 'slots'],
      });
      void qc.invalidateQueries({
        queryKey: ['scheduling-advanced', 'candidate', candidateId],
      });
    },
  });
}

export function useActivateCandidate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<ActivateCandidateResponseDto>(`/api/v1/scheduling/candidates/${id}/activate`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling-advanced'] });
      // The timetable should re-fetch because new slots have landed.
      void qc.invalidateQueries({ queryKey: ['scheduling', 'timetable'] });
    },
  });
}

export function useActivationLogs(candidateId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['scheduling-advanced', 'candidate', candidateId, 'activations'],
    queryFn: () =>
      apiFetch<ActivationLogDto[]>(`/api/v1/scheduling/candidates/${candidateId}/activations`),
    enabled: enabled && typeof candidateId === 'string' && candidateId.length > 0,
  });
}
