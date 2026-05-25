'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type FamilyChildStatus = 'PLACEHOLDER' | 'PENDING_LINK' | 'LINKED';

/**
 * accessLevel is the caller-relative authority on a family row.
 * Server derives it from platform_users.managed_by_person_id:
 *
 *   PLACEHOLDER — pre-link state, no iam_person yet. Edits go to
 *                 the family row directly.
 *   MANAGED     — the linked account's managed_by_person_id is the
 *                 caller. The caller is the custodian and PATCH
 *                 endpoints accept full identity edits.
 *   INDEPENDENT — the linked account is unmanaged or managed by
 *                 someone else. PATCH endpoints return 403.
 */
export type FamilyAccessLevel = 'PLACEHOLDER' | 'MANAGED' | 'INDEPENDENT';

export interface FamilyChildDto {
  id: string;
  familyId: string;
  personId: string | null;
  firstName: string;
  middleName: string | null;
  lastName: string;
  preferredName: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  // primaryPhone + notes live on iam_person and are populated for
  // LINKED children only. PLACEHOLDER / PENDING_LINK rows have no
  // iam_person yet and these will be null on the wire.
  primaryPhone: string | null;
  notes: string | null;
  status: FamilyChildStatus;
  accessLevel: FamilyAccessLevel;
  inviteCode: string | null;
  inviteEmail: string | null;
  inviteSentAt: string | null;
  linkedAt: string | null;
  createdAt: string;
}

export interface CreateFamilyChildPayload {
  firstName: string;
  middleName?: string;
  lastName: string;
  preferredName?: string;
  dateOfBirth?: string;
  gender?: string;
}

export interface UpdateFamilyChildPayload {
  firstName?: string;
  middleName?: string | null;
  lastName?: string;
  preferredName?: string | null;
  dateOfBirth?: string;
  gender?: string;
  primaryPhone?: string | null;
  notes?: string | null;
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

export type FamilyMemberStatus = 'PLACEHOLDER' | 'PENDING_INVITE' | 'ACTIVE';

export interface FamilyMemberDto {
  id: string;
  personId: string | null;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  email: string | null;
  memberRole: string;
  isPrimaryContact: boolean;
  isCurrentUser: boolean;
  status: FamilyMemberStatus;
  accessLevel: FamilyAccessLevel;
  inviteCode: string | null;
  inviteSentAt: string | null;
}

export interface AddFamilyMemberPayload {
  firstName: string;
  lastName: string;
  email?: string;
  relationship?: string;
}

export interface UpdateFamilyMemberPayload {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  relationship?: string;
}

export interface CreateMemberAccountPayload {
  email?: string;
}

export interface SendMemberInvitePayload {
  email?: string;
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
  type: 'FAMILY_INVITE' | 'CHILD_LINK' | 'GUARDIAN_INVITE';
}

export interface InviteGuardianPayload {
  email?: string;
  firstName?: string;
  lastName?: string;
  relationship?: string;
}

export interface GenerateFamilyCodePayload {
  email?: string;
}

/**
 * POST /family/invite-guardian — parent generates a GUARDIAN_INVITE
 * code. Whoever accepts joins the family as a co-parent and gains
 * full read/write on every child.
 */
export function useInviteGuardian() {
  return useMutation({
    mutationFn: (payload: InviteGuardianPayload) =>
      apiFetch<GenerateLinkCodeDto>('/api/v1/family/invite-guardian', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  });
}

/**
 * POST /family/generate-code — parent generates a FAMILY_INVITE code
 * that any authenticated user can accept to join the caller's family
 * as a LINKED child. Optional email lands on target_email for the
 * future send-email worker.
 */
export function useGenerateFamilyCode() {
  return useMutation({
    mutationFn: (payload: GenerateFamilyCodePayload = {}) =>
      apiFetch<GenerateLinkCodeDto>('/api/v1/family/generate-code', {
        method: 'POST',
        body: JSON.stringify(payload),
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

// ─── Placeholder guardian members ─────────────────────────

export function useAddFamilyMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AddFamilyMemberPayload) =>
      apiFetch<FamilyMemberDto>('/api/v1/family/members', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
    },
  });
}

export function useUpdateFamilyMember(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateFamilyMemberPayload) =>
      apiFetch<FamilyMemberDto>('/api/v1/family/members/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
    },
  });
}

