import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ApproveChangeRequestPayload,
  CompleteRunLogPayload,
  CreateBusPassPayload,
  CreateDelayReportPayload,
  CreateDriverCredentialPayload,
  CreateInspectionPayload,
  CreateRunLogPayload,
  CreateTransportAssignmentPayload,
  CreateTransportChangeRequestPayload,
  CreateTransportRoutePayload,
  CreateTransportVehiclePayload,
  CreateVehicleDocumentPayload,
  DelayReportDto,
  DriverCredentialDto,
  DriverDto,
  NoShowAlertDto,
  RejectChangeRequestPayload,
  ResolveNoShowPayload,
  RidershipRecordDto,
  RouteChangeLogDto,
  RouteDirection,
  RouteStatus,
  RunLogDto,
  ScanRidershipPayload,
  TransportBusPassDto,
  TransportInspectionDto,
  TransportRouteChangeRequestDto,
  TransportRouteDto,
  TransportStopDto,
  TransportStudentAssignmentDto,
  TransportVehicleDocumentDto,
  TransportVehicleDto,
  UpdateDriverCredentialPayload,
  UpdateTransportRoutePayload,
  VehicleStatus,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ── Routes ──
export function useTransportRoutes(args?: { status?: RouteStatus; direction?: RouteDirection }) {
  const params = new URLSearchParams();
  if (args?.status) params.set('status', args.status);
  if (args?.direction) params.set('direction', args.direction);
  const qs = params.toString();
  return useQuery({
    queryKey: ['transport', 'routes', { ...args }],
    queryFn: () => apiFetch<TransportRouteDto[]>(`${PREFIX}/transport/routes${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useTransportRoute(id: string | null) {
  return useQuery({
    queryKey: ['transport', 'route', id],
    queryFn: () => apiFetch<TransportRouteDto>(`${PREFIX}/transport/routes/${id}`),
    enabled: !!id,
  });
}

export function useTransportRouteStops(id: string | null) {
  return useQuery({
    queryKey: ['transport', 'route-stops', id],
    queryFn: () => apiFetch<TransportStopDto[]>(`${PREFIX}/transport/routes/${id}/stops`),
    enabled: !!id,
  });
}

export function useCreateTransportRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTransportRoutePayload) =>
      apiFetch<TransportRouteDto>(`${PREFIX}/transport/routes`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

export function useUpdateTransportRoute(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateTransportRoutePayload) =>
      apiFetch<TransportRouteDto>(`${PREFIX}/transport/routes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

// ── Stops ──
export function useCreateStop(routeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      address?: string;
      sequenceOrder: number;
      scheduledTime?: string;
    }) =>
      apiFetch<TransportStopDto>(`${PREFIX}/transport/routes/${routeId}/stops`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

export function useDeleteStop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`${PREFIX}/transport/stops/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

// ── Assignments ──
export function useRouteAssignments(routeId: string | null) {
  return useQuery({
    queryKey: ['transport', 'assignments', routeId],
    queryFn: () =>
      apiFetch<TransportStudentAssignmentDto[]>(`${PREFIX}/transport/routes/${routeId}/students`),
    enabled: !!routeId,
  });
}

export function useMyTransportRoute() {
  return useQuery({
    queryKey: ['transport', 'my-route'],
    queryFn: () => apiFetch<TransportStudentAssignmentDto[]>(`${PREFIX}/transport/my-route`),
    staleTime: 60_000,
  });
}

export function useCreateAssignment(routeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTransportAssignmentPayload) =>
      apiFetch<TransportStudentAssignmentDto>(`${PREFIX}/transport/routes/${routeId}/students`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

export function useDeleteAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`${PREFIX}/transport/student-assignments/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

// ── Change requests ──
export function useChangeRequests(args?: { status?: 'PENDING' | 'APPROVED' | 'REJECTED' }) {
  const params = new URLSearchParams();
  if (args?.status) params.set('status', args.status);
  const qs = params.toString();
  return useQuery({
    queryKey: ['transport', 'change-requests', { ...args }],
    queryFn: () =>
      apiFetch<TransportRouteChangeRequestDto[]>(
        `${PREFIX}/transport/route-changes${qs ? `?${qs}` : ''}`,
      ),
    staleTime: 30_000,
  });
}

export function useSubmitChangeRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTransportChangeRequestPayload) =>
      apiFetch<TransportRouteChangeRequestDto>(`${PREFIX}/transport/route-changes`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

export function useApproveChangeRequest(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ApproveChangeRequestPayload) =>
      apiFetch<TransportRouteChangeRequestDto>(`${PREFIX}/transport/route-changes/${id}/approve`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

export function useRejectChangeRequest(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RejectChangeRequestPayload) =>
      apiFetch<TransportRouteChangeRequestDto>(`${PREFIX}/transport/route-changes/${id}/reject`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

// ── Change log ──
export function useRouteChangeLog(routeId: string | null) {
  return useQuery({
    queryKey: ['transport', 'change-log', routeId],
    queryFn: () =>
      apiFetch<RouteChangeLogDto[]>(`${PREFIX}/transport/routes/${routeId}/change-log`),
    enabled: !!routeId,
  });
}

// ── Vehicles ──
export function useVehicles(args?: { status?: VehicleStatus }) {
  const params = new URLSearchParams();
  if (args?.status) params.set('status', args.status);
  const qs = params.toString();
  return useQuery({
    queryKey: ['transport', 'vehicles', { ...args }],
    queryFn: () =>
      apiFetch<TransportVehicleDto[]>(`${PREFIX}/transport/vehicles${qs ? `?${qs}` : ''}`),
    staleTime: 60_000,
  });
}

export function useVehicle(id: string | null) {
  return useQuery({
    queryKey: ['transport', 'vehicle', id],
    queryFn: () => apiFetch<TransportVehicleDto>(`${PREFIX}/transport/vehicles/${id}`),
    enabled: !!id,
  });
}

export function useCreateVehicle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTransportVehiclePayload) =>
      apiFetch<TransportVehicleDto>(`${PREFIX}/transport/vehicles`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

export function useVehicleDocuments(vehicleId: string | null) {
  return useQuery({
    queryKey: ['transport', 'vehicle-docs', vehicleId],
    queryFn: () =>
      apiFetch<TransportVehicleDocumentDto[]>(
        `${PREFIX}/transport/vehicles/${vehicleId}/documents`,
      ),
    enabled: !!vehicleId,
  });
}

export function useAddVehicleDocument(vehicleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateVehicleDocumentPayload) =>
      apiFetch<TransportVehicleDocumentDto>(`${PREFIX}/transport/vehicles/${vehicleId}/documents`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

// ── Inspections ──
export function useVehicleInspections(vehicleId: string | null) {
  return useQuery({
    queryKey: ['transport', 'inspections', vehicleId],
    queryFn: () =>
      apiFetch<TransportInspectionDto[]>(`${PREFIX}/transport/vehicles/${vehicleId}/inspections`),
    enabled: !!vehicleId,
  });
}

export function useInspection(id: string | null) {
  return useQuery({
    queryKey: ['transport', 'inspection', id],
    queryFn: () => apiFetch<TransportInspectionDto>(`${PREFIX}/transport/inspections/${id}`),
    enabled: !!id,
  });
}

export function useCreateInspection(vehicleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInspectionPayload) =>
      apiFetch<TransportInspectionDto>(`${PREFIX}/transport/vehicles/${vehicleId}/inspections`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

// ── Drivers ──
export function useDrivers() {
  return useQuery({
    queryKey: ['transport', 'drivers'],
    queryFn: () => apiFetch<DriverDto[]>(`${PREFIX}/transport/drivers`),
    staleTime: 60_000,
  });
}

export function useDriverCredentials(driverId: string | null) {
  return useQuery({
    queryKey: ['transport', 'driver-credentials', driverId],
    queryFn: () =>
      apiFetch<DriverCredentialDto[]>(`${PREFIX}/transport/drivers/${driverId}/credentials`),
    enabled: !!driverId,
  });
}

export function useAddDriverCredential(driverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDriverCredentialPayload) =>
      apiFetch<DriverCredentialDto>(`${PREFIX}/transport/drivers/${driverId}/credentials`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

export function useUpdateDriverCredential(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateDriverCredentialPayload) =>
      apiFetch<DriverCredentialDto>(`${PREFIX}/transport/driver-credentials/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

// ── Bus passes / ridership ──
export function useBusPasses() {
  return useQuery({
    queryKey: ['transport', 'bus-passes'],
    queryFn: () => apiFetch<TransportBusPassDto[]>(`${PREFIX}/transport/bus-passes`),
    staleTime: 60_000,
  });
}

export function useMyBusPass() {
  return useQuery({
    queryKey: ['transport', 'my-bus-pass'],
    queryFn: () => apiFetch<TransportBusPassDto[]>(`${PREFIX}/transport/my-bus-pass`),
    staleTime: 60_000,
  });
}

export function useCreateBusPass() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBusPassPayload) =>
      apiFetch<TransportBusPassDto>(`${PREFIX}/transport/bus-passes`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

export function useScanRidership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ScanRidershipPayload) =>
      apiFetch<RidershipRecordDto>(`${PREFIX}/transport/ridership/scan`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

export function useMyRidership() {
  return useQuery({
    queryKey: ['transport', 'my-ridership'],
    queryFn: () => apiFetch<RidershipRecordDto[]>(`${PREFIX}/transport/my-ridership`),
    staleTime: 30_000,
  });
}

export function useRouteRidership(routeId: string | null, date?: string) {
  const qs = date ? `?date=${date}` : '';
  return useQuery({
    queryKey: ['transport', 'route-ridership', routeId, date],
    queryFn: () =>
      apiFetch<RidershipRecordDto[]>(`${PREFIX}/transport/ridership/route/${routeId}${qs}`),
    enabled: !!routeId,
  });
}

// ── Run logs ──
export function useStartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRunLogPayload) =>
      apiFetch<RunLogDto>(`${PREFIX}/transport/runs`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

export function useCompleteRun(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CompleteRunLogPayload) =>
      apiFetch<RunLogDto>(`${PREFIX}/transport/runs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

// ── No-show alerts ──
export function useNoShowAlerts(args?: { date?: string; resolved?: boolean }) {
  const params = new URLSearchParams();
  if (args?.date) params.set('date', args.date);
  if (args?.resolved !== undefined) params.set('resolved', String(args.resolved));
  const qs = params.toString();
  return useQuery({
    queryKey: ['transport', 'no-shows', { ...args }],
    queryFn: () => apiFetch<NoShowAlertDto[]>(`${PREFIX}/transport/no-shows${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useResolveNoShow(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ResolveNoShowPayload) =>
      apiFetch<NoShowAlertDto>(`${PREFIX}/transport/no-shows/${id}/resolve`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

export function useRunNoShowSweep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: { date?: string }) =>
      apiFetch<{ inserted: number; insertedIds: string[] }>(
        `${PREFIX}/transport/no-shows/run-once`,
        { method: 'POST', body: JSON.stringify(body ?? {}) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}

// ── Delays ──
export function useDelayReports(args?: { routeId?: string; date?: string }) {
  const params = new URLSearchParams();
  if (args?.routeId) params.set('routeId', args.routeId);
  if (args?.date) params.set('date', args.date);
  const qs = params.toString();
  return useQuery({
    queryKey: ['transport', 'delays', { ...args }],
    queryFn: () => apiFetch<DelayReportDto[]>(`${PREFIX}/transport/delays${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
  });
}

export function useReportDelay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDelayReportPayload) =>
      apiFetch<DelayReportDto>(`${PREFIX}/transport/delays`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport'] }),
  });
}
