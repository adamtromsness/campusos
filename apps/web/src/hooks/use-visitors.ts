'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  BannedPersonDto,
  BypassSafeguardingPayload,
  CreateBannedPersonPayload,
  CreateMusterPayload,
  CreatePreRegistrationPayload,
  CreateRecurringVisitorPayload,
  CreateSignInPayload,
  CreateVisitorTypePayload,
  MusterDetailDto,
  MusterDto,
  MusterEntryDto,
  PreRegistrationDto,
  RecurringVisitorDto,
  SignInDto,
  SignInSettingsDto,
  UpdateBannedPersonPayload,
  UpdateMusterEntryPayload,
  UpdateSignInSettingsPayload,
  UpdateVisitorTypePayload,
  VisitorDto,
  VisitorTypeDto,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ── Visitor types ──

export function useVisitorTypes(includeInactive = false) {
  return useQuery({
    queryKey: ['visitors', 'types', { includeInactive }],
    queryFn: () =>
      apiFetch<VisitorTypeDto[]>(
        PREFIX + '/visitors/visitor-types' + (includeInactive ? '?includeInactive=true' : ''),
      ),
    staleTime: 60_000,
  });
}

export function useCreateVisitorType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateVisitorTypePayload) =>
      apiFetch<VisitorTypeDto>(PREFIX + '/visitors/visitor-types', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['visitors', 'types'] }),
  });
}

export function useUpdateVisitorType(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateVisitorTypePayload) =>
      apiFetch<VisitorTypeDto>(PREFIX + '/visitors/visitor-types/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['visitors', 'types'] }),
  });
}

// ── Visitor lookup + directory ──

export function useVisitorLookup(email: string | null) {
  return useQuery({
    queryKey: ['visitors', 'lookup', email],
    queryFn: () =>
      apiFetch<VisitorDto | null>(
        PREFIX + '/visitors/lookup?email=' + encodeURIComponent(email ?? ''),
      ),
    enabled: !!email && email.length > 3,
    staleTime: 0,
  });
}

// ── Sign-ins ──

export function useOnSite() {
  return useQuery({
    queryKey: ['visitors', 'on-site'],
    queryFn: () => apiFetch<SignInDto[]>(PREFIX + '/visitors/on-site'),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useSignInLog(args?: { fromDate?: string; toDate?: string; limit?: number }) {
  const qs = new URLSearchParams();
  if (args?.fromDate) qs.set('fromDate', args.fromDate);
  if (args?.toDate) qs.set('toDate', args.toDate);
  if (args?.limit) qs.set('limit', String(args.limit));
  const search = qs.toString() ? '?' + qs.toString() : '';
  return useQuery({
    queryKey: ['visitors', 'log', args ?? {}],
    queryFn: () => apiFetch<SignInDto[]>(PREFIX + '/visitors/log' + search),
    staleTime: 30_000,
  });
}

export function useCreateSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSignInPayload) =>
      apiFetch<SignInDto>(PREFIX + '/visitors/sign-in', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['visitors', 'on-site'] });
      qc.invalidateQueries({ queryKey: ['visitors', 'log'] });
    },
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<SignInDto>(PREFIX + '/visitors/sign-ins/' + id + '/sign-out', {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['visitors', 'on-site'] });
      qc.invalidateQueries({ queryKey: ['visitors', 'log'] });
    },
  });
}

export function useBypassSafeguarding(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: BypassSafeguardingPayload) =>
      apiFetch<SignInDto>(PREFIX + '/visitors/sign-ins/' + id + '/bypass', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['visitors', 'on-site'] });
      qc.invalidateQueries({ queryKey: ['visitors', 'log'] });
    },
  });
}

// ── Pre-registrations ──

export function usePreRegistrations() {
  return useQuery({
    queryKey: ['visitors', 'pre-regs'],
    queryFn: () => apiFetch<PreRegistrationDto[]>(PREFIX + '/visitors/pre-registrations'),
    staleTime: 60_000,
  });
}

export function useCreatePreRegistration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePreRegistrationPayload) =>
      apiFetch<PreRegistrationDto>(PREFIX + '/visitors/pre-register', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['visitors', 'pre-regs'] }),
  });
}

