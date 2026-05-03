'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useCreateTask } from '@/hooks/use-tasks';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  TASK_CATEGORIES,
  TASK_CATEGORY_LABELS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
} from '@/lib/tasks-format';
import type { CreateTaskPayload, TaskCategory, TaskPriority } from '@/lib/types';

export default function NewTaskPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['ops-001:admin', 'sch-001:admin']);
  const create = useCreateTask();
  const { toast } = useToast();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('NORMAL');
  // ACKNOWLEDGEMENT category is created by the worker, not via /tasks
  // (the API rejects it for non-admins). Hide from the picker for
  // everyone — admins backfilling an ack-task can do it via SQL.
  const [taskCategory, setTaskCategory] = useState<TaskCategory>('PERSONAL');
  const [dueAt, setDueAt] = useState('');
  const [assigneeAccountId, setAssigneeAccountId] = useState('');

  const canSubmit = title.trim().length > 0 && !create.isPending;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const payload: CreateTaskPayload = {
      title: title.trim(),
      priority,
      taskCategory,
    };
    if (description.trim()) payload.description = description.trim();
    if (dueAt) payload.dueAt = new Date(dueAt).toISOString();
    if (assigneeAccountId.trim() && isAdmin) {
      payload.assigneeAccountId = assigneeAccountId.trim();
    }
    try {
      await create.mutateAsync(payload);
      toast('Task created', 'success');
      router.push('/tasks');
    } catch (e: any) {
      toast(e?.message || 'Could not create task', 'error');
    }
  }

  if (!user) return null;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New task" description="Manual tasks land on your own list. Admins can delegate." />

      <form onSubmit={submit} className="space-y-4 rounded-card border border-gray-200 bg-white p-6 shadow-card">
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            required
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            placeholder="What needs doing?"
          />
        </label>

        <label className="block text-sm">
          <span className="font-medium text-gray-700">Description (optional)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={2000}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Category</span>
            <select
              value={taskCategory}
              onChange={(e) => setTaskCategory(e.target.value as TaskCategory)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            >
              {TASK_CATEGORIES.filter((c) => c !== 'ACKNOWLEDGEMENT').map((c) => (
                <option key={c} value={c}>
                  {TASK_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            <span className="font-medium text-gray-700">Priority</span>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            >
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {TASK_PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block text-sm">
          <span className="font-medium text-gray-700">Due (optional)</span>
          <input
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </label>

        {isAdmin && (
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Assign to (admin only — UUID)</span>
            <input
              value={assigneeAccountId}
              onChange={(e) => setAssigneeAccountId(e.target.value)}
              placeholder="Leave blank to keep on your own list"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
            <span className="mt-1 block text-xs text-gray-500">
              When set, the task lives on the recipient&rsquo;s list with you as the creator. Future
              cycles will replace this with a directory picker.
            </span>
          </label>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => router.push('/tasks')}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
          >
            Create task
          </button>
        </div>
      </form>
    </div>
  );
}
