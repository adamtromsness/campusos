'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  BellScheduleDto,
  CancelRoomBookingPayload,
  CreateBellSchedulePayload,
  CreateRoomBookingPayload,
  CreateRoomChangeRequestPayload,
  CreateRoomPayload,
  CreateTimetableSlotPayload,
  ListRoomBookingsArgs,
  ListRoomChangeRequestsArgs,
  ListRoomsArgs,
  ListTimetableArgs,
  ReviewRoomChangeRequestPayload,
  RoomBookingDto,
  RoomChangeRequestDto,
  RoomDto,
  TimetableSlotDto,
  UpdateBellSchedulePayload,
  UpdateRoomPayload,
  UpdateTimetableSlotPayload,
  UpsertPeriodsPayload,
} from '@/lib/types';

// ── Bell schedules ────────────────────────────────────────────────

export function useBellSchedules(enabled = true) {
  return useQuery({
    queryKey: ['scheduling', 'bell-schedules'],
    queryFn: () => apiFetch<BellScheduleDto[]>('/api/v1/bell-schedules'),
    enabled,
    staleTime: 60_000,
  });
}

export function useBellSchedule(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['scheduling', 'bell-schedule', id],
    queryFn: () => apiFetch<BellScheduleDto>(`/api/v1/bell-schedules/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useCreateBellSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateBellSchedulePayload) =>
      apiFetch<BellScheduleDto>('/api/v1/bell-schedules', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'bell-schedules'] });
    },
  });
}

export function useUpdateBellSchedule(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateBellSchedulePayload) =>
      apiFetch<BellScheduleDto>(`/api/v1/bell-schedules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'bell-schedules'] });
      void qc.invalidateQueries({ queryKey: ['scheduling', 'bell-schedule', id] });
    },
  });
}

export function useUpsertPeriods(scheduleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpsertPeriodsPayload) =>
      apiFetch<BellScheduleDto>(`/api/v1/bell-schedules/${scheduleId}/periods`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'bell-schedules'] });
      void qc.invalidateQueries({ queryKey: ['scheduling', 'bell-schedule', scheduleId] });
      void qc.invalidateQueries({ queryKey: ['scheduling', 'timetable'] });
    },
  });
}

export function useSetDefaultBellSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<BellScheduleDto>(`/api/v1/bell-schedules/${id}/set-default`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'bell-schedules'] });
      void qc.invalidateQueries({ queryKey: ['scheduling', 'bell-schedule'] });
    },
  });
}

// ── Timetable ─────────────────────────────────────────────────────

export function useTimetable(args: ListTimetableArgs = {}, enabled = true) {
  const params = new URLSearchParams();
  if (args.classId) params.set('classId', args.classId);
  if (args.teacherId) params.set('teacherId', args.teacherId);
  if (args.roomId) params.set('roomId', args.roomId);
  if (args.onDate) params.set('onDate', args.onDate);
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'scheduling',
      'timetable',
      {
        classId: args.classId ?? null,
        teacherId: args.teacherId ?? null,
        roomId: args.roomId ?? null,
        onDate: args.onDate ?? null,
      },
    ],
    queryFn: () => apiFetch<TimetableSlotDto[]>(`/api/v1/timetable${qs ? `?${qs}` : ''}`),
    enabled,
  });
}

export function useTimetableForTeacher(employeeId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['scheduling', 'timetable', 'teacher', employeeId],
    queryFn: () => apiFetch<TimetableSlotDto[]>(`/api/v1/timetable/teacher/${employeeId}`),
    enabled: enabled && typeof employeeId === 'string' && employeeId.length > 0,
  });
}

export function useTimetableForClass(classId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['scheduling', 'timetable', 'class', classId],
    queryFn: () => apiFetch<TimetableSlotDto[]>(`/api/v1/timetable/class/${classId}`),
    enabled: enabled && typeof classId === 'string' && classId.length > 0,
  });
}

export function useTimetableForRoom(roomId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['scheduling', 'timetable', 'room', roomId],
    queryFn: () => apiFetch<TimetableSlotDto[]>(`/api/v1/timetable/room/${roomId}`),
    enabled: enabled && typeof roomId === 'string' && roomId.length > 0,
  });
}

export function useCreateTimetableSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTimetableSlotPayload) =>
      apiFetch<TimetableSlotDto>('/api/v1/timetable/slots', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'timetable'] });
    },
  });
}

