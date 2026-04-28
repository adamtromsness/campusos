'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { ChatBubbleIcon } from '@/components/shell/icons';
import { formatRelative } from '@/components/notifications/NotificationBell';
import { cn } from '@/components/ui/cn';
import { useThreads } from '@/hooks/use-messaging';
import { useAuthStore } from '@/lib/auth-store';
import type { ThreadDto } from '@/lib/types';

export default function MessagesInboxPage() {
  const user = useAuthStore((s) => s.user);
  const [includeArchived, setIncludeArchived] = useState(false);
  const threads = useThreads(includeArchived);

  if (!user) return null;

  const items = threads.data ?? [];
  const totalUnread = items.reduce((sum, t) => sum + (t.unreadCount || 0), 0);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Messages"
        description={
          totalUnread > 0
            ? `${totalUnread} unread ${totalUnread === 1 ? 'message' : 'messages'} across your conversations.`
            : 'Direct conversations with teachers, parents, students, and staff.'
        }
        actions={
          <Link
            href="/messages/new"
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
          >
            New message
          </Link>
        }
      />

      <div className="mb-4 flex items-center justify-end">
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-gray-600">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-campus-600 focus:ring-campus-500"
          />
          Show archived
        </label>
      </div>

      {threads.isLoading && (
        <div className="flex h-32 items-center justify-center">
          <LoadingSpinner />
        </div>
      )}

      {!threads.isLoading && items.length === 0 && (
        <EmptyState
          icon={<ChatBubbleIcon className="h-10 w-10" />}
          title="No conversations yet"
          description="Start a new message with a teacher, parent, or staff member."
          action={
            <Link
              href="/messages/new"
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
            >
              New message
            </Link>
          }
        />
      )}

      {!threads.isLoading && items.length > 0 && (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white">
          <ul className="divide-y divide-gray-100">
            {items.map((thread) => (
              <li key={thread.id}>
                <ThreadRow thread={thread} currentAccountId={user.id} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface ThreadRowProps {
  thread: ThreadDto;
  currentAccountId: string;
}

function ThreadRow({ thread, currentAccountId }: ThreadRowProps) {
  const others = thread.participants.filter(
    (p) => p.platformUserId !== currentAccountId && !p.leftAt,
  );
  const headline = others.length > 0
    ? others.map((p) => p.displayName || p.email || 'Unknown').join(', ')
    : 'Just you';
  const unread = thread.unreadCount || 0;
  const subject = thread.subject || labelForType(thread.threadTypeName);
  const preview = thread.lastMessagePreview || 'No messages yet';
  const previewSender = thread.lastSenderName ? `${thread.lastSenderName}: ` : '';

  return (
    <Link
      href={`/messages/${thread.id}`}
      className={cn(
        'flex items-start gap-4 px-5 py-4 transition-colors hover:bg-gray-50',
        unread > 0 && 'bg-campus-50/40',
        thread.isArchived && 'opacity-60',
      )}
    >
      <Avatar name={others[0]?.displayName || others[0]?.email || '?'} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className={cn('truncate text-sm font-semibold text-gray-900', unread > 0 && 'text-gray-950')}>
            {headline}
          </p>
          <span className="shrink-0 text-xs text-gray-400">
            {thread.lastMessageAt ? formatRelative(thread.lastMessageAt) : ''}
          </span>
        </div>
        <p className="mt-0.5 truncate text-sm text-gray-700">
          <span className="font-medium">{subject}</span>
          {thread.threadTypeName && (
            <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">
              {labelForType(thread.threadTypeName)}
            </span>
          )}
        </p>
        <div className="mt-1 flex items-center gap-2">
          <p className="line-clamp-1 flex-1 text-xs text-gray-500">
            {previewSender}
            {preview}
          </p>
          {unread > 0 && (
            <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-campus-600 px-1.5 text-[11px] font-semibold text-white">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
          {thread.isArchived && (
            <span className="text-[10px] uppercase tracking-wide text-gray-400">Archived</span>
          )}
        </div>
      </div>
    </Link>
  );
}

function labelForType(name: string): string {
  switch (name) {
    case 'TEACHER_PARENT':
      return 'Teacher ↔ Parent';
    case 'CLASS_DISCUSSION':
      return 'Class discussion';
    case 'ADMIN_STAFF':
      return 'Staff';
    case 'SYSTEM_NOTIFICATION':
      return 'System';
    default:
      return name.replace(/_/g, ' ').toLowerCase();
  }
}
