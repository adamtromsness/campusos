'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';
import { MegaphoneIcon } from '@/components/shell/icons';
import { formatRelative } from '@/components/notifications/NotificationBell';
import { cn } from '@/components/ui/cn';
import {
  useAnnouncement,
  useAnnouncementStats,
  useMarkAnnouncementRead,
  useUpdateAnnouncement,
} from '@/hooks/use-announcements';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { ApiError } from '@/lib/api-client';
import type { AnnouncementDto } from '@/lib/types';

function audienceLabel(a: AnnouncementDto): string {
  switch (a.audienceType) {
    case 'ALL_SCHOOL':
      return 'All school';
    case 'CLASS':
      return 'Class';
    case 'YEAR_GROUP':
      return `Grade ${a.audienceRef ?? ''}`.trim();
    case 'ROLE':
      return a.audienceRef
        ? a.audienceRef
            .split('_')
            .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
            .join(' ')
        : 'Role';
    case 'CUSTOM':
      return 'Custom group';
    default:
      return a.audienceType;
  }
}

export default function AnnouncementDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const user = useAuthStore((s) => s.user);
  const { toast } = useToast();

  const announcement = useAnnouncement(id);
  const markRead = useMarkAnnouncementRead();
  const lastMarkedReadFor = useRef<string | null>(null);

  const isManager = !!user && hasAnyPermission(user, ['com-002:write']);
  const isAuthor = !!user && announcement.data?.authorId === user.id;
  const canSeeStats = isManager && (isAuthor || hasAnyPermission(user, ['sch-001:admin']));

  const stats = useAnnouncementStats(canSeeStats ? id : null);
  const update = useUpdateAnnouncement(id ?? '');

  // Mark read on first load when the announcement is published and unread.
  useEffect(() => {
    if (!id || !announcement.data) return;
    if (lastMarkedReadFor.current === id) return;
    if (announcement.data.isPublished && !announcement.data.isRead) {
      lastMarkedReadFor.current = id;
      markRead.mutate(id);
    } else {
      lastMarkedReadFor.current = id;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, announcement.data?.id, announcement.data?.isRead, announcement.data?.isPublished]);

  if (!user) return null;
  if (!id) return null;

  if (announcement.isError) {
    const status = (announcement.error as ApiError | undefined)?.status;
    return (
      <div className="mx-auto max-w-3xl">
        <div className="rounded-card border border-gray-200 bg-white px-5 py-12 text-center">
          <p className="text-sm font-semibold text-gray-900">
            {status === 404
              ? "This announcement isn't available."
              : 'Could not load the announcement.'}
          </p>
          <Link
            href="/announcements"
            className="mt-3 inline-block rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
          >
            Back to announcements
          </Link>
        </div>
      </div>
    );
  }

  if (announcement.isLoading || !announcement.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="flex h-32 items-center justify-center">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  const a = announcement.data;
  const expired = a.expiresAt ? Date.parse(a.expiresAt) < Date.now() : false;
  const canPublish = isManager && !a.isPublished;

  async function publishNow() {
    try {
      await update.mutateAsync({ isPublished: true });
      toast('Announcement published.', 'success');
    } catch (err) {
      const message = err instanceof ApiError && err.message ? err.message : 'Could not publish.';
      toast(message, 'error');
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between gap-4">
        <Link href="/announcements" className="text-sm text-campus-700 hover:underline">
          ← Announcements
        </Link>
        {canPublish && (
          <button
            type="button"
            onClick={publishNow}
            disabled={update.isPending}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {update.isPending ? 'Publishing…' : 'Publish now'}
          </button>
        )}
      </div>

      <article className="rounded-card border border-gray-200 bg-white px-6 py-6">
        <header className="mb-5">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                'mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                severityIconColor(a.alertTypeSeverity),
              )}
            >
              <MegaphoneIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-2xl text-gray-900">{a.title}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-campus-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-campus-700">
                  {audienceLabel(a)}
                </span>
                {a.alertTypeName && (
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                      severityPillColor(a.alertTypeSeverity),
                    )}
                  >
                    {a.alertTypeName.replace(/_/g, ' ').toLowerCase()}
                  </span>
                )}
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
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {a.authorName ? `From ${a.authorName} · ` : ''}
                {a.publishAt
                  ? `Published ${formatRelative(a.publishAt)}`
                  : `Created ${formatRelative(a.createdAt)}`}
                {a.expiresAt && (
                  <>
                    {' · '}
                    Expires {formatRelative(a.expiresAt)}
                  </>
                )}
              </p>
            </div>
          </div>
        </header>

        <div className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-800">
          {a.body}
        </div>
      </article>

      {canSeeStats && <StatsPanel announcement={a} stats={stats.data} loading={stats.isLoading} />}
    </div>
  );
}

function StatsPanel({
  announcement,
  stats,
  loading,
}: {
  announcement: AnnouncementDto;
  stats: ReturnType<typeof useAnnouncementStats>['data'];
  loading: boolean;
}) {
  if (!announcement.isPublished) {
    return (
      <div className="mt-6 rounded-card border border-dashed border-gray-200 bg-white px-5 py-4 text-sm text-gray-500">
        Stats appear here once the announcement is published.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="mt-6 flex h-24 items-center justify-center rounded-card border border-gray-200 bg-white">
        <LoadingSpinner />
      </div>
    );
  }
  if (!stats) return null;
  const pct = stats.totalAudience > 0 ? stats.readPercentage : 0;
  return (
    <section className="mt-6 rounded-card border border-gray-200 bg-white px-6 py-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Delivery & reach
      </h2>
      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Audience" value={stats.totalAudience.toString()} />
        <Metric label="Read" value={`${stats.readCount} (${pct}%)`} />
        <Metric label="Delivered" value={stats.deliveredCount.toString()} />
        <Metric label="Pending / failed" value={`${stats.pendingCount} / ${stats.failedCount}`} />
      </div>
      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
          <span>Read progress</span>
          <span>
            {stats.readCount}/{stats.totalAudience}
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div
            className="h-full rounded-full bg-campus-600 transition-all"
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-gray-900">{value}</p>
    </div>
  );
}

function severityIconColor(severity: string | null): string {
  if (severity === 'URGENT') return 'bg-rose-100 text-rose-700';
  if (severity === 'WARNING') return 'bg-amber-100 text-amber-700';
  return 'bg-campus-100 text-campus-700';
}

function severityPillColor(severity: string | null): string {
  if (severity === 'URGENT') return 'bg-rose-100 text-rose-700';
  if (severity === 'WARNING') return 'bg-amber-100 text-amber-700';
  return 'bg-sky-100 text-sky-700';
}
