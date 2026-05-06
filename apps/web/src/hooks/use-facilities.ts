import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  FacAdjustSupplyPayload,
  FacBookingDto,
  FacBuildingDto,
  FacChecklistResultDto,
  FacClosureDto,
  FacCreateBookingPayload,
  FacCreateBuildingPayload,
  FacCreateClosurePayload,
  FacCreateInspectionPayload,
  FacCreateInspectionTypePayload,
  FacCreatePmPlanPayload,
  FacCreateSpacePayload,
  FacCreateSupplyPayload,
  FacCreateViolationPayload,
  FacCreateWorkOrderPayload,
  FacCreateZoneAssignmentPayload,
  FacCreateZonePayload,
  FacGeneratePmTasksPayload,
  FacInspectionDto,
  FacInspectionTypeDto,
  FacPmPlanDto,
  FacPmTaskDto,
  FacPmTaskStatus,
  FacResolveViolationPayload,
  FacSpaceDto,
  FacSubmitChecklistResultsPayload,
  FacSupplyDto,
  FacUpdateBookingPayload,
  FacUpdateBuildingPayload,
  FacUpdateClosurePayload,
  FacUpdatePmTaskPayload,
  FacUpdateSpacePayload,
  FacUpdateWorkOrderPayload,
  FacViolationDto,
  FacWorkOrderActivityDto,
  FacWorkOrderDto,
  FacWorkOrderPriority,
  FacWorkOrderStatus,
  FacZoneDto,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ── Buildings ──
export function useFacBuildings() {
  return useQuery({
    queryKey: ['facilities', 'buildings'],
    queryFn: () => apiFetch<FacBuildingDto[]>(`${PREFIX}/facilities/buildings`),
    refetchOnWindowFocus: true,
  });
}

export function useFacBuilding(id: string | null) {
  return useQuery({
    queryKey: ['facilities', 'building', id],
    queryFn: () => apiFetch<FacBuildingDto>(`${PREFIX}/facilities/buildings/${id}`),
    enabled: !!id,
  });
}

export function useFacCreateBuilding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacCreateBuildingPayload) =>
      apiFetch<FacBuildingDto>(`${PREFIX}/facilities/buildings`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'buildings'] });
    },
  });
}

export function useFacUpdateBuilding(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacUpdateBuildingPayload) =>
      apiFetch<FacBuildingDto>(`${PREFIX}/facilities/buildings/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'buildings'] });
      qc.invalidateQueries({ queryKey: ['facilities', 'building', id] });
    },
  });
}

// ── Spaces ──
export function useFacSpaces(buildingId: string | null) {
  return useQuery({
    queryKey: ['facilities', 'spaces', buildingId],
    queryFn: () => apiFetch<FacSpaceDto[]>(`${PREFIX}/facilities/buildings/${buildingId}/spaces`),
    enabled: !!buildingId,
  });
}

export function useFacSpace(id: string | null) {
  return useQuery({
    queryKey: ['facilities', 'space', id],
    queryFn: () => apiFetch<FacSpaceDto>(`${PREFIX}/facilities/spaces/${id}`),
    enabled: !!id,
  });
}

export function useFacCreateSpace(buildingId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacCreateSpacePayload) =>
      apiFetch<FacSpaceDto>(`${PREFIX}/facilities/buildings/${buildingId}/spaces`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'spaces', buildingId] });
    },
  });
}

export function useFacUpdateSpace(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacUpdateSpacePayload) =>
      apiFetch<FacSpaceDto>(`${PREFIX}/facilities/spaces/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'space', id] });
      qc.invalidateQueries({ queryKey: ['facilities', 'spaces'] });
    },
  });
}

// ── Bookings ──
export function useFacSpaceBookings(
  spaceId: string | null,
  args?: { fromDate?: string; toDate?: string },
) {
  const qs = new URLSearchParams();
  if (args?.fromDate) qs.set('fromDate', args.fromDate);
  if (args?.toDate) qs.set('toDate', args.toDate);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return useQuery({
    queryKey: ['facilities', 'bookings', 'space', spaceId, args?.fromDate, args?.toDate],
    queryFn: () =>
      apiFetch<FacBookingDto[]>(`${PREFIX}/facilities/spaces/${spaceId}/bookings${suffix}`),
    enabled: !!spaceId,
  });
}

export function useFacMyBookings() {
  return useQuery({
    queryKey: ['facilities', 'bookings', 'mine'],
    queryFn: () => apiFetch<FacBookingDto[]>(`${PREFIX}/facilities/bookings/my`),
    refetchOnWindowFocus: true,
  });
}

export function useFacCreateBooking(spaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacCreateBookingPayload) =>
      apiFetch<FacBookingDto>(`${PREFIX}/facilities/spaces/${spaceId}/bookings`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'bookings'] });
    },
  });
}

