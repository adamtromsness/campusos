'use client';

import { hasAnyPermission, type AuthUser } from '@/lib/auth-store';
import { useThreads } from './use-messaging';
import { useAnnouncements } from './use-announcements';

export interface AppBadges {
  messages: number;
  announcements: number;
}

/**
 * Computes per-App unread counters for the home launchpad and the sidebar.
 * The hooks are gated on the user's permissions so a STUDENT without
 * `com-001:read` doesn't 403 on `/threads`. Both inner queries already
 * poll, so badges refresh without any extra plumbing here.
 */
export function useAppBadges(user: AuthUser | null): AppBadges {
  const canMessages = !!user && hasAnyPermission(user, ['com-001:read']);
  const canAnnouncements = !!user && hasAnyPermission(user, ['com-002:read']);

  const threads = useThreads(false, canMessages);
  const announcements = useAnnouncements({}, canAnnouncements);

  const messages = (threads.data ?? []).reduce((sum, t) => sum + (t.unreadCount ?? 0), 0);
  const announcementsUnread = (announcements.data ?? []).filter(
    (a) => a.isPublished && !a.isRead,
  ).length;

  return { messages, announcements: announcementsUnread };
}
