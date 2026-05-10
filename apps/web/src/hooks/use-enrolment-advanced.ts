'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CancelWithdrawalPayload,
  CompleteWithdrawalPayload,
  CreateMidYearAdmissionPayload,
  CreateReenrolPayload,
  CreateTourBookingPayload,
  CreateTourSlotPayload,
  CreateWithdrawalPayload,
  ExitTaskResponseDto,
  LinkApplicationPayload,
  MidYearAdmissionResponseDto,
  PlaceReenrolHoldPayload,
  PublicTourBookingPayload,
  ReenrolResponseDto,
  ReenrolSummaryDto,
  ExitTaskCategory,
  TaskTemplateResponseDto,
  TourBookingResponseDto,
  TourSlotResponseDto,
  UpdateExitTaskPayload,
  UpdateMidYearAdmissionPayload,
  UpdateTourBookingPayload,
  UpdateTourSlotPayload,
  UpsertTaskTemplatePayload,
  WithdrawalResponseDto,
  WithdrawalStatus,
} from '@/lib/types';

const PREFIX = '/api/v1';

// ─────────────────────────────────────────────────────────────────────────
// Tour slots
// ─────────────────────────────────────────────────────────────────────────

export function usePublicTourSlots() {
  return useQuery({
    queryKey: ['enrolment-tours-public'],
    queryFn: () => apiFetch<TourSlotResponseDto[]>(`${PREFIX}/enrolment/tours/public`),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useTourSlots(enabled = true) {
  return useQuery({
    queryKey: ['enrolment-tours-admin'],
    queryFn: () => apiFetch<TourSlotResponseDto[]>(`${PREFIX}/enrolment/tours`),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useTourSlot(id: string | null) {
  return useQuery({
    queryKey: ['enrolment-tour-slot', id],
    queryFn: () => apiFetch<TourSlotResponseDto>(`${PREFIX}/enrolment/tours/${id}`),
    enabled: !!id,
  });
}

export function useCreateTourSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTourSlotPayload) =>
      apiFetch<TourSlotResponseDto>(`${PREFIX}/enrolment/tours`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enrolment-tours-admin'] });
      qc.invalidateQueries({ queryKey: ['enrolment-tours-public'] });
    },
  });
}

export function useUpdateTourSlot(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateTourSlotPayload) =>
      apiFetch<TourSlotResponseDto>(`${PREFIX}/enrolment/tours/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enrolment-tours-admin'] });
      qc.invalidateQueries({ queryKey: ['enrolment-tours-public'] });
      qc.invalidateQueries({ queryKey: ['enrolment-tour-slot', id] });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Tour bookings
// ─────────────────────────────────────────────────────────────────────────

export function useTourBookings(enabled = true) {
  return useQuery({
    queryKey: ['enrolment-tour-bookings'],
    queryFn: () => apiFetch<TourBookingResponseDto[]>(`${PREFIX}/enrolment/tour-bookings`),
    enabled,
    staleTime: 30_000,
  });
}

export function useTourBooking(id: string | null) {
  return useQuery({
    queryKey: ['enrolment-tour-booking', id],
    queryFn: () => apiFetch<TourBookingResponseDto>(`${PREFIX}/enrolment/tour-bookings/${id}`),
    enabled: !!id,
  });
}

export function useBookTourPublic(slotId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PublicTourBookingPayload) =>
      apiFetch<TourBookingResponseDto>(`${PREFIX}/enrolment/tours/${slotId}/book`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enrolment-tours-public'] });
    },
  });
}

export function useUpdateTourBooking(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateTourBookingPayload) =>
      apiFetch<TourBookingResponseDto>(`${PREFIX}/enrolment/tour-bookings/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enrolment-tour-bookings'] });
      qc.invalidateQueries({ queryKey: ['enrolment-tours-admin'] });
    },
  });
}

export function useLinkTourBookingApplication(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LinkApplicationPayload) =>
      apiFetch<TourBookingResponseDto>(`${PREFIX}/enrolment/tour-bookings/${id}/link-application`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enrolment-tour-bookings'] });
    },
  });
}

// Used by CreateTourBookingPayload type signature kept for future use.
export type _BookingPayload = CreateTourBookingPayload;

// ─────────────────────────────────────────────────────────────────────────
// Withdrawals
// ─────────────────────────────────────────────────────────────────────────

export function useWithdrawals(status?: WithdrawalStatus) {
  return useQuery({
    queryKey: ['enrolment-withdrawals', status ?? 'all'],
    queryFn: () =>
      apiFetch<WithdrawalResponseDto[]>(
        `${PREFIX}/enrolment/withdrawals${status ? `?status=${status}` : ''}`,
      ),
    refetchOnWindowFocus: true,
  });
}

export function useWithdrawal(id: string | null) {
  return useQuery({
    queryKey: ['enrolment-withdrawal', id],
    queryFn: () => apiFetch<WithdrawalResponseDto>(`${PREFIX}/enrolment/withdrawals/${id}`),
    enabled: !!id,
  });
}

export function useCreateWithdrawal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWithdrawalPayload) =>
      apiFetch<WithdrawalResponseDto>(`${PREFIX}/enrolment/withdrawals`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enrolment-withdrawals'] });
    },
  });
}

