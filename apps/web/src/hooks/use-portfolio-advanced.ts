import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AssignPathwayPayload,
  CollegeApplicationDto,
  CreateCollegeApplicationPayload,
  CreateEndorsementPayload,
  CreateMilestonePayload,
  CreatePathwayPayload,
  CreateReflectionPayload,
  CreateSectionPayload,
  EndorsementDto,
  GenerateResumePdfResponseDto,
  PathwayAssignmentDto,
  PathwayMilestoneDto,
  PortfolioSectionDto,
  ReadinessDashboardRowDto,
  ReadinessPathwayDetailDto,
  ReadinessPathwayDto,
  ReflectionDto,
  ResumeProfileDto,
  UpdateCollegeApplicationPayload,
  UpdateMilestonePayload,
  UpdateMilestoneStatusPayload,
  UpdatePathwayPayload,
  UpdateReflectionPayload,
  UpdateResumePayload,
  UpdateSectionPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ── Sections ───────────────────────────────────────────────

export function usePortfolioSections(portfolioId: string | null) {
  return useQuery({
    queryKey: ['portfolio-advanced', 'sections', portfolioId],
    queryFn: () => apiFetch<PortfolioSectionDto[]>(`${PREFIX}/portfolio/${portfolioId}/sections`),
    enabled: !!portfolioId,
    staleTime: 30_000,
  });
}

export function useCreateSection(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSectionPayload) =>
      apiFetch<PortfolioSectionDto>(`${PREFIX}/portfolio/${portfolioId}/sections`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'sections', portfolioId] });
      qc.invalidateQueries({ queryKey: ['portfolio'] });
    },
  });
}

export function useUpdateSection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sectionId, payload }: { sectionId: string; payload: UpdateSectionPayload }) =>
      apiFetch<PortfolioSectionDto>(`${PREFIX}/portfolio/sections/${sectionId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'sections'] });
      qc.invalidateQueries({ queryKey: ['portfolio'] });
    },
  });
}

export function useRemoveSection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sectionId: string) =>
      apiFetch<void>(`${PREFIX}/portfolio/sections/${sectionId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'sections'] });
      qc.invalidateQueries({ queryKey: ['portfolio'] });
    },
  });
}

export function useAssignItemToSection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, sectionId }: { itemId: string; sectionId: string | null }) =>
      apiFetch<{ ok: true }>(`${PREFIX}/portfolio/items/${itemId}/section`, {
        method: 'PATCH',
        body: JSON.stringify({ sectionId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'sections'] });
      qc.invalidateQueries({ queryKey: ['portfolio'] });
    },
  });
}

// ── Reflections ────────────────────────────────────────────

export function useItemReflections(itemId: string | null) {
  return useQuery({
    queryKey: ['portfolio-advanced', 'reflections', itemId],
    queryFn: () => apiFetch<ReflectionDto[]>(`${PREFIX}/portfolio/items/${itemId}/reflections`),
    enabled: !!itemId,
    staleTime: 30_000,
  });
}

export function useCreateReflection(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateReflectionPayload) =>
      apiFetch<ReflectionDto>(`${PREFIX}/portfolio/items/${itemId}/reflections`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'reflections', itemId] });
    },
  });
}

export function useUpdateReflection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      reflectionId,
      payload,
    }: {
      reflectionId: string;
      payload: UpdateReflectionPayload;
    }) =>
      apiFetch<ReflectionDto>(`${PREFIX}/portfolio/reflections/${reflectionId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'reflections'] });
    },
  });
}

// ── Endorsements ───────────────────────────────────────────

export function usePortfolioEndorsements(portfolioId: string | null) {
  return useQuery({
    queryKey: ['portfolio-advanced', 'endorsements', portfolioId],
    queryFn: () => apiFetch<EndorsementDto[]>(`${PREFIX}/portfolio/${portfolioId}/endorsements`),
    enabled: !!portfolioId,
    staleTime: 30_000,
  });
}

export function useCreateEndorsement(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateEndorsementPayload) =>
      apiFetch<EndorsementDto>(`${PREFIX}/portfolio/${portfolioId}/endorsements`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'endorsements', portfolioId] });
    },
  });
}

export function useUpdateEndorsementVisibility() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      endorsementId,
      isVisibleOnShare,
    }: {
      endorsementId: string;
      isVisibleOnShare: boolean;
    }) =>
      apiFetch<EndorsementDto>(`${PREFIX}/portfolio/endorsements/${endorsementId}/visibility`, {
        method: 'PATCH',
        body: JSON.stringify({ isVisibleOnShare }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'endorsements'] });
    },
  });
}

export function useRemoveEndorsement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (endorsementId: string) =>
      apiFetch<void>(`${PREFIX}/portfolio/endorsements/${endorsementId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'endorsements'] });
    },
  });
}

// ── Readiness Pathways ─────────────────────────────────────

export function useReadinessPathways(includeInactive = false) {
  return useQuery({
    queryKey: ['portfolio-advanced', 'pathways', { includeInactive }],
    queryFn: () =>
      apiFetch<ReadinessPathwayDto[]>(
        `${PREFIX}/portfolio/pathways${includeInactive ? '?includeInactive=true' : ''}`,
      ),
    staleTime: 60_000,
  });
}

export function useReadinessPathway(pathwayId: string | null) {
  return useQuery({
    queryKey: ['portfolio-advanced', 'pathway', pathwayId],
    queryFn: () => apiFetch<ReadinessPathwayDetailDto>(`${PREFIX}/portfolio/pathways/${pathwayId}`),
    enabled: !!pathwayId,
    staleTime: 60_000,
  });
}

