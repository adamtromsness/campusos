import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  RptAgedDebtorDto,
  RptAtRiskConfigDto,
  RptAtRiskStudentDto,
  RptAttendanceSummaryDto,
  RptClassPerformanceDto,
  RptCreateAtRiskConfigPayload,
  RptCreateReportDefinitionPayload,
  RptCreateScheduledReportPayload,
  RptDistrictSchoolComparisonDto,
  RptDistrictSummaryDto,
  RptOutputFormat,
  RptReportDefinitionDto,
  RptReportRunDto,
  RptScheduledReportDto,
  RptSchoolSummaryDto,
  RptStaffSummaryDto,
  RptStateReportTemplateDto,
  RptStudentAcademicDto,
  RptUpdateAtRiskConfigPayload,
  RptUpdateReportDefinitionPayload,
  RptWellbeingTrendsDto,
  RptWorkerRunSummaryDto,
  RptWorkerStatusDto,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ─── Dashboards ──────────────────────────────────────────────────────

export function useAttendanceSummary(args?: {
  fromDate?: string;
  toDate?: string;
  classId?: string;
  enabled?: boolean;
}) {
  const qs = new URLSearchParams();
  if (args?.fromDate) qs.set('fromDate', args.fromDate);
  if (args?.toDate) qs.set('toDate', args.toDate);
  if (args?.classId) qs.set('classId', args.classId);
  const qstr = qs.toString();
  return useQuery({
    queryKey: ['analytics', 'attendance', args?.fromDate, args?.toDate, args?.classId],
    queryFn: () =>
      apiFetch<RptAttendanceSummaryDto[]>(
        `${PREFIX}/analytics/attendance${qstr ? `?${qstr}` : ''}`,
      ),
    enabled: args?.enabled ?? true,
    staleTime: 30_000,
  });
}

export function useAcademicSummary(args?: {
  gradeLevel?: string;
  atRiskOnly?: boolean;
  enabled?: boolean;
}) {
  const qs = new URLSearchParams();
  if (args?.gradeLevel) qs.set('gradeLevel', args.gradeLevel);
  if (args?.atRiskOnly) qs.set('atRiskOnly', 'true');
  const qstr = qs.toString();
  return useQuery({
    queryKey: ['analytics', 'academics', args?.gradeLevel, args?.atRiskOnly],
    queryFn: () =>
      apiFetch<RptStudentAcademicDto[]>(`${PREFIX}/analytics/academics${qstr ? `?${qstr}` : ''}`),
    enabled: args?.enabled ?? true,
    staleTime: 30_000,
  });
}

export function useClassPerformance(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'classes'],
    queryFn: () => apiFetch<RptClassPerformanceDto[]>(`${PREFIX}/analytics/classes`),
    enabled,
    staleTime: 30_000,
  });
}

export function useStaffSummary(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'staff-summary'],
    queryFn: () => apiFetch<RptStaffSummaryDto[]>(`${PREFIX}/analytics/staff-summary`),
    enabled,
    staleTime: 60_000,
  });
}

export function useSchoolSummary(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'school-summary'],
    queryFn: () => apiFetch<RptSchoolSummaryDto | null>(`${PREFIX}/analytics/school-summary`),
    enabled,
    staleTime: 60_000,
  });
}

export function useDistrictSummary(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'district-summary'],
    queryFn: () => apiFetch<RptDistrictSummaryDto | null>(`${PREFIX}/analytics/district-summary`),
    enabled,
    staleTime: 60_000,
  });
}

export function useDistrictComparison(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'district-comparison'],
    queryFn: () =>
      apiFetch<RptDistrictSchoolComparisonDto[]>(`${PREFIX}/analytics/district-comparison`),
    enabled,
    staleTime: 60_000,
  });
}

export function useWellbeingTrends(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'wellbeing'],
    queryFn: () => apiFetch<RptWellbeingTrendsDto[]>(`${PREFIX}/analytics/wellbeing-trends`),
    enabled,
    staleTime: 60_000,
  });
}

export function useAgedDebtors(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'aged-debtors'],
    queryFn: () => apiFetch<RptAgedDebtorDto[]>(`${PREFIX}/analytics/aged-debtors`),
    enabled,
    staleTime: 60_000,
  });
}

