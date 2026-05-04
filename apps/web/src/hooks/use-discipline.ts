'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  StudentDto,
  BehaviorPlanDto,
  BIPFeedbackDto,
  CreateBehaviorPlanPayload,
  CreateGoalPayload,
  GoalDto,
  ListBehaviorPlansArgs,
  RequestFeedbackPayload,
  SubmitFeedbackPayload,
  UpdateBehaviorPlanPayload,
  UpdateGoalPayload,
  CreateActionPayload,
  CreateDisciplineActionTypePayload,
  CreateDisciplineCategoryPayload,
  CreateIncidentPayload,
  DisciplineActionDto,
  DisciplineActionTypeDto,
  DisciplineCategoryDto,
  DisciplineIncidentDto,
  ListIncidentsArgs,
  ResolveIncidentPayload,
  ReviewIncidentPayload,
  UpdateActionPayload,
  UpdateDisciplineActionTypePayload,
  UpdateDisciplineCategoryPayload,
} from '@/lib/types';

function buildIncidentsQs(args: ListIncidentsArgs): string {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.severity) params.set('severity', args.severity);
  if (args.categoryId) params.set('categoryId', args.categoryId);
  if (args.studentId) params.set('studentId', args.studentId);
  if (args.fromDate) params.set('fromDate', args.fromDate);
  if (args.toDate) params.set('toDate', args.toDate);
  if (args.limit) params.set('limit', String(args.limit));
  const qs = params.toString();
  return qs ? '?' + qs : '';
}

// ── Students for the report form (server is already row-scoped) ─

/**
 * Pull the calling caller's visible student set for the report-incident
 * picker. The backend StudentService.list applies the standard
 * visibility predicate (admin sees all, teacher sees own classes via
 * sis_class_teachers + sis_enrollments, parent sees own children); the
 * form just renders what comes back.
 */
export function useStudentsForReport(enabled = true) {
  return useQuery({
    queryKey: ['discipline', 'students-for-report'],
    queryFn: () => apiFetch<StudentDto[]>('/api/v1/students'),
    enabled,
    staleTime: 60_000,
  });
}

// ── Catalogue (categories + action types) ──────────────────────

export function useDisciplineCategories(enabled = true, includeInactive = false) {
  return useQuery({
    queryKey: ['discipline', 'categories', { includeInactive }],
    queryFn: () =>
      apiFetch<DisciplineCategoryDto[]>(
        '/api/v1/discipline/categories' + (includeInactive ? '?includeInactive=true' : ''),
      ),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useDisciplineActionTypes(enabled = true, includeInactive = false) {
  return useQuery({
    queryKey: ['discipline', 'action-types', { includeInactive }],
    queryFn: () =>
      apiFetch<DisciplineActionTypeDto[]>(
        '/api/v1/discipline/action-types' + (includeInactive ? '?includeInactive=true' : ''),
      ),
    enabled,
    staleTime: 5 * 60_000,
  });
}

// ── Incidents ──────────────────────────────────────────────────

export function useDisciplineIncidents(args: ListIncidentsArgs = {}, enabled = true) {
  return useQuery({
    queryKey: [
      'discipline',
      'incidents',
      'list',
      {
        status: args.status ?? null,
        severity: args.severity ?? null,
        categoryId: args.categoryId ?? null,
        studentId: args.studentId ?? null,
        fromDate: args.fromDate ?? null,
        toDate: args.toDate ?? null,
        limit: args.limit ?? null,
      },
    ],
    queryFn: () =>
      apiFetch<DisciplineIncidentDto[]>('/api/v1/discipline/incidents' + buildIncidentsQs(args)),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export function useDisciplineIncident(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['discipline', 'incidents', 'one', id],
    queryFn: () => apiFetch<DisciplineIncidentDto>('/api/v1/discipline/incidents/' + id),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useDisciplineIncidentActions(
  incidentId: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ['discipline', 'incidents', 'actions', incidentId],
    queryFn: () =>
      apiFetch<DisciplineActionDto[]>('/api/v1/discipline/incidents/' + incidentId + '/actions'),
    enabled: enabled && typeof incidentId === 'string' && incidentId.length > 0,
    staleTime: 30_000,
  });
}

export function useCreateIncident() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateIncidentPayload) =>
      apiFetch<DisciplineIncidentDto>('/api/v1/discipline/incidents', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['discipline'] });
    },
  });
}

