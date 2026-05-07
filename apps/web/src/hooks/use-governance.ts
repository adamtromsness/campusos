import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

// DTO type aliases — keep loose here; full strict typing lives in the
// API DTO module. The web layer only consumes the JSON envelope.

export type ProcessingActivity = {
  id: string;
  schoolId: string;
  activityName: string;
  purpose: string;
  legalBasis: string;
  dataCategories: string[];
  dataSubjects: string[];
  retentionPolicyId: string | null;
  retentionPolicyCategory: string | null;
  transfersOutsideUkEea: boolean;
  transferSafeguards: string | null;
  automatedDecisionMaking: boolean;
  profiling: boolean;
  highRiskProcessing: boolean;
  dpiaId: string | null;
  dpiaTitle: string | null;
  hasDpiaGap: boolean;
  isActive: boolean;
  lastReviewedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RetentionPolicy = {
  id: string;
  dataCategory: string;
  retentionPeriod: string;
  legalBasisForRetention: string;
  reviewFrequency: string;
  lastReviewedAt: string | null;
  nextReviewDate: string;
  linksToArchiveTier: string | null;
  notes: string | null;
  reviewDue: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Dpia = {
  id: string;
  processingActivityId: string | null;
  processingActivityName: string | null;
  dpiaTitle: string;
  triggerReason: string;
  status: string;
  descriptionOfProcessing: string;
  necessityProportionalityAssessment: string | null;
  risksIdentified: Array<{
    riskDescription: string;
    likelihood: string;
    severity: string;
    mitigationMeasures: string;
  }>;
  residualRiskLevel: string | null;
  dpoOpinion: string | null;
  supervisoryAuthorityConsultationRequired: boolean;
  completedAt: string | null;
  documentS3Key: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Processor = {
  id: string;
  processorName: string;
  processorType: string;
  registeredCountry: string;
  dataCategoriesProcessed: string[];
  dpaInPlace: boolean;
  dpaId: string | null;
  dpaStatus: string | null;
  adequacyDecisionApplicable: boolean;
  transferMechanism: string | null;
  lastReviewedAt: string | null;
  nextReviewDate: string;
  notes: string | null;
  hasDpaGap: boolean;
  reviewDue: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Dpa = {
  id: string;
  processorId: string;
  agreementReference: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  documentS3Key: string;
  subProcessorsDisclosed: boolean;
  subProcessorListS3Key: string | null;
  reviewDate: string;
  signedById: string;
  status: string;
  notes: string | null;
};

export type BreachRecord = {
  id: string;
  breachTitle: string;
  breachType: string;
  discoveryDate: string;
  breachStartDate: string | null;
  personalDataCategoriesInvolved: string[];
  estimatedAffectedIndividuals: number | null;
  riskLevel: string;
  riskToIndividuals: string;
  supervisoryAuthorityNotificationRequired: boolean;
  supervisoryAuthorityNotifiedAt: string | null;
  supervisoryAuthorityReference: string | null;
  dataSubjectsNotificationRequired: boolean;
  dataSubjectsNotifiedAt: string | null;
  breachCause: string;
  remediationActions: string;
  isResolved: boolean;
  resolvedAt: string | null;
  status: string;
  hoursSinceDiscovery: number;
  hoursRemainingTo72: number | null;
  isOverdue: boolean;
};

export type Sar = {
  id: string;
  dataSubjectId: string;
  dataSubjectName: string | null;
  requestedById: string;
  requestedByName: string | null;
  requestType: string;
  requestDetails: string | null;
  deadlineDate: string;
  status: string;
  responseS3Key: string | null;
  completedAt: string | null;
  denialReason: string | null;
  daysUntilDeadline: number;
  isOverdue: boolean;
  notes: string | null;
};

export type ErasureRequest = {
  id: string;
  dataSubjectId: string;
  requestedById: string;
  requestDetails: string | null;
  status: string;
  denialBasis: string | null;
  categoriesErased: string[];
  categoriesRetained: string[];
  categoriesPseudonymised: string[];
  completedAt: string | null;
  notes: string | null;
};

export type PseudonymisationLog = {
  id: string;
  erasureRequestId: string;
  dataSubjectId: string;
  targetTable: string;
  targetField: string;
  rowsPseudonymised: number;
  pseudonymisationToken: string;
  pseudonymisedAt: string;
  notes: string | null;
};

export type ConsentRecord = {
  id: string;
  dataSubjectId: string;
  processingActivityId: string;
  processingActivityName: string | null;
  consented: boolean;
  consentMethod: string;
  consentGivenAt: string | null;
  consentWithdrawnAt: string | null;
};

export type PrivacyNotice = {
  id: string;
  noticeVersion: string;
  effectiveFrom: string;
  contentSummary: string;
  documentS3Key: string;
  publishedById: string;
  publishedByName: string | null;
  publishedAt: string | null;
  supersededAt: string | null;
  isCurrent: boolean;
};

export type ComplianceConfig = {
  id: string;
  sarDefaultDeadlineDays: number;
  breachEscalationHours: number;
  retentionReviewReminderDays: number;
  dpaReviewReminderDays: number;
  dpiaReviewReminderDays: number;
  notes: string | null;
};

export type ComplianceDashboard = {
  schoolId: string;
  asOf: string;
  ropaCount: number;
  highRiskActivities: number;
  dpiaGaps: number;
  retentionPolicies: number;
  retentionReviewsDue: number;
  processors: number;
  dpaGaps: number;
  dpaReviewsDue: number;
  activeBreaches: number;
  breachesAwaitingNotification: number;
  breachOverdueCount: number;
  pendingSars: number;
  overdueSars: number;
  pendingErasures: number;
  pseudonymisationsLast30Days: number;
  activeConsents: number;
  withdrawnConsents: number;
  currentPrivacyNoticeVersion: string | null;
};

const KEY = ['governance'] as const;

// ─── Reads ─────────────────────────────────────────────────────────

export function useComplianceDashboard(enabled = true) {
  return useQuery<ComplianceDashboard>({
    queryKey: [...KEY, 'dashboard'],
    queryFn: () => apiFetch('/api/v1/governance/dashboard'),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useProcessingActivities(args?: { gapsOnly?: boolean; includeInactive?: boolean }) {
  const params = new URLSearchParams();
  if (args?.gapsOnly) params.set('gapsOnly', 'true');
  if (args?.includeInactive) params.set('includeInactive', 'true');
  const qs = params.toString();
  return useQuery<ProcessingActivity[]>({
    queryKey: [...KEY, 'processing-activities', args],
    queryFn: () => apiFetch(`/api/v1/governance/processing-activities${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
  });
}

export function useProcessingActivity(id: string | null | undefined) {
  return useQuery<ProcessingActivity>({
    queryKey: [...KEY, 'processing-activities', id],
    queryFn: () => apiFetch(`/api/v1/governance/processing-activities/${id}`),
    enabled: !!id,
  });
}

export function useRetentionPolicies(args?: { dueOnly?: boolean }) {
  const qs = args?.dueOnly ? '?dueOnly=true' : '';
  return useQuery<RetentionPolicy[]>({
    queryKey: [...KEY, 'retention-policies', args],
    queryFn: () => apiFetch(`/api/v1/governance/retention-policies${qs}`),
    staleTime: 60_000,
  });
}

export function useDpias(status?: string) {
  const qs = status ? `?status=${status}` : '';
  return useQuery<Dpia[]>({
    queryKey: [...KEY, 'dpias', status ?? null],
    queryFn: () => apiFetch(`/api/v1/governance/dpias${qs}`),
    staleTime: 30_000,
  });
}

export function useDpia(id: string | null | undefined) {
  return useQuery<Dpia>({
    queryKey: [...KEY, 'dpias', id],
    queryFn: () => apiFetch(`/api/v1/governance/dpias/${id}`),
    enabled: !!id,
  });
}

export function useProcessors(args?: { gapsOnly?: boolean }) {
  const qs = args?.gapsOnly ? '?gapsOnly=true' : '';
  return useQuery<Processor[]>({
    queryKey: [...KEY, 'processors', args],
    queryFn: () => apiFetch(`/api/v1/governance/processors${qs}`),
    staleTime: 60_000,
  });
}

export function useDpas(processorId?: string | null) {
  const qs = processorId ? `?processorId=${processorId}` : '';
  return useQuery<Dpa[]>({
    queryKey: [...KEY, 'dpas', processorId ?? null],
    queryFn: () => apiFetch(`/api/v1/governance/dpas${qs}`),
    staleTime: 60_000,
  });
}

export function useBreaches(args?: { status?: string; pendingNotificationOnly?: boolean }) {
  const params = new URLSearchParams();
  if (args?.status) params.set('status', args.status);
  if (args?.pendingNotificationOnly) params.set('pendingNotificationOnly', 'true');
  const qs = params.toString();
  return useQuery<BreachRecord[]>({
    queryKey: [...KEY, 'breaches', args],
    queryFn: () => apiFetch(`/api/v1/governance/breaches${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useBreach(id: string | null | undefined) {
  return useQuery<BreachRecord>({
    queryKey: [...KEY, 'breaches', id],
    queryFn: () => apiFetch(`/api/v1/governance/breaches/${id}`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useSars(args?: { status?: string; overdueOnly?: boolean }) {
  const params = new URLSearchParams();
  if (args?.status) params.set('status', args.status);
  if (args?.overdueOnly) params.set('overdueOnly', 'true');
  const qs = params.toString();
  return useQuery<Sar[]>({
    queryKey: [...KEY, 'sars', args],
    queryFn: () => apiFetch(`/api/v1/governance/sars${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
  });
}

export function useSar(id: string | null | undefined) {
  return useQuery<Sar>({
    queryKey: [...KEY, 'sars', id],
    queryFn: () => apiFetch(`/api/v1/governance/sars/${id}`),
    enabled: !!id,
  });
}

export function useErasures(status?: string) {
  const qs = status ? `?status=${status}` : '';
  return useQuery<ErasureRequest[]>({
    queryKey: [...KEY, 'erasures', status ?? null],
    queryFn: () => apiFetch(`/api/v1/governance/erasures${qs}`),
    staleTime: 30_000,
  });
}

export function usePseudonymisations(erasureRequestId?: string) {
  const qs = erasureRequestId ? `?erasureRequestId=${erasureRequestId}` : '';
  return useQuery<PseudonymisationLog[]>({
    queryKey: [...KEY, 'pseudonymisations', erasureRequestId ?? null],
    queryFn: () => apiFetch(`/api/v1/governance/pseudonymisation-log${qs}`),
    staleTime: 60_000,
  });
}

export function useConsents(args?: {
  dataSubjectId?: string;
  processingActivityId?: string;
  consentedOnly?: boolean;
}) {
  const params = new URLSearchParams();
  if (args?.dataSubjectId) params.set('dataSubjectId', args.dataSubjectId);
  if (args?.processingActivityId) params.set('processingActivityId', args.processingActivityId);
  if (args?.consentedOnly) params.set('consentedOnly', 'true');
  const qs = params.toString();
  return useQuery<ConsentRecord[]>({
    queryKey: [...KEY, 'consents', args],
    queryFn: () => apiFetch(`/api/v1/governance/consents${qs ? `?${qs}` : ''}`),
    staleTime: 60_000,
  });
}

export function usePrivacyNotices() {
  return useQuery<PrivacyNotice[]>({
    queryKey: [...KEY, 'privacy-notices'],
    queryFn: () => apiFetch('/api/v1/governance/privacy-notices'),
    staleTime: 60_000,
  });
}

export function useComplianceConfig(enabled = true) {
  return useQuery<ComplianceConfig>({
    queryKey: [...KEY, 'compliance-config'],
    queryFn: () => apiFetch('/api/v1/governance/compliance-config'),
    enabled,
    staleTime: 5 * 60_000,
  });
}

// ─── Mutations ─────────────────────────────────────────────────────

export function useCreateProcessingActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch('/api/v1/governance/processing-activities', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<ProcessingActivity>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useUpdateProcessingActivity(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch(`/api/v1/governance/processing-activities/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<ProcessingActivity>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useCreateRetentionPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch('/api/v1/governance/retention-policies', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<RetentionPolicy>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useCreateProcessor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch('/api/v1/governance/processors', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<Processor>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useCreateDpa() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch('/api/v1/governance/dpas', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<Dpa>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useCreateBreach() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch('/api/v1/governance/breaches', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<BreachRecord>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useNotifySupervisoryAuthority(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { supervisoryAuthorityReference: string; notifiedAt?: string }) =>
      apiFetch(`/api/v1/governance/breaches/${id}/notify-supervisory-authority`, {
        method: 'PATCH',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<BreachRecord>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useResolveBreach(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input?: { resolvedAt?: string }) =>
      apiFetch(`/api/v1/governance/breaches/${id}/resolve`, {
        method: 'PATCH',
        body: JSON.stringify(input ?? {}),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<BreachRecord>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useCreateSar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch('/api/v1/governance/sars', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<Sar>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useUpdateSar(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch(`/api/v1/governance/sars/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<Sar>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useCreateErasure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch('/api/v1/governance/erasures', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<ErasureRequest>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useUpdateErasure(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch(`/api/v1/governance/erasures/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<ErasureRequest>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function usePseudonymise(erasureRequestId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { targetTable: string; targetField: string }) =>
      apiFetch(`/api/v1/governance/erasures/${erasureRequestId}/pseudonymise`, {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<PseudonymisationLog>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useCreateConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch('/api/v1/governance/consents', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<ConsentRecord>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useWithdrawConsent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input?: { withdrawnAt?: string; notes?: string }) =>
      apiFetch(`/api/v1/governance/consents/${id}/withdraw`, {
        method: 'PATCH',
        body: JSON.stringify(input ?? {}),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<ConsentRecord>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useCreatePrivacyNotice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch('/api/v1/governance/privacy-notices', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<PrivacyNotice>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function usePublishPrivacyNotice(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input?: { publishedAt?: string }) =>
      apiFetch(`/api/v1/governance/privacy-notices/${id}/publish`, {
        method: 'PATCH',
        body: JSON.stringify(input ?? {}),
        headers: { 'Content-Type': 'application/json' },
      }) as Promise<PrivacyNotice>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}
