'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AssignTicketPayload,
  AssignVendorPayload,
  CancelTicketPayload,
  CreateProblemPayload,
  CreateTicketCategoryPayload,
  CreateTicketCommentPayload,
  CreateTicketPayload,
  CreateTicketSubcategoryPayload,
  CreateTicketVendorPayload,
  LinkProblemTicketsPayload,
  ListProblemsArgs,
  ListTicketsArgs,
  ProblemDto,
  ResolveProblemPayload,
  ResolveProblemResponse,
  ResolveTicketPayload,
  TicketActivityDto,
  TicketCategoryDto,
  TicketCommentDto,
  TicketDto,
  TicketSlaPolicyDto,
  TicketSubcategoryDto,
  TicketVendorDto,
  UpdateProblemPayload,
  UpdateTicketCategoryPayload,
  UpdateTicketSubcategoryPayload,
  UpdateTicketVendorPayload,
  UpsertTicketSlaPayload,
} from '@/lib/types';

function buildQs(args: ListTicketsArgs): string {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.priority) params.set('priority', args.priority);
  if (args.categoryId) params.set('categoryId', args.categoryId);
  if (args.assigneeId) params.set('assigneeId', args.assigneeId);
  if (args.vendorId) params.set('vendorId', args.vendorId);
  if (args.createdAfter) params.set('createdAfter', args.createdAfter);
  if (args.createdBefore) params.set('createdBefore', args.createdBefore);
  if (args.includeTerminal) params.set('includeTerminal', 'true');
  if (args.limit) params.set('limit', String(args.limit));
  const qs = params.toString();
  return qs ? '?' + qs : '';
}

// ── Ticket list / detail / lifecycle ────────────────────────────

export function useTickets(args: ListTicketsArgs = {}, enabled = true) {
  return useQuery({
    queryKey: [
      'tickets',
      'list',
      {
        status: args.status ?? null,
        priority: args.priority ?? null,
        categoryId: args.categoryId ?? null,
        assigneeId: args.assigneeId ?? null,
        vendorId: args.vendorId ?? null,
        createdAfter: args.createdAfter ?? null,
        createdBefore: args.createdBefore ?? null,
        includeTerminal: !!args.includeTerminal,
        limit: args.limit ?? null,
      },
    ],
    queryFn: () => apiFetch<TicketDto[]>('/api/v1/tickets' + buildQs(args)),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export function useTicket(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['tickets', 'one', id],
    queryFn: () => apiFetch<TicketDto>('/api/v1/tickets/' + id),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTicketPayload) =>
      apiFetch<TicketDto>('/api/v1/tickets', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
}

export function useAssignTicket(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AssignTicketPayload) =>
      apiFetch<TicketDto>('/api/v1/tickets/' + id + '/assign', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateTicket(qc, id),
  });
}

export function useAssignVendor(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AssignVendorPayload) =>
      apiFetch<TicketDto>('/api/v1/tickets/' + id + '/assign-vendor', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateTicket(qc, id),
  });
}

export function useResolveTicket(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ResolveTicketPayload) =>
      apiFetch<TicketDto>('/api/v1/tickets/' + id + '/resolve', {
        method: 'PATCH',
        body: JSON.stringify(payload ?? {}),
      }),
    onSuccess: () => invalidateTicket(qc, id),
  });
}

export function useCloseTicket(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<TicketDto>('/api/v1/tickets/' + id + '/close', { method: 'PATCH' }),
    onSuccess: () => invalidateTicket(qc, id),
  });
}

export function useReopenTicket(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<TicketDto>('/api/v1/tickets/' + id + '/reopen', { method: 'PATCH' }),
    onSuccess: () => invalidateTicket(qc, id),
  });
}

export function useCancelTicket(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CancelTicketPayload) =>
      apiFetch<TicketDto>('/api/v1/tickets/' + id + '/cancel', {
        method: 'PATCH',
        body: JSON.stringify(payload ?? {}),
      }),
    onSuccess: () => invalidateTicket(qc, id),
  });
}

function invalidateTicket(qc: ReturnType<typeof useQueryClient>, id: string): void {
  void qc.invalidateQueries({ queryKey: ['tickets'] });
  void qc.invalidateQueries({ queryKey: ['tickets', 'one', id] });
  void qc.invalidateQueries({ queryKey: ['tickets', 'comments', id] });
  void qc.invalidateQueries({ queryKey: ['tickets', 'activity', id] });
  // Resolve on a ticket cascades to a linked auto-task DONE flip — refresh
  // the Tasks badge as well.
  void qc.invalidateQueries({ queryKey: ['tasks'] });
  void qc.invalidateQueries({ queryKey: ['notifications'] });
}

// ── Comments ────────────────────────────────────────────────────

export function useTicketComments(ticketId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['tickets', 'comments', ticketId],
    queryFn: () =>
      apiFetch<TicketCommentDto[]>('/api/v1/tickets/' + ticketId + '/comments'),
    enabled: enabled && typeof ticketId === 'string' && ticketId.length > 0,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
}