export function useFacUpdateBooking(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacUpdateBookingPayload) =>
      apiFetch<FacBookingDto>(`${PREFIX}/facilities/bookings/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'bookings'] });
    },
  });
}

// ── Closures ──
export function useFacClosures(activeOnly = true) {
  return useQuery({
    queryKey: ['facilities', 'closures', activeOnly],
    queryFn: () =>
      apiFetch<FacClosureDto[]>(
        `${PREFIX}/facilities/closures${activeOnly ? '?activeOnly=true' : ''}`,
      ),
  });
}

export function useFacCreateClosure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacCreateClosurePayload) =>
      apiFetch<FacClosureDto>(`${PREFIX}/facilities/closures`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'closures'] });
    },
  });
}

export function useFacUpdateClosure(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacUpdateClosurePayload) =>
      apiFetch<FacClosureDto>(`${PREFIX}/facilities/closures/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'closures'] });
    },
  });
}

// ── Work Orders ──
export function useFacWorkOrders(args?: {
  status?: FacWorkOrderStatus;
  priority?: FacWorkOrderPriority;
  buildingId?: string;
  assignedToId?: string;
}) {
  const qs = new URLSearchParams();
  if (args?.status) qs.set('status', args.status);
  if (args?.priority) qs.set('priority', args.priority);
  if (args?.buildingId) qs.set('buildingId', args.buildingId);
  if (args?.assignedToId) qs.set('assignedToId', args.assignedToId);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return useQuery({
    queryKey: ['facilities', 'work-orders', args],
    queryFn: () => apiFetch<FacWorkOrderDto[]>(`${PREFIX}/facilities/work-orders${suffix}`),
    refetchOnWindowFocus: true,
  });
}

export function useFacWorkOrder(id: string | null) {
  return useQuery({
    queryKey: ['facilities', 'work-order', id],
    queryFn: () => apiFetch<FacWorkOrderDto>(`${PREFIX}/facilities/work-orders/${id}`),
    enabled: !!id,
  });
}

export function useFacWorkOrderActivity(id: string | null) {
  return useQuery({
    queryKey: ['facilities', 'work-order-activity', id],
    queryFn: () =>
      apiFetch<FacWorkOrderActivityDto[]>(`${PREFIX}/facilities/work-orders/${id}/activity`),
    enabled: !!id,
  });
}

export function useFacCreateWorkOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacCreateWorkOrderPayload) =>
      apiFetch<FacWorkOrderDto>(`${PREFIX}/facilities/work-orders`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'work-orders'] });
    },
  });
}

export function useFacUpdateWorkOrder(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacUpdateWorkOrderPayload) =>
      apiFetch<FacWorkOrderDto>(`${PREFIX}/facilities/work-orders/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'work-orders'] });
      qc.invalidateQueries({ queryKey: ['facilities', 'work-order', id] });
      qc.invalidateQueries({ queryKey: ['facilities', 'work-order-activity', id] });
    },
  });
}

export function useFacCommentWorkOrder(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      apiFetch<FacWorkOrderDto>(`${PREFIX}/facilities/work-orders/${id}/comment`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'work-order', id] });
      qc.invalidateQueries({ queryKey: ['facilities', 'work-order-activity', id] });
    },
  });
}

// ── PM ──
export function useFacPmPlans() {
  return useQuery({
    queryKey: ['facilities', 'pm-plans'],
    queryFn: () => apiFetch<FacPmPlanDto[]>(`${PREFIX}/facilities/pm-plans`),
  });
}

export function useFacPmPlan(id: string | null) {
  return useQuery({
    queryKey: ['facilities', 'pm-plan', id],
    queryFn: () => apiFetch<FacPmPlanDto>(`${PREFIX}/facilities/pm-plans/${id}`),
    enabled: !!id,
  });
}

export function useFacCreatePmPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacCreatePmPlanPayload) =>
      apiFetch<FacPmPlanDto>(`${PREFIX}/facilities/pm-plans`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'pm-plans'] });
    },
  });
}

export function useFacGeneratePmTasks(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacGeneratePmTasksPayload) =>
      apiFetch<{ created: number; skipped: number; firstId: string | null }>(
        `${PREFIX}/facilities/pm-plans/${planId}/generate-tasks`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'pm-tasks'] });
    },
  });
}

export function useFacPmTasks(args?: {
  planId?: string;
  status?: FacPmTaskStatus;
  fromDate?: string;
  toDate?: string;
}) {
  const qs = new URLSearchParams();
  if (args?.planId) qs.set('planId', args.planId);
  if (args?.status) qs.set('status', args.status);
  if (args?.fromDate) qs.set('fromDate', args.fromDate);
  if (args?.toDate) qs.set('toDate', args.toDate);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return useQuery({
    queryKey: ['facilities', 'pm-tasks', args],
    queryFn: () => apiFetch<FacPmTaskDto[]>(`${PREFIX}/facilities/pm-tasks${suffix}`),
  });
}

export function useFacPmTask(id: string | null) {
  return useQuery({
    queryKey: ['facilities', 'pm-task', id],
    queryFn: () => apiFetch<FacPmTaskDto>(`${PREFIX}/facilities/pm-tasks/${id}`),
    enabled: !!id,
  });
}

export function useFacPmTaskResults(id: string | null) {
  return useQuery({
    queryKey: ['facilities', 'pm-task-results', id],
    queryFn: () => apiFetch<FacChecklistResultDto[]>(`${PREFIX}/facilities/pm-tasks/${id}/results`),
    enabled: !!id,
  });
}

export function useFacUpdatePmTask(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacUpdatePmTaskPayload) =>
      apiFetch<FacPmTaskDto>(`${PREFIX}/facilities/pm-tasks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'pm-tasks'] });
      qc.invalidateQueries({ queryKey: ['facilities', 'pm-task', id] });
    },
  });
}

