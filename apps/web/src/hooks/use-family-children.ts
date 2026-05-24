'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type FamilyChildStatus = 'PLACEHOLDER' | 'PENDING_LINK' | 'LINKED';

export interface FamilyChildDto {
  id: string;
  familyId: string;
  personId: string | null;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  gender: string | null;
  status: FamilyChildStatus;
  inviteCode: string | null;
  inviteEmail: string | null;
  inviteSentAt: string | null;
  linkedAt: string | null;
  createdAt: string;
}

export interface CreateFamilyChildPayload {
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  gender?: string;
}

export interface UpdateFamilyChildPayload {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  gender?: string;
}

export interface CreateChildAccountPayload {
  email?: string;
}

export interface SendChildLinkPayload {
  email: string;
}

export interface AcceptFamilyLinkPayload {
  code: string;
}

const KEY = ['family', 'children'] as const;
// Broader prefix used by every mutation's invalidation so both
// useFamilyChildren and useFamilyView (and any future ['family', ...]
// query) refresh together.
const INVALIDATE = ['family'] as const;

// ─── Composite family view — Parents + Children + viewer role ─

export type FamilyViewerRole = 'PARENT' | 'CHILD';

export interface FamilyMemberDto {
  personId: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  memberRole: string;
  isPrimaryContact: boolean;
  isCurrentUser: boolean;
}

export interface FamilyHeaderDto {
  id: string;
  name: string | null;
}

export interface FamilyViewDto {
  family: FamilyHeaderDto;
  viewerRole: FamilyViewerRole;
  viewerPersonId: string;
  members: FamilyMemberDto[];
  children: FamilyChildDto[];
}

/**
 * GET /family — composite shape used by /family/page.tsx. viewerRole
 * picks the render path; CHILD viewers see read-only siblings + own
 * profile card, PARENT viewers see the existing per-child action set.
 */
export function useFamilyView(enabled = true) {
  return useQuery({
    queryKey: ['family', 'view'] as const,
    queryFn: () => apiFetch<FamilyViewDto | null>('/api/v1/family'),
    enabled,
    staleTime: 30_000,
  });
}

export function useFamilyChildren(enabled = true) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<FamilyChildDto[]>('/api/v1/family/children'),
    enabled,
    staleTime: 30_000,
  });
}

export function useCreateFamilyChild() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateFamilyChildPayload) =>
      apiFetch<FamilyChildDto>('/api/v1/family/children', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
    },
  });
}

export function useUpdateFamilyChild(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateFamilyChildPayload) =>
      apiFetch<FamilyChildDto>('/api/v1/family/children/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
    },
  });
}

export function useDeleteFamilyChild(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/api/v1/family/children/' + id, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
    },
  });
}

export function useCreateChildAccount(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateChildAccountPayload) =>
      apiFetch<FamilyChildDto>('/api/v1/family/children/' + id + '/create-account', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
      // /auth/me lives in the Zustand auth store, not React Query —
      // callers must invoke refreshUser() from useAuthActions after this
      // mutation succeeds so the new PARENT persona activates without a
      // page reload. The server-side persona-cache refresh runs inside
      // createAccountForChild, so /auth/me will return the PARENT row.
    },
  });
}

export function useSendChildLink(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SendChildLinkPayload) =>
      apiFetch<FamilyChildDto>('/api/v1/family/children/' + id + '/send-link', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
    },
  });
}

/**
 * Cancel a PENDING_LINK invitation — revokes the platform_invitations
 * row and resets the family_child back to PLACEHOLDER. Maps to POST
 * /api/v1/family/children/:id/cancel-link, added in the Codex review
 * FIX 3 so cancel + delete are explicit, separate decisions.
 */
export function useCancelChildLink(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<FamilyChildDto>('/api/v1/family/children/' + id + '/cancel-link', {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
    },
  });
}

export function useAcceptFamilyLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AcceptFamilyLinkPayload) =>
      apiFetch<FamilyChildDto>('/api/v1/family/link', {
        method: 'POST',
        body: JSON.stringify({ code: payload.code }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
      // Callers must invoke refreshUser() from useAuthActions — see the
      // comment on useCreateChildAccount above.
    },
  });
}

// ─── Bidirectional family-link code generators ─────────────

export interface GenerateLinkCodeDto {
  code: string;
  expiresAt: string;
  type: 'FAMILY_INVITE' | 'CHILD_LINK';
}

/**
 * POST /family/generate-code — parent generates a FAMILY_INVITE code
 * that any authenticated user can accept to join the caller's family
 * as a LINKED child.
 */
export function useGenerateFamilyCode() {
  return useMutation({
    mutationFn: () =>
      apiFetch<GenerateLinkCodeDto>('/api/v1/family/generate-code', {
        method: 'POST',
      }),
  });
}

/**
 * POST /family/generate-child-code — child generates a CHILD_LINK
 * code with no familyChildId metadata. A parent who accepts links
 * the caller as a child in the parent's family.
 */
export function useGenerateChildCode() {
  return useMutation({
    mutationFn: () =>
      apiFetch<GenerateLinkCodeDto>('/api/v1/family/generate-child-code', {
        method: 'POST',
      }),
  });
}
