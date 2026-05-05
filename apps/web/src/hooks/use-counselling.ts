'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AcceptReferralPayload,
  AddParticipantPayload,
  AttachTeamMeetingStudentPayload,
  CaseloadDto,
  CaseloadStatus,
  CloseCaseloadPayload,
  CompleteReferralPayload,
  CoordinatedCareNoteDto,
  CreateCaseloadPayload,
  CreateCoordinatedCareNotePayload,
  CreateInterventionPayload,
  CreateMandatoryReportPayload,
  CreateMtssTierPayload,
  CreateReferralPayload,
  CreateReferralTypePayload,
  CreateSessionNotePayload,
  CreateSessionPayload,
  CreateTeamMeetingPayload,
  DeclineReferralPayload,
  InterventionDto,
  InterventionProgressEntryDto,
  LogProgressPayload,
  MandatoryReportDto,
  MarkAttendancePayload,
  MtssDashboardDto,
  MtssDomain,
  MtssTier,
  MtssTierDto,
  MtssTierStatus,
  PrimaryConcern,
  ReferralActivityDto,
  ReferralDto,
  ReferralPriority,
  ReferralStatus,
  ReferralTypeDto,
  ReportStatus,
  SessionDto,
  SessionNoteDto,
  SessionParticipantDto,
  SessionStatus,
  SessionType,
  TeamMeetingDto,
  TeamMeetingStudentDto,
  TriageReferralPayload,
  UpdateCaseloadPayload,
  UpdateInterventionPayload,
  UpdateMandatoryReportPayload,
  UpdateMtssTierPayload,
  UpdateReferralTypePayload,
  UpdateSessionNotePayload,
  UpdateSessionPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ─── Caseloads ───────────────────────────────────────────────

export interface ListCaseloadsArgs {
  status?: CaseloadStatus;
  concern?: PrimaryConcern;
  academicYearId?: string;
  counselorId?: string;
  enabled?: boolean;
}

function caseloadsQs(args: ListCaseloadsArgs): string {
  const p = new URLSearchParams();
  if (args.status) p.set('status', args.status);
  if (args.concern) p.set('concern', args.concern);
  if (args.academicYearId) p.set('academicYearId', args.academicYearId);
  if (args.counselorId) p.set('counselorId', args.counselorId);
  const s = p.toString();
  return s ? '?' + s : '';
}

export function useCaseloads(args: ListCaseloadsArgs = {}) {
  return useQuery({
    queryKey: ['counselling', 'caseloads', args],
    queryFn: () => apiFetch<CaseloadDto[]>(PREFIX + '/counselling/caseloads' + caseloadsQs(args)),
    enabled: args.enabled !== false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useCaseload(id: string | null | undefined) {
  return useQuery({
    queryKey: ['counselling', 'caseload', id],
    queryFn: () => apiFetch<CaseloadDto>(PREFIX + '/counselling/caseloads/' + id),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateCaseload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateCaseloadPayload) =>
      apiFetch<CaseloadDto>(PREFIX + '/counselling/caseloads', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['counselling', 'caseloads'] });
    },
  });
}

export function useUpdateCaseload(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateCaseloadPayload) =>
      apiFetch<CaseloadDto>(PREFIX + '/counselling/caseloads/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['counselling', 'caseload', id] });
      qc.invalidateQueries({ queryKey: ['counselling', 'caseloads'] });
    },
  });
}

export function useCloseCaseload(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CloseCaseloadPayload) =>
      apiFetch<CaseloadDto>(PREFIX + '/counselling/caseloads/' + id + '/close', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['counselling', 'caseload', id] });
      qc.invalidateQueries({ queryKey: ['counselling', 'caseloads'] });
    },
  });
}

// ─── Referral types ──────────────────────────────────────────

