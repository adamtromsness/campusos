'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import {
  describeNotification,
  formatRelative,
  resolveDeepLink,
} from '@/components/notifications/NotificationBell';
import {
  BellIcon,
  AttendanceIcon,
  ChatBubbleIcon,
  CheckCircleIcon,
  GradeIcon,
  MegaphoneIcon,
} from '@/components/shell/icons';
import { useMarkAllNotificationsRead, useNotificationHistory } from '@/hooks/use-notifications';
import { useAuthStore } from '@/lib/auth-store';
import type { NotificationItem } from '@/lib/types';
import { cn } from '@/components/ui/cn';

const TYPE_FILTERS: Array<{ key: string; label: string; matches: (type: string) => boolean }> = [
  { key: 'all', label: 'All', matches: () => true },
  {
    key: 'attendance',
    label: 'Attendance',
    matches: (t) => t.startsWith('attendance.') || t.startsWith('absence.'),
  },
  { key: 'grades', label: 'Grades', matches: (t) => t.startsWith('grade.') },
  {
    key: 'progress',
    label: 'Progress notes',
    matches: (t) => t.startsWith('progress_note.'),
  },
  { key: 'messages', label: 'Messages', matches: (t) => t === 'message.posted' },
  {
    key: 'announcements',
    label: 'Announcements',
    matches: (t) => t === 'announcement.published',
  },
];

export default function NotificationsPage() {
  const user = useAuthStore((s) => s.user);
  const [filterKey, setFilterKey] = useState<string>('all');

  // Server-side type filter only narrows on a single notification_type
  // string; for grouped filters (Attendance covers tardy/absent + absence
  // requests) we filter client-side instead. Keeping the page request
  // unfiltered also lets the "All" tab hit the same React Query cache
  // entry as the other tabs do for filtered subsets.
  const historyQuery = useNotificationHistory({ limit: 50 });
  const markAllRead = useMarkAllNotificationsRead();

  const filtered = useMemo(() => {
    const filter = TYPE_FILTERS.find((f) => f.key === filterKey) ?? TYPE_FILTERS[0]!;
    return (historyQuery.data?.items ?? []).filter((it) => filter.matches(it.type));
  }, [filterKey, historyQuery.data]);

  if (!user) return null;

  const totalShown = filtered.length;
  const unreadShown = filtered.filter((it) => !it.isRead).length;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Notifications"
        description="Everything CampusOS has flagged for you across attendance, grades, messages, and announcements."
        actions={
          <button
            type="button"
            onClick={() => markAllRead.mutate()}
            disabled={unreadShown === 0 || markAllRead.isPending}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400"
          >
            Mark all read
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {TYPE_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilterKey(f.key)}
            className={cn(
              'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
              filterKey === f.key
                ? 'bg-campus-700 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {historyQuery.isLoading && (
        <div className="flex h-32 items-center justify-center">
          <LoadingSpinner />
        </div>
      )}

      {!historyQuery.isLoading && totalShown === 0 && (
        <EmptyState
          icon={<BellIcon className="h-10 w-10" />}
          title="No notifications"
          description="When teachers post grades, mark attendance, or send you messages, they'll show up here."
        />
      )}

      {!historyQuery.isLoading && totalShown > 0 && (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white">
          <ul className="divide-y divide-gray-100">
            {filtered.map((item, idx) => (
              <li key={item.id ?? `idx-${idx}`}>
                <NotificationListRow item={item} user={user} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface NotificationListRowProps {
  item: NotificationItem;
  user: ReturnType<typeof useAuthStore.getState>['user'];
}

function NotificationListRow({ item, user }: NotificationListRowProps) {
  const link = user ? resolveDeepLink(item, user) : null;
  const { title, subtitle } = describeNotification(item);
  const Icon = iconFor(item.type);
  const cls = cn(
    'flex items-start gap-4 px-5 py-4 transition-colors',
    'hover:bg-gray-50',
    !item.isRead && 'bg-campus-50/40',
  );
  const body = (
    <>
      <span
        className={cn(
          'mt-1 flex h-9 w-9 items-center justify-center rounded-full',
          colorFor(item.type),
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold text-gray-900">{title}</p>
          {!item.isRead && <span className="h-2 w-2 shrink-0 rounded-full bg-campus-500" />}
        </div>
        {subtitle && <p className="mt-0.5 line-clamp-2 text-sm text-gray-600">{subtitle}</p>}
        <p className="mt-1 text-xs text-gray-400">{formatRelative(item.occurredAt)}</p>
      </div>
    </>
  );
  if (link)
    return (
      <Link href={link} className={cls}>
        {body}
      </Link>
    );
  return <div className={cls}>{body}</div>;
}

function iconFor(type: string): (props: { className?: string }) => JSX.Element {
  if (type.startsWith('attendance.')) return AttendanceIcon;
  if (type.startsWith('grade.')) return GradeIcon;
  if (type.startsWith('progress_note.')) return CheckCircleIcon;
  if (type.startsWith('absence.')) return CheckCircleIcon;
  if (type === 'message.posted') return ChatBubbleIcon;
  if (type === 'announcement.published') return MegaphoneIcon;
  return BellIcon;
}

function colorFor(type: string): string {
  if (type.startsWith('attendance.')) return 'bg-amber-100 text-amber-700';
  if (type.startsWith('grade.')) return 'bg-emerald-100 text-emerald-700';
  if (type.startsWith('progress_note.')) return 'bg-sky-100 text-sky-700';
  if (type.startsWith('absence.')) return 'bg-orange-100 text-orange-700';
  if (type === 'message.posted') return 'bg-violet-100 text-violet-700';
  if (type === 'announcement.published') return 'bg-rose-100 text-rose-700';
  return 'bg-gray-100 text-gray-600';
}