export function usePostTicketComment(ticketId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTicketCommentPayload) =>
      apiFetch<TicketCommentDto>('/api/v1/tickets/' + ticketId + '/comments', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tickets', 'comments', ticketId] });
      void qc.invalidateQueries({ queryKey: ['tickets', 'one', ticketId] });
      void qc.invalidateQueries({ queryKey: ['tickets', 'activity', ticketId] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

// ── Activity ────────────────────────────────────────────────────

export function useTicketActivity(ticketId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['tickets', 'activity', ticketId],
    queryFn: () =>
      apiFetch<TicketActivityDto[]>('/api/v1/tickets/' + ticketId + '/activity'),
    enabled: enabled && typeof ticketId === 'string' && ticketId.length > 0,
    staleTime: 30_000,
  });
}

// ── Categories / Vendors / SLA ──────────────────────────────────

export function useTicketCategories(enabled = true, includeInactive = false) {
  return useQuery({
    queryKey: ['tickets', 'categories', { includeInactive }],
    queryFn: () =>
      apiFetch<TicketCategoryDto[]>(
        '/api/v1/ticket-categories' + (includeInactive ? '?includeInactive=true' : ''),
      ),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useTicketVendors(enabled = true, includeInactive = false) {
  return useQuery({
    queryKey: ['tickets', 'vendors', { includeInactive }],
    queryFn: () =>
      apiFetch<TicketVendorDto[]>(
        '/api/v1/ticket-vendors' + (includeInactive ? '?includeInactive=true' : ''),
      ),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useTicketSla(enabled = true) {
  return useQuery({
    queryKey: ['tickets', 'sla'],
    queryFn: () => apiFetch<TicketSlaPolicyDto[]>('/api/v1/ticket-sla'),
    enabled,
    staleTime: 5 * 60_000,
  });
}

// ── Admin mutations (Step 8) ────────────────────────────────────

export function useCreateTicketCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTicketCategoryPayload) =>
      apiFetch<TicketCategoryDto>('/api/v1/ticket-categories', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tickets', 'categories'] });
    },
  });
}

export function useUpdateTicketCategory(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateTicketCategoryPayload) =>
      apiFetch<TicketCategoryDto>('/api/v1/ticket-categories/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tickets', 'categories'] });
    },
  });
}

export function useCreateTicketSubcategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTicketSubcategoryPayload) =>
      apiFetch<TicketSubcategoryDto>('/api/v1/ticket-subcategories', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tickets', 'categories'] });
    },
  });
}

export function useUpdateTicketSubcategory(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateTicketSubcategoryPayload) =>
      apiFetch<TicketSubcategoryDto>('/api/v1/ticket-subcategories/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tickets', 'categories'] });
    },
  });
}

export function useCreateTicketVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTicketVendorPayload) =>
      apiFetch<TicketVendorDto>('/api/v1/ticket-vendors', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tickets', 'vendors'] });
    },
  });
}

export function useUpdateTicketVendor(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateTicketVendorPayload) =>
      apiFetch<TicketVendorDto>('/api/v1/ticket-vendors/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tickets', 'vendors'] });
    },
  });
}

export function useUpsertTicketSla() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpsertTicketSlaPayload) =>
      apiFetch<TicketSlaPolicyDto>('/api/v1/ticket-sla', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tickets', 'sla'] });
    },
  });
}

// ── Problem management (Step 9) ─────────────────────────────────

function buildProblemQs(args: ListProblemsArgs): string {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.categoryId) params.set('categoryId', args.categoryId);
  if (args.limit) params.set('limit', String(args.limit));
  const qs = params.toString();
  return qs ? '?' + qs : '';
}

export function useProblems(args: ListProblemsArgs = {}, enabled = true) {
  return useQuery({
    queryKey: [
      'problems',
      'list',
      {
        status: args.status ?? null,
        categoryId: args.categoryId ?? null,
        limit: args.limit ?? null,
      },
    ],
    queryFn: () => apiFetch<ProblemDto[]>('/api/v1/problems' + buildProblemQs(args)),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export function useProblem(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['problems', 'one', id],
    queryFn: () => apiFetch<ProblemDto>('/api/v1/problems/' + id),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

function invalidateProblem(qc: ReturnType<typeof useQueryClient>, id: string | null): void {
  void qc.invalidateQueries({ queryKey: ['problems'] });
  if (id) void qc.invalidateQueries({ queryKey: ['problems', 'one', id] });
}

export function useCreateProblem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateProblemPayload) =>
      apiFetch<ProblemDto>('/api/v1/problems', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => invalidateProblem(qc, data.id),
  });
}

export function useUpdateProblem(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateProblemPayload) =>
      apiFetch<ProblemDto>('/api/v1/problems/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateProblem(qc, id),
  });
}

export function useLinkProblemTickets(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: LinkProblemTicketsPayload) =>
      apiFetch<ProblemDto>('/api/v1/problems/' + id + '/link', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateProblem(qc, id),
  });
}

export function useResolveProblem(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ResolveProblemPayload) =>
      apiFetch<ResolveProblemResponse>('/api/v1/problems/' + id + '/resolve', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      // Resolve cascades to flipping linked tickets to RESOLVED via the
      // ProblemService.resolveBatch endpoint, plus per-ticket
      // tkt.ticket.resolved emits that flip linked auto-tasks DONE via
      // Step 6's TicketTaskCompletionConsumer. Refresh everything.
      invalidateProblem(qc, id);
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
