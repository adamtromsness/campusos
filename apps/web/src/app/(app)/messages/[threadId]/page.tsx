'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { formatRelative } from '@/components/notifications/NotificationBell';
import {
  useArchiveThread,
  useMarkThreadRead,
  usePostMessage,
  useThread,
  useThreadMessages,
} from '@/hooks/use-messaging';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { ApiError } from '@/lib/api-client';
import type { MessageDto, ThreadDto } from '@/lib/types';

export default function ThreadPage() {
  const params = useParams<{ threadId: string }>();
  const threadId = params?.threadId;
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const { toast } = useToast();

  const thread = useThread(threadId);
  const messages = useThreadMessages(threadId);
  const markRead = useMarkThreadRead();
  const postMessage = usePostMessage(threadId ?? '');
  const archiveThread = useArchiveThread();

  const [body, setBody] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const lastMarkedReadFor = useRef<string | null>(null);

  // Newest-first from the API; flip for display. Computed before any early
  // returns so the hook order stays stable across loading / error states.
  const ordered = useMemo(() => {
    if (!messages.data) return [] as MessageDto[];
    return [...messages.data].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
  }, [messages.data]);

  // Mark thread as read when it first loads with unread messages. Track per
  // thread so re-mounting the same thread doesn't re-fire on every poll.
  useEffect(() => {
    if (!threadId || !thread.data) return;
    if (lastMarkedReadFor.current === threadId) return;
    if (thread.data.unreadCount > 0) {
      lastMarkedReadFor.current = threadId;
      markRead.mutate(threadId);
    } else {
      lastMarkedReadFor.current = threadId;
    }
    // markRead is stable from useMutation; no need to depend on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, thread.data?.id, thread.data?.unreadCount]);

  // Scroll to the latest message whenever the message list changes.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.data?.length]);

  if (!user) return null;
  if (!threadId) return null;

  if (thread.isError) {
    const status = (thread.error as ApiError | undefined)?.status;
    return (
      <div className="mx-auto max-w-3xl">
        <div className="rounded-card border border-gray-200 bg-white px-5 py-12 text-center">
          <p className="text-sm font-semibold text-gray-900">
            {status === 404 ? "This conversation isn't available." : 'Could not load the conversation.'}
          </p>
          <Link
            href="/messages"
            className="mt-3 inline-block rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
          >
            Back to inbox
          </Link>
        </div>
      </div>
    );
  }

  if (thread.isLoading || !thread.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="flex h-32 items-center justify-center">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  const t = thread.data;
  const others = t.participants.filter((p) => p.platformUserId !== user.id && !p.leftAt);
  const headline = others.map((p) => p.displayName || p.email || 'Unknown').join(', ') || 'Just you';
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const canPost = hasAnyPermission(user, ['com-001:write']);
  const isParticipant = t.participants.some(
    (p) => p.platformUserId === user.id && !p.leftAt,
  );

  async function onSend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!threadId) return;
    if (body.trim().length === 0) return;
    try {
      await postMessage.mutateAsync({ body: body.trim() });
      setBody('');
    } catch (err) {
      handlePostError(err, toast);
    }
  }

  async function onArchive() {
    if (!threadId) return;
    try {
      await archiveThread.mutateAsync({ threadId, isArchived: !t.isArchived });
      toast(t.isArchived ? 'Thread restored.' : 'Thread archived.', 'success');
      if (!t.isArchived) router.push('/messages');
    } catch (err) {
      const message =
        err instanceof ApiError && err.message ? err.message : 'Could not archive the thread.';
      toast(message, 'error');
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <ThreadHeader
        thread={t}
        headline={headline}
        onArchive={onArchive}
        archivePending={archiveThread.isPending}
        canArchive={isParticipant || isAdmin}
      />

      <div className="rounded-card border border-gray-200 bg-white">
        <div className="max-h-[60vh] min-h-[40vh] space-y-4 overflow-y-auto px-5 py-5">
          {messages.isLoading && (
            <div className="flex h-32 items-center justify-center">
              <LoadingSpinner />
            </div>
          )}
          {!messages.isLoading && ordered.length === 0 && (
            <p className="py-12 text-center text-sm text-gray-500">No messages in this thread yet.</p>
          )}
          {!messages.isLoading && ordered.map((m) => (
            <MessageBubble key={m.id} message={m} ownAccountId={user.id} />
          ))}
          <div ref={messagesEndRef} />
        </div>

        {canPost && isParticipant && !t.isArchived && (
          <form onSubmit={onSend} className="border-t border-gray-100 px-5 py-4">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              maxLength={8000}
              placeholder="Reply to this conversation…"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
            <div className="mt-2 flex justify-end">
              <button
                type="submit"
                disabled={postMessage.isPending || body.trim().length === 0}
                className="rounded-lg bg-campus-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {postMessage.isPending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        )}

        {!isParticipant && isAdmin && (
          <p className="border-t border-gray-100 px-5 py-3 text-xs text-gray-500">
            Read-only — admins can review this thread but cannot post into it.
          </p>
        )}

        {t.isArchived && (
          <p className="border-t border-gray-100 px-5 py-3 text-xs text-gray-500">
            This thread is archived. Restore it to send new messages.
          </p>
        )}
      </div>
    </div>
  );
}

interface ThreadHeaderProps {
  thread: ThreadDto;
  headline: string;
  onArchive: () => void;
  archivePending: boolean;
  canArchive: boolean;
}

function ThreadHeader({ thread, headline, onArchive, archivePending, canArchive }: ThreadHeaderProps) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3">
          <Link href="/messages" className="text-sm text-campus-700 hover:underline">
            ← Inbox
          </Link>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">
            {labelForType(thread.threadTypeName)}
          </span>
          {thread.isArchived && (
            <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-600">
              Archived
            </span>
          )}
        </div>
        <h1 className="mt-1 truncate font-display text-2xl text-gray-900">
          {thread.subject || headline}
        </h1>
        <p className="mt-0.5 truncate text-sm text-gray-500">{headline}</p>
      </div>
      {canArchive && (
        <button
          type="button"
          onClick={onArchive}
          disabled={archivePending}
          className="shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400"
        >
          {thread.isArchived ? 'Restore' : 'Archive'}
        </button>
      )}
    </div>
  );
}

interface MessageBubbleProps {
  message: MessageDto;
  ownAccountId: string;
}

function MessageBubble({ message, ownAccountId }: MessageBubbleProps) {
  const isMine = message.senderId === ownAccountId;
  const isDeleted = message.isDeleted;
  const isFlagged = message.moderationStatus === 'FLAGGED' || message.moderationStatus === 'ESCALATED';
  const senderName = message.senderName || 'Unknown';

  return (
    <div className={cn('flex items-start gap-3', isMine && 'flex-row-reverse')}>
      <Avatar name={senderName} size="sm" />
      <div className={cn('max-w-[75%] min-w-0', isMine && 'items-end')}>
        <div className={cn('flex items-baseline gap-2', isMine && 'flex-row-reverse')}>
          <span className="text-xs font-semibold text-gray-700">
            {isMine ? 'You' : senderName}
          </span>
          <span className="text-[10px] text-gray-400">{formatRelative(message.createdAt)}</span>
          {message.isEdited && !isDeleted && (
            <span className="text-[10px] italic text-gray-400">edited</span>
          )}
        </div>
        <div
          className={cn(
            'mt-1 whitespace-pre-wrap break-words rounded-2xl px-4 py-2 text-sm',
            isMine
              ? 'rounded-tr-sm bg-campus-600 text-white'
              : 'rounded-tl-sm bg-gray-100 text-gray-900',
            isDeleted && 'italic',
            isDeleted && (isMine ? 'bg-campus-300' : 'bg-gray-100 text-gray-500'),
          )}
        >
          {isDeleted ? 'Message deleted' : message.body}
        </div>
        {isFlagged && !isDeleted && (
          <p className="mt-1 text-[11px] text-amber-700">
            Flagged for review
          </p>
        )}
      </div>
    </div>
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

function handlePostError(err: unknown, toast: (msg: string, variant?: 'info' | 'success' | 'warning' | 'error') => void) {
  if (err instanceof ApiError) {
    if (err.status === 422) {
      toast(
        'This message was not sent because it contains content that violates school policy.',
        'error',
      );
      return;
    }
    if (err.status === 403 || err.status === 400) {
      toast(err.message || 'Could not send the message.', 'error');
      return;
    }
  }
  toast('Could not send the message. Please try again.', 'error');
}
