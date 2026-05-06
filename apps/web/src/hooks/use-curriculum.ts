import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CurAdoptionDto,
  CurAlignStandardPayload,
  CurCreateAdoptionPayload,
  CurCreateCustomFrameworkPayload,
  CurCreateMapPayload,
  CurCreateResourcePayload,
  CurCreateStandardPayload,
  CurCreateUnitPayload,
  CurDeliveryGapDto,
  CurFrameworkDetailDto,
  CurFrameworkDto,
  CurGapType,
  CurLinkLessonPayload,
  CurMapDto,
  CurMapStatus,
  CurReorderUnitsPayload,
  CurResourceDto,
  CurStandardDto,
  CurUnitDetailDto,
  CurUnitDto,
  CurUnitLessonDto,
  CurUnitStandardDto,
  CurUpdateMapPayload,
  CurUpdateResourcePayload,
  CurUpdateUnitPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ── Frameworks ──
export function useCurFrameworks(includeUnadopted = false) {
  return useQuery({
    queryKey: ['curriculum', 'frameworks', includeUnadopted],
    queryFn: () =>
      apiFetch<CurFrameworkDto[]>(
        `${PREFIX}/curriculum/frameworks${includeUnadopted ? '?includeUnadopted=true' : ''}`,
      ),
    staleTime: 5 * 60 * 1000,
  });
}

export function useCurFramework(id: string | null) {
  return useQuery({
    queryKey: ['curriculum', 'framework', id],
    queryFn: () => apiFetch<CurFrameworkDetailDto>(`${PREFIX}/curriculum/frameworks/${id}`),
    enabled: !!id,
  });
}

export function useCreateCurCustomFramework() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CurCreateCustomFrameworkPayload) =>
      apiFetch<CurFrameworkDetailDto>(`${PREFIX}/curriculum/frameworks`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['curriculum', 'frameworks'] }),
  });
}

export function useCurAdoptions() {
  return useQuery({
    queryKey: ['curriculum', 'adoptions'],
    queryFn: () => apiFetch<CurAdoptionDto[]>(`${PREFIX}/curriculum/framework-adoptions`),
  });
}

export function useCreateCurAdoption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CurCreateAdoptionPayload) =>
      apiFetch<CurAdoptionDto>(`${PREFIX}/curriculum/framework-adoptions`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['curriculum', 'adoptions'] });
      qc.invalidateQueries({ queryKey: ['curriculum', 'frameworks'] });
    },
  });
}

// ── Standards ──
export function useCurStandards(
  args: {
    q?: string;
    frameworkId?: string;
    gradeBand?: string;
    domain?: string;
    enabled?: boolean;
  } = {},
) {
  const params = new URLSearchParams();
  if (args.q) params.set('q', args.q);
  if (args.frameworkId) params.set('frameworkId', args.frameworkId);
  if (args.gradeBand) params.set('gradeBand', args.gradeBand);
  if (args.domain) params.set('domain', args.domain);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['curriculum', 'standards', args],
    queryFn: () => apiFetch<CurStandardDto[]>(`${PREFIX}/curriculum/standards${qs}`),
    enabled: args.enabled ?? true,
    staleTime: 30 * 1000,
  });
}

export function useCreateCurCustomStandard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CurCreateStandardPayload) =>
      apiFetch<CurStandardDto>(`${PREFIX}/curriculum/standards`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['curriculum', 'standards'] });
      qc.invalidateQueries({ queryKey: ['curriculum', 'frameworks'] });
    },
  });
}

// ── Curriculum Maps ──
export function useCurMaps(
  args: {
    subject?: string;
    gradeLevel?: string;
    academicYearId?: string;
    status?: CurMapStatus;
  } = {},
) {
  const params = new URLSearchParams();
  if (args.subject) params.set('subject', args.subject);
  if (args.gradeLevel) params.set('gradeLevel', args.gradeLevel);
  if (args.academicYearId) params.set('academicYearId', args.academicYearId);
  if (args.status) params.set('status', args.status);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['curriculum', 'maps', args],
    queryFn: () => apiFetch<CurMapDto[]>(`${PREFIX}/curriculum/maps${qs}`),
    refetchOnWindowFocus: true,
  });
}

export function useCurMap(id: string | null) {
  return useQuery({
    queryKey: ['curriculum', 'map', id],
    queryFn: () => apiFetch<CurMapDto>(`${PREFIX}/curriculum/maps/${id}`),
    enabled: !!id,
  });
}