export function useCompleteWithdrawal(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CompleteWithdrawalPayload) =>
      apiFetch<WithdrawalResponseDto>(`${PREFIX}/enrolment/withdrawals/${id}/complete`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enrolment-withdrawals'] });
      qc.invalidateQueries({ queryKey: ['enrolment-withdrawal', id] });
    },
  });
}

export function useCancelWithdrawal(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CancelWithdrawalPayload) =>
      apiFetch<WithdrawalResponseDto>(`${PREFIX}/enrolment/withdrawals/${id}/cancel`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enrolment-withdrawals'] });
      qc.invalidateQueries({ queryKey: ['enrolment-withdrawal', id] });
    },
  });
}

export function usePlaceReenrolHold(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PlaceReenrolHoldPayload) =>
      apiFetch<WithdrawalResponseDto>(`${PREFIX}/enrolment/withdrawals/${id}/reenrol-hold`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enrolment-withdrawal', id] });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Exit tasks
// ─────────────────────────────────────────────────────────────────────────

export function useExitTasksPending(category?: ExitTaskCategory) {
  return useQuery({
    queryKey: ['enrolment-exit-tasks-pending', category ?? 'all'],
    queryFn: () =>
      apiFetch<ExitTaskResponseDto[]>(
        `${PREFIX}/enrolment/exit-tasks/my-department${category ? `?category=${category}` : ''}`,
      ),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useUpdateExitTask(id: string, withdrawalId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateExitTaskPayload) =>
      apiFetch<ExitTaskResponseDto>(`${PREFIX}/enrolment/exit-tasks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enrolment-exit-tasks-pending'] });
      qc.invalidateQueries({ queryKey: ['enrolment-withdrawals'] });
      if (withdrawalId) {
        qc.invalidateQueries({ queryKey: ['enrolment-withdrawal', withdrawalId] });
      }
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Re-enrolment
// ─────────────────────────────────────────────────────────────────────────

export function useReenrolConfirmations(args: { academicYearId?: string; mine?: boolean }) {
  const qs = new URLSearchParams();
  if (args.academicYearId) qs.set('academicYearId', args.academicYearId);
  if (args.mine) qs.set('mine', 'true');
  return useQuery({
    queryKey: ['enrolment-reenrol', args.academicYearId ?? 'all', args.mine ?? false],
    queryFn: () =>
      apiFetch<ReenrolResponseDto[]>(
        `${PREFIX}/enrolment/reenrolment${qs.toString() ? '?' + qs.toString() : ''}`,
      ),
  });
}

export function useReenrolSummary(academicYearId: string | null) {
  return useQuery({
    queryKey: ['enrolment-reenrol-summary', academicYearId],
    queryFn: () =>
      apiFetch<ReenrolSummaryDto>(
        `${PREFIX}/enrolment/reenrolment/summary?academicYearId=${academicYearId}`,
      ),
    enabled: !!academicYearId,
  });
}

export function useSubmitReenrol() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateReenrolPayload) =>
      apiFetch<ReenrolResponseDto>(`${PREFIX}/enrolment/reenrolment`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enrolment-reenrol'] });
      qc.invalidateQueries({ queryKey: ['enrolment-reenrol-summary'] });
      qc.invalidateQueries({ queryKey: ['enrolment-withdrawals'] });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Mid-year admissions
// ─────────────────────────────────────────────────────────────────────────

export function useMidYearAdmissions() {
  return useQuery({
    queryKey: ['enrolment-mid-year'],
    queryFn: () => apiFetch<MidYearAdmissionResponseDto[]>(`${PREFIX}/enrolment/mid-year`),
  });
}

export function useMidYearAdmission(id: string | null) {
  return useQuery({
    queryKey: ['enrolment-mid-year-row', id],
    queryFn: () => apiFetch<MidYearAdmissionResponseDto>(`${PREFIX}/enrolment/mid-year/${id}`),
    enabled: !!id,
  });
}

export function useSubmitMidYearAdmission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMidYearAdmissionPayload) =>
      apiFetch<MidYearAdmissionResponseDto>(`${PREFIX}/enrolment/mid-year`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enrolment-mid-year'] });
    },
  });
}

export function useUpdateMidYearAdmission(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMidYearAdmissionPayload) =>
      apiFetch<MidYearAdmissionResponseDto>(`${PREFIX}/enrolment/mid-year/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enrolment-mid-year'] });
      qc.invalidateQueries({ queryKey: ['enrolment-mid-year-row', id] });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Exit task templates (Step 8)
// ─────────────────────────────────────────────────────────────────────────

export function useTaskTemplates() {
  return useQuery({
    queryKey: ['enrolment-task-templates'],
    queryFn: () =>
      apiFetch<TaskTemplateResponseDto[]>(`${PREFIX}/enrolment/withdrawal-task-templates`),
  });
}

export function useUpsertTaskTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpsertTaskTemplatePayload) =>
      apiFetch<TaskTemplateResponseDto[]>(`${PREFIX}/enrolment/withdrawal-task-templates`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enrolment-task-templates'] });
    },
  });
}
