'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { MegaphoneIcon } from '@/components/shell/icons';
import { formatRelative } from '@/components/notifications/NotificationBell';
import { cn } from '@/components/ui/cn';
import { useAnnouncements } from '@/hooks/use-announcements';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import type { AnnouncementDto } from '@/lib/types';

type FilterKey = 'all' | 'unread' | 'drafts' | 'expired';

export default function AnnouncementsPage() {
  const user = useAuthStore((s) => s.user);
  const [filterKey, setFilterKey] = useState<FilterKey>('all');

  const canManage = !!user && hasAnyPermission(user, ['com-002:write']);
  const wantsDrafts = canManage && filterKey === 'drafts';
  const wantsExpired = canManage && filterKey === 'expired';

  const announcements = useAnnouncements({
    includeDrafts: wantsDrafts,
    includeExpired: wantsExpired,
  });

  const items = useMemo(() => {
    const list = announcements.data ?? [];
    if (filterKey === 'unread') return list.filter((a) => !a.isRead && a.isPublished);
    if (filterKey === 'drafts') return list.filter((a) => !a.isPublished);
    if (filterKey === 'expired') {
      const now = Date.now();
      return list.filter(
        (a) => a.expiresAt && Date.parse(a.expiresAt) < now,
      );
    }
    return list;
  }, [announcements.data, filterKey]);

  if (!user) return null;

  const unreadCount = (announcements.data ?? []).filter(
    (a) => !a.isRead && a.isPublished,
  ).length;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Announcements"
        description={
          unreadCount > 0
            ? `${unreadCount} unread ${unreadCount === 1 ? 'announcement' : 'announcements'}.`
            : 'School-wide and class announcements you have access to.'
        }
        actions={
          canManage ? (
            <Link
              href="/announcements/new"
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
            >
              New announcement
            </Link>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <FilterChip active={filterKey === 'all'} onClick={() => setFilterKey('all')}>
          All
        </FilterChip>
        <FilterChip active={filterKey === 'unread'} onClick={() => setFilterKey('unread')}>
          Unread
        </FilterChip>
        {canManage && (
          <FilterChip active={filterKey === 'drafts'} onClick={() => setFilterKey('drafts')}>
            Drafts
          </FilterChip>
        )}
        {canManage && (
          <FilterChip active={filterKey === 'expired'} onClick={() => setFilterKey('expired')}>
            Expired
          </FilterChip>
        )}
      </div>

      {announcements.isLoading && (
        <div className="flex h-32 items-center justify-center">
          <LoadingSpinner />
        </div>
      )}

      {!announcements.isLoading && items.length === 0 && (
        <EmptyState
          icon={<MegaphoneIcon className="h-10 w-10" />}
          title={
            filterKey === 'drafts'
              ? 'No drafts'
              : filterKey === 'unread'
                ? 'You\'re caught up'
                : filterKey === 'expired'
                  ? 'No expired announcements'
                  : 'No announcements yet'
          }
          description={
            filterKey === 'drafts'
              ? 'Drafts you create will appear here until you publish them.'
              : 'Important school news and updates will show up here.'
          }
        />
      )}

      {!announcements.isLoading && items.length > 0 && (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white">
          <ul className="divide-y divide-gray-100">
            {items.map((a) => (
              <li key={a.id}>
                <AnnouncementRow announcement={a} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
        active ? 'bg-campus-700 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200',
      )}
    >
      {children}
    </button>
  );
}

function AnnouncementRow({ announcement }: { announcement: AnnouncementDto }) {
  const a = announcement;
  const expired = a.expiresAt ? Date.parse(a.expiresAt) < Date.now() : false;
  const unread = !a.isRead && a.isPublished;
  return (
    <Link
      href={`/announcements/${a.id}`}
      className={cn(
        'flex items-start gap-4 px-5 py-4 transition-colors hover:bg-gray-50',
        unread && 'bg-campus-50/40',
        (expired || !a.isPublished) && 'opacity-60',
      )}
    >
      <span
        className={cn(
          'mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
          severityIconColor(a.alertTypeSeverity),
        )}
      >
        <MegaphoneIcon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="truncate text-sm font-semibold text-gray-900">{a.title}</p>
          <span className="shrink-0 text-xs text-gray-400">
            {formatRelative(a.publishAt || a.createdAt)}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          <AudiencePill announcement={a} />
          {a.alertTypeName && <SeverityPill severity={a.alertTypeSeverity} label={a.alertTypeName} />}
          {!a.isPublished && (
            <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-700">
              Draft
            </span>
          )}
          {expired && (
            <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-700">
              Expired
            </span>
          )}
          {unread && <span className="h-2 w-2 rounded-full bg-campus-500" />}
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-gray-600">{a.body}</p>
        {a.authorName && (
          <p className="mt-1 text-xs text-gray-400">From {a.authorName}</p>
        )}
      </div>
    </Link>
  );
}

function AudiencePill({ announcement }: { announcement: AnnouncementDto }) {
  const label = audienceLabel(announcement);
  return (
    <span className="rounded-full bg-campus-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-campus-700">
      {label}
    </span>
  );
}

function SeverityPill({
  severity,
  label,
}: {
  severity: string | null;
  label: string;
}) {
  const cls =
    severity === 'URGENT'
      ? 'bg-rose-100 text-rose-700'
      : severity === 'WARNING'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-sky-100 text-sky-700';
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        cls,
      )}
    >
      {label.replace(/_/g, ' ').toLowerCase()}
    </span>
  );
}

function audienceLabel(a: AnnouncementDto): string {
  switch (a.audienceType) {
    case 'ALL_SCHOOL':
      return 'All school';
    case 'CLASS':
      return 'Class';
    case 'YEAR_GROUP':
      return `Grade ${a.audienceRef ?? ''}`.trim();
    case 'ROLE':
      return a.audienceRef ? prettyRole(a.audienceRef) : 'Role';
    case 'CUSTOM':
      return 'Custom group';
    default:
      return a.audienceType;
  }
}

function prettyRole(token: string): string {
  return token
    .split('_')
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

function severityIconColor(severity: string | null): string {
  if (severity === 'URGENT') return 'bg-rose-100 text-rose-700';
  if (severity === 'WARNING') return 'bg-amber-100 text-amber-700';
  return 'bg-campus-100 text-campus-700';
}
