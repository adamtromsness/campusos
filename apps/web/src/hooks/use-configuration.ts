'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

const PREFIX = '/api/v1/admin/configuration';

/**
 * School Configuration Admin — Step 1 hook surface.
 *
 * Backed by /api/v1/admin/configuration/setup-status (gated on
 * sys-001:admin). Steps 2-7 will land facility-tree / academic-tree /
 * position-tree / connections-summary / imports / grade-bands hooks
 * in this same file.
 */

export type SetupStatus = 'DONE' | 'PARTIAL' | 'NOT_STARTED';

export type SetupStatusKey =
  | 'buildings'
  | 'rooms'
  | 'academic_year'
  | 'classes'
  | 'positions'
  | 'staff_assigned'
  | 'classes_in_rooms';

export interface SetupStatusItem {
  key: SetupStatusKey;
  label: string;
  status: SetupStatus;
  count: number;
  doneThreshold: number;
}

export interface SetupStatusResponseDto {
  items: SetupStatusItem[];
  completedCount: number;
  totalCount: number;
}

export function useSetupStatus(enabled = true) {
  return useQuery({
    queryKey: ['configuration', 'setup-status'],
    queryFn: () => apiFetch<SetupStatusResponseDto>(`${PREFIX}/setup-status`),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}
