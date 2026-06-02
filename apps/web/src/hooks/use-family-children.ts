'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AddPersonEmailPayload,
  AddPersonPhonePayload,
  PersonEmailDto,
  PersonPhoneDto,
  UpdatePersonEmailPayload,
  UpdatePersonPhonePayload,
} from '@/lib/types';

export type FamilyChildStatus = 'PLACEHOLDER' | 'PENDING_LINK' | 'LINKED';

/**
 * accessLevel is now DESCRIPTIVE ONLY — a self-login indicator, not an edit
 * gate. Use `FamilyChildDto.canEdit` (the server's age + consent decision) for
 * whether the caller may edit. accessLevel meanings:
 *
 *   PLACEHOLDER — pre-link state, no iam_person yet.
 *   MANAGED     — the linked account is managed by a family guardian.
 *   INDEPENDENT — the linked account has its own login (the child logs in
 *                 themselves). This NO LONGER blocks guardian editing.
 */
export type FamilyAccessLevel = 'PLACEHOLDER' | 'MANAGED' | 'INDEPENDENT';

export type EmergencyContactSource = 'FAMILY' | 'CUSTOM';

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
  // Server-computed, caller-relative edit authority (age + consent model).
  // The UI gates ALL edit affordances on this — never on accessLevel.
  canEdit: boolean;
  // FAMILY (default) → inherit emergency contacts from
  // /family/settings/emergency-contacts, with per-child rows acting
  // as additive "additional contacts for this child only".
  // CUSTOM → only per-child rows are used; family contacts ignored.
  emergencyContactSource: EmergencyContactSource;
  // Per-child home + mailing address. addressSource 'FAMILY' (default)
  // inherits from family settings; 'CUSTOM' uses customAddress* fields.
  // mailingAddressDifferent === true → mailing* columns are used.
  addressSource: 'FAMILY' | 'CUSTOM';
  customAddressLine1: string | null;
  customAddressLine2: string | null;
  customCity: string | null;
  customState: string | null;
  customPostalCode: string | null;
  customCountry: string | null;
  mailingAddressSource: 'FAMILY' | 'CUSTOM';
  mailingAddressDifferent: boolean;
  mailingLine1: string | null;
  mailingLine2: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingPostalCode: string | null;
  mailingCountry: string | null;
  // Login email from platform_users.email. LINKED children only;
  // null for pre-link rows. Read-only on this surface.
  email: string | null;
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
  emergencyContactSource?: EmergencyContactSource;
  addressSource?: 'FAMILY' | 'CUSTOM';
  customAddressLine1?: string | null;
  customAddressLine2?: string | null;
  customCity?: string | null;
  customState?: string | null;
  customPostalCode?: string | null;
  customCountry?: string | null;
  mailingAddressSource?: 'FAMILY' | 'CUSTOM';
  mailingAddressDifferent?: boolean;
  mailingLine1?: string | null;
  mailingLine2?: string | null;
  mailingCity?: string | null;
  mailingState?: string | null;
  mailingPostalCode?: string | null;
  mailingCountry?: string | null;
}