export function useCreateCurMap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CurCreateMapPayload) =>
      apiFetch<CurMapDto>(`${PREFIX}/curriculum/maps`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['curriculum', 'maps'] }),
  });
}

export function useUpdateCurMap(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CurUpdateMapPayload) =>
      apiFetch<CurMapDto>(`${PREFIX}/curriculum/maps/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['curriculum', 'maps'] });
      qc.invalidateQueries({ queryKey: ['curriculum', 'map', id] });
    },
  });
}

// ── Units ──
export function useCurUnitsForMap(mapId: string | null) {
  return useQuery({
    queryKey: ['curriculum', 'units', mapId],
    queryFn: () => apiFetch<CurUnitDto[]>(`${PREFIX}/curriculum/maps/${mapId}/units`),
    enabled: !!mapId,
  });
}

export function useCurUnit(id: string | null) {
  return useQuery({
    queryKey: ['curriculum', 'unit', id],
    queryFn: () => apiFetch<CurUnitDetailDto>(`${PREFIX}/curriculum/units/${id}`),
    enabled: !!id,
  });
}

export function useCreateCurUnit(mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CurCreateUnitPayload) =>
      apiFetch<CurUnitDto>(`${PREFIX}/curriculum/maps/${mapId}/units`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['curriculum', 'units', mapId] });
      qc.invalidateQueries({ queryKey: ['curriculum', 'maps'] });
    },
  });
}

export function useUpdateCurUnit(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CurUpdateUnitPayload) =>
      apiFetch<CurUnitDetailDto>(`${PREFIX}/curriculum/units/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['curriculum', 'units'] });
      qc.invalidateQueries({ queryKey: ['curriculum', 'unit', id] });
    },
  });
}

export function useReorderCurUnits(mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CurReorderUnitsPayload) =>
      apiFetch<CurUnitDto[]>(`${PREFIX}/curriculum/maps/${mapId}/units/reorder`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['curriculum', 'units', mapId] }),
  });
}

export function useAlignCurStandard(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CurAlignStandardPayload) =>
      apiFetch<CurUnitStandardDto>(`${PREFIX}/curriculum/units/${unitId}/standards`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['curriculum', 'unit', unitId] });
      qc.invalidateQueries({ queryKey: ['curriculum', 'units'] });
    },
  });
}

export function useUnalignCurStandard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`${PREFIX}/curriculum/unit-standards/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['curriculum'] }),
  });
}

export function useLinkCurLesson(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CurLinkLessonPayload) =>
      apiFetch<CurUnitLessonDto>(`${PREFIX}/curriculum/units/${unitId}/lessons`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['curriculum', 'unit', unitId] }),
  });
}

export function useUnlinkCurLesson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`${PREFIX}/curriculum/unit-lessons/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['curriculum'] }),
  });
}

// ── Delivery Gaps ──
export function useCurDeliveryGaps(
  args: {
    curriculumMapId?: string;
    unitId?: string;
    gapType?: CurGapType;
  } = {},
) {
  const params = new URLSearchParams();
  if (args.curriculumMapId) params.set('curriculumMapId', args.curriculumMapId);
  if (args.unitId) params.set('unitId', args.unitId);
  if (args.gapType) params.set('gapType', args.gapType);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['curriculum', 'gaps', args],
    queryFn: () => apiFetch<CurDeliveryGapDto[]>(`${PREFIX}/curriculum/delivery-gaps${qs}`),
  });
}

export function useRefreshCurGaps() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ unitsScanned: number; gapsWritten: number }>(
        `${PREFIX}/curriculum/delivery-gaps/refresh`,
        { method: 'POST', body: '{}' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['curriculum'] }),
  });
}

// ── Resources ──
export function useCurResources(unitId: string | null) {
  return useQuery({
    queryKey: ['curriculum', 'resources', unitId],
    queryFn: () => apiFetch<CurResourceDto[]>(`${PREFIX}/curriculum/units/${unitId}/resources`),
    enabled: !!unitId,
  });
}

export function useCreateCurResource(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CurCreateResourcePayload) =>
      apiFetch<CurResourceDto>(`${PREFIX}/curriculum/units/${unitId}/resources`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['curriculum', 'resources', unitId] });
      qc.invalidateQueries({ queryKey: ['curriculum', 'unit', unitId] });
    },
  });
}

export function useUpdateCurResource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CurUpdateResourcePayload }) =>
      apiFetch<CurResourceDto>(`${PREFIX}/curriculum/resources/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['curriculum'] }),
  });
}

export function useDeleteCurResource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`${PREFIX}/curriculum/resources/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['curriculum'] }),
  });
}