export function useDeleteFamilyMember(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/api/v1/family/members/' + id, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
    },
  });
}

export function useCreateMemberAccount(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateMemberAccountPayload) =>
      apiFetch<FamilyMemberDto>('/api/v1/family/members/' + id + '/create-account', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
    },
  });
}

export function useSendMemberInvite(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SendMemberInvitePayload) =>
      apiFetch<FamilyMemberDto>('/api/v1/family/members/' + id + '/send-invite', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
    },
  });
}

// ─── Child profile sections ───────────────────────────────

export type AllergySeverity = 'MILD' | 'MODERATE' | 'SEVERE' | 'LIFE_THREATENING';
export type AllergyType = 'FOOD' | 'ENVIRONMENTAL' | 'MEDICATION' | 'OTHER';
export type DietaryType =
  | 'NONE'
  | 'VEGETARIAN'
  | 'VEGAN'
  | 'HALAL'
  | 'KOSHER'
  | 'GLUTEN_FREE'
  | 'DAIRY_FREE'
  | 'OTHER';

export interface ChildAllergyEntry {
  name: string;
  severity?: AllergySeverity;
  type?: AllergyType;
  notes?: string;
}
export interface ChildMedicationEntry {
  name: string;
  dosage?: string;
  frequency?: string;
  prescriber?: string;
  notes?: string;
}
export interface ChildConditionEntry {
  name: string;
  diagnosedDate?: string;
  notes?: string;
}
export interface ChildFoodAllergyEntry {
  name: string;
  severity?: AllergySeverity;
  notes?: string;
}

export interface ChildMedicalInfoDto {
  personId: string;
  allergies: ChildAllergyEntry[];
  medications: ChildMedicationEntry[];
  conditions: ChildConditionEntry[];
  doctorName: string | null;
  doctorPhone: string | null;
  doctorClinic: string | null;
  insuranceProvider: string | null;
  insurancePolicy: string | null;
  insuranceGroup: string | null;
  bloodType: string | null;
  medicalNotes: string | null;
}
export interface UpdateChildMedicalInfoPayload {
  allergies?: ChildAllergyEntry[];
  medications?: ChildMedicationEntry[];
  conditions?: ChildConditionEntry[];
  doctorName?: string | null;
  doctorPhone?: string | null;
  doctorClinic?: string | null;
  insuranceProvider?: string | null;
  insurancePolicy?: string | null;
  insuranceGroup?: string | null;
  bloodType?: string | null;
  medicalNotes?: string | null;
}

export interface ChildEmergencyContactDto {
  id: string;
  name: string;
  relationship: string;
  phonePrimary: string;
  phoneAlternate: string | null;
  email: string | null;
  authorizedPickup: boolean;
  priorityOrder: number;
}
export interface AddChildEmergencyContactPayload {
  name: string;
  relationship: string;
  phonePrimary: string;
  phoneAlternate?: string;
  email?: string;
  authorizedPickup?: boolean;
  priorityOrder?: number;
}
export interface UpdateChildEmergencyContactPayload {
  name?: string;
  relationship?: string;
  phonePrimary?: string;
  phoneAlternate?: string | null;
  email?: string | null;
  authorizedPickup?: boolean;
  priorityOrder?: number;
}

export interface ChildDietaryInfoDto {
  personId: string;
  dietaryType: DietaryType;
  foodAllergies: ChildFoodAllergyEntry[];
  additionalRestrictions: string | null;
  mealPreference: string | null;
}
export interface UpdateChildDietaryInfoPayload {
  dietaryType?: DietaryType;
  foodAllergies?: ChildFoodAllergyEntry[];
  additionalRestrictions?: string | null;
  mealPreference?: string | null;
}