export function useScanPreRegistration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (qrCodeToken: string) =>
      apiFetch<SignInDto>(PREFIX + '/visitors/pre-register/scan', {
        method: 'POST',
        body: JSON.stringify({ qrCodeToken }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['visitors', 'on-site'] });
      qc.invalidateQueries({ queryKey: ['visitors', 'pre-regs'] });
    },
  });
}

// ── Recurring visitors ──

export function useRecurringVisitors() {
  return useQuery({
    queryKey: ['visitors', 'recurring'],
    queryFn: () => apiFetch<RecurringVisitorDto[]>(PREFIX + '/visitors/recurring'),
    staleTime: 60_000,
  });
}

export function useRecurringVisitorsToday() {
  return useQuery({
    queryKey: ['visitors', 'recurring', 'today'],
    queryFn: () => apiFetch<RecurringVisitorDto[]>(PREFIX + '/visitors/recurring/today'),
    staleTime: 60_000,
  });
}

export function useCreateRecurringVisitor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateRecurringVisitorPayload) =>
      apiFetch<RecurringVisitorDto>(PREFIX + '/visitors/recurring', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['visitors', 'recurring'] }),
  });
}

// ── Banned persons ──

export function useBannedPersons(includeInactive = false) {
  return useQuery({
    queryKey: ['visitors', 'banned', { includeInactive }],
    queryFn: () =>
      apiFetch<BannedPersonDto[]>(
        PREFIX + '/visitors/banned-persons' + (includeInactive ? '?includeInactive=true' : ''),
      ),
    staleTime: 60_000,
  });
}

export function useCreateBannedPerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateBannedPersonPayload) =>
      apiFetch<BannedPersonDto>(PREFIX + '/visitors/banned-persons', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['visitors', 'banned'] }),
  });
}

export function useUpdateBannedPerson(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateBannedPersonPayload) =>
      apiFetch<BannedPersonDto>(PREFIX + '/visitors/banned-persons/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['visitors', 'banned'] }),
  });
}

// ── Muster ──

export function useMusters() {
  return useQuery({
    queryKey: ['visitors', 'musters'],
    queryFn: () => apiFetch<MusterDto[]>(PREFIX + '/visitors/muster'),
    staleTime: 30_000,
  });
}

export function useActiveMuster() {
  return useQuery({
    queryKey: ['visitors', 'muster', 'active'],
    queryFn: () => apiFetch<MusterDto | null>(PREFIX + '/visitors/muster/active'),
    refetchInterval: 30_000,
  });
}

export function useMusterDetail(id: string | null) {
  return useQuery({
    queryKey: ['visitors', 'muster', id],
    queryFn: () => apiFetch<MusterDetailDto>(PREFIX + '/visitors/muster/' + id),
    enabled: !!id,
    refetchInterval: 15_000,
  });
}

export function useCreateMuster() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateMusterPayload) =>
      apiFetch<MusterDetailDto>(PREFIX + '/visitors/muster', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['visitors', 'musters'] });
      qc.invalidateQueries({ queryKey: ['visitors', 'muster', 'active'] });
    },
  });
}

export function useUpdateMusterEntry(musterId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { entryId: string; payload: UpdateMusterEntryPayload }) =>
      apiFetch<MusterEntryDto>(PREFIX + '/visitors/muster-entries/' + vars.entryId, {
        method: 'PATCH',
        body: JSON.stringify(vars.payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['visitors', 'muster', musterId] });
    },
  });
}

export function useCloseMuster() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<MusterDto>(PREFIX + '/visitors/muster/' + id + '/close', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['visitors', 'musters'] });
      qc.invalidateQueries({ queryKey: ['visitors', 'muster', 'active'] });
    },
  });
}

// ── Settings ──

export function useSignInSettings() {
  return useQuery({
    queryKey: ['visitors', 'settings'],
    queryFn: () => apiFetch<SignInSettingsDto>(PREFIX + '/visitors/settings'),
    staleTime: 5 * 60_000,
  });
}

export function useUpdateSignInSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateSignInSettingsPayload) =>
      apiFetch<SignInSettingsDto>(PREFIX + '/visitors/settings', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['visitors', 'settings'] }),
  });
}
