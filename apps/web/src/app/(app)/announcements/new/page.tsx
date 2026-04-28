'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { useClasses } from '@/hooks/use-classes';
import { useCreateAnnouncement } from '@/hooks/use-announcements';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { ApiError } from '@/lib/api-client';
import type { AudienceType, CreateAnnouncementPayload } from '@/lib/types';

const AUDIENCE_OPTIONS: Array<{ value: AudienceType; label: string; description: string }> = [
  { value: 'ALL_SCHOOL', label: 'All school', description: 'Everyone enrolled at this school.' },
  { value: 'CLASS', label: 'Class', description: 'Students in a specific class, plus their guardians and the assigned teachers.' },
  { value: 'YEAR_GROUP', label: 'Year group', description: 'Students in one grade level, plus their guardians.' },
  { value: 'ROLE', label: 'Role', description: 'Everyone who holds a specific role at this school.' },
];

// Hard-coded for Step 10 — see HANDOFF-CYCLE3.md. The audience worker resolves
// YEAR_GROUP via `sis_students.grade_level = audienceRef`, so any string the
// students table actually uses works. Seed currently uses '9' and '10'; we
// expose 9–12 as a reasonable high-school range.
const GRADE_LEVELS = ['9', '10', '11', '12'];

const ROLE_OPTIONS = ['TEACHER', 'STUDENT', 'PARENT', 'SCHOOL_ADMIN'];

export default function NewAnnouncementPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const { toast } = useToast();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audienceType, setAudienceType] = useState<AudienceType>('ALL_SCHOOL');
  const [audienceRef, setAudienceRef] = useState<string>('');
  const [expiresAt, setExpiresAt] = useState<string>('');

  const classes = useClasses();
  const createAnnouncement = useCreateAnnouncement();

  const sortedClasses = useMemo(() => {
    return [...(classes.data ?? [])].sort((a, b) => {
      const an = (a.course?.name || '').toLowerCase();
      const bn = (b.course?.name || '').toLowerCase();
      if (an !== bn) return an < bn ? -1 : 1;
      return (a.sectionCode || '').localeCompare(b.sectionCode || '');
    });
  }, [classes.data]);

  if (!user) return null;

  const canManage = hasAnyPermission(user, ['com-002:write']);
  if (!canManage) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="New announcement" />
        <EmptyState
          title="Not available"
          description="Your role doesn't have permission to publish announcements."
        />
      </div>
    );
  }

  function pickAudienceType(t: AudienceType) {
    setAudienceType(t);
    setAudienceRef('');
  }

  async function submit(publishNow: boolean, e: FormEvent) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    if (trimmedTitle.length === 0) {
      toast('Add a title before saving.', 'warning');
      return;
    }
    if (trimmedBody.length === 0) {
      toast('Write a message body before saving.', 'warning');
      return;
    }
    if (audienceType !== 'ALL_SCHOOL' && audienceRef.trim().length === 0) {
      toast(`Pick a ${labelForAudience(audienceType).toLowerCase()} for the audience.`, 'warning');
      return;
    }

    const payload: CreateAnnouncementPayload = {
      title: trimmedTitle,
      body: trimmedBody,
      audienceType,
      isPublished: publishNow,
    };
    if (audienceType !== 'ALL_SCHOOL') {
      payload.audienceRef = audienceRef.trim();
    }
    if (expiresAt) {
      // <input type="datetime-local"> returns "YYYY-MM-DDTHH:mm" in the
      // user's local timezone — Date treats that as local time and the
      // backend accepts any IsISO8601 string.
      payload.expiresAt = new Date(expiresAt).toISOString();
    }

    try {
      const created = await createAnnouncement.mutateAsync(payload);
      toast(publishNow ? 'Announcement published.' : 'Draft saved.', 'success');
      router.push(`/announcements/${created.id}`);
    } catch (err) {
      const message =
        err instanceof ApiError && err.message
          ? err.message
          : 'Could not save the announcement.';
      toast(message, 'error');
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="New announcement"
        description="Send a message to a slice of the school community."
        actions={
          <Link
            href="/announcements"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            Cancel
          </Link>
        }
      />

      <form className="space-y-5 rounded-card border border-gray-200 bg-white p-5">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="e.g. Snow day — school closed Friday"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
            Body
          </label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            placeholder="Write the announcement…"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
            Audience
          </label>
          <div className="mb-2 flex flex-wrap gap-2">
            {AUDIENCE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => pickAudienceType(opt.value)}
                className={cn(
                  'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                  audienceType === opt.value
                    ? 'bg-campus-700 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="mb-3 text-xs text-gray-500">
            {AUDIENCE_OPTIONS.find((o) => o.value === audienceType)?.description}
          </p>

          {audienceType === 'CLASS' && (
            <div className="rounded-lg border border-gray-200 p-3">
              {classes.isLoading ? (
                <div className="flex h-12 items-center justify-center">
                  <LoadingSpinner />
                </div>
              ) : sortedClasses.length === 0 ? (
                <p className="text-sm text-gray-500">No classes available to target.</p>
              ) : (
                <select
                  value={audienceRef}
                  onChange={(e) => setAudienceRef(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
                >
                  <option value="">Choose a class…</option>
                  {sortedClasses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.sectionCode} — {c.course?.name ?? 'Class'}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {audienceType === 'YEAR_GROUP' && (
            <div className="rounded-lg border border-gray-200 p-3">
              <select
                value={audienceRef}
                onChange={(e) => setAudienceRef(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              >
                <option value="">Choose a grade level…</option>
                {GRADE_LEVELS.map((g) => (
                  <option key={g} value={g}>
                    Grade {g}
                  </option>
                ))}
              </select>
            </div>
          )}

          {audienceType === 'ROLE' && (
            <div className="rounded-lg border border-gray-200 p-3">
              <select
                value={audienceRef}
                onChange={(e) => setAudienceRef(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              >
                <option value="">Choose a role…</option>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {prettyRole(r)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
            Expires (optional)
          </label>
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
          <p className="mt-1 text-xs text-gray-500">
            After this date, the announcement is hidden from the feed by default.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Link
            href="/announcements"
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            Cancel
          </Link>
          <button
            type="button"
            onClick={(e) => submit(false, e)}
            disabled={createAnnouncement.isPending}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400"
          >
            Save draft
          </button>
          <button
            type="button"
            onClick={(e) => submit(true, e)}
            disabled={createAnnouncement.isPending}
            className="rounded-lg bg-campus-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {createAnnouncement.isPending ? 'Saving…' : 'Publish now'}
          </button>
        </div>
      </form>
    </div>
  );
}

function labelForAudience(t: AudienceType): string {
  return AUDIENCE_OPTIONS.find((o) => o.value === t)?.label ?? t;
}

function prettyRole(token: string): string {
  return token
    .split('_')
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}