export function useReferralTypes(includeInactive = false) {
  return useQuery({
    queryKey: ['counselling', 'referral-types', includeInactive],
    queryFn: () =>
      apiFetch<ReferralTypeDto[]>(
        PREFIX + '/counselling/referral-types' + (includeInactive ? '?includeInactive=true' : ''),
      ),
    staleTime: 5 * 60_000,
  });
}

export function useCreateReferralType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateReferralTypePayload) =>
      apiFetch<ReferralTypeDto>(PREFIX + '/counselling/referral-types', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counselling', 'referral-types'] }),
  });
}

export function useUpdateReferralType(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateReferralTypePayload) =>
      apiFetch<ReferralTypeDto>(PREFIX + '/counselling/referral-types/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counselling', 'referral-types'] }),
  });
}

// ─── Referrals ───────────────────────────────────────────────

export interface ListReferralsArgs {
  status?: ReferralStatus;
  priority?: ReferralPriority;
  referralTypeId?: string;
  studentId?: string;
  assignedCounselorId?: string;
  enabled?: boolean;
}

function referralsQs(args: ListReferralsArgs): string {
  const p = new URLSearchParams();
  if (args.status) p.set('status', args.status);
  if (args.priority) p.set('priority', args.priority);
  if (args.referralTypeId) p.set('referralTypeId', args.referralTypeId);
  if (args.studentId) p.set('studentId', args.studentId);
  if (args.assignedCounselorId) p.set('assignedCounselorId', args.assignedCounselorId);
  const s = p.toString();
  return s ? '?' + s : '';
}

export function useReferrals(args: ListReferralsArgs = {}) {
  return useQuery({
    queryKey: ['counselling', 'referrals', args],
    queryFn: () => apiFetch<ReferralDto[]>(PREFIX + '/counselling/referrals' + referralsQs(args)),
    enabled: args.enabled !== false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useReferral(id: string | null | undefined) {
  return useQuery({
    queryKey: ['counselling', 'referral', id],
    queryFn: () => apiFetch<ReferralDto>(PREFIX + '/counselling/referrals/' + id),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useReferralActivity(id: string | null | undefined) {
  return useQuery({
    queryKey: ['counselling', 'referral-activity', id],
    queryFn: () =>
      apiFetch<ReferralActivityDto[]>(PREFIX + '/counselling/referrals/' + id + '/activity'),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateReferral() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateReferralPayload) =>
      apiFetch<ReferralDto>(PREFIX + '/counselling/referrals', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counselling', 'referrals'] }),
  });
}

function referralLifecycleMutator(id: string, action: string, body?: unknown) {
  return apiFetch<ReferralDto>(PREFIX + '/counselling/referrals/' + id + '/' + action, {
    method: 'PATCH',
    body: body ? JSON.stringify(body) : '{}',
  });
}

export function useTriageReferral(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: TriageReferralPayload) => referralLifecycleMutator(id, 'triage', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['counselling', 'referrals'] });
      qc.invalidateQueries({ queryKey: ['counselling', 'referral', id] });
      qc.invalidateQueries({ queryKey: ['counselling', 'referral-activity', id] });
    },
  });
}

export function useAcceptReferral(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AcceptReferralPayload) => referralLifecycleMutator(id, 'accept', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['counselling', 'referrals'] });
      qc.invalidateQueries({ queryKey: ['counselling', 'referral', id] });
      qc.invalidateQueries({ queryKey: ['counselling', 'referral-activity', id] });
      qc.invalidateQueries({ queryKey: ['counselling', 'caseloads'] });
    },
  });
}

export function useStartReferral(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => referralLifecycleMutator(id, 'start'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['counselling', 'referral', id] });
      qc.invalidateQueries({ queryKey: ['counselling', 'referrals'] });
      qc.invalidateQueries({ queryKey: ['counselling', 'referral-activity', id] });
    },
  });
}

