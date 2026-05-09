'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AppraisalCycleDto,
  AppraisalDto,
  AppraisalFrameworkDto,
  AppraisalGoalDto,
  AppraisalCommentDto,
  CertificationTypeDto,
  CreateAppraisalCommentPayload,
  CreateAppraisalGoalPayload,
  CreateExpenseClaimPayload,
  CreateLessonObservationPayload,
  CreateTrainingEventPayload,
  CreateTrainingProgrammePayload,
  DecideExpenseClaimPayload,
  EmployeeCertificationDto,
  EventStatus,
  ExpenseClaimDto,
  ExpenseStatus,
  LessonObservationDto,
  RecordCompletionPayload,
  TrainingCompletionDto,
  TrainingEventDto,
  TrainingProgrammeDto,
  UpdateAppraisalGoalPayload,
  UpdateAppraisalPayload,
  UpdateTrainingEventPayload,
  UpdateTrainingProgrammePayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ─────────────────────────────────────────────────────────────────────────
// Training programmes
// ─────────────────────────────────────────────────────────────────────────

export function useTrainingProgrammes(includeInactive = false) {
  return useQuery({
    queryKey: ['hr-training-programmes', includeInactive],
    queryFn: () =>
      apiFetch<TrainingProgrammeDto[]>(
        `${PREFIX}/hr/training/programmes${includeInactive ? '?includeInactive=true' : ''}`,
      ),
    staleTime: 60_000,
  });
}

export function useCreateTrainingProgramme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTrainingProgrammePayload) =>
      apiFetch<TrainingProgrammeDto>(`${PREFIX}/hr/training/programmes`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-training-programmes'] }),
  });
}

