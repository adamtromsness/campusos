'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { useTasks, useUpdateTask } from '@/hooks/use-tasks';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  TASK_CATEGORIES,
  TASK_CATEGORY_ACCENT,
  TASK_CATEGORY_LABELS,
  TASK_PRIORITY_LABELS,
  TASK_PRIORITY_PILL,
  TASK_STATUS_LABELS,
  TASK_STATUS_PILL,
  formatRelativeDue,
  isTaskOverdue,
} from '@/lib/tasks-format';
import type { TaskCategory, TaskDto, TaskStatus } from '@/lib/types';

const FILTER_CHIPS: Array<{ value: 'OPEN' | 'ALL' | 'DONE'; label: string }> = [
  { value: 'OPEN', label: 'Open' },
  { value: 'ALL', label: 'All' },
  { value: 'DONE', label: 'Done' },
];

export default function TasksPage() {
  const user = useAuthStore((s) => s.user);
  const canTasks = !!user && hasAnyPermission(user, ['ops-001:read']);
  const [filter, setFilter] = useState<'OPEN' | 'ALL' | 'DONE'>('OPEN');
  const [collapsed, setCollapsed] = useState<Record<TaskCategory, boolean>>({
    ACADEMIC: false,
    PERSONAL: false,
    ADMINISTRATIVE: false,
    ACKNOWLEDGEMENT: false,
  });

  const includeCompleted = filter !== 'OPEN';
  const tasks = useTasks(
    {
      includeCompleted,
      ...(filter === 'DONE' ? { status: 'DONE' as TaskStatus } : {}),
    },
    canTasks,
  );

  const grouped = useMemo(() => {
    const out: Record<TaskCategory, TaskDto[]> = {
      ACADEMIC: [],
      PERSONAL: [],
      ADMINISTRATIVE: [],
      ACKNOWLEDGEMENT: [],
    };
    for (const t of tasks.data ?? []) out[t.taskCategory].push(t);
    return out;
  }, [tasks.data]);

  if (!user) return null;
  if (!canTasks) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Tasks" />
        <EmptyState
          title="Access required"
          description="You need OPS-001 read access to view tasks."
        />
      </div>
    );
  }

  const list = tasks.data ?? [];
  const totalOpen = list.filter((t) => t.status === 'TODO' || t.status === 'IN_PROGRESS').length;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Tasks"
        description={
          totalOpen === 0
            ? 'You’re all caught up.'
            : totalOpen === 1
              ? '1 open task'
              : totalOpen + ' open tasks'
        }
        actions={
          <Link
            href="/tasks/new"
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
          >
            Add task
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {FILTER_CHIPS.map((chip) => (
          <button
            key={chip.value}
            type="button"
            onClick={() => setFilter(chip.value)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              filter === chip.value
                ? 'border-campus-700 bg-campus-700 text-white'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50',
            )}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {tasks.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title={filter === 'DONE' ? 'No completed tasks yet' : 'Nothing on your list'}
          description={
            filter === 'OPEN'
              ? 'Tasks created for you by teachers, the office, or auto-generated from assignments will appear here.'
              : 'Switch filters or add a manual task.'
          }
        />
      ) : (
        <div className="space-y-4">
          {TASK_CATEGORIES.map((cat) => {
            const items = grouped[cat];
            if (items.length === 0) return null;
            return (
              <CategorySection
                key={cat}
                category={cat}
                tasks={items}
                collapsed={collapsed[cat]}
                onToggle={() => setCollapsed((prev) => ({ ...prev, [cat]: !prev[cat] }))}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function CategorySection({
  category,
  tasks,
  collapsed,
  onToggle,
}: {
  category: TaskCategory;
  tasks: TaskDto[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  // Overdue first, then ascending due_at, then by created_at desc.
  const sorted = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        const aOverdue = isTaskOverdue(a.dueAt, a.status);
        const bOverdue = isTaskOverdue(b.dueAt, b.status);
        if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
        if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
        if (a.dueAt) return -1;
        if (b.dueAt) return 1;
        return b.createdAt.localeCompare(a.createdAt);
      }),
    [tasks],
  );
  return (
    <section
      className={cn(
        'overflow-hidden rounded-card border-l-4 border border-gray-200 bg-white shadow-card',
        TASK_CATEGORY_ACCENT[category],
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-5 py-3 text-left"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
          {TASK_CATEGORY_LABELS[category]}{' '}
          <span className="ml-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-600">
            {tasks.length}
          </span>
        </h2>
        <span className="text-xs text-gray-400">{collapsed ? 'Show' : 'Hide'}</span>
      </button>
      {!collapsed && (
        <ul className="divide-y divide-gray-100">
          {sorted.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskRow({ task }: { task: TaskDto }) {
  const overdue = isTaskOverdue(task.dueAt, task.status);
  const dueLabel = formatRelativeDue(task.dueAt);
  const update = useUpdateTask(task.id);

  function quickComplete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (task.status === 'DONE' || task.status === 'CANCELLED') return;
    void update.mutateAsync({ status: 'DONE' });
  }

  return (
    <li>
      <Link
        href={'/tasks/' + task.id}
        className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-gray-50"
      >
        <button
          type="button"
          onClick={quickComplete}
          aria-label="Mark done"
          disabled={task.status === 'DONE' || task.status === 'CANCELLED' || update.isPending}
          className={cn(
            'mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border transition-colors',
            task.status === 'DONE'
              ? 'border-emerald-500 bg-emerald-500 text-white'
              : 'border-gray-300 bg-white text-transparent hover:border-emerald-500 hover:text-emerald-500',
          )}
        >
          {task.status === 'DONE' ? '✓' : ''}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <h3
              className={cn(
                'truncate text-sm font-medium',
                task.status === 'DONE'
                  ? 'text-gray-400 line-through'
                  : task.status === 'CANCELLED'
                    ? 'text-gray-400 line-through'
                    : 'text-gray-900',
              )}
            >
              {task.title}
            </h3>
            <span
              className={cn(
                'inline-flex flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                TASK_PRIORITY_PILL[task.priority],
              )}
            >
              {TASK_PRIORITY_LABELS[task.priority]}
            </span>
          </div>
          {task.description && (
            <p className="line-clamp-1 text-xs text-gray-500">{task.description}</p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
            {dueLabel && (
              <span className={cn(overdue && 'font-medium text-rose-600')}>{dueLabel}</span>
            )}
            {task.source !== 'MANUAL' && (
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                Auto
              </span>
            )}
            <span
              className={cn(
                'inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium',
                TASK_STATUS_PILL[task.status],
              )}
            >
              {TASK_STATUS_LABELS[task.status]}
            </span>
          </div>
        </div>
      </Link>
    </li>
  );
}