export function useCreatePathway() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePathwayPayload) =>
      apiFetch<ReadinessPathwayDto>(`${PREFIX}/portfolio/pathways`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'pathways'] }),
  });
}

export function useUpdatePathway() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pathwayId, payload }: { pathwayId: string; payload: UpdatePathwayPayload }) =>
      apiFetch<ReadinessPathwayDto>(`${PREFIX}/portfolio/pathways/${pathwayId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'pathways'] }),
  });
}

export function useCreateMilestone(pathwayId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateMilestonePayload) =>
      apiFetch<PathwayMilestoneDto>(`${PREFIX}/portfolio/pathways/${pathwayId}/milestones`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'pathway', pathwayId] }),
  });
}

export function useUpdateMilestone(pathwayId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      payload,
    }: {
      milestoneId: string;
      payload: UpdateMilestonePayload;
    }) =>
      apiFetch<PathwayMilestoneDto>(`${PREFIX}/portfolio/milestones/${milestoneId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'pathway', pathwayId] }),
  });
}

export function useAssignPathway(pathwayId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AssignPathwayPayload) =>
      apiFetch<PathwayAssignmentDto>(`${PREFIX}/portfolio/pathways/${pathwayId}/assign`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'readiness'] });
    },
  });
}

export function useStudentReadiness(studentId: string | null) {
  return useQuery({
    queryKey: ['portfolio-advanced', 'readiness', 'student', studentId],
    queryFn: () =>
      apiFetch<PathwayAssignmentDto[]>(`${PREFIX}/portfolio/readiness/students/${studentId}`),
    enabled: !!studentId,
    staleTime: 30_000,
  });
}

export function usePathwayAssignment(assignmentId: string | null) {
  return useQuery({
    queryKey: ['portfolio-advanced', 'assignment', assignmentId],
    queryFn: () =>
      apiFetch<PathwayAssignmentDto>(`${PREFIX}/portfolio/pathway-assignments/${assignmentId}`),
    enabled: !!assignmentId,
    staleTime: 30_000,
  });
}

export function useUpdateMilestoneStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      assignmentId,
      payload,
    }: {
      assignmentId: string;
      payload: UpdateMilestoneStatusPayload;
    }) =>
      apiFetch<PathwayAssignmentDto>(
        `${PREFIX}/portfolio/pathway-assignments/${assignmentId}/milestone-status`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'readiness'] });
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'assignment'] });
    },
  });
}

export function useReadinessDashboard(atRiskOnly = false, enabled = true) {
  return useQuery({
    queryKey: ['portfolio-advanced', 'readiness', 'dashboard', { atRiskOnly }],
    queryFn: () =>
      apiFetch<ReadinessDashboardRowDto[]>(
        `${PREFIX}/portfolio/readiness/dashboard${atRiskOnly ? '?atRiskOnly=true' : ''}`,
      ),
    enabled,
    staleTime: 30_000,
  });
}

// ── College Applications ───────────────────────────────────

export function useStudentCollegeApplications(studentId: string | null) {
  return useQuery({
    queryKey: ['portfolio-advanced', 'college', 'student', studentId],
    queryFn: () =>
      apiFetch<CollegeApplicationDto[]>(
        `${PREFIX}/portfolio/college-applications/students/${studentId}`,
      ),
    enabled: !!studentId,
    staleTime: 30_000,
  });
}

export function useUpcomingDeadlines(enabled = true) {
  return useQuery({
    queryKey: ['portfolio-advanced', 'college', 'deadlines'],
    queryFn: () =>
      apiFetch<CollegeApplicationDto[]>(`${PREFIX}/portfolio/college-applications/deadlines`),
    enabled,
    staleTime: 60_000,
  });
}

export function useCreateCollegeApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateCollegeApplicationPayload) =>
      apiFetch<CollegeApplicationDto>(`${PREFIX}/portfolio/college-applications`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'college'] });
    },
  });
}

export function useUpdateCollegeApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      applicationId,
      payload,
    }: {
      applicationId: string;
      payload: UpdateCollegeApplicationPayload;
    }) =>
      apiFetch<CollegeApplicationDto>(`${PREFIX}/portfolio/college-applications/${applicationId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'college'] });
    },
  });
}

export function useRemoveCollegeApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (applicationId: string) =>
      apiFetch<void>(`${PREFIX}/portfolio/college-applications/${applicationId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'college'] });
    },
  });
}

// ── Resume ────────────────────────────────────────────────

export function useStudentResume(studentId: string | null) {
  return useQuery({
    queryKey: ['portfolio-advanced', 'resume', 'student', studentId],
    queryFn: () => apiFetch<ResumeProfileDto>(`${PREFIX}/portfolio/resume/students/${studentId}`),
    enabled: !!studentId,
    staleTime: 30_000,
  });
}

export function useUpdateResume() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ studentId, payload }: { studentId: string; payload: UpdateResumePayload }) =>
      apiFetch<ResumeProfileDto>(`${PREFIX}/portfolio/resume/students/${studentId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'resume'] });
    },
  });
}

export function useGenerateResumePdf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (studentId: string) =>
      apiFetch<GenerateResumePdfResponseDto>(
        `${PREFIX}/portfolio/resume/students/${studentId}/generate-pdf`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-advanced', 'resume'] });
    },
  });
}
