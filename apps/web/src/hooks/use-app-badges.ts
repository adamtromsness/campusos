'use client';

import { hasAnyPermission, type AuthUser } from '@/lib/auth-store';
import { useThreads } from './use-messaging';
import { useAnnouncements } from './use-announcements';
import { useTasks } from './use-tasks';
import { useApprovals } from './use-approvals';
import { useTickets } from './use-tickets';
import { isTaskBadgeWorthy } from '@/lib/tasks-format';
import { isTicketLive } from '@/lib/tickets-format';

export interface AppBadges {
  messages: number;
  announcements: number;
  tasks: number;
  approvals: number;
  helpdesk: number;
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
 *
 * The Helpdesk badge counts tickets in non-terminal states where the
 * caller is the requester or the assignee — the same row-scope the
 * `/helpdesk` page applies. Server-side row scope at TicketService.list
 * already restricts non-admins to their own tickets, so the count
 * matches the page's "live" filter.
 */
export function useAppBadges(user: AuthUser | null): AppBadges {
  const canMessages = !!user && hasAnyPermission(user, ['com-001:read']);
  const canAnnouncements = !!user && hasAnyPermission(user, ['com-002:read']);
  const canTasks = !!user && hasAnyPermission(user, ['ops-001:read']);
  const canApprovals = !!user && hasAnyPermission(user, ['ops-001:read']);
  const canHelpdesk = !!user && hasAnyPermission(user, ['it-001:read']);

  const threads = useThreads(false, canMessages);
  const announcements = useAnnouncements({}, canAnnouncements);
  const tasks = useTasks({}, canTasks);
  // Pull every approval the caller can see (own + as-approver). The
  // backend list is row-scoped — non-admins only get rows where they're
  // requester or approver. Filter client-side to AWAITING steps where
  // they're the assigned approver, since we want the approver-pending
  // count and not their own in-flight submissions.
  const approvals = useApprovals({ status: 'PENDING' }, canApprovals);
  const tickets = useTickets({ includeTerminal: false, limit: 200 }, canHelpdesk);

  const messages = (threads.data ?? []).reduce((sum, t) => sum + (t.unreadCount ?? 0), 0);
  const announcementsUnread = (announcements.data ?? []).filter(
    (a) => a.isPublished && !a.isRead,
  ).length;
  const tasksDueToday = (tasks.data ?? []).filter((t) =>
    isTaskBadgeWorthy(t.status, t.dueAt),
  ).length;
  const myAccountId = user?.id ?? '';
  const approvalsAwaiting = (approvals.data ?? []).reduce((sum, r) => {
    return (
      sum + r.steps.filter((s) => s.status === 'AWAITING' && s.approverId === myAccountId).length
    );
  }, 0);
  const helpdeskLive = (tickets.data ?? []).filter((t) => isTicketLive(t.status)).length;

  return {
    messages,
    announcements: announcementsUnread,
    tasks: tasksDueToday,
    approvals: approvalsAwaiting,
    helpdesk: helpdeskLive,
  };
}
