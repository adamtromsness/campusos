'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { AbsenceRequestDto } from '@/lib/types';

interface UseAbsenceRequestsOptions {
  status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  studentId?: string;
}

export function useAbsenceRequests(options: UseAbsenceRequestsOptions = {}) {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.studentId) params.set('studentId', options.studentId);
  const qs = params.toString();

  return useQuery({
    queryKey: ['absence-requests', options],
    queryFn: () => apiFetch<AbsenceRequestDto[]>(`/api/v1/absence-requests${qs ? `?${qs}` : ''}`),
  });
}