// ─── At-risk ─────────────────────────────────────────────────────────

export function useAtRiskStudents(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'at-risk', 'students'],
    queryFn: () => apiFetch<RptAtRiskStudentDto[]>(`${PREFIX}/analytics/at-risk`),
    enabled,
    staleTime: 30_000,
  });
}

export function useAtRiskConfigs(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'at-risk', 'configs'],
    queryFn: () => apiFetch<RptAtRiskConfigDto[]>(`${PREFIX}/analytics/at-risk/configurations`),
    enabled,
    staleTime: 30_000,
  });
}

export function useCreateAtRiskConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: RptCreateAtRiskConfigPayload) =>
      apiFetch<RptAtRiskConfigDto>(`${PREFIX}/analytics/at-risk/configurations`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['analytics', 'at-risk'] }),
  });
}

export function useUpdateAtRiskConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; payload: RptUpdateAtRiskConfigPayload }) =>
      apiFetch<RptAtRiskConfigDto>(`${PREFIX}/analytics/at-risk/configurations/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify(vars.payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['analytics', 'at-risk'] }),
  });
}

// ─── Workers ─────────────────────────────────────────────────────────

export function useWorkerStatus(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'worker-status'],
    queryFn: () => apiFetch<RptWorkerStatusDto[]>(`${PREFIX}/analytics/workers/status`),
    enabled,
    staleTime: 30_000,
  });
}

export function useRunWorkers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { worker?: string; asOfDate?: string }) =>
      apiFetch<RptWorkerRunSummaryDto[]>(`${PREFIX}/analytics/workers/run`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['analytics'] }),
  });
}

// ─── Report engine ───────────────────────────────────────────────────

export function useReportDefinitions(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'reports'],
    queryFn: () => apiFetch<RptReportDefinitionDto[]>(`${PREFIX}/analytics/reports`),
    enabled,
  });
}

export function useReportDefinition(id: string | null) {
  return useQuery({
    queryKey: ['analytics', 'reports', id],
    queryFn: () => apiFetch<RptReportDefinitionDto>(`${PREFIX}/analytics/reports/${id}`),
    enabled: !!id,
  });
}

export function useCreateReportDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: RptCreateReportDefinitionPayload) =>
      apiFetch<RptReportDefinitionDto>(`${PREFIX}/analytics/reports`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['analytics', 'reports'] }),
  });
}

export function useUpdateReportDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; payload: RptUpdateReportDefinitionPayload }) =>
      apiFetch<RptReportDefinitionDto>(`${PREFIX}/analytics/reports/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify(vars.payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['analytics', 'reports'] }),
  });
}

export function useRunReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; outputFormat?: RptOutputFormat }) =>
      apiFetch<RptReportRunDto>(`${PREFIX}/analytics/reports/${vars.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ outputFormat: vars.outputFormat ?? 'CSV' }),
      }),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['analytics', 'report-runs', v.id] }),
  });
}

export function useReportRuns(definitionId: string | null) {
  return useQuery({
    queryKey: ['analytics', 'report-runs', definitionId],
    queryFn: () => apiFetch<RptReportRunDto[]>(`${PREFIX}/analytics/reports/${definitionId}/runs`),
    enabled: !!definitionId,
  });
}

// ─── Scheduled reports ───────────────────────────────────────────────

export function useScheduledReports(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'scheduled'],
    queryFn: () => apiFetch<RptScheduledReportDto[]>(`${PREFIX}/analytics/scheduled-reports`),
    enabled,
    staleTime: 30_000,
  });
}

export function useCreateScheduledReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: RptCreateScheduledReportPayload) =>
      apiFetch<RptScheduledReportDto>(`${PREFIX}/analytics/scheduled-reports`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['analytics', 'scheduled'] }),
  });
}

export function useRunScheduledNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<RptScheduledReportDto>(`${PREFIX}/analytics/scheduled-reports/${id}/run-now`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['analytics', 'scheduled'] }),
  });
}

// ─── State report templates ──────────────────────────────────────────

export function useStateReportTemplates(enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'state-reports'],
    queryFn: () => apiFetch<RptStateReportTemplateDto[]>(`${PREFIX}/analytics/state-reports`),
    enabled,
    staleTime: 5 * 60_000,
  });
}
