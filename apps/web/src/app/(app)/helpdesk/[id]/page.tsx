'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useCancelTicket,
  useCloseTicket,
  usePostTicketComment,
  useReopenTicket,
  useResolveTicket,
  useTicket,
  useTicketActivity,
  useTicketComments,
} from '@/hooks/use-tickets';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  ACTIVITY_TYPE_LABELS,
  SLA_URGENCY_DOT,
  SLA_URGENCY_LABEL,
  TICKET_PRIORITY_LABELS,
  TICKET_PRIORITY_PILL,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_PILL,
  formatSlaRemaining,
  slaUrgency,
} from '@/lib/tickets-format';
import type { TicketActivityDto, TicketCommentDto, TicketDto } from '@/lib/types';

export default function HelpdeskDetailPage() {
  const params = useParams<{ id: string }>();
  const ticketId = params?.id ?? '';
  const router = useRouter();
  const { toast } = useToast();
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['it-001:read']);
  const canWrite = !!user && hasAnyPermission(user, ['it-001:write']);
  const isAdmin = !!user && hasAnyPermission(user, ['sch-001:admin', 'it-001:admin']);

  const ticket = useTicket(ticketId, canRead);
  const comments = useTicketComments(ticketId, canRead);
  const activity = useTicketActivity(ticketId, canRead);

  const resolve = useResolveTicket(ticketId);
  const close = useCloseTicket(ticketId);
  const reopen = useReopenTicket(ticketId);
  const cancel = useCancelTicket(ticketId);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Ticket" />
        <EmptyState
          title="Access required"
          description="You need IT-001 read access to view tickets."
        />
      </div>
    );
  }

  if (ticket.isLoading) {
    return (
      <div className="mx-auto max-w-3xl py-8">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      </div>
    );
  }

  if (!ticket.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Ticket" />
        <EmptyState
          title="Ticket not found"
          description="It may have been removed or you don't have access to it."
          action={
            <Link
              href="/helpdesk"
              className="inline-flex items-center rounded-lg bg-campus-700 px-4 py-2 text-sm font-medium text-white hover:bg-campus-800"
            >
              Back to helpdesk
            </Link>
          }
        />
      </div>
    );
  }

  const t = ticket.data;
  const isRequester = t.requesterId === user.id;
  const isAssignee = !!t.assigneeId && t.assigneeName !== null; // best-effort — backend won't surface assignee_account on detail
  const urgency = slaUrgency(t.sla);
  const remaining = formatSlaRemaining(t.sla);

  async function onResolve(): Promise<void> {
    try {
      await resolve.mutateAsync({});
      toast('Ticket resolved', 'success');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not resolve';
      toast(msg, 'error');
    }
  }

  async function onClose(): Promise<void> {
    try {
      await close.mutateAsync();
      toast('Ticket closed', 'success');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not close';
      toast(msg, 'error');
    }
  }

  async function onReopen(): Promise<void> {
    try {
      await reopen.mutateAsync();
      toast('Ticket reopened', 'success');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not reopen';
      toast(msg, 'error');
    }
  }

  async function onCancel(): Promise<void> {
    if (!window.confirm('Cancel this ticket? This ends the request without resolution.')) return;
    try {
      await cancel.mutateAsync({});
      toast('Ticket cancelled', 'success');
      router.push('/helpdesk');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not cancel';
      toast(msg, 'error');
    }
  }

  const isWorking =
    t.status === 'OPEN' ||
    t.status === 'IN_PROGRESS' ||
    t.status === 'VENDOR_ASSIGNED' ||
    t.status === 'PENDING_REQUESTER';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={t.title}
        actions={
          <Link href="/helpdesk" className="text-sm text-campus-700 hover:underline">
            ← Back to helpdesk
          </Link>
        }
      />

      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 font-medium',
              TICKET_PRIORITY_PILL[t.priority],
            )}
          >
            {TICKET_PRIORITY_LABELS[t.priority]}
          </span>
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 font-medium',
              TICKET_STATUS_PILL[t.status],
            )}
          >
            {TICKET_STATUS_LABELS[t.status]}
          </span>
          <span
            className={cn('inline-flex items-center gap-1 rounded-full bg-gray-50 px-2 py-0.5 ring-1 ring-gray-200')}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', SLA_URGENCY_DOT[urgency])} />
            <span className="text-gray-600">{SLA_URGENCY_LABEL[urgency]}</span>
            {remaining && <span className="text-gray-500">· {remaining}</span>}
          </span>
        </div>

        {t.description && (
          <p className="mt-3 whitespace-pre-wrap text-sm text-gray-800">{t.description}</p>
        )}

        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-500">Category</dt>
            <dd className="text-gray-900">
              {t.categoryName}
              {t.subcategoryName ? ' / ' + t.subcategoryName : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-500">Requester</dt>
            <dd className="text-gray-900">{t.requesterName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-500">Assigned to</dt>
            <dd className="text-gray-900">
              {t.assigneeName ?? (t.vendorName ? 'Vendor: ' + t.vendorName : 'Unassigned')}
              {t.vendorReference ? ' (' + t.vendorReference + ')' : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-500">SLA target</dt>
            <dd className="text-gray-900">
              {t.sla.responseHours !== null && t.sla.resolutionHours !== null
                ? t.sla.responseHours + 'h response · ' + t.sla.resolutionHours + 'h resolution'
                : 'No policy linked'}
            </dd>
          </div>
        </dl>

        {(isRequester || isAdmin || isAssignee) && (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-gray-100 pt-4">
            {(isAssignee || isAdmin) && isWorking && (
              <button
                type="button"
                onClick={onResolve}
                disabled={resolve.isPending}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Mark resolved
              </button>
            )}
            {(isRequester || isAdmin) && t.status === 'RESOLVED' && (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={close.isPending}
                  className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
                >
                  Close ticket
                </button>
                <button
                  type="button"
                  onClick={onReopen}
                  disabled={reopen.isPending}
                  className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  Reopen
                </button>
              </>
            )}
            {(isRequester || isAdmin) && isWorking && (
              <button
                type="button"
                onClick={onCancel}
                disabled={cancel.isPending}
                className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-rose-700 ring-1 ring-rose-200 hover:bg-rose-50 disabled:opacity-50"
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </div>

      <CommentThread
        ticketId={ticketId}
        ticket={t}
        canPost={canWrite && (isRequester || isAssignee || isAdmin) && isWorking}
        canBeInternal={isAdmin || isAssignee}
        comments={comments.data ?? []}
        loading={comments.isLoading}
      />

      <ActivityTimeline activity={activity.data ?? []} loading={activity.isLoading} />
    </div>
  );
}

// ── Comment thread ─────────────────────────────────────────────

function CommentThread({
  ticketId,
  ticket,
  canPost,
  canBeInternal,
  comments,
  loading,
}: {
  ticketId: string;
  ticket: TicketDto;
  canPost: boolean;
  canBeInternal: boolean;
  comments: TicketCommentDto[];
  loading: boolean;
}) {
  const post = usePostTicketComment(ticketId);
  const { toast } = useToast();
  const [body, setBody] = useState('');
  const [isInternal, setIsInternal] = useState(false);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!body.trim()) return;
    try {
      await post.mutateAsync({ body: body.trim(), isInternal: isInternal && canBeInternal });
      setBody('');
      setIsInternal(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not post';
      toast(msg, 'error');
    }
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <h3 className="mb-3 text-sm font-semibold text-gray-900">
        Conversation {comments.length > 0 && <span className="text-gray-400">· {comments.length}</span>}
      </h3>

      {loading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading comments…
        </div>
      ) : comments.length === 0 ? (
        <p className="py-4 text-sm text-gray-500">No comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {comments.map((c) => (
            <li
              key={c.id}
              className={cn(
                'rounded-md p-3',
                c.isInternal ? 'bg-amber-50 ring-1 ring-amber-200' : 'bg-gray-50',
              )}
            >
              <div className="flex items-baseline gap-2 text-xs text-gray-500">
                <span className="font-medium text-gray-900">{c.authorName ?? 'Unknown'}</span>
                <span>·</span>
                <span>{new Date(c.createdAt).toLocaleString()}</span>
                {c.isInternal && (
                  <span className="ml-auto inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                    Internal
                  </span>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-gray-800">{c.body}</p>
            </li>
          ))}
        </ul>
      )}

      {canPost && (
        <form onSubmit={onSubmit} className="mt-4 border-t border-gray-100 pt-4">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={ticket.status === 'PENDING_REQUESTER' ? 'Reply to keep things moving…' : 'Add a comment…'}
            rows={3}
            maxLength={4000}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-campus-500 focus:ring-2 focus:ring-campus-200"
          />
          <div className="mt-2 flex items-center justify-between">
            {canBeInternal ? (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={isInternal}
                  onChange={(e) => setIsInternal(e.target.checked)}
                  className="rounded border-gray-300 text-campus-600 focus:ring-campus-300"
                />
                Internal note (hidden from requester)
              </label>
            ) : (
              <span className="text-xs text-gray-400">Visible to staff and the requester.</span>
            )}
            <button
              type="submit"
              disabled={!body.trim() || post.isPending}
              className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
            >
              {post.isPending ? 'Posting…' : 'Post comment'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

// ── Activity timeline ───────────────────────────────────────────

function ActivityTimeline({
  activity,
  loading,
}: {
  activity: TicketActivityDto[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h3 className="mb-3 text-sm font-semibold text-gray-900">Activity</h3>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      </section>
    );
  }
  if (activity.length === 0) return null;
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <h3 className="mb-3 text-sm font-semibold text-gray-900">Activity</h3>
      <ol className="space-y-2">
        {activity.map((a) => (
          <li key={a.id} className="flex items-start gap-3 text-sm">
            <span className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-gray-400" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-xs text-gray-500">
                <span className="font-medium text-gray-700">
                  {ACTIVITY_TYPE_LABELS[a.activityType]}
                </span>
                <span>·</span>
                <span>{new Date(a.createdAt).toLocaleString()}</span>
                {a.actorName && (
                  <>
                    <span>·</span>
                    <span>{a.actorName}</span>
                  </>
                )}
              </div>
              <ActivityMetadata metadata={a.metadata} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ActivityMetadata({ metadata }: { metadata: Record<string, unknown> }) {
  if (!metadata || Object.keys(metadata).length === 0) return null;
  if ('from' in metadata && 'to' in metadata) {
    return (
      <p className="text-sm text-gray-700">
        {String(metadata.from ?? 'unset')} → {String(metadata.to ?? 'unset')}
        {'reason' in metadata && metadata.reason ? ' · ' + String(metadata.reason) : ''}
      </p>
    );
  }
  if ('vendor_id' in metadata && 'vendor_reference' in metadata) {
    const ref = metadata.vendor_reference;
    return (
      <p className="text-sm text-gray-700">
        Assigned to vendor{ref ? ' · ' + String(ref) : ''}
      </p>
    );
  }
  if ('is_internal' in metadata) {
    return (
      <p className="text-sm text-gray-700">
        {metadata.is_internal ? 'Internal note' : 'Public comment'}
        {'first_response_bump' in metadata && metadata.first_response_bump
          ? ' · stopped the SLA response clock'
          : ''}
      </p>
    );
  }
  return null;
}