export interface CreateChildAccountPayload {
  email?: string;
  // DOB + gender are required server-side to provision the account
  // (Account Creation spec, Step 2). DOB may already be on the
  // placeholder row; gender is collected at account creation.
  dateOfBirth?: string;
  gender?: string;
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
  // Surfaced for ACTIVE guardians (joined to iam_person). Used by the
  // family Emergency Contacts tab to render the guardian's phone.
  primaryPhone: string | null;
  // Primary phone + email TYPE for the read-only Guardian Contacts
  // panel on the child Contact tab. Sourced via subquery into
  // platform_person_phones / platform_person_emails (is_primary=true).
  // Null for PLACEHOLDER members or when the row hasn't been seeded.
  primaryPhoneType: string | null;
  primaryEmailType: string | null;
  memberRole: string;
  isPrimaryContact: boolean;
  isCurrentUser: boolean;
  status: FamilyMemberStatus;
  accessLevel: FamilyAccessLevel;
  // Family-level pickup-authorization toggle. Surfaced on the
  // family Emergency Contacts tab; defaults to true at row creation.
  emergencyAuthorizedPickup: boolean;
  // Position in the unified emergency-contacts list (shared
  // namespace with platform_family_emergency_contacts.priority_order).
  // Default 0 until the first reorder fans positions out.
  emergencyPriorityOrder: number;
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
  // Settable for ACTIVE guardians too — the server allows the pickup
  // toggle through even when identity edits would be refused.
  emergencyAuthorizedPickup?: boolean;
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

/**
 * PATCH /families/:familyId/primary-guardian — reassign the family's
 * primary contact to another ACTIVE guardian. "Primary" is a contact
 * label only and does not change edit rights / guardianship. Invalidates
 * the whole family space so the star + completion %/checklist re-derive.
 */
export function useSetPrimaryGuardian(familyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (guardianPersonId: string) =>
      apiFetch<FamilyViewDto>('/api/v1/families/' + familyId + '/primary-guardian', {
        method: 'PATCH',
        body: JSON.stringify({ guardianPersonId }),
      }),
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

export type MedicalSource = 'FAMILY' | 'CUSTOM';

export interface ChildMedicalInfoDto {
  personId: string;
  allergies: ChildAllergyEntry[];
  medications: ChildMedicationEntry[];
  conditions: ChildConditionEntry[];
  // When 'FAMILY' (default), the doctor/insurance fields below are
  // inherited from the family record — clients render them read-only
  // with a deep-link to /family/settings for edits. When 'CUSTOM',
  // the per-child values are authoritative and editable.
  medicalSource: MedicalSource;
  doctorName: string | null;
  doctorPhone: string | null;
  doctorClinic: string | null;
  insuranceProvider: string | null;
  insurancePolicy: string | null;
  insuranceGroup: string | null;
  bloodType: string | null;
  medicalNotes: string | null;
  // Family's explicit three-state flags, set only in FAMILY (inherited)
  // mode: true = family has one, false = family explicitly has none,
  // null = unanswered. Lets the Use-family view show "No family doctor on
  // file" for false instead of empty dashes. null in CUSTOM mode.
  hasFamilyDoctor: boolean | null;
  hasInsurance: boolean | null;
}
export interface UpdateChildMedicalInfoPayload {
  allergies?: ChildAllergyEntry[];
  medications?: ChildMedicationEntry[];
  conditions?: ChildConditionEntry[];
  medicalSource?: MedicalSource;
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

// ─── Child phones — /family/children/:id/phones ──────────────

const CHILD_PHONES_KEY = (childId: string) =>
  ['family', 'children', childId, 'phones'] as const;
const invalidateChildPhones = (qc: ReturnType<typeof useQueryClient>, childId: string) => {
  void qc.invalidateQueries({ queryKey: CHILD_PHONES_KEY(childId) });
  void qc.invalidateQueries({ queryKey: KEY });
};

export function useChildPhones(childId: string, enabled = true) {
  return useQuery({
    queryKey: CHILD_PHONES_KEY(childId),
    queryFn: () => apiFetch<PersonPhoneDto[]>('/api/v1/family/children/' + childId + '/phones'),
    enabled: enabled && Boolean(childId),
    staleTime: 30_000,
  });
}

export function useAddChildPhone(childId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AddPersonPhonePayload) =>
      apiFetch<PersonPhoneDto>('/api/v1/family/children/' + childId + '/phones', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateChildPhones(qc, childId),
  });
}

export function useUpdateChildPhone(childId: string, phoneId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdatePersonPhonePayload) =>
      apiFetch<PersonPhoneDto>(
        '/api/v1/family/children/' + childId + '/phones/' + phoneId,
        { method: 'PATCH', body: JSON.stringify(payload) },
      ),
    onSuccess: () => invalidateChildPhones(qc, childId),
  });
}

export function useDeleteChildPhone(childId: string, phoneId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<void>('/api/v1/family/children/' + childId + '/phones/' + phoneId, {
        method: 'DELETE',
      }),
    onSuccess: () => invalidateChildPhones(qc, childId),
  });
}

// ─── Child emails — /family/children/:id/emails ──────────────

const CHILD_EMAILS_KEY = (childId: string) =>
  ['family', 'children', childId, 'emails'] as const;
const invalidateChildEmails = (qc: ReturnType<typeof useQueryClient>, childId: string) => {
  void qc.invalidateQueries({ queryKey: CHILD_EMAILS_KEY(childId) });
  void qc.invalidateQueries({ queryKey: KEY });
};

