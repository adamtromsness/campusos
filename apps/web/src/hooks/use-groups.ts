'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CreateGroupAnnouncementPayload,
  CreateGroupEventPayload,
  CreateGroupPayload,
  GroupAnnouncementDto,
  GroupDto,
  GroupEventDto,
  GroupMemberDto,
  GroupNotificationPrefsDto,
  GroupRsvpStatus,
  GroupTransferDto,
  InitiateGroupTransferPayload,
  InviteGroupMemberPayload,
  UpdateGroupNotificationPrefsPayload,
  UpdateGroupPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ── Groups ──

export function useGroups(
  args: { mine?: boolean; status?: string; scopeType?: string } = {},
  enabled = true,
) {
  const qs = new URLSearchParams();
  if (args.mine) qs.set('mine', 'true');
  if (args.status) qs.set('status', args.status);
  if (args.scopeType) qs.set('scopeType', args.scopeType);
  const q = qs.toString();
  return useQuery({
    queryKey: ['groups', 'list', args],
    queryFn: () => apiFetch<GroupDto[]>(`${PREFIX}/groups${q ? '?' + q : ''}`),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useMyGroups(enabled = true) {
  return useQuery({
    queryKey: ['groups', 'mine'],
    queryFn: () => apiFetch<GroupDto[]>(`${PREFIX}/groups/mine`),
    enabled,
    staleTime: 30_000,
  });
}

export function useGroup(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['groups', 'detail', id],
    queryFn: () => apiFetch<GroupDto>(`${PREFIX}/groups/${id}`),
    enabled: enabled && !!id,
  });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateGroupPayload) =>
      apiFetch<GroupDto>(`${PREFIX}/groups`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useUpdateGroup(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateGroupPayload) =>
      apiFetch<GroupDto>(`${PREFIX}/groups/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
      void qc.invalidateQueries({ queryKey: ['groups', 'detail', id] });
    },
  });
}

// ── Membership ──

export function useGroupMembers(groupId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['groups', 'members', groupId],
    queryFn: () => apiFetch<GroupMemberDto[]>(`${PREFIX}/groups/${groupId}/members`),
    enabled: enabled && !!groupId,
  });
}

export function useMyMemberships(enabled = true) {
  return useQuery({
    queryKey: ['groups', 'my-memberships'],
    queryFn: () => apiFetch<GroupMemberDto[]>(`${PREFIX}/groups/me/memberships`),
    enabled,
  });
}

export function useJoinGroup(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { message?: string } = {}) =>
      apiFetch<GroupMemberDto>(`${PREFIX}/groups/${groupId}/join`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useLeaveGroup(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ ok: true }>(`${PREFIX}/groups/${groupId}/leave`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useInviteMember(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: InviteGroupMemberPayload) =>
      apiFetch<GroupMemberDto>(`${PREFIX}/groups/${groupId}/invite`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups', 'members', groupId] });
      void qc.invalidateQueries({ queryKey: ['groups', 'detail', groupId] });
    },
  });
}

export function useApproveJoin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role?: 'ADMIN' | 'MEMBER' }) =>
      apiFetch<GroupMemberDto>(`${PREFIX}/group-members/${memberId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useDenyJoin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) =>
      apiFetch<{ ok: true }>(`${PREFIX}/group-members/${memberId}/deny`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useUpdateMemberRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: 'ADMIN' | 'MEMBER' }) =>
      apiFetch<GroupMemberDto>(`${PREFIX}/group-members/${memberId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useSuspendMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memberId, reason }: { memberId: string; reason: string }) =>
      apiFetch<GroupMemberDto>(`${PREFIX}/group-members/${memberId}/suspend`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) =>
      apiFetch<{ ok: true }>(`${PREFIX}/group-members/${memberId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useGroupNotificationPrefs(memberId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['groups', 'prefs', memberId],
    queryFn: () =>
      apiFetch<GroupNotificationPrefsDto>(`${PREFIX}/group-members/${memberId}/notification-prefs`),
    enabled: enabled && !!memberId,
  });
}

export function useUpdateGroupNotificationPrefs(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateGroupNotificationPrefsPayload) =>
      apiFetch<GroupNotificationPrefsDto>(
        `${PREFIX}/group-members/${memberId}/notification-prefs`,
        { method: 'PATCH', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups', 'prefs', memberId] });
    },
  });
}

// ── Ownership transfers ──

export function useGroupTransfers(groupId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['groups', 'transfers', groupId],
    queryFn: () => apiFetch<GroupTransferDto[]>(`${PREFIX}/groups/${groupId}/transfers`),
    enabled: enabled && !!groupId,
  });
}

export function useMyPendingTransfers(enabled = true) {
  return useQuery({
    queryKey: ['groups', 'my-pending-transfers'],
    queryFn: () => apiFetch<GroupTransferDto[]>(`${PREFIX}/groups/me/pending-transfers`),
    enabled,
    staleTime: 30_000,
  });
}

export function useInitiateTransfer(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: InitiateGroupTransferPayload) =>
      apiFetch<GroupTransferDto>(`${PREFIX}/groups/${groupId}/transfers`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups', 'transfers', groupId] });
      void qc.invalidateQueries({ queryKey: ['groups', 'my-pending-transfers'] });
    },
  });
}

export function useAcceptTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<GroupTransferDto>(`${PREFIX}/group-transfers/${id}/accept`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useDeclineTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<GroupTransferDto>(`${PREFIX}/group-transfers/${id}/decline`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useCancelTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<GroupTransferDto>(`${PREFIX}/group-transfers/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

// ── Announcements ──

export function useGroupAnnouncements(groupId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['groups', 'announcements', groupId],
    queryFn: () => apiFetch<GroupAnnouncementDto[]>(`${PREFIX}/groups/${groupId}/announcements`),
    enabled: enabled && !!groupId,
  });
}

export function useCreateGroupAnnouncement(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateGroupAnnouncementPayload) =>
      apiFetch<GroupAnnouncementDto>(`${PREFIX}/groups/${groupId}/announcements`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups', 'announcements', groupId] });
    },
  });
}

export function useMarkAnnouncementRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: true }>(`${PREFIX}/group-announcements/${id}/read`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups', 'announcements'] });
    },
  });
}

// ── Events ──

export function useGroupEvents(groupId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['groups', 'events', groupId],
    queryFn: () => apiFetch<GroupEventDto[]>(`${PREFIX}/groups/${groupId}/events`),
    enabled: enabled && !!groupId,
  });
}

export function useCreateGroupEvent(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateGroupEventPayload) =>
      apiFetch<GroupEventDto>(`${PREFIX}/groups/${groupId}/events`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups', 'events', groupId] });
    },
  });
}

export function useRsvpEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: GroupRsvpStatus }) =>
      apiFetch<GroupEventDto>(`${PREFIX}/group-events/${id}/rsvp`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups', 'events'] });
    },
  });
}

export function useMyEventRsvps(enabled = true) {
  return useQuery({
    queryKey: ['groups', 'my-rsvps'],
    queryFn: () => apiFetch<GroupEventDto[]>(`${PREFIX}/group-events/me/rsvps`),
    enabled,
  });
}