export function useCompleteReferral(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CompleteReferralPayload) =>
      referralLifecycleMutator(id, 'complete', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['counselling', 'referral', id] });
      qc.invalidateQueries({ queryKey: ['counselling', 'referrals'] });
      qc.invalidateQueries({ queryKey: ['counselling', 'referral-activity', id] });
    },
  });
}

export function useDeclineReferral(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: DeclineReferralPayload) =>
      referralLifecycleMutator(id, 'decline', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['counselling', 'referral', id] });
      qc.invalidateQueries({ queryKey: ['counselling', 'referrals'] });
      qc.invalidateQueries({ queryKey: ['counselling', 'referral-activity', id] });
    },
  });
}

// ─── Sessions ────────────────────────────────────────────────

export interface ListSessionsArgs {
  status?: SessionStatus;
  sessionType?: SessionType;
  caseloadId?: string;
  counselorId?: string;
  fromDate?: string;
  toDate?: string;
  enabled?: boolean;
}

function sessionsQs(args: ListSessionsArgs): string {
  const p = new URLSearchParams();
  if (args.status) p.set('status', args.status);
  if (args.sessionType) p.set('sessionType', args.sessionType);
  if (args.caseloadId) p.set('caseloadId', args.caseloadId);
  if (args.counselorId) p.set('counselorId', args.counselorId);
  if (args.fromDate) p.set('fromDate', args.fromDate);
  if (args.toDate) p.set('toDate', args.toDate);
  const s = p.toString();
  return s ? '?' + s : '';
}

export function useSessions(args: ListSessionsArgs = {}) {
  return useQuery({
    queryKey: ['counselling', 'sessions', args],
    queryFn: () => apiFetch<SessionDto[]>(PREFIX + '/counselling/sessions' + sessionsQs(args)),
    enabled: args.enabled !== false,
    staleTime: 30_000,
  });
}

export function useSession(id: string | null | undefined) {
  return useQuery({
    queryKey: ['counselling', 'session', id],
    queryFn: () => apiFetch<SessionDto>(PREFIX + '/counselling/sessions/' + id),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSessionPayload) =>
      apiFetch<SessionDto>(PREFIX + '/counselling/sessions', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counselling', 'sessions'] }),
  });
}

export function useUpdateSession(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateSessionPayload) =>
      apiFetch<SessionDto>(PREFIX + '/counselling/sessions/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['counselling', 'session', id] });
      qc.invalidateQueries({ queryKey: ['counselling', 'sessions'] });
    },
  });
}

export function useAddParticipant(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AddParticipantPayload) =>
      apiFetch<SessionParticipantDto>(
        PREFIX + '/counselling/sessions/' + sessionId + '/participants',
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counselling', 'session', sessionId] }),
  });
}

export function useMarkAttendance(participantId: string, sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: MarkAttendancePayload) =>
      apiFetch<SessionParticipantDto>(
        PREFIX + '/counselling/session-participants/' + participantId,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counselling', 'session', sessionId] }),
  });
}

// ─── Session notes (FERPA-gated) ─────────────────────────────

/**
 * The FERPA gate is enforced server-side. The hook accepts an
 * `enabled` flag so callers can short-circuit when they know the user
 * lacks `student_counseling_record:read` (avoiding a guaranteed 403).
 * On 403 React Query treats it as an error — pages should render the
 * "Session notes are restricted to the counselling team" placeholder.
 */
export function useSessionNotes(sessionId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['counselling', 'session-notes', sessionId],
    queryFn: () =>
      apiFetch<SessionNoteDto[]>(PREFIX + '/counselling/sessions/' + sessionId + '/notes'),
    enabled: !!sessionId && enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useCreateSessionNote(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSessionNotePayload) =>
      apiFetch<SessionNoteDto>(PREFIX + '/counselling/sessions/' + sessionId + '/notes', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['counselling', 'session-notes', sessionId] }),
  });
}

export function useUpdateSessionNote(noteId: string, sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateSessionNotePayload) =>
      apiFetch<SessionNoteDto>(PREFIX + '/counselling/session-notes/' + noteId, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['counselling', 'session-notes', sessionId] }),
  });
}

