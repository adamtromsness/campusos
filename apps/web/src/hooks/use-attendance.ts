'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AttendanceRecord,
  BatchAttendanceEntry,
  BatchSubmitResult,
  ClassDto,
} from '@/lib/types';

export function useClass(classId: string | undefined) {
  return useQuery({
    queryKey: ['class', classId],
    queryFn: () => apiFetch<ClassDto>(`/api/v1/classes/${classId}`),
    enabled: !!classId,
  });
}

export function useClassAttendance(
  classId: string | undefined,
  date: string,
  period: string | undefined,
) {
  return useQuery({
    queryKey: ['attendance', classId, date, period],
    queryFn: () => {
      const qs = period ? `?period=${encodeURIComponent(period)}` : '';
      return apiFetch<AttendanceRecord[]>(`/api/v1/classes/${classId}/attendance/${date}${qs}`);
    },
    enabled: !!classId && !!date && !!period,
  });
}

interface BatchSubmitArgs {
  period: string;
  records: BatchAttendanceEntry[];
}

export function useBatchSubmitAttendance(classId: string, date: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ period, records }: BatchSubmitArgs) =>
      apiFetch<BatchSubmitResult>(`/api/v1/classes/${classId}/attendance/${date}/batch`, {
        method: 'POST',
        body: JSON.stringify({ period, records }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['attendance', classId, date] });
      void qc.invalidateQueries({ queryKey: ['classes', 'my'] });
    },
  });
}
