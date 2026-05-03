'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AbsenceRequestDto,
  AttendanceRecord,
  ChildLinkRequestDto,
  ChildLinkRequestStatus,
  ChildSearchArgs,
  ChildSearchResultDto,
  CreateAbsenceRequestPayload,
  ReviewLinkRequestPayload,
  StudentDto,
  SubmitAddNewChildPayload,
  SubmitLinkExistingPayload,
} from '@/lib/types';

export function useMyChildren() {
  return useQuery({
    queryKey: ['students', 'my-children'],
    queryFn: () => apiFetch<StudentDto[]>('/api/v1/students/my-children'),
  });
}

export function useStudent(studentId: string | undefined) {
  return useQuery({
    queryKey: ['student', studentId],
    queryFn: () => apiFetch<StudentDto>(`/api/v1/students/${studentId}`),
    enabled: !!studentId,
  });
}

export function useStudentAttendance(
  studentId: string | undefined,
  fromDate?: string,
  toDate?: string,
) {
  const params = new URLSearchParams();
  if (fromDate) params.set('fromDate', fromDate);
  if (toDate) params.set('toDate', toDate);
  const qs = params.toString();
  return useQuery({
    queryKey: ['student-attendance', studentId, fromDate, toDate],
    queryFn: () =>
      apiFetch<AttendanceRecord[]>(`/api/v1/students/${studentId}/attendance${qs ? `?${qs}` : ''}`),
    enabled: !!studentId,
  });
}

export function useSubmitAbsenceRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAbsenceRequestPayload) =>
      apiFetch<AbsenceRequestDto>('/api/v1/absence-requests', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['absence-requests'] });
    },
  });
}

// ── Add Child / Child Link Requests ─────────────────────────────────

export function useChildSearch(args: ChildSearchArgs | null) {
  const enabled = !!args && !!args.firstName && !!args.lastName && !!args.dateOfBirth;
  const qs = enabled
    ? new URLSearchParams({
        firstName: args!.firstName,
        lastName: args!.lastName,
        dateOfBirth: args!.dateOfBirth,
      }).toString()
    : '';
  return useQuery({
    queryKey: ['children', 'search', args],
    queryFn: () => apiFetch<ChildSearchResultDto[]>(`/api/v1/children/search?${qs}`),
    enabled,
  });
}

export function useChildLinkRequests(status?: ChildLinkRequestStatus, enabled = true) {
  const qs = status ? `?status=${status}` : '';
  return useQuery({
    queryKey: ['children', 'link-requests', status ?? null],
    queryFn: () => apiFetch<ChildLinkRequestDto[]>(`/api/v1/children/link-requests${qs}`),
    enabled,
  });
}

export function useSubmitLinkExistingChild() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SubmitLinkExistingPayload) =>
      apiFetch<ChildLinkRequestDto>('/api/v1/children/link-request', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['children', 'link-requests'] });
    },
  });
}

export function useSubmitAddNewChild() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SubmitAddNewChildPayload) =>
      apiFetch<ChildLinkRequestDto>('/api/v1/children/add-request', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['children', 'link-requests'] });
    },
  });
}

export function useApproveChildLinkRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ReviewLinkRequestPayload }) =>
      apiFetch<ChildLinkRequestDto>(`/api/v1/children/link-requests/${id}/approve`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['children', 'link-requests'] });
      // Approving may also affect the parent's children list once the
      // approver is the same user, but more importantly for fresh data
      // after admin approval.
      void qc.invalidateQueries({ queryKey: ['students'] });
    },
  });
}

export function useRejectChildLinkRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ReviewLinkRequestPayload }) =>
      apiFetch<ChildLinkRequestDto>(`/api/v1/children/link-requests/${id}/reject`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['children', 'link-requests'] });
    },
  });
}
