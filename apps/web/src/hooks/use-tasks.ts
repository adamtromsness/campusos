'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  AcknowledgementDto,
  CreateTaskPayload,
  DisputeAcknowledgementPayload,
  ListTasksArgs,
  TaskDto,
  UpdateTaskPayload,
} from '@/lib/types';

function buildQs(args: ListTasksArgs): string {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.taskCategory) params.set('taskCategory', args.taskCategory);
  if (args.priority) params.set('priority', args.priority);
  if (args.dueAfter) params.set('dueAfter', args.dueAfter);
  if (args.dueBefore) params.set('dueBefore', args.dueBefore);
  if (args.includeCompleted) params.set('includeCompleted', 'true');
  if (args.limit) params.set('limit', String(args.limit));
  const qs = params.toString();
  return qs ? '?' + qs : '';
}

export function useTasks(args: ListTasksArgs = {}, enabled = true) {
  return useQuery({
    queryKey: [
      'tasks',
      'list',
      {
        status: args.status ?? null,
        taskCategory: args.taskCategory ?? null,
        priority: args.priority ?? null,
        dueAfter: args.dueAfter ?? null,
        dueBefore: args.dueBefore ?? null,
        includeCompleted: !!args.includeCompleted,
        limit: args.limit ?? null,
      },
    ],
    queryFn: () => apiFetch<TaskDto[]>('/api/v1/tasks' + buildQs(args)),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export function useAssignedTasks(enabled = true) {
  return useQuery({
    queryKey: ['tasks', 'assigned'],
    queryFn: () => apiFetch<TaskDto[]>('/api/v1/tasks/assigned'),
    enabled,
  });
}

export function useTask(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['tasks', 'one', id],
    queryFn: () => apiFetch<TaskDto>('/api/v1/tasks/' + id),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTaskPayload) =>
      apiFetch<TaskDto>('/api/v1/tasks', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useUpdateTask(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateTaskPayload) =>
      apiFetch<TaskDto>('/api/v1/tasks/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useAcknowledgements(enabled = true, all = false) {
  return useQuery({
    queryKey: ['acknowledgements', { all }],
    queryFn: () => apiFetch<AcknowledgementDto[]>('/api/v1/acknowledgements' + (all ? '?all=true' : '')),
    enabled,
  });
}

export function useAcknowledgement(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['acknowledgements', 'one', id],
    queryFn: () => apiFetch<AcknowledgementDto>('/api/v1/acknowledgements/' + id),
    enabled: enabled && typeof id === 'string' && id.length > 0,
  });
}

export function useAcknowledge(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<AcknowledgementDto>('/api/v1/acknowledgements/' + id + '/acknowledge', {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['acknowledgements'] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useDispute(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: DisputeAcknowledgementPayload) =>
      apiFetch<AcknowledgementDto>('/api/v1/acknowledgements/' + id + '/dispute', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['acknowledgements'] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}
