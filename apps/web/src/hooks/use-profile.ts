'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AddHouseholdMemberPayload,
  AddPersonEmailPayload,
  AddPersonPhonePayload,
  AdultMedicalInfoDto,
  HouseholdDto,
  PersonEmailDto,
  PersonPhoneDto,
  ProfileDto,
  UpdateAdminProfilePayload,
  UpdateAdultMedicalInfoPayload,
  UpdateHouseholdMemberPayload,
  UpdateHouseholdPayload,
  UpdatePersonEmailPayload,
  UpdatePersonPhonePayload,
  UpdateProfilePayload,
} from '@/lib/types';

// ── Profile ────────────────────────────────────────────────

export function useMyProfile(enabled = true) {
  return useQuery({
    queryKey: ['profile', 'me'],
    queryFn: () => apiFetch<ProfileDto>(`/api/v1/profile/me`),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useProfile(personId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['profile', personId],
    queryFn: () => apiFetch<ProfileDto>(`/api/v1/profile/${personId}`),
    enabled: enabled && typeof personId === 'string' && personId.length > 0,
    staleTime: 30_000,
  });
}

export function useUpdateMyProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateProfilePayload) =>
      apiFetch<ProfileDto>(`/api/v1/profile/me`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['profile', 'me'], data);
      void qc.invalidateQueries({ queryKey: ['profile'] });
      void qc.invalidateQueries({ queryKey: ['household', 'mine'] });
    },
  });
}

// ── Multi-phone list — /profile/me/phones ────────────────

export function useMyPhones(enabled = true) {
  return useQuery({
    queryKey: ['profile', 'me', 'phones'] as const,
    queryFn: () => apiFetch<PersonPhoneDto[]>('/api/v1/profile/me/phones'),
    enabled,
    staleTime: 30_000,
  });
}

const invalidatePhones = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['profile', 'me', 'phones'] });
  // Primary-phone changes propagate to iam_person.primary_phone too,
  // so refresh /profile/me which downstream surfaces read.
  void qc.invalidateQueries({ queryKey: ['profile', 'me'] });
};

export function useAddMyPhone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AddPersonPhonePayload) =>
      apiFetch<PersonPhoneDto>('/api/v1/profile/me/phones', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidatePhones(qc),
  });
}

export function useUpdateMyPhone(phoneId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdatePersonPhonePayload) =>
      apiFetch<PersonPhoneDto>('/api/v1/profile/me/phones/' + phoneId, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidatePhones(qc),
  });
}

export function useDeleteMyPhone(phoneId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/api/v1/profile/me/phones/' + phoneId, { method: 'DELETE' }),
    onSuccess: () => invalidatePhones(qc),
  });
}

// ── Multi-email list — /profile/me/emails ────────────────

export function useMyEmails(enabled = true) {
  return useQuery({
    queryKey: ['profile', 'me', 'emails'] as const,
    queryFn: () => apiFetch<PersonEmailDto[]>('/api/v1/profile/me/emails'),
    enabled,
    staleTime: 30_000,
  });
}

// Email mutations also touch the family roster: FamilyMemberDto.email
// is sourced from platform_person_emails on the server, so adding /
// removing / re-prioritising emails affects the completion checker.
// Invalidate /family alongside the emails query.
const invalidateEmails = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['profile', 'me', 'emails'] });
  void qc.invalidateQueries({ queryKey: ['profile', 'me'] });
  void qc.invalidateQueries({ queryKey: ['family'] });
};

export function useAddMyEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AddPersonEmailPayload) =>
      apiFetch<PersonEmailDto>('/api/v1/profile/me/emails', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateEmails(qc),
  });
}

export function useUpdateMyEmail(emailId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdatePersonEmailPayload) =>
      apiFetch<PersonEmailDto>('/api/v1/profile/me/emails/' + emailId, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateEmails(qc),
  });
}

export function useDeleteMyEmail(emailId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/api/v1/profile/me/emails/' + emailId, { method: 'DELETE' }),
    onSuccess: () => invalidateEmails(qc),
  });
}

// ── Adult medical info — /profile/me/medical ─────────────

export function useMyMedical(enabled = true) {
  return useQuery({
    queryKey: ['profile', 'me', 'medical'] as const,
    queryFn: () => apiFetch<AdultMedicalInfoDto>('/api/v1/profile/me/medical'),
    enabled,
    staleTime: 30_000,
  });
}

export function useUpdateMyMedical() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateAdultMedicalInfoPayload) =>
      apiFetch<AdultMedicalInfoDto>('/api/v1/profile/me/medical', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['profile', 'me', 'medical'], data);
    },
  });
}

export function useUpdateProfile(personId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateAdminProfilePayload) =>
      apiFetch<ProfileDto>(`/api/v1/profile/${personId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['profile', personId], data);
      void qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

// ── Households ─────────────────────────────────────────────

export function useMyHousehold(enabled = true) {
  return useQuery({
    queryKey: ['household', 'mine'],
    queryFn: () => apiFetch<HouseholdDto | null>(`/api/v1/households/my`),
    enabled,
    staleTime: 30_000,
  });
}

export function useHousehold(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['household', id],
    queryFn: () => apiFetch<HouseholdDto>(`/api/v1/households/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
    staleTime: 30_000,
  });
}

export function useUpdateHousehold(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateHouseholdPayload) =>
      apiFetch<HouseholdDto>(`/api/v1/households/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['household', 'mine'], data);
      qc.setQueryData(['household', id], data);
      void qc.invalidateQueries({ queryKey: ['household'] });
    },
  });
}

export function useAddHouseholdMember(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AddHouseholdMemberPayload) =>
      apiFetch<HouseholdDto>(`/api/v1/households/${id}/members`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['household'] });
      void qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

export function useUpdateHouseholdMember(id: string, memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateHouseholdMemberPayload) =>
      apiFetch<HouseholdDto>(`/api/v1/households/${id}/members/${memberId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['household'] });
    },
  });
}

export function useRemoveHouseholdMember(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) =>
      apiFetch<HouseholdDto>(`/api/v1/households/${id}/members/${memberId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['household'] });
      void qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}