export function usePatchTrainingProgramme(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateTrainingProgrammePayload) =>
      apiFetch<TrainingProgrammeDto>(`${PREFIX}/hr/training/programmes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-training-programmes'] }),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Training events
// ─────────────────────────────────────────────────────────────────────────

export function useTrainingEvents(args?: { programmeId?: string; status?: EventStatus }) {
  const qs = new URLSearchParams();
  if (args?.programmeId) qs.set('programmeId', args.programmeId);
  if (args?.status) qs.set('status', args.status);
  const tail = qs.toString();
  return useQuery({
    queryKey: ['hr-training-events', args ?? null],
    queryFn: () =>
      apiFetch<TrainingEventDto[]>(`${PREFIX}/hr/training/events${tail ? `?${tail}` : ''}`),
    staleTime: 30_000,
  });
}

export function useCreateTrainingEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTrainingEventPayload) =>
      apiFetch<TrainingEventDto>(`${PREFIX}/hr/training/events`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-training-events'] }),
  });
}

export function usePatchTrainingEvent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateTrainingEventPayload) =>
      apiFetch<TrainingEventDto>(`${PREFIX}/hr/training/events/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-training-events'] }),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Completions — admin views per-event roster (own row only for non-admin)
// ─────────────────────────────────────────────────────────────────────────

export function useEventCompletions(eventId: string | null) {
  return useQuery({
    queryKey: ['hr-training-completions-event', eventId],
    queryFn: () =>
      apiFetch<TrainingCompletionDto[]>(`${PREFIX}/hr/training/events/${eventId}/completions`),
    enabled: !!eventId,
    staleTime: 30_000,
  });
}

export function useEmployeeCompletions(employeeId: string | null) {
  return useQuery({
    queryKey: ['hr-training-completions-employee', employeeId],
    queryFn: () =>
      apiFetch<TrainingCompletionDto[]>(
        `${PREFIX}/hr/training/employees/${employeeId}/completions`,
      ),
    enabled: !!employeeId,
    staleTime: 60_000,
  });
}

export function useRecordCompletion(eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: RecordCompletionPayload) =>
      apiFetch<TrainingCompletionDto>(`${PREFIX}/hr/training/events/${eventId}/completions`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hr-training-completions-event', eventId] });
      void qc.invalidateQueries({ queryKey: ['hr-training-completions-employee'] });
      void qc.invalidateQueries({ queryKey: ['hr-employee-certifications'] });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Certifications
// ─────────────────────────────────────────────────────────────────────────

export function useCertificationTypes(includeInactive = false) {
  return useQuery({
    queryKey: ['hr-cert-types', includeInactive],
    queryFn: () =>
      apiFetch<CertificationTypeDto[]>(
        `${PREFIX}/hr/training/certification-types${includeInactive ? '?includeInactive=true' : ''}`,
      ),
    staleTime: 5 * 60_000,
  });
}

export function useEmployeeCertifications(employeeId: string | null) {
  return useQuery({
    queryKey: ['hr-employee-certifications', employeeId],
    queryFn: () =>
      apiFetch<EmployeeCertificationDto[]>(
        `${PREFIX}/hr/training/employees/${employeeId}/certifications`,
      ),
    enabled: !!employeeId,
    staleTime: 60_000,
  });
}

export function useCertificationsExpiring(daysAhead = 60) {
  return useQuery({
    queryKey: ['hr-certifications-expiring', daysAhead],
    queryFn: () =>
      apiFetch<EmployeeCertificationDto[]>(
        `${PREFIX}/hr/training/certifications-expiring?daysAhead=${daysAhead}`,
      ),
    staleTime: 60_000,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Appraisals
// ─────────────────────────────────────────────────────────────────────────

export function useAppraisalCycles() {
  return useQuery({
    queryKey: ['hr-appraisal-cycles'],
    queryFn: () => apiFetch<AppraisalCycleDto[]>(`${PREFIX}/hr/appraisals/cycles`),
    staleTime: 60_000,
  });
}

export function useAppraisalFrameworks() {
  return useQuery({
    queryKey: ['hr-appraisal-frameworks'],
    queryFn: () => apiFetch<AppraisalFrameworkDto[]>(`${PREFIX}/hr/appraisals/frameworks`),
    staleTime: 5 * 60_000,
  });
}

export function useAppraisals(args?: { cycleId?: string; employeeId?: string }) {
  const qs = new URLSearchParams();
  if (args?.cycleId) qs.set('cycleId', args.cycleId);
  if (args?.employeeId) qs.set('employeeId', args.employeeId);
  const tail = qs.toString();
  return useQuery({
    queryKey: ['hr-appraisals', args ?? null],
    queryFn: () => apiFetch<AppraisalDto[]>(`${PREFIX}/hr/appraisals${tail ? `?${tail}` : ''}`),
    staleTime: 30_000,
  });
}

export function useAppraisal(id: string | null) {
  return useQuery({
    queryKey: ['hr-appraisal', id],
    queryFn: () => apiFetch<AppraisalDto>(`${PREFIX}/hr/appraisals/${id}`),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function usePatchAppraisal(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateAppraisalPayload) =>
      apiFetch<AppraisalDto>(`${PREFIX}/hr/appraisals/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hr-appraisal', id] });
      void qc.invalidateQueries({ queryKey: ['hr-appraisals'] });
    },
  });
}

export function useCreateAppraisalGoal(appraisalId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAppraisalGoalPayload) =>
      apiFetch<AppraisalGoalDto>(`${PREFIX}/hr/appraisals/${appraisalId}/goals`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-appraisal', appraisalId] }),
  });
}

export function usePatchAppraisalGoal(appraisalId: string, goalId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateAppraisalGoalPayload) =>
      apiFetch<AppraisalGoalDto>(`${PREFIX}/hr/appraisal-goals/${goalId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-appraisal', appraisalId] }),
  });
}

export function useCreateAppraisalComment(appraisalId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAppraisalCommentPayload) =>
      apiFetch<AppraisalCommentDto>(`${PREFIX}/hr/appraisals/${appraisalId}/comments`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-appraisal', appraisalId] }),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Lesson observations — admin only (lesson_observation:write)
// ─────────────────────────────────────────────────────────────────────────

export function useCreateLessonObservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateLessonObservationPayload) =>
      apiFetch<LessonObservationDto>(`${PREFIX}/hr/appraisals/lesson-observations`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (_, payload) => {
      if (payload.appraisalId) {
        void qc.invalidateQueries({ queryKey: ['hr-appraisal', payload.appraisalId] });
      }
      void qc.invalidateQueries({ queryKey: ['hr-lesson-observations'] });
    },
  });
}

export function useLockLessonObservation(observationId: string, appraisalId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<LessonObservationDto>(
        `${PREFIX}/hr/appraisals/lesson-observations/${observationId}/lock`,
        { method: 'PATCH' },
      ),
    onSuccess: () => {
      if (appraisalId) {
        void qc.invalidateQueries({ queryKey: ['hr-appraisal', appraisalId] });
      }
      void qc.invalidateQueries({ queryKey: ['hr-lesson-observations'] });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Expense claims — HR-012 self-submit, HR-013 admin
// ─────────────────────────────────────────────────────────────────────────

export function useExpenseClaims(args?: { status?: ExpenseStatus; mine?: boolean }) {
  const qs = new URLSearchParams();
  if (args?.status) qs.set('status', args.status);
  if (args?.mine) qs.set('mine', 'true');
  const tail = qs.toString();
  return useQuery({
    queryKey: ['hr-expense-claims', args ?? null],
    queryFn: () =>
      apiFetch<ExpenseClaimDto[]>(`${PREFIX}/hr/expense-claims${tail ? `?${tail}` : ''}`),
    staleTime: 30_000,
  });
}

export function useCreateExpenseClaim() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateExpenseClaimPayload) =>
      apiFetch<ExpenseClaimDto>(`${PREFIX}/hr/expense-claims`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-expense-claims'] }),
  });
}

export function useDecideExpenseClaim(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: DecideExpenseClaimPayload) =>
      apiFetch<ExpenseClaimDto>(`${PREFIX}/hr/expense-claims/${id}/decide`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-expense-claims'] }),
  });
}

export function useMarkExpensePaid(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<ExpenseClaimDto>(`${PREFIX}/hr/expense-claims/${id}/mark-paid`, {
        method: 'PATCH',
        body: JSON.stringify({}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-expense-claims'] }),
  });
}