const childSectionInvalidate = (qc: ReturnType<typeof useQueryClient>, childId: string) => {
  void qc.invalidateQueries({ queryKey: ['family', 'child', childId] });
};

export function useChildMedical(childId: string, enabled = true) {
  return useQuery({
    queryKey: ['family', 'child', childId, 'medical'] as const,
    queryFn: () =>
      apiFetch<ChildMedicalInfoDto>('/api/v1/family/children/' + childId + '/medical'),
    enabled: enabled && childId.length > 0,
    staleTime: 30_000,
  });
}

export function useUpdateChildMedical(childId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateChildMedicalInfoPayload) =>
      apiFetch<ChildMedicalInfoDto>('/api/v1/family/children/' + childId + '/medical', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => childSectionInvalidate(qc, childId),
  });
}

export function useChildEmergencyContacts(childId: string, enabled = true) {
  return useQuery({
    queryKey: ['family', 'child', childId, 'emergency-contacts'] as const,
    queryFn: () =>
      apiFetch<ChildEmergencyContactDto[]>(
        '/api/v1/family/children/' + childId + '/emergency-contacts',
      ),
    enabled: enabled && childId.length > 0,
    staleTime: 30_000,
  });
}

export function useAddChildEmergencyContact(childId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AddChildEmergencyContactPayload) =>
      apiFetch<ChildEmergencyContactDto>(
        '/api/v1/family/children/' + childId + '/emergency-contacts',
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => childSectionInvalidate(qc, childId),
  });
}

export function useUpdateChildEmergencyContact(childId: string, contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateChildEmergencyContactPayload) =>
      apiFetch<ChildEmergencyContactDto>(
        '/api/v1/family/children/' + childId + '/emergency-contacts/' + contactId,
        { method: 'PATCH', body: JSON.stringify(payload) },
      ),
    onSuccess: () => childSectionInvalidate(qc, childId),
  });
}

export function useDeleteChildEmergencyContact(childId: string, contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<void>('/api/v1/family/children/' + childId + '/emergency-contacts/' + contactId, {
        method: 'DELETE',
      }),
    onSuccess: () => childSectionInvalidate(qc, childId),
  });
}

export function useChildDietary(childId: string, enabled = true) {
  return useQuery({
    queryKey: ['family', 'child', childId, 'dietary'] as const,
    queryFn: () =>
      apiFetch<ChildDietaryInfoDto>('/api/v1/family/children/' + childId + '/dietary'),
    enabled: enabled && childId.length > 0,
    staleTime: 30_000,
  });
}

// ─── Family settings (shared attributes) ──────────────────

export interface FamilySettingsDto {
  familyId: string;
  displayName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  homePhone: string | null;
  doctorName: string | null;
  doctorPhone: string | null;
  doctorClinic: string | null;
  insuranceProvider: string | null;
  insurancePolicy: string | null;
  insuranceGroup: string | null;
  primaryContactPersonId: string | null;
  primaryContactName: string | null;
  canEdit: boolean;
}

export interface UpdateFamilySettingsPayload {
  displayName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  homePhone?: string | null;
  doctorName?: string | null;
  doctorPhone?: string | null;
  doctorClinic?: string | null;
  insuranceProvider?: string | null;
  insurancePolicy?: string | null;
  insuranceGroup?: string | null;
}

export function useFamilySettings(enabled = true) {
  return useQuery({
    queryKey: ['family', 'settings'] as const,
    queryFn: () => apiFetch<FamilySettingsDto | null>('/api/v1/family/settings'),
    enabled,
    staleTime: 30_000,
  });
}

export function useUpdateFamilySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateFamilySettingsPayload) =>
      apiFetch<FamilySettingsDto>('/api/v1/family/settings', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
    },
  });
}

export function useUpdateChildDietary(childId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateChildDietaryInfoPayload) =>
      apiFetch<ChildDietaryInfoDto>('/api/v1/family/children/' + childId + '/dietary', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => childSectionInvalidate(qc, childId),
  });
}
