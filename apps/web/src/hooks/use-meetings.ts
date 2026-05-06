'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ActionItemDto,
  ActionItemStatus,
  AgendaItemDto,
  ConferenceEventDto,
  CreateActionItemPayload,
  CreateAgendaItemPayload,
  CreateConferenceEventPayload,
  CreateIepMeetingRecordPayload,
  CreateMeetingPayload,
  CreateRecordingPayload,
  CreateSlotsPayload,
  GiveConsentPayload,
  IepMeetingRecordDto,
  MeetingDto,
  MeetingNotesDto,
  MeetingSlotDto,
  MeetingStatus,
  MeetingTypeDto,
  RecordingConsentDto,
  RecordingDto,
  UpdateActionItemPayload,
  UpdateConferenceEventPayload,
  UpdateMeetingPayload,
  UpsertMeetingNotesPayload,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ── Conferences ──

export function useConferences(enabled = true) {
  return useQuery({
    queryKey: ['conferences'],
    queryFn: () => apiFetch<ConferenceEventDto[]>(PREFIX + '/meetings/conferences'),
    staleTime: 60 * 1000,
    enabled,
  });
}

export function useConference(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ['conferences', id],
    queryFn: () => apiFetch<ConferenceEventDto>(PREFIX + '/meetings/conferences/' + id),
    enabled: enabled && !!id,
  });
}

export function useCreateConference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateConferenceEventPayload) =>
      apiFetch<ConferenceEventDto>(PREFIX + '/meetings/conferences', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conferences'] }),
  });
}

export function useUpdateConference(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateConferenceEventPayload) =>
      apiFetch<ConferenceEventDto>(PREFIX + '/meetings/conferences/' + id, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conferences'] }),
  });
}

// ── Meeting types ──

export function useMeetingTypes(enabled = true) {
  return useQuery({
    queryKey: ['meeting-types'],
    queryFn: () => apiFetch<MeetingTypeDto[]>(PREFIX + '/meetings/types'),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

// ── Meetings ──

export function useMeetings(
  args: {
    fromDate?: string;
    toDate?: string;
    status?: MeetingStatus;
    conferenceEventId?: string;
  } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: ['meetings', args],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (args.fromDate) qs.set('fromDate', args.fromDate);
      if (args.toDate) qs.set('toDate', args.toDate);
      if (args.status) qs.set('status', args.status);
      if (args.conferenceEventId) qs.set('conferenceEventId', args.conferenceEventId);
      const q = qs.toString();
      return apiFetch<MeetingDto[]>(PREFIX + '/meetings' + (q ? '?' + q : ''));
    },
    refetchOnWindowFocus: true,
    staleTime: 30 * 1000,
    enabled,
  });
}

export function useMeeting(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ['meetings', id],
    queryFn: () => apiFetch<MeetingDto>(PREFIX + '/meetings/' + id),
    enabled: enabled && !!id,
    staleTime: 30 * 1000,
  });
}

export function useCreateMeeting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMeetingPayload) =>
      apiFetch<MeetingDto>(PREFIX + '/meetings', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meetings'] }),
  });
}

export function useUpdateMeeting(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMeetingPayload) =>
      apiFetch<MeetingDto>(PREFIX + '/meetings/' + id, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meetings'] }),
  });
}

// ── Slots ──

export function useMeetingSlots(meetingId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['meeting-slots', meetingId],
    queryFn: () => apiFetch<MeetingSlotDto[]>(PREFIX + '/meetings/' + meetingId + '/slots'),
    enabled: enabled && !!meetingId,
    staleTime: 15 * 1000,
    refetchOnWindowFocus: true,
  });
}

export function useCreateSlots(meetingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSlotsPayload) =>
      apiFetch<MeetingSlotDto[]>(PREFIX + '/meetings/' + meetingId + '/slots', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meeting-slots', meetingId] }),
  });
}

export function useBookSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slotId: string) =>
      apiFetch<MeetingSlotDto>(PREFIX + '/meeting-slots/' + slotId + '/book', {
        method: 'PATCH',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['meeting-slots'] });
      qc.invalidateQueries({ queryKey: ['meetings'] });
      qc.invalidateQueries({ queryKey: ['conferences'] });
    },
  });
}

