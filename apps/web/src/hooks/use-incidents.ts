'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AccountabilityRecordDto,
  AccountabilitySummaryDto,
  BulkUpdateAccountabilityPayload,
  CancelDrillPayload,
  CompleteDrillPayload,
  CorrectReunificationPayload,
  CreateDrillPayload,
  CreateIncidentTypePayload,
  CreateNonDisciplinePayload,
  CreateProcedurePayload,
  CreateReunificationPayload,
  CreateTimelineEntryPayload,
  DeclareIncidentPayload,
  DrillDto,
  DrillStatus,
  IncidentDto,
  IncidentTypeDto,
  EmergencyIncidentStatus,
  NonDisciplineIncidentDto,
  NonDisciplineIncidentType,
  NonDisciplineStatus,
  OverdueDrillDto,
  ProcedureDto,
  ProcedureType,
  ResolveIncidentPayload,
  ReunificationCorrectionDto,
  ReunificationRecordDto,
  TimelineEntryDto,
  UpdateAccountabilityPayload,
  UpdateIncidentTypePayload,
  UpdateNonDisciplinePayload,
  UpdateProcedurePayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ----- Incident lifecycle ----------------------------------------------------

export function useIncidents(args?: { status?: EmergencyIncidentStatus; limit?: number }) {
  const params = new URLSearchParams();
  if (args?.status) params.set('status', args.status);
  if (args?.limit != null) params.set('limit', String(args.limit));
  const query = params.toString();
  return useQuery({
    queryKey: ['incidents', { status: args?.status ?? null, limit: args?.limit ?? null }],
    queryFn: () => apiFetch<IncidentDto[]>(`${PREFIX}/incidents${query ? `?${query}` : ''}`),
    refetchInterval: 5000, // emergency dashboard polls every 5s
  });
}

export function useIncident(id: string | null) {
  return useQuery({
    queryKey: ['incident', id],
    queryFn: () => apiFetch<IncidentDto>(`${PREFIX}/incidents/${id}`),
    enabled: !!id,
    refetchInterval: 5000,
  });
}

export function useDeclareIncident() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: DeclareIncidentPayload) =>
      apiFetch<IncidentDto>(`${PREFIX}/incidents/declare`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['incidents'] });
    },
  });
}

export function useResolveIncident(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ResolveIncidentPayload) =>
      apiFetch<IncidentDto>(`${PREFIX}/incidents/${id}/resolve`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['incident', id] });
      void qc.invalidateQueries({ queryKey: ['incidents'] });
    },
  });
}

export function useCancelIncident(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<IncidentDto>(`${PREFIX}/incidents/${id}/cancel`, { method: 'PATCH' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['incident', id] });
      void qc.invalidateQueries({ queryKey: ['incidents'] });
    },
  });
}

// ----- Incident types --------------------------------------------------------

export function useIncidentTypes(includeInactive = false) {
  return useQuery({
    queryKey: ['incident-types', includeInactive],
    queryFn: () =>
      apiFetch<IncidentTypeDto[]>(
        `${PREFIX}/incidents/types/list${includeInactive ? '?includeInactive=true' : ''}`,
      ),
    staleTime: 60_000,
  });
}

export function useCreateIncidentType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateIncidentTypePayload) =>
      apiFetch<IncidentTypeDto>(`${PREFIX}/incidents/types`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['incident-types'] }),
  });
}

export function useUpdateIncidentType(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateIncidentTypePayload) =>
      apiFetch<IncidentTypeDto>(`${PREFIX}/incidents/types/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['incident-types'] }),
  });
}

// ----- Procedures ------------------------------------------------------------

export function useProcedures(includeInactive = false) {
  return useQuery({
    queryKey: ['procedures', includeInactive],
    queryFn: () =>
      apiFetch<ProcedureDto[]>(
        `${PREFIX}/incidents/procedures${includeInactive ? '?includeInactive=true' : ''}`,
      ),
    staleTime: 60_000,
  });
}

export function useProcedureByType(procedureType: ProcedureType | null) {
  return useQuery({
    queryKey: ['procedure-by-type', procedureType],
    queryFn: () =>
      apiFetch<ProcedureDto>(`${PREFIX}/incidents/procedures/by-type/${procedureType}`),
    enabled: !!procedureType,
  });
}

export function useCreateProcedure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateProcedurePayload) =>
      apiFetch<ProcedureDto>(`${PREFIX}/incidents/procedures`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['procedures'] }),
  });
}

export function useUpdateProcedure(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateProcedurePayload) =>
      apiFetch<ProcedureDto>(`${PREFIX}/incidents/procedures/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['procedures'] }),
  });
}

// ----- Timeline --------------------------------------------------------------

export function useTimeline(incidentId: string | null) {
  return useQuery({
    queryKey: ['incident-timeline', incidentId],
    queryFn: () => apiFetch<TimelineEntryDto[]>(`${PREFIX}/incidents/${incidentId}/timeline`),
    enabled: !!incidentId,
    refetchInterval: 3000, // live tail during active incidents
  });
}

export function useAppendTimeline(incidentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTimelineEntryPayload) =>
      apiFetch<TimelineEntryDto>(`${PREFIX}/incidents/${incidentId}/timeline`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['incident-timeline', incidentId] }),
  });
}

// ----- Accountability --------------------------------------------------------

