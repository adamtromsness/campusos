'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AddHouseholdMemberPayload,
  HouseholdDto,
  ProfileDto,
  UpdateAdminProfilePayload,
  UpdateHouseholdMemberPayload,
  UpdateHouseholdPayload,
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
