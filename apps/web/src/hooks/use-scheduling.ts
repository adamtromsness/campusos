'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AssignCoveragePayload,
  BellScheduleDto,
  CalendarDayResolutionDto,
  CalendarEventDto,
  CancelCoveragePayload,
  CancelRoomBookingPayload,
  CoverageRequestDto,
  CreateBellSchedulePayload,
  CreateCalendarEventPayload,
  CreateDayOverridePayload,
  CreateRoomBookingPayload,
  CreateRoomChangeRequestPayload,
  CreateRoomPayload,
  CreateTimetableSlotPayload,
  DayOverrideDto,
  ListCalendarEventsArgs,
  ListCoverageArgs,
  ListDayOverridesArgs,
  ListRoomBookingsArgs,
  ListRoomChangeRequestsArgs,
  ListRoomsArgs,
  ListSubstitutionsArgs,
  ListTimetableArgs,
  ReviewRoomChangeRequestPayload,
  RoomBookingDto,
  RoomChangeRequestDto,
  RoomDto,
  SubstitutionDto,
  TimetableSlotDto,
  UpdateBellSchedulePayload,
  UpdateCalendarEventPayload,
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

export function useTimetableForStudent(studentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['scheduling', 'timetable', 'student', studentId],
    queryFn: () => apiFetch<TimetableSlotDto[]>(`/api/v1/timetable/student/${studentId}`),
    enabled: enabled && typeof studentId === 'string' && studentId.length > 0,
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

export function useRoomChangeRequests(args: ListRoomChangeRequestsArgs = {}, enabled = true) {
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

// ── Calendar events ───────────────────────────────────────────────

export function useCalendarEvents(args: ListCalendarEventsArgs = {}, enabled = true) {
  const params = new URLSearchParams();
  if (args.fromDate) params.set('fromDate', args.fromDate);
  if (args.toDate) params.set('toDate', args.toDate);
  if (args.eventType) params.set('eventType', args.eventType);
  if (args.includeDrafts) params.set('includeDrafts', 'true');
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'scheduling',
      'calendar',
      'events',
      {
        fromDate: args.fromDate ?? null,
        toDate: args.toDate ?? null,
        eventType: args.eventType ?? null,
        includeDrafts: !!args.includeDrafts,
      },
    ],
    queryFn: () => apiFetch<CalendarEventDto[]>(`/api/v1/calendar${qs ? `?${qs}` : ''}`),
    enabled,
  });
}

export function useCalendarEvent(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['scheduling', 'calendar', 'event', id],
    queryFn: () => apiFetch<CalendarEventDto>(`/api/v1/calendar/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useCalendarDayResolution(date: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['scheduling', 'calendar', 'day', date],
    queryFn: () => apiFetch<CalendarDayResolutionDto>(`/api/v1/calendar/day/${date}`),
    enabled: enabled && typeof date === 'string' && date.length > 0,
  });
}

export function useCreateCalendarEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateCalendarEventPayload) =>
      apiFetch<CalendarEventDto>(`/api/v1/calendar`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'calendar'] });
    },
  });
}

export function useUpdateCalendarEvent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateCalendarEventPayload) =>
      apiFetch<CalendarEventDto>(`/api/v1/calendar/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'calendar'] });
    },
  });
}

export function useDeleteCalendarEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/api/v1/calendar/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'calendar'] });
    },
  });
}

// ── Day overrides ─────────────────────────────────────────────────

export function useDayOverrides(args: ListDayOverridesArgs = {}, enabled = true) {
  const params = new URLSearchParams();
  if (args.fromDate) params.set('fromDate', args.fromDate);
  if (args.toDate) params.set('toDate', args.toDate);
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'scheduling',
      'calendar',
      'overrides',
      { fromDate: args.fromDate ?? null, toDate: args.toDate ?? null },
    ],
    queryFn: () => apiFetch<DayOverrideDto[]>(`/api/v1/calendar/overrides${qs ? `?${qs}` : ''}`),
    enabled,
  });
}

export function useCreateDayOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateDayOverridePayload) =>
      apiFetch<DayOverrideDto>(`/api/v1/calendar/overrides`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'calendar'] });
    },
  });
}

export function useDeleteDayOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (date: string) =>
      apiFetch<void>(`/api/v1/calendar/overrides/${date}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'calendar'] });
    },
  });
}

// ── Coverage ──────────────────────────────────────────────────────

export function useCoverageRequests(args: ListCoverageArgs = {}, enabled = true) {
  const params = new URLSearchParams();
  if (args.fromDate) params.set('fromDate', args.fromDate);
  if (args.toDate) params.set('toDate', args.toDate);
  if (args.status) params.set('status', args.status);
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'scheduling',
      'coverage',
      {
        fromDate: args.fromDate ?? null,
        toDate: args.toDate ?? null,
        status: args.status ?? null,
      },
    ],
    queryFn: () => apiFetch<CoverageRequestDto[]>(`/api/v1/coverage${qs ? `?${qs}` : ''}`),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useCoverageRequest(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['scheduling', 'coverage', 'detail', id],
    queryFn: () => apiFetch<CoverageRequestDto>(`/api/v1/coverage/${id}`),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useAssignCoverage(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AssignCoveragePayload) =>
      apiFetch<CoverageRequestDto>(`/api/v1/coverage/${id}/assign`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'coverage'] });
      void qc.invalidateQueries({ queryKey: ['scheduling', 'substitutions'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useCancelCoverage(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CancelCoveragePayload = {}) =>
      apiFetch<CoverageRequestDto>(`/api/v1/coverage/${id}/cancel`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduling', 'coverage'] });
      void qc.invalidateQueries({ queryKey: ['scheduling', 'substitutions'] });
    },
  });
}

// ── Substitutions ─────────────────────────────────────────────────

export function useSubstitutions(args: ListSubstitutionsArgs = {}, enabled = true) {
  const params = new URLSearchParams();
  if (args.fromDate) params.set('fromDate', args.fromDate);
  if (args.toDate) params.set('toDate', args.toDate);
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'scheduling',
      'substitutions',
      { fromDate: args.fromDate ?? null, toDate: args.toDate ?? null },
    ],
    queryFn: () => apiFetch<SubstitutionDto[]>(`/api/v1/substitutions${qs ? `?${qs}` : ''}`),
    enabled,
  });
}

export function useSubstitutionsForTeacher(
  employeeId: string | null | undefined,
  args: ListSubstitutionsArgs = {},
  enabled = true,
) {
  const params = new URLSearchParams();
  if (args.fromDate) params.set('fromDate', args.fromDate);
  if (args.toDate) params.set('toDate', args.toDate);
  const qs = params.toString();
  return useQuery({
    queryKey: [
      'scheduling',
      'substitutions',
      'teacher',
      employeeId,
      { fromDate: args.fromDate ?? null, toDate: args.toDate ?? null },
    ],
    queryFn: () =>
      apiFetch<SubstitutionDto[]>(
        `/api/v1/substitutions/teacher/${employeeId}${qs ? `?${qs}` : ''}`,
      ),
    enabled: enabled && typeof employeeId === 'string' && employeeId.length > 0,
  });
}