export function useReviewIncident(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReviewIncidentPayload) =>
      apiFetch<DisciplineIncidentDto>('/api/v1/discipline/incidents/' + id + '/review', {
        method: 'PATCH',
        body: JSON.stringify(payload ?? {}),
      }),
    onSuccess: () => invalidateIncident(qc, id),
  });
}

export function useResolveIncident(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ResolveIncidentPayload) =>
      apiFetch<DisciplineIncidentDto>('/api/v1/discipline/incidents/' + id + '/resolve', {
        method: 'PATCH',
        body: JSON.stringify(payload ?? {}),
      }),
    onSuccess: () => invalidateIncident(qc, id),
  });
}

export function useReopenIncident(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<DisciplineIncidentDto>('/api/v1/discipline/incidents/' + id + '/reopen', {
        method: 'PATCH',
      }),
    onSuccess: () => invalidateIncident(qc, id),
  });
}

function invalidateIncident(qc: ReturnType<typeof useQueryClient>, id: string): void {
  void qc.invalidateQueries({ queryKey: ['discipline'] });
  void qc.invalidateQueries({ queryKey: ['discipline', 'incidents', 'one', id] });
  void qc.invalidateQueries({ queryKey: ['discipline', 'incidents', 'actions', id] });
  // The Cycle 7 TaskWorker can land an admin-review AUTO task on report;
  // resolution doesn't currently cascade to that task but a future
  // BehaviourTaskCompletionConsumer (Phase 2 polish) might. Keep the
  // tasks key invalidated so the badge stays fresh on the UI side.
  void qc.invalidateQueries({ queryKey: ['tasks'] });
  void qc.invalidateQueries({ queryKey: ['notifications'] });
}

// ── Actions per incident ───────────────────────────────────────

export function useAddAction(incidentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateActionPayload) =>
      apiFetch<DisciplineActionDto>('/api/v1/discipline/incidents/' + incidentId + '/actions', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateIncident(qc, incidentId),
  });
}

export function useUpdateAction(actionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateActionPayload) =>
      apiFetch<DisciplineActionDto>('/api/v1/discipline/actions/' + actionId, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['discipline'] });
    },
  });
}

export function useRemoveAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (actionId: string) =>
      apiFetch<void>('/api/v1/discipline/actions/' + actionId, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['discipline'] });
    },
  });
}

// ── Catalogue mutations (admin) ────────────────────────────────

export function useCreateDisciplineCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateDisciplineCategoryPayload) =>
      apiFetch<DisciplineCategoryDto>('/api/v1/discipline/categories', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['discipline', 'categories'] });
    },
  });
}

export function useUpdateDisciplineCategory(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateDisciplineCategoryPayload) =>
      apiFetch<DisciplineCategoryDto>('/api/v1/discipline/categories/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['discipline', 'categories'] });
    },
  });
}

export function useCreateDisciplineActionType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateDisciplineActionTypePayload) =>
      apiFetch<DisciplineActionTypeDto>('/api/v1/discipline/action-types', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['discipline', 'action-types'] });
    },
  });
}

export function useUpdateDisciplineActionType(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateDisciplineActionTypePayload) =>
      apiFetch<DisciplineActionTypeDto>('/api/v1/discipline/action-types/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['discipline', 'action-types'] });
    },
  });
}

// ─── Cycle 9 Step 5: Behaviour Plans / Goals / Feedback ──────

function buildBehaviorPlansQs(args: ListBehaviorPlansArgs): string {
  const params = new URLSearchParams();
  if (args.studentId) params.set('studentId', args.studentId);
  if (args.status) params.set('status', args.status);
  if (args.planType) params.set('planType', args.planType);
  const qs = params.toString();
  return qs ? '?' + qs : '';
}

export function useBehaviorPlans(args: ListBehaviorPlansArgs = {}, enabled = true) {
  return useQuery({
    queryKey: [
      'discipline',
      'behavior-plans',
      'list',
      {
        studentId: args.studentId ?? null,
        status: args.status ?? null,
        planType: args.planType ?? null,
      },
    ],
    queryFn: () =>
      apiFetch<BehaviorPlanDto[]>('/api/v1/behavior-plans' + buildBehaviorPlansQs(args)),
    enabled,
    staleTime: 30_000,
  });
}