export function useCancelSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slotId: string) =>
      apiFetch<MeetingSlotDto>(PREFIX + '/meeting-slots/' + slotId + '/cancel', {
        method: 'PATCH',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['meeting-slots'] });
      qc.invalidateQueries({ queryKey: ['meetings'] });
      qc.invalidateQueries({ queryKey: ['conferences'] });
    },
  });
}

// ── Notes ──

export function useMeetingNotes(meetingId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['meeting-notes', meetingId],
    queryFn: () => apiFetch<MeetingNotesDto | null>(PREFIX + '/meetings/' + meetingId + '/notes'),
    enabled: enabled && !!meetingId,
  });
}

export function useUpsertMeetingNotes(meetingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertMeetingNotesPayload) =>
      apiFetch<MeetingNotesDto>(PREFIX + '/meetings/' + meetingId + '/notes', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meeting-notes', meetingId] }),
  });
}

export function useApproveNotes(meetingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (notesId: string) =>
      apiFetch<MeetingNotesDto>(PREFIX + '/meeting-notes/' + notesId + '/approve', {
        method: 'PATCH',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meeting-notes', meetingId] }),
  });
}

// ── Agenda ──

export function useAgenda(meetingId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['meeting-agenda', meetingId],
    queryFn: () => apiFetch<AgendaItemDto[]>(PREFIX + '/meetings/' + meetingId + '/agenda'),
    enabled: enabled && !!meetingId,
  });
}

export function useCreateAgendaItem(meetingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgendaItemPayload) =>
      apiFetch<AgendaItemDto>(PREFIX + '/meetings/' + meetingId + '/agenda', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meeting-agenda', meetingId] }),
  });
}

// ── Action items ──

export function useMyActionItems(status?: ActionItemStatus, enabled = true) {
  return useQuery({
    queryKey: ['action-items', { status }],
    queryFn: () =>
      apiFetch<ActionItemDto[]>(
        PREFIX + '/meeting-action-items' + (status ? '?status=' + status : ''),
      ),
    enabled,
    staleTime: 30 * 1000,
  });
}

export function useMeetingActionItems(meetingId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['action-items', 'meeting', meetingId],
    queryFn: () => apiFetch<ActionItemDto[]>(PREFIX + '/meetings/' + meetingId + '/action-items'),
    enabled: enabled && !!meetingId,
  });
}

export function useCreateActionItem(meetingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateActionItemPayload) =>
      apiFetch<ActionItemDto>(PREFIX + '/meetings/' + meetingId + '/action-items', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['action-items'] });
    },
  });
}

export function useUpdateActionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateActionItemPayload }) =>
      apiFetch<ActionItemDto>(PREFIX + '/meeting-action-items/' + id, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['action-items'] });
    },
  });
}

// ── Recording ──

export function useRecording(meetingId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['recording', meetingId],
    queryFn: () => apiFetch<RecordingDto | null>(PREFIX + '/meetings/' + meetingId + '/recording'),
    enabled: enabled && !!meetingId,
  });
}

export function useCreateRecording(meetingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRecordingPayload) =>
      apiFetch<RecordingDto>(PREFIX + '/meetings/' + meetingId + '/recording', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recording', meetingId] }),
  });
}

export function useGiveConsent(meetingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ recordingId, input }: { recordingId: string; input: GiveConsentPayload }) =>
      apiFetch<RecordingConsentDto>(PREFIX + '/meeting-recordings/' + recordingId + '/consent', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recording', meetingId] }),
  });
}

// ── IEP record ──

export function useIepMeetingRecord(meetingId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['iep-meeting-record', meetingId],
    queryFn: () =>
      apiFetch<IepMeetingRecordDto | null>(PREFIX + '/meetings/' + meetingId + '/iep-record'),
    enabled: enabled && !!meetingId,
  });
}

export function useCreateIepMeetingRecord(meetingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateIepMeetingRecordPayload) =>
      apiFetch<IepMeetingRecordDto>(PREFIX + '/meetings/' + meetingId + '/iep-record', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['iep-meeting-record', meetingId] }),
  });
}
