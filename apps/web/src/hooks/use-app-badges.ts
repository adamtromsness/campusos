'use client';

import { hasAnyPermission, type AuthUser } from '@/lib/auth-store';
import { useThreads } from './use-messaging';
import { useAnnouncements } from './use-announcements';
import { useTasks } from './use-tasks';
import { isTaskBadgeWorthy } from '@/lib/tasks-format';

export interface AppBadges {
  messages: number;
  announcements: number;
  tasks: number;
}

/**
 * Computes per-App unread counters for the home launchpad and the sidebar.
 * The hooks are gated on the user's permissions so a STUDENT without
 * `com-001:read` doesn't 403 on `/threads`. The inner queries already
 * poll (or refetch on focus), so badges refresh without extra plumbing.
 *
 * The Tasks badge counts TODO + IN_PROGRESS rows with `due_at <= today`
 * (overdue or due today). Filters happen client-side on the cached
 * task list — the to-do surface is small and one query covers both
 * the badge and the page.
 */
export function useAppBadges(user: AuthUser | null): AppBadges {
  const canMessages = !!user && hasAnyPermission(user, ['com-001:read']);
  const canAnnouncements = !!user && hasAnyPermission(user, ['com-002:read']);
  const canTasks = !!user && hasAnyPermission(user, ['ops-001:read']);

  const threads = useThreads(false, canMessages);
  const announcements = useAnnouncements({}, canAnnouncements);
  const tasks = useTasks({}, canTasks);

  const messages = (threads.data ?? []).reduce((sum, t) => sum + (t.unreadCount ?? 0), 0);
  const announcementsUnread = (announcements.data ?? []).filter(
    (a) => a.isPublished && !a.isRead,
  ).length;
  const tasksDueToday = (tasks.data ?? []).filter((t) =>
    isTaskBadgeWorthy(t.status, t.dueAt),
  ).length;

  return { messages, announcements: announcementsUnread, tasks: tasksDueToday };
}
