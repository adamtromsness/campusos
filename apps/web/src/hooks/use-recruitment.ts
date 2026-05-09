'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

const PREFIX = '/api/v1';

export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'TEMPORARY' | 'LONG_TERM_SUBSTITUTE';
export type PostingStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'LIVE'
  | 'CLOSED'
  | 'CANCELLED';
export type ApplicationStatus =
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'SCREENING'
  | 'INTERVIEW_SCHEDULED'
  | 'INTERVIEW_COMPLETED'
  | 'OFFER_EXTENDED'
  | 'OFFER_ACCEPTED'
  | 'OFFER_DECLINED'
  | 'NOT_SELECTED'
  | 'WITHDRAWN';
export type InterviewStatus = 'SCHEDULED' | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED';
export type EvaluationRating = 'STRONG_HIRE' | 'HIRE' | 'NEUTRAL' | 'NO_HIRE' | 'STRONG_NO_HIRE';
export type ContractType = 'ANNUAL' | 'MULTI_YEAR' | 'AT_WILL' | 'TEMPORARY';
export type OfferStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'WITHDRAWN';

export interface JobPostingDto {
  id: string;
  schoolId: string;
  positionTitle: string;
  department: string | null;
  description: string;
  qualificationsRequired: string | null;
  salaryRangeLow: number | null;
  salaryRangeHigh: number | null;
  employmentType: EmploymentType;
  applicationDeadline: string | null;
  status: PostingStatus;
  postedAt: string | null;
  closedAt: string | null;
  applicationCount: number;
  createdAt: string;
}

export interface ApplicationDto {
  id: string;
  postingId: string;
  postingTitle: string;
  personId: string;
  applicantName: string | null;
  applicantEmail: string | null;
  status: ApplicationStatus;
  resumeS3Key: string | null;
  coverLetterS3Key: string | null;
  submittedAt: string;
  notSelectedReason: string | null;
  withdrawnReason: string | null;
}

export interface OfferDto {
  id: string;
  applicationId: string;
  schoolId: string;
  positionTitle: string;
  salary: number;
  startDate: string;
  contractType: ContractType;
  conditions: unknown;
  acceptanceDeadline: string;
  status: OfferStatus;
  extendedAt: string;
  respondedAt: string | null;
  responseNotes: string | null;
  createdEmployeeId: string | null;
}

export const POSTING_STATUS_LABEL: Record<PostingStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  LIVE: 'Live',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};
export const POSTING_STATUS_PILL: Record<PostingStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-sky-100 text-sky-800',
  LIVE: 'bg-emerald-100 text-emerald-800',
  CLOSED: 'bg-slate-200 text-slate-700',
  CANCELLED: 'bg-rose-100 text-rose-700',
};
export const APPLICATION_STATUS_LABEL: Record<ApplicationStatus, string> = {
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  SCREENING: 'Screening',
  INTERVIEW_SCHEDULED: 'Interview scheduled',
  INTERVIEW_COMPLETED: 'Interview complete',
  OFFER_EXTENDED: 'Offer extended',
  OFFER_ACCEPTED: 'Offer accepted',
  OFFER_DECLINED: 'Offer declined',
  NOT_SELECTED: 'Not selected',
  WITHDRAWN: 'Withdrawn',
};
export const APPLICATION_STATUS_PILL: Record<ApplicationStatus, string> = {
  SUBMITTED: 'bg-slate-100 text-slate-700',
  UNDER_REVIEW: 'bg-sky-100 text-sky-800',
  SCREENING: 'bg-sky-100 text-sky-800',
  INTERVIEW_SCHEDULED: 'bg-amber-100 text-amber-800',
  INTERVIEW_COMPLETED: 'bg-amber-100 text-amber-800',
  OFFER_EXTENDED: 'bg-violet-100 text-violet-800',
  OFFER_ACCEPTED: 'bg-emerald-100 text-emerald-800',
  OFFER_DECLINED: 'bg-rose-100 text-rose-700',
  NOT_SELECTED: 'bg-slate-100 text-slate-600',
  WITHDRAWN: 'bg-slate-200 text-slate-600',
};
export const OFFER_STATUS_PILL: Record<OfferStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  ACCEPTED: 'bg-emerald-100 text-emerald-800',
  DECLINED: 'bg-rose-100 text-rose-700',
  EXPIRED: 'bg-slate-200 text-slate-600',
  WITHDRAWN: 'bg-slate-200 text-slate-600',
};

export function formatCurrencyRange(low: number | null, high: number | null): string {
  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(n);
  if (low === null && high === null) return '—';
  if (low !== null && high !== null) return `${fmt(low)} – ${fmt(high)}`;
  return fmt((low ?? high) as number);
}

export function useJobPostings(args?: { status?: PostingStatus; department?: string }) {
  const params = new URLSearchParams();
  if (args?.status) params.set('status', args.status);
  if (args?.department) params.set('department', args.department);
  const qs = params.toString();
  return useQuery({
    queryKey: ['recruitment-postings', args ?? null],
    queryFn: () => apiFetch<JobPostingDto[]>(`${PREFIX}/hr/jobs${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
  });
}

export function useCreateJobPosting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      positionTitle: string;
      description: string;
      employmentType: EmploymentType;
      department?: string;
      salaryRangeLow?: number;
      salaryRangeHigh?: number;
      applicationDeadline?: string;
      qualificationsRequired?: string;
    }) =>
      apiFetch<JobPostingDto>(`${PREFIX}/hr/jobs`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recruitment-postings'] }),
  });
}

export function usePatchJobPosting(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: Partial<{ status: PostingStatus; positionTitle: string }>) =>
      apiFetch<JobPostingDto>(`${PREFIX}/hr/jobs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recruitment-postings'] }),
  });
}

export function useApplicationsForPosting(postingId: string | null) {
  return useQuery({
    queryKey: ['recruitment-applications', postingId],
    queryFn: () => apiFetch<ApplicationDto[]>(`${PREFIX}/hr/jobs/${postingId}/applications`),
    enabled: !!postingId,
    staleTime: 30_000,
  });
}

export function useOffers() {
  return useQuery({
    queryKey: ['recruitment-offers'],
    queryFn: () => apiFetch<OfferDto[]>(`${PREFIX}/hr/offers`),
    staleTime: 30_000,
  });
}

export function useExtendOffer(applicationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      positionTitle: string;
      salary: number;
      startDate: string;
      contractType: ContractType;
      acceptanceDeadline: string;
      conditions?: unknown;
    }) =>
      apiFetch<OfferDto>(`${PREFIX}/hr/applications/${applicationId}/offer`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recruitment-offers'] });
      void qc.invalidateQueries({ queryKey: ['recruitment-applications'] });
    },
  });
}

export function useRespondToOffer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      decision: 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN';
      responseNotes?: string;
    }) =>
      apiFetch<OfferDto>(`${PREFIX}/hr/offers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recruitment-offers'] });
      void qc.invalidateQueries({ queryKey: ['recruitment-applications'] });
    },
  });
}
