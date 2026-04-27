'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { ClassDto } from '@/lib/types';

export function useMyClasses() {
  return useQuery({
    queryKey: ['classes', 'my'],
    queryFn: () => apiFetch<ClassDto[]>('/api/v1/classes/my'),
  });
}