export function useUpdateTimetableSlot(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateTimetableSlotPayload) =>
      apiFetch<TimetableSlotDto>(`/api/v1/timetable/slots/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'timetable'] });
    },
  });
}

export function useDeleteTimetableSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/timetable/slots/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'timetable'] });
    },
  });
}

// ── Rooms ─────────────────────────────────────────────────────────

export function useRooms(args: ListRoomsArgs = {}, enabled = true) {
  const params = new URLSearchParams();
  if (args.includeInactive) params.set('includeInactive', 'true');
  if (args.roomType) params.set('roomType', args.roomType);
  if (args.availabilityDate) params.set('availabilityDate', args.availabilityDate);
  if (args.availabilityPeriodId) params.set('availabilityPeriodId', args.availabilityPeriodId);
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'scheduling',
      'rooms',
      {
        includeInactive: !!args.includeInactive,
        roomType: args.roomType ?? null,
        availabilityDate: args.availabilityDate ?? null,
        availabilityPeriodId: args.availabilityPeriodId ?? null,
      },
    ],
    queryFn: () => apiFetch<RoomDto[]>(`/api/v1/rooms${qs ? `?${qs}` : ''}`),
    enabled,
    staleTime: 30_000,
  });
}

export function useRoom(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['scheduling', 'room', id],
    queryFn: () => apiFetch<RoomDto>(`/api/v1/rooms/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useCreateRoom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateRoomPayload) =>
      apiFetch<RoomDto>('/api/v1/rooms', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'rooms'] });
    },
  });
}

export function useUpdateRoom(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateRoomPayload) =>
      apiFetch<RoomDto>(`/api/v1/rooms/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'rooms'] });
      void qc.invalidateQueries({ queryKey: ['scheduling', 'room', id] });
    },
  });
}

// ── Room bookings ─────────────────────────────────────────────────

export function useRoomBookings(args: ListRoomBookingsArgs = {}, enabled = true) {
  const params = new URLSearchParams();
  if (args.roomId) params.set('roomId', args.roomId);
  if (args.status) params.set('status', args.status);
  if (args.fromDate) params.set('fromDate', args.fromDate);
  if (args.toDate) params.set('toDate', args.toDate);
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'scheduling',
      'room-bookings',
      {
        roomId: args.roomId ?? null,
        status: args.status ?? null,
        fromDate: args.fromDate ?? null,
        toDate: args.toDate ?? null,
      },
    ],
    queryFn: () => apiFetch<RoomBookingDto[]>(`/api/v1/room-bookings${qs ? `?${qs}` : ''}`),
    enabled,
  });
}

export function useCreateRoomBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateRoomBookingPayload) =>
      apiFetch<RoomBookingDto>('/api/v1/room-bookings', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'room-bookings'] });
    },
  });
}

export function useCancelRoomBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; payload?: CancelRoomBookingPayload }) =>
      apiFetch<RoomBookingDto>(`/api/v1/room-bookings/${args.id}/cancel`, {
        method: 'PATCH',
        body: JSON.stringify(args.payload ?? {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'room-bookings'] });
    },
  });
}

// ── Room change requests ──────────────────────────────────────────

export function useRoomChangeRequests(
  args: ListRoomChangeRequestsArgs = {},
  enabled = true,
) {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.fromDate) params.set('fromDate', args.fromDate);
  if (args.toDate) params.set('toDate', args.toDate);
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'scheduling',
      'room-change-requests',
      {
        status: args.status ?? null,
        fromDate: args.fromDate ?? null,
        toDate: args.toDate ?? null,
      },
    ],
    queryFn: () =>
      apiFetch<RoomChangeRequestDto[]>(`/api/v1/room-change-requests${qs ? `?${qs}` : ''}`),
    enabled,
  });
}

export function useCreateRoomChangeRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateRoomChangeRequestPayload) =>
      apiFetch<RoomChangeRequestDto>('/api/v1/room-change-requests', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'room-change-requests'] });
    },
  });
}

export function useApproveRoomChangeRequest(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReviewRoomChangeRequestPayload = {}) =>
      apiFetch<RoomChangeRequestDto>(`/api/v1/room-change-requests/${id}/approve`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'room-change-requests'] });
    },
  });
}

export function useRejectRoomChangeRequest(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReviewRoomChangeRequestPayload = {}) =>
      apiFetch<RoomChangeRequestDto>(`/api/v1/room-change-requests/${id}/reject`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'room-change-requests'] });
    },
  });
}