export function useAccountability(incidentId: string | null) {
  return useQuery({
    queryKey: ['accountability', incidentId],
    queryFn: () =>
      apiFetch<AccountabilityRecordDto[]>(`${PREFIX}/incidents/${incidentId}/accountability`),
    enabled: !!incidentId,
    refetchInterval: 3000,
  });
}

export function useAccountabilitySummary(incidentId: string | null) {
  return useQuery({
    queryKey: ['accountability-summary', incidentId],
    queryFn: () =>
      apiFetch<AccountabilitySummaryDto | null>(
        `${PREFIX}/incidents/${incidentId}/accountability/summary`,
      ),
    enabled: !!incidentId,
    refetchInterval: 3000,
  });
}

export function useUpdateAccountabilityRecord(incidentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      recordId,
      payload,
    }: {
      recordId: string;
      payload: UpdateAccountabilityPayload;
    }) =>
      apiFetch<AccountabilityRecordDto>(`${PREFIX}/incidents/accountability/${recordId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accountability', incidentId] });
      void qc.invalidateQueries({ queryKey: ['accountability-summary', incidentId] });
    },
  });
}

export function useBulkAccountability(incidentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: BulkUpdateAccountabilityPayload) =>
      apiFetch<{ updated: number }>(`${PREFIX}/incidents/${incidentId}/accountability/bulk`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accountability', incidentId] });
      void qc.invalidateQueries({ queryKey: ['accountability-summary', incidentId] });
    },
  });
}

// ----- Reunification ---------------------------------------------------------

export function useReunifications(incidentId: string | null) {
  return useQuery({
    queryKey: ['reunifications', incidentId],
    queryFn: () =>
      apiFetch<ReunificationRecordDto[]>(`${PREFIX}/incidents/${incidentId}/reunification`),
    enabled: !!incidentId,
    refetchInterval: 5000,
  });
}

export function useCreateReunification(incidentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateReunificationPayload) =>
      apiFetch<ReunificationRecordDto>(`${PREFIX}/incidents/${incidentId}/reunification`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reunifications', incidentId] });
      void qc.invalidateQueries({ queryKey: ['accountability', incidentId] });
      void qc.invalidateQueries({ queryKey: ['accountability-summary', incidentId] });
    },
  });
}

export function useCorrectReunification(reunificationId: string, incidentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CorrectReunificationPayload) =>
      apiFetch<ReunificationCorrectionDto>(
        `${PREFIX}/incidents/reunification/${reunificationId}/correct`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reunifications', incidentId] });
    },
  });
}

// ----- Drills ----------------------------------------------------------------

export function useDrills(status?: DrillStatus) {
  return useQuery({
    queryKey: ['drills', status ?? null],
    queryFn: () =>
      apiFetch<DrillDto[]>(`${PREFIX}/incidents/drills/list${status ? `?status=${status}` : ''}`),
    staleTime: 30_000,
  });
}

export function useOverdueDrills() {
  return useQuery({
    queryKey: ['drills-overdue'],
    queryFn: () => apiFetch<OverdueDrillDto[]>(`${PREFIX}/incidents/drills/overdue`),
    staleTime: 60_000,
  });
}

export function useCreateDrill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateDrillPayload) =>
      apiFetch<DrillDto>(`${PREFIX}/incidents/drills`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['drills'] });
      void qc.invalidateQueries({ queryKey: ['drills-overdue'] });
    },
  });
}

export function useCompleteDrill(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CompleteDrillPayload) =>
      apiFetch<DrillDto>(`${PREFIX}/incidents/drills/${id}/complete`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['drills'] });
      void qc.invalidateQueries({ queryKey: ['drills-overdue'] });
    },
  });
}

export function useCancelDrill(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CancelDrillPayload) =>
      apiFetch<DrillDto>(`${PREFIX}/incidents/drills/${id}/cancel`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['drills'] });
    },
  });
}

// ----- Non-discipline incident reports --------------------------------------

export function useNonDisciplineReports(args?: {
  status?: NonDisciplineStatus;
  incidentType?: NonDisciplineIncidentType;
  mineOnly?: boolean;
  limit?: number;
}) {
  const params = new URLSearchParams();
  if (args?.status) params.set('status', args.status);
  if (args?.incidentType) params.set('incidentType', args.incidentType);
  if (args?.mineOnly) params.set('mineOnly', 'true');
  if (args?.limit != null) params.set('limit', String(args.limit));
  const qs = params.toString();
  return useQuery({
    queryKey: ['non-discipline-reports', args ?? null],
    queryFn: () =>
      apiFetch<NonDisciplineIncidentDto[]>(`${PREFIX}/incidents/reports/list${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
  });
}

export function useNonDisciplineReport(id: string | null) {
  return useQuery({
    queryKey: ['non-discipline-report', id],
    queryFn: () => apiFetch<NonDisciplineIncidentDto>(`${PREFIX}/incidents/reports/${id}`),
    enabled: !!id,
  });
}

export function useCreateNonDiscipline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateNonDisciplinePayload) =>
      apiFetch<NonDisciplineIncidentDto>(`${PREFIX}/incidents/reports`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['non-discipline-reports'] }),
  });
}

export function useUpdateNonDiscipline(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateNonDisciplinePayload) =>
      apiFetch<NonDisciplineIncidentDto>(`${PREFIX}/incidents/reports/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['non-discipline-report', id] });
      void qc.invalidateQueries({ queryKey: ['non-discipline-reports'] });
    },
  });
}
