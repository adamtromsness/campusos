'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AssignmentCategoryDto,
  AssignmentDto,
  AssignmentTypeDto,
  BatchGradePayload,
  BatchGradeResultDto,
  CreateAssignmentPayload,
  GradeDto,
  GradeSubmissionPayload,
  GradebookClassResponseDto,
  GradebookStudentResponseDto,
  ProgressNoteDto,
  PublishAllResultDto,
  StudentClassGradesResponseDto,
  StudentDto,
  SubmissionDto,
  SubmitAssignmentPayload,
  TeacherSubmissionListDto,
  UpdateAssignmentPayload,
  UpsertCategoryEntry,
  UpsertProgressNotePayload,
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

// ── Gradebook ────────────────────────────────────────────────────────────

export function useClassGradebook(classId: string | undefined, termId?: string) {
  return useQuery({
    queryKey: ['classroom', 'gradebook', 'class', classId, termId ?? null],
    queryFn: () => {
      const qs = termId ? `?termId=${encodeURIComponent(termId)}` : '';
      return apiFetch<GradebookClassResponseDto>(`/api/v1/classes/${classId}/gradebook${qs}`);
    },
    enabled: !!classId,
  });
}

export function useStudentGradebook(studentId: string | undefined, termId?: string) {
  return useQuery({
    queryKey: ['classroom', 'gradebook', 'student', studentId, termId ?? null],
    queryFn: () => {
      const qs = termId ? `?termId=${encodeURIComponent(termId)}` : '';
      return apiFetch<GradebookStudentResponseDto>(`/api/v1/students/${studentId}/gradebook${qs}`);
    },
    enabled: !!studentId,
  });
}

// ── Per-class student grade breakdown (Step 9) ──────────────────────────

export function useStudentClassGrades(studentId: string | undefined, classId: string | undefined) {
  return useQuery({
    queryKey: ['classroom', 'student-class-grades', studentId, classId],
    queryFn: () =>
      apiFetch<StudentClassGradesResponseDto>(
        `/api/v1/students/${studentId}/classes/${classId}/grades`,
      ),
    enabled: !!studentId && !!classId,
  });
}

// ── Submissions ──────────────────────────────────────────────────────────

export function useSubmissionsForAssignment(assignmentId: string | undefined) {
  return useQuery({
    queryKey: ['classroom', 'submissions', 'assignment', assignmentId],
    queryFn: () =>
      apiFetch<TeacherSubmissionListDto>(`/api/v1/assignments/${assignmentId}/submissions`),
    enabled: !!assignmentId,
  });
}

export function useSubmission(submissionId: string | undefined) {
  return useQuery({
    queryKey: ['classroom', 'submission', submissionId],
    queryFn: () => apiFetch<SubmissionDto>(`/api/v1/submissions/${submissionId}`),
    enabled: !!submissionId,
  });
}

// ── Student-side submission flow (Step 9) ───────────────────────────────

export function useMyStudent() {
  return useQuery({
    queryKey: ['student', 'me'],
    queryFn: () => apiFetch<StudentDto>('/api/v1/students/me'),
    retry: false,
    staleTime: 60_000,
  });
}

export function useMySubmission(assignmentId: string | undefined) {
  return useQuery({
    queryKey: ['classroom', 'submission', 'mine', assignmentId],
    queryFn: () =>
      apiFetch<SubmissionDto | null>(`/api/v1/assignments/${assignmentId}/submissions/mine`),
    enabled: !!assignmentId,
  });
}

export function useSubmitAssignment(assignmentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SubmitAssignmentPayload) =>
      apiFetch<SubmissionDto>(`/api/v1/assignments/${assignmentId}/submit`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['classroom', 'submission', 'mine', assignmentId], data);
      // Per-class breakdown also surfaces submission status — invalidate everything
      // student-scoped so the page reflects the new SUBMITTED state.
      void qc.invalidateQueries({ queryKey: ['classroom', 'student-class-grades'] });
    },
  });
}

// ── Grading mutations ────────────────────────────────────────────────────

interface GradeSubmissionArgs {
  submissionId: string;
  payload: GradeSubmissionPayload;
  /** Used so the hook can invalidate the right caches without an extra round-trip. */
  assignmentId?: string;
  classId?: string;
}

export function useGradeSubmission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ submissionId, payload }: GradeSubmissionArgs) =>
      apiFetch<GradeDto>(`/api/v1/submissions/${submissionId}/grade`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: ['classroom', 'submission', vars.submissionId] });
      if (vars.assignmentId) {
        void qc.invalidateQueries({
          queryKey: ['classroom', 'submissions', 'assignment', vars.assignmentId],
        });
      }
      if (vars.classId) {
        void qc.invalidateQueries({
          queryKey: ['classroom', 'gradebook', 'class', vars.classId],
        });
      }
    },
  });
}

export function useBatchGrade(classId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BatchGradePayload) =>
      apiFetch<BatchGradeResultDto>(`/api/v1/classes/${classId}/grades/batch`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({
        queryKey: ['classroom', 'submissions', 'assignment', data.assignmentId],
      });
      void qc.invalidateQueries({ queryKey: ['classroom', 'gradebook', 'class', classId] });
    },
  });
}

interface GradeIdArgs {
  gradeId: string;
  assignmentId?: string;
  classId?: string;
  submissionId?: string;
}

function invalidateAfterGradeMutation(qc: ReturnType<typeof useQueryClient>, vars: GradeIdArgs) {
  if (vars.submissionId)
    void qc.invalidateQueries({ queryKey: ['classroom', 'submission', vars.submissionId] });
  if (vars.assignmentId)
    void qc.invalidateQueries({
      queryKey: ['classroom', 'submissions', 'assignment', vars.assignmentId],
    });
  if (vars.classId)
    void qc.invalidateQueries({ queryKey: ['classroom', 'gradebook', 'class', vars.classId] });
}

export function usePublishGrade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ gradeId }: GradeIdArgs) =>
      apiFetch<GradeDto>(`/api/v1/grades/${gradeId}/publish`, { method: 'POST' }),
    onSuccess: (_, vars) => invalidateAfterGradeMutation(qc, vars),
  });
}

export function useUnpublishGrade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ gradeId }: GradeIdArgs) =>
      apiFetch<GradeDto>(`/api/v1/grades/${gradeId}/unpublish`, { method: 'POST' }),
    onSuccess: (_, vars) => invalidateAfterGradeMutation(qc, vars),
  });
}

export function usePublishAllGrades(classId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assignmentId: string) =>
      apiFetch<PublishAllResultDto>(`/api/v1/classes/${classId}/grades/publish-all`, {
        method: 'POST',
        body: JSON.stringify({ assignmentId }),
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({
        queryKey: ['classroom', 'submissions', 'assignment', data.assignmentId],
      });
      void qc.invalidateQueries({ queryKey: ['classroom', 'gradebook', 'class', classId] });
    },
  });
}

// ── Progress notes ───────────────────────────────────────────────────────

export function useStudentProgressNotes(studentId: string | undefined) {
  return useQuery({
    queryKey: ['classroom', 'progress-notes', 'student', studentId],
    queryFn: () => apiFetch<ProgressNoteDto[]>(`/api/v1/students/${studentId}/progress-notes`),
    enabled: !!studentId,
  });
}

export function useUpsertProgressNote(classId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpsertProgressNotePayload) =>
      apiFetch<ProgressNoteDto>(`/api/v1/classes/${classId}/progress-notes`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({
        queryKey: ['classroom', 'progress-notes', 'student', data.studentId],
      });
    },
  });
}