export function useChildEmails(childId: string, enabled = true) {
  return useQuery({
    queryKey: CHILD_EMAILS_KEY(childId),
    queryFn: () => apiFetch<PersonEmailDto[]>('/api/v1/family/children/' + childId + '/emails'),
    enabled: enabled && Boolean(childId),
    staleTime: 30_000,
  });
}

export function useAddChildEmail(childId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AddPersonEmailPayload) =>
      apiFetch<PersonEmailDto>('/api/v1/family/children/' + childId + '/emails', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateChildEmails(qc, childId),
  });
}

export function useUpdateChildEmail(childId: string, emailId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdatePersonEmailPayload) =>
      apiFetch<PersonEmailDto>(
        '/api/v1/family/children/' + childId + '/emails/' + emailId,
        { method: 'PATCH', body: JSON.stringify(payload) },
      ),
    onSuccess: () => invalidateChildEmails(qc, childId),
  });
}

export function useDeleteChildEmail(childId: string, emailId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<void>('/api/v1/family/children/' + childId + '/emails/' + emailId, {
        method: 'DELETE',
      }),
    onSuccess: () => invalidateChildEmails(qc, childId),
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
  mailingAddressDifferent: boolean;
  mailingLine1: string | null;
  mailingLine2: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingPostalCode: string | null;
  mailingCountry: string | null;
  doctorName: string | null;
  doctorPhone: string | null;
  doctorClinic: string | null;
  insuranceProvider: string | null;
  insurancePolicy: string | null;
  insuranceGroup: string | null;
  // Three-state opt-outs. null = not answered, true = has one,
  // false = explicit "we don't have one" — counts as ✅ in the
  // family-profile completion checker.
  hasFamilyDoctor: boolean | null;
  hasInsurance: boolean | null;
  medicalNotes: string | null;
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
  mailingAddressDifferent?: boolean;
  mailingLine1?: string | null;
  mailingLine2?: string | null;
  mailingCity?: string | null;
  mailingState?: string | null;
  mailingPostalCode?: string | null;
  mailingCountry?: string | null;
  doctorName?: string | null;
  doctorPhone?: string | null;
  doctorClinic?: string | null;
  insuranceProvider?: string | null;
  insurancePolicy?: string | null;
  insuranceGroup?: string | null;
  hasFamilyDoctor?: boolean | null;
  hasInsurance?: boolean | null;
  medicalNotes?: string | null;
  primaryContactPersonId?: string;
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

// ─── People search (for emergency-contact linking) ────────

export interface PeopleSearchResult {
  id: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  email: string | null;
  primaryPhone: string | null;
}

/**
 * Hits GET /api/v1/people/search?q=…. Returns up to 10 results.
 * Pass `enabled` to short-circuit when the input is below the
 * 2-character minimum; an enabled-false query won't fire.
 *
 * `includeSelf` keeps the current user in the results (default: excluded).
 * The family-structure Set Father/Mother modal opts in so a parent can
 * find + select themselves as the child's parent.
 */
export function usePeopleSearch(query: string, enabled = true, includeSelf = false) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ['people', 'search', trimmed, includeSelf] as const,
    queryFn: () =>
      apiFetch<PeopleSearchResult[]>(
        '/api/v1/people/search?q=' +
          encodeURIComponent(trimmed) +
          (includeSelf ? '&includeSelf=true' : ''),
      ),
    enabled: enabled && trimmed.length >= 2,
    staleTime: 30_000,
  });
}

// ─── Duplicate detection (account-creation safety) ─────────

export interface CheckDuplicatePayload {
  email?: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
}

export interface CheckDuplicateResult {
  exists: boolean;
  // Present only when exists. Given name + last initial ("Alivia T.").
  displayName?: string;
  // Coarse role label only ("Parent", "Student", …) — never PII.
  context?: string;
  // True when the matched account is already managed by the caller, so
  // the UI may offer a direct link; otherwise a claim request is needed.
  alreadyManagedByCurrentUser?: boolean;
}

/**
 * POST /api/v1/people/check-duplicate — Account Creation spec, Step 3.
 * A mutation (not a query) so the form can fire it imperatively on
 * email-blur or after the name+DOB triple is complete. The server only
 * returns a strong match (exact email OR name+DOB) and a minimal
 * descriptor; partial-name probes never match.
 */
