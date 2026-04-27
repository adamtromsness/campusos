'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AbsenceRequestDto,
  AttendanceRecord,
  CreateAbsenceRequestPayload,
  StudentDto,
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