export function useFacSubmitPmResults(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacSubmitChecklistResultsPayload) =>
      apiFetch<{ task: FacPmTaskDto; followUpWorkOrders: string[] }>(
        `${PREFIX}/facilities/pm-tasks/${id}/results`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'pm-tasks'] });
      qc.invalidateQueries({ queryKey: ['facilities', 'pm-task', id] });
      qc.invalidateQueries({ queryKey: ['facilities', 'pm-task-results', id] });
      qc.invalidateQueries({ queryKey: ['facilities', 'work-orders'] });
    },
  });
}

// ── Inspections ──
export function useFacInspectionTypes() {
  return useQuery({
    queryKey: ['facilities', 'inspection-types'],
    queryFn: () => apiFetch<FacInspectionTypeDto[]>(`${PREFIX}/facilities/inspection-types`),
  });
}

export function useFacCreateInspectionType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacCreateInspectionTypePayload) =>
      apiFetch<FacInspectionTypeDto>(`${PREFIX}/facilities/inspection-types`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'inspection-types'] });
    },
  });
}

export function useFacInspections(buildingId?: string | null) {
  const suffix = buildingId ? `?buildingId=${buildingId}` : '';
  return useQuery({
    queryKey: ['facilities', 'inspections', buildingId],
    queryFn: () => apiFetch<FacInspectionDto[]>(`${PREFIX}/facilities/inspections${suffix}`),
  });
}

export function useFacInspection(id: string | null) {
  return useQuery({
    queryKey: ['facilities', 'inspection', id],
    queryFn: () => apiFetch<FacInspectionDto>(`${PREFIX}/facilities/inspections/${id}`),
    enabled: !!id,
  });
}

export function useFacCreateInspection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacCreateInspectionPayload) =>
      apiFetch<FacInspectionDto>(`${PREFIX}/facilities/inspections`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'inspections'] });
    },
  });
}

// ── Violations ──
export function useFacInspectionViolations(inspectionId: string | null) {
  return useQuery({
    queryKey: ['facilities', 'violations', 'insp', inspectionId],
    queryFn: () =>
      apiFetch<FacViolationDto[]>(`${PREFIX}/facilities/inspections/${inspectionId}/violations`),
    enabled: !!inspectionId,
  });
}

export function useFacActiveViolations() {
  return useQuery({
    queryKey: ['facilities', 'violations', 'active'],
    queryFn: () => apiFetch<FacViolationDto[]>(`${PREFIX}/facilities/violations`),
    refetchOnWindowFocus: true,
  });
}

export function useFacCreateViolation(inspectionId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacCreateViolationPayload) =>
      apiFetch<FacViolationDto>(`${PREFIX}/facilities/inspections/${inspectionId}/violations`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'violations'] });
    },
  });
}

export function useFacResolveViolation(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacResolveViolationPayload) =>
      apiFetch<FacViolationDto>(`${PREFIX}/facilities/violations/${id}/resolve`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'violations'] });
    },
  });
}

// ── Zones ──
export function useFacZones() {
  return useQuery({
    queryKey: ['facilities', 'zones'],
    queryFn: () => apiFetch<FacZoneDto[]>(`${PREFIX}/facilities/zones`),
  });
}

export function useFacCreateZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacCreateZonePayload) =>
      apiFetch<FacZoneDto>(`${PREFIX}/facilities/zones`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'zones'] });
    },
  });
}

export function useFacCreateZoneAssignment(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacCreateZoneAssignmentPayload) =>
      apiFetch(`${PREFIX}/facilities/zones/${zoneId}/assignments`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'zones'] });
    },
  });
}

// ── Supply ──
export function useFacBuildingSupply(buildingId: string | null) {
  return useQuery({
    queryKey: ['facilities', 'supply', buildingId],
    queryFn: () => apiFetch<FacSupplyDto[]>(`${PREFIX}/facilities/buildings/${buildingId}/supply`),
    enabled: !!buildingId,
  });
}

export function useFacCreateSupply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacCreateSupplyPayload) =>
      apiFetch<FacSupplyDto>(`${PREFIX}/facilities/supply`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'supply'] });
    },
  });
}

export function useFacAdjustSupply(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FacAdjustSupplyPayload) =>
      apiFetch<FacSupplyDto>(`${PREFIX}/facilities/supply/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facilities', 'supply'] });
    },
  });
}