export function useCheckDuplicate() {
  return useMutation({
    mutationFn: (payload: CheckDuplicatePayload) =>
      apiFetch<CheckDuplicateResult>('/api/v1/people/check-duplicate', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  });
}

// ─── Family contact preferences (per-category) ─────────────

export const FAMILY_CONTACT_CATEGORIES = [
  'GENERAL',
  'ELECTRONIC_APPROVALS',
  'TRANSPORTATION',
  'HEALTH_MEDICAL',
  'BILLING_FINANCIAL',
  'ACADEMIC',
  'BEHAVIOUR_DISCIPLINE',
  'EMERGENCY',
] as const;
export type FamilyContactCategory = (typeof FAMILY_CONTACT_CATEGORIES)[number];

export interface FamilyContactPreferenceDto {
  category: FamilyContactCategory;
  primaryPersonId: string;
  primaryContactName: string;
}

export interface UpdateFamilyContactPreferencesPayload {
  preferences: Array<{ category: FamilyContactCategory; primaryPersonId: string }>;
}

export function useFamilyContactPreferences(enabled = true) {
  return useQuery({
    queryKey: ['family', 'contact-preferences'] as const,
    queryFn: () =>
      apiFetch<FamilyContactPreferenceDto[]>('/api/v1/family/contact-preferences'),
    enabled,
    staleTime: 30_000,
  });
}

export function useUpdateFamilyContactPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateFamilyContactPreferencesPayload) =>
      apiFetch<FamilyContactPreferenceDto[]>('/api/v1/family/contact-preferences', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
    },
  });
}

// ─── Family emergency contacts (shared default) ───────────

export interface FamilyEmergencyContactDto {
  id: string;
  familyId: string;
  // When set, the contact IS a CampusOS user; name/phone/email on
  // the wire are the current iam_person values, not whatever was
  // captured at link time.
  linkedPersonId: string | null;
  name: string;
  relationship: string;
  phonePrimary: string;
  phoneAlternate: string | null;
  email: string | null;
  authorizedPickup: boolean;
  priorityOrder: number;
}

export interface AddFamilyEmergencyContactPayload {
  // Either link OR provide name/phone manually.
  linkedPersonId?: string;
  name?: string;
  relationship: string;
  phonePrimary?: string;
  phoneAlternate?: string;
  email?: string;
  authorizedPickup?: boolean;
  priorityOrder?: number;
}

export interface UpdateFamilyEmergencyContactPayload {
  // Always editable.
  relationship?: string;
  authorizedPickup?: boolean;
  priorityOrder?: number;
  // Manual-only — silently ignored on linked rows server-side.
  name?: string;
  phonePrimary?: string;
  phoneAlternate?: string | null;
  email?: string | null;
}

export function useFamilyEmergencyContacts(enabled = true) {
  return useQuery({
    queryKey: ['family', 'emergency-contacts'] as const,
    queryFn: () =>
      apiFetch<FamilyEmergencyContactDto[]>('/api/v1/family/settings/emergency-contacts'),
    enabled,
    staleTime: 30_000,
  });
}

export function useAddFamilyEmergencyContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AddFamilyEmergencyContactPayload) =>
      apiFetch<FamilyEmergencyContactDto>('/api/v1/family/settings/emergency-contacts', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
    },
  });
}

export function useUpdateFamilyEmergencyContact(contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateFamilyEmergencyContactPayload) =>
      apiFetch<FamilyEmergencyContactDto>(
        '/api/v1/family/settings/emergency-contacts/' + contactId,
        { method: 'PATCH', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
    },
  });
}

export function useDeleteFamilyEmergencyContact(contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<void>('/api/v1/family/settings/emergency-contacts/' + contactId, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE });
    },
  });
}

/**
 * PATCH /family/settings/emergency-contacts/reorder — bulk reorder
 * by id. Pass the full ordering; server clamps to caller's family
 * + assigns priority_order = position. Used by the up/down arrows.
 */
export function useReorderFamilyEmergencyContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: string[]) =>
      apiFetch<FamilyEmergencyContactDto[]>(
        '/api/v1/family/settings/emergency-contacts/reorder',
        { method: 'PATCH', body: JSON.stringify({ orderedIds }) },
      ),
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