export function useLockSessionNote(noteId: string, sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<SessionNoteDto>(PREFIX + '/counselling/session-notes/' + noteId + '/lock', {
        method: 'PATCH',
        body: '{}',
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['counselling', 'session-notes', sessionId] }),
  });
}

// ─── Step 7 — MTSS / Care / Reporting ─────────────────────────

// MTSS tiers

export interface ListMtssTiersArgs {
  tier?: MtssTier;
  domain?: MtssDomain;
  status?: MtssTierStatus;
  academicYearId?: string;
  studentId?: string;
  enabled?: boolean;
}

function mtssQs(args: ListMtssTiersArgs): string {
  const p = new URLSearchParams();
  if (args.tier) p.set('tier', args.tier);
  if (args.domain) p.set('domain', args.domain);
  if (args.status) p.set('status', args.status);
  if (args.academicYearId) p.set('academicYearId', args.academicYearId);
  if (args.studentId) p.set('studentId', args.studentId);
  const s = p.toString();
  return s ? '?' + s : '';
}

export function useMtssTiers(args: ListMtssTiersArgs = {}) {
  return useQuery({
    queryKey: ['counselling', 'mtss-tiers', args],
    queryFn: () => apiFetch<MtssTierDto[]>(PREFIX + '/counselling/mtss/tiers' + mtssQs(args)),
    enabled: args.enabled !== false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useMtssTier(id: string | null | undefined) {
  return useQuery({
    queryKey: ['counselling', 'mtss-tier', id],
    queryFn: () => apiFetch<MtssTierDto>(PREFIX + '/counselling/mtss/tiers/' + id),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useMtssDashboard(enabled = true) {
  return useQuery({
    queryKey: ['counselling', 'mtss-dashboard'],
    queryFn: () => apiFetch<MtssDashboardDto>(PREFIX + '/counselling/mtss/dashboard'),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useCreateMtssTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateMtssTierPayload) =>
      apiFetch<MtssTierDto>(PREFIX + '/counselling/mtss/tiers', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['counselling', 'mtss-tiers'] });
      qc.invalidateQueries({ queryKey: ['counselling', 'mtss-dashboard'] });
    },
  });
}

export function useUpdateMtssTier(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateMtssTierPayload) =>
      apiFetch<MtssTierDto>(PREFIX + '/counselling/mtss/tiers/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['counselling', 'mtss-tier', id] });
      qc.invalidateQueries({ queryKey: ['counselling', 'mtss-tiers'] });
      qc.invalidateQueries({ queryKey: ['counselling', 'mtss-dashboard'] });
    },
  });
}

// Interventions

export function useInterventions(tierId: string | null | undefined) {
  return useQuery({
    queryKey: ['counselling', 'interventions', tierId],
    queryFn: () =>
      apiFetch<InterventionDto[]>(PREFIX + '/counselling/mtss/tiers/' + tierId + '/interventions'),
    enabled: !!tierId,
    staleTime: 30_000,
  });
}

export function useCreateIntervention(tierId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateInterventionPayload) =>
      apiFetch<InterventionDto>(PREFIX + '/counselling/mtss/tiers/' + tierId + '/interventions', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counselling', 'interventions', tierId] }),
  });
}

export function useUpdateIntervention(id: string, tierId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateInterventionPayload) =>
      apiFetch<InterventionDto>(PREFIX + '/counselling/mtss/interventions/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counselling', 'interventions', tierId] }),
  });
}

export function useInterventionProgress(interventionId: string | null | undefined) {
  return useQuery({
    queryKey: ['counselling', 'progress', interventionId],
    queryFn: () =>
      apiFetch<InterventionProgressEntryDto[]>(
        PREFIX + '/counselling/mtss/interventions/' + interventionId + '/progress',
      ),
    enabled: !!interventionId,
    staleTime: 30_000,
  });
}

