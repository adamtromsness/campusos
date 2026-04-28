'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useCreateThread,
  useMessagingRecipients,
  useThreadTypes,
} from '@/hooks/use-messaging';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { ApiError } from '@/lib/api-client';
import type { MessagingRecipientDto, ThreadTypeDto } from '@/lib/types';

export default function ComposeMessagePage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const { toast } = useToast();

  const types = useThreadTypes();
  const [threadTypeId, setThreadTypeId] = useState<string | null>(null);
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [search, setSearch] = useState('');

  const createThread = useCreateThread();
  const recipients = useMessagingRecipients(threadTypeId);

  const eligibleTypes = useMemo<ThreadTypeDto[]>(() => {
    return (types.data ?? []).filter((t) => !t.isSystem);
  }, [types.data]);

  // Default-select the first eligible thread type once they load.
  useEffect(() => {
    if (!threadTypeId && eligibleTypes.length > 0) {
      setThreadTypeId(eligibleTypes[0]!.id);
    }
  }, [eligibleTypes, threadTypeId]);

  // Clear recipients when the thread type changes (the eligible set
  // changes with it).
  useEffect(() => {
    setSelectedRecipientIds([]);
  }, [threadTypeId]);

  const filteredRecipients = useMemo<MessagingRecipientDto[]>(() => {
    const q = search.trim().toLowerCase();
    const all = recipients.data ?? [];
    if (!q) return all;
    return all.filter((r) => {
      const name = (r.displayName || '').toLowerCase();
      const email = (r.email || '').toLowerCase();
      const roles = r.roles.join(' ').toLowerCase();
      return name.includes(q) || email.includes(q) || roles.includes(q);
    });
  }, [recipients.data, search]);

  if (!user) return null;

  const canWrite = hasAnyPermission(user, ['com-001:write']);
  if (!canWrite) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="New message" />
        <EmptyState
          title="Not available"
          description="Your role doesn't have permission to send messages."
        />
      </div>
    );
  }

  function toggleRecipient(id: string) {
    setSelectedRecipientIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!threadTypeId) {
      toast('Pick a thread type first.', 'warning');
      return;
    }
    if (selectedRecipientIds.length === 0) {
      toast('Choose at least one recipient.', 'warning');
      return;
    }
    if (body.trim().length === 0) {
      toast('Write a message before sending.', 'warning');
      return;
    }
    try {
      const thread = await createThread.mutateAsync({
        threadTypeId,
        subject: subject.trim() || undefined,
        participants: selectedRecipientIds.map((id) => ({ platformUserId: id })),
        initialMessage: body.trim(),
      });
      toast('Message sent.', 'success');
      router.push(`/messages/${thread.id}`);
    } catch (err) {
      handleSendError(err, toast);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="New message"
        description="Choose recipients and start a new conversation."
        actions={
          <Link
            href="/messages"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            Cancel
          </Link>
        }
      />

      {types.isLoading && (
        <div className="flex h-32 items-center justify-center">
          <LoadingSpinner />
        </div>
      )}

      {!types.isLoading && eligibleTypes.length === 0 && (
        <EmptyState
          title="No thread types available"
          description="Your school hasn't set up any conversation types you can start."
        />
      )}

      {!types.isLoading && eligibleTypes.length > 0 && (
        <form onSubmit={onSubmit} className="space-y-5 rounded-card border border-gray-200 bg-white p-5">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
              Conversation type
            </label>
            <div className="flex flex-wrap gap-2">
              {eligibleTypes.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setThreadTypeId(t.id)}
                  className={cn(
                    'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                    threadTypeId === t.id
                      ? 'bg-campus-700 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200',
                  )}
                >
                  {labelForType(t.name)}
                </button>
              ))}
            </div>
            {threadTypeId && (
              <p className="mt-1 text-xs text-gray-500">
                {describeType(eligibleTypes.find((t) => t.id === threadTypeId))}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
              Recipients
            </label>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, email, or role…"
              className="mb-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
            <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-200">
              {recipients.isLoading && (
                <div className="flex items-center justify-center px-4 py-6">
                  <LoadingSpinner />
                </div>
              )}
              {!recipients.isLoading && filteredRecipients.length === 0 && (
                <p className="px-4 py-6 text-center text-sm text-gray-500">
                  {recipients.data && recipients.data.length === 0
                    ? 'No eligible recipients for this conversation type.'
                    : 'No matches.'}
                </p>
              )}
              {!recipients.isLoading && filteredRecipients.length > 0 && (
                <ul className="divide-y divide-gray-100">
                  {filteredRecipients.map((r) => {
                    const checked = selectedRecipientIds.includes(r.platformUserId);
                    return (
                      <li key={r.platformUserId}>
                        <label
                          className={cn(
                            'flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors',
                            checked ? 'bg-campus-50/60' : 'hover:bg-gray-50',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleRecipient(r.platformUserId)}
                            className="h-4 w-4 rounded border-gray-300 text-campus-600 focus:ring-campus-500"
                          />
                          <Avatar name={r.displayName || r.email || '?'} size="sm" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-gray-900">
                              {r.displayName || r.email || 'Unknown'}
                            </p>
                            <p className="truncate text-xs text-gray-500">
                              {r.roles.length > 0 ? r.roles.map(prettyRole).join(', ') : '—'}
                              {r.email && r.displayName ? ` · ${r.email}` : ''}
                            </p>
                          </div>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {selectedRecipientIds.length > 0 && (
              <p className="mt-1 text-xs text-gray-500">
                {selectedRecipientIds.length} recipient{selectedRecipientIds.length === 1 ? '' : 's'} selected
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
              Subject (optional)
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
              placeholder="Subject line"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
              Message
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              maxLength={8000}
              placeholder="Write your message…"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Link
              href="/messages"
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={createThread.isPending}
              className="rounded-lg bg-campus-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {createThread.isPending ? 'Sending…' : 'Send message'}
            </button>
          </div>
        </form>
      )}
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
    default:
      return name.replace(/_/g, ' ').toLowerCase();
  }
}

function prettyRole(token: string): string {
  return token
    .split('_')
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

function describeType(t?: ThreadTypeDto): string {
  if (!t) return '';
  if (t.description) return t.description;
  if (t.allowedRoles.length === 0) return 'Open to any role.';
  return `Open to: ${t.allowedRoles.map(prettyRole).join(', ')}.`;
}

function handleSendError(err: unknown, toast: (msg: string, variant?: 'info' | 'success' | 'warning' | 'error') => void) {
  if (err instanceof ApiError) {
    if (err.status === 422) {
      toast(
        'This message was not sent because it contains content that violates school policy.',
        'error',
      );
      return;
    }
    if (err.status === 400 || err.status === 403) {
      toast(err.message || 'Could not start the conversation.', 'error');
      return;
    }
  }
  toast('Could not send the message. Please try again.', 'error');
}