export function useBehaviorPlan(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['discipline', 'behavior-plans', 'one', id],
    queryFn: () => apiFetch<BehaviorPlanDto>('/api/v1/behavior-plans/' + id),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

function invalidatePlan(qc: ReturnType<typeof useQueryClient>, id: string | null): void {
  void qc.invalidateQueries({ queryKey: ['discipline', 'behavior-plans'] });
  if (id) void qc.invalidateQueries({ queryKey: ['discipline', 'behavior-plans', 'one', id] });
}

export function useCreateBehaviorPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateBehaviorPlanPayload) =>
      apiFetch<BehaviorPlanDto>('/api/v1/behavior-plans', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => invalidatePlan(qc, data.id),
  });
}

export function useUpdateBehaviorPlan(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateBehaviorPlanPayload) =>
      apiFetch<BehaviorPlanDto>('/api/v1/behavior-plans/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidatePlan(qc, id),
  });
}

export function useActivateBehaviorPlan(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<BehaviorPlanDto>('/api/v1/behavior-plans/' + id + '/activate', {
        method: 'PATCH',
      }),
    onSuccess: () => invalidatePlan(qc, id),
  });
}

export function useExpireBehaviorPlan(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<BehaviorPlanDto>('/api/v1/behavior-plans/' + id + '/expire', {
        method: 'PATCH',
      }),
    onSuccess: () => invalidatePlan(qc, id),
  });
}

// ── Goals ─────────────────────────────────────────────────────

export function useAddGoal(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateGoalPayload) =>
      apiFetch<GoalDto>('/api/v1/behavior-plans/' + planId + '/goals', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidatePlan(qc, planId),
  });
}

export function useUpdateGoal(goalId: string, planIdForInvalidate?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateGoalPayload) =>
      apiFetch<GoalDto>('/api/v1/behavior-plan-goals/' + goalId, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['discipline', 'behavior-plans'] });
      if (planIdForInvalidate) {
        void qc.invalidateQueries({
          queryKey: ['discipline', 'behavior-plans', 'one', planIdForInvalidate],
        });
      }
    },
  });
}

export function useDeleteGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (goalId: string) =>
      apiFetch<void>('/api/v1/behavior-plan-goals/' + goalId, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['discipline', 'behavior-plans'] });
    },
  });
}

// ── Feedback ──────────────────────────────────────────────────

export function useFeedbackForPlan(planId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['discipline', 'behavior-plans', 'feedback', planId],
    queryFn: () => apiFetch<BIPFeedbackDto[]>('/api/v1/behavior-plans/' + planId + '/feedback'),
    enabled: enabled && typeof planId === 'string' && planId.length > 0,
    staleTime: 30_000,
  });
}

export function useFeedbackPending(enabled = true) {
  return useQuery({
    queryKey: ['discipline', 'bip-feedback', 'pending'],
    queryFn: () => apiFetch<BIPFeedbackDto[]>('/api/v1/bip-feedback/pending'),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useRequestFeedback(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: RequestFeedbackPayload) =>
      apiFetch<BIPFeedbackDto>('/api/v1/behavior-plans/' + planId + '/feedback-requests', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['discipline', 'behavior-plans', 'one', planId] });
      void qc.invalidateQueries({ queryKey: ['discipline', 'behavior-plans', 'feedback', planId] });
      void qc.invalidateQueries({ queryKey: ['discipline', 'bip-feedback', 'pending'] });
      // Step 6 BehaviourNotificationConsumer enqueues IN_APP rows + the
      // Cycle 7 TaskWorker creates an AUTO task on the recipient
      // teacher's list — refresh both badges.
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useSubmitFeedback(feedbackId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SubmitFeedbackPayload) =>
      apiFetch<BIPFeedbackDto>('/api/v1/bip-feedback/' + feedbackId, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['discipline', 'behavior-plans'] });
      void qc.invalidateQueries({ queryKey: ['discipline', 'bip-feedback', 'pending'] });
    },
  });
}