export function useLogProgress(interventionId: string, tierId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: LogProgressPayload) =>
      apiFetch<InterventionProgressEntryDto>(
        PREFIX + '/counselling/mtss/interventions/' + interventionId + '/progress',
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['counselling', 'progress', interventionId] });
      qc.invalidateQueries({ queryKey: ['counselling', 'interventions', tierId] });
    },
  });
}

// Team meetings

export function useTeamMeetings(args: { fromDate?: string; toDate?: string } = {}) {
  const p = new URLSearchParams();
  if (args.fromDate) p.set('fromDate', args.fromDate);
  if (args.toDate) p.set('toDate', args.toDate);
  const qs = p.toString() ? '?' + p.toString() : '';
  return useQuery({
    queryKey: ['counselling', 'team-meetings', args],
    queryFn: () => apiFetch<TeamMeetingDto[]>(PREFIX + '/counselling/mtss/team-meetings' + qs),
    staleTime: 60_000,
  });
}

export function useTeamMeeting(id: string | null | undefined) {
  return useQuery({
    queryKey: ['counselling', 'team-meeting', id],
    queryFn: () => apiFetch<TeamMeetingDto>(PREFIX + '/counselling/mtss/team-meetings/' + id),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateTeamMeeting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTeamMeetingPayload) =>
      apiFetch<TeamMeetingDto>(PREFIX + '/counselling/mtss/team-meetings', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counselling', 'team-meetings'] }),
  });
}

export function useAttachMeetingStudent(meetingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AttachTeamMeetingStudentPayload) =>
      apiFetch<TeamMeetingStudentDto>(
        PREFIX + '/counselling/mtss/team-meetings/' + meetingId + '/students',
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counselling', 'team-meeting', meetingId] }),
  });
}

// Coordinated care (intersection-gated server-side)

export function useCoordinatedCare(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['counselling', 'coordinated-care', studentId],
    queryFn: () =>
      apiFetch<CoordinatedCareNoteDto[]>(PREFIX + '/counselling/coordinated-care/' + studentId),
    enabled: !!studentId && enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useCreateCoordinatedCareNote(studentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateCoordinatedCareNotePayload) =>
      apiFetch<CoordinatedCareNoteDto>(PREFIX + '/counselling/coordinated-care/' + studentId, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['counselling', 'coordinated-care', studentId] }),
  });
}

// Mandatory reports

export interface ListMandatoryReportsArgs {
  status?: ReportStatus;
  studentId?: string;
}

export function useMandatoryReports(args: ListMandatoryReportsArgs = {}) {
  const p = new URLSearchParams();
  if (args.status) p.set('status', args.status);
  if (args.studentId) p.set('studentId', args.studentId);
  const qs = p.toString() ? '?' + p.toString() : '';
  return useQuery({
    queryKey: ['counselling', 'mandatory-reports', args],
    queryFn: () => apiFetch<MandatoryReportDto[]>(PREFIX + '/counselling/mandatory-reports' + qs),
    staleTime: 30_000,
  });
}

export function useMandatoryReport(id: string | null | undefined) {
  return useQuery({
    queryKey: ['counselling', 'mandatory-report', id],
    queryFn: () => apiFetch<MandatoryReportDto>(PREFIX + '/counselling/mandatory-reports/' + id),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useFileMandatoryReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateMandatoryReportPayload) =>
      apiFetch<MandatoryReportDto>(PREFIX + '/counselling/mandatory-reports', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counselling', 'mandatory-reports'] }),
  });
}

export function useUpdateMandatoryReport(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateMandatoryReportPayload) =>
      apiFetch<MandatoryReportDto>(PREFIX + '/counselling/mandatory-reports/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['counselling', 'mandatory-reports'] });
      qc.invalidateQueries({ queryKey: ['counselling', 'mandatory-report', id] });
    },
  });
}
