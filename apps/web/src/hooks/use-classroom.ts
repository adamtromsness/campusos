'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AssignmentCategoryDto,
  AssignmentDto,
  AssignmentTypeDto,
  CreateAssignmentPayload,
  UpdateAssignmentPayload,
  UpsertCategoryEntry,
} from '@/lib/types';

// ── Assignment types (school-wide) ───────────────────────────────────────

export function useAssignmentTypes() {
  return useQuery({
    queryKey: ['classroom', 'assignment-types'],
    queryFn: () => apiFetch<AssignmentTypeDto[]>('/api/v1/assignment-types'),
    staleTime: 60_000,
  });
}

// ── Per-class assignments ────────────────────────────────────────────────

interface UseAssignmentsOptions {
  includeUnpublished?: boolean;
}

export function useAssignments(classId: string | undefined, opts: UseAssignmentsOptions = {}) {
  const includeUnpublished = opts.includeUnpublished === true;
  return useQuery({
    queryKey: ['classroom', 'assignments', 'class', classId, includeUnpublished],
    queryFn: () => {
      const qs = includeUnpublished ? '?includeUnpublished=true' : '';
      return apiFetch<AssignmentDto[]>(`/api/v1/classes/${classId}/assignments${qs}`);
    },
    enabled: !!classId,
  });
}

export function useAssignment(assignmentId: string | undefined) {
  return useQuery({
    queryKey: ['classroom', 'assignment', assignmentId],
    queryFn: () => apiFetch<AssignmentDto>(`/api/v1/assignments/${assignmentId}`),
    enabled: !!assignmentId,
  });
}

export function useCreateAssignment(classId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAssignmentPayload) =>
      apiFetch<AssignmentDto>(`/api/v1/classes/${classId}/assignments`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['classroom', 'assignments', 'class', classId] });
    },
  });
}

export function useUpdateAssignment(assignmentId: string, classId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAssignmentPayload) =>
      apiFetch<AssignmentDto>(`/api/v1/assignments/${assignmentId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['classroom', 'assignment', assignmentId], data);
      void qc.invalidateQueries({ queryKey: ['classroom', 'assignments', 'class', classId] });
    },
  });
}

export function useDeleteAssignment(assignmentId: string, classId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/v1/assignments/${assignmentId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['classroom', 'assignments', 'class', classId] });
    },
  });
}

// ── Per-class categories ────────────────────────────────────────────────

export function useCategories(classId: string | undefined) {
  return useQuery({
    queryKey: ['classroom', 'categories', 'class', classId],
    queryFn: () => apiFetch<AssignmentCategoryDto[]>(`/api/v1/classes/${classId}/categories`),
    enabled: !!classId,
  });
}

export function useUpsertCategories(classId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (categories: UpsertCategoryEntry[]) =>
      apiFetch<AssignmentCategoryDto[]>(`/api/v1/classes/${classId}/categories`, {
        method: 'PUT',
        body: JSON.stringify({ categories }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['classroom', 'categories', 'class', classId], data);
      // Categories influence assignment list display (category name on each row)
      void qc.invalidateQueries({ queryKey: ['classroom', 'assignments', 'class', classId] });
    },
  });
}
