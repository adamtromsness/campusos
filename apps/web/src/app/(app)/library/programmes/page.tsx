'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useCreateReadingProgramme, useReadingProgrammes } from '@/hooks/use-library';
import {
  READING_PROGRAMME_AUDIENCE_LABELS,
  READING_PROGRAMME_AUDIENCE_TYPES,
  formatDate,
} from '@/lib/library-format';
import type { CreateReadingProgrammePayload, ReadingProgrammeAudienceType } from '@/lib/types';

/**
 * /library/programmes — Reading programme list. Librarians + admins can
 * create. Students see active programmes inlined with their own progress
 * via the Step 7 backend's `myProgress` field.
 */
export default function ReadingProgrammesPage() {
  const user = useAuthStore((s) => s.user);
  const isLibrarian = !!user && hasAnyPermission(user, ['sch-001:admin', 'lib-003:write']);
  const isStudent = user?.personType === 'STUDENT';

  const [includeInactive, setIncludeInactive] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const programmesQ = useReadingProgrammes(includeInactive);
  const programmes = programmesQ.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reading programmes"
        description={
          isLibrarian
            ? 'Create challenges and watch students progress toward their reading goals.'
            : isStudent
              ? 'Active challenges across the school. Your own progress is shown below each one.'
              : 'Active reading challenges across the school.'
        }
      />

      <Link href="/library" className="text-sm font-medium text-campus-700 hover:text-campus-800">
        ← Back to library
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {isLibrarian && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-campus-600 focus:ring-campus-500"
            />
            Show inactive
          </label>
        )}
        {isLibrarian && (
          <button
            onClick={() => setCreateOpen(true)}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            New programme
          </button>
        )}
      </div>

      {programmesQ.isLoading ? (
        <LoadingSpinner />
      ) : programmes.length === 0 ? (
        <EmptyState
          title="No reading programmes"
          description={
            isLibrarian
              ? 'Click "New programme" to launch a reading challenge.'
              : 'Check back later for active challenges.'
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {programmes.map((p) => (
            <li
              key={p.id}
              className="rounded-lg border border-gray-200 bg-white p-5 transition hover:border-campus-300 hover:shadow-sm"
            >
              <Link href={`/library/programmes/${p.id}`} className="block space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-display text-lg text-gray-900">{p.name}</h3>
                      {!p.isActive && (
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-gray-600">
                          Inactive
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      {READING_PROGRAMME_AUDIENCE_LABELS[p.targetAudienceType]} ·{' '}
                      {formatDate(p.startDate)} → {formatDate(p.endDate)}
                    </div>
                  </div>
                </div>

                {p.description && (
                  <p className="line-clamp-2 text-sm text-gray-700">{p.description}</p>
                )}

                <div className="flex flex-wrap gap-3 text-xs">
                  {p.targetBooks !== null && (
                    <span className="rounded bg-sky-50 px-2 py-0.5 text-sky-800 ring-1 ring-sky-100">
                      Goal: {p.targetBooks} book{p.targetBooks === 1 ? '' : 's'}
                    </span>
                  )}
                  {p.targetPages !== null && (
                    <span className="rounded bg-violet-50 px-2 py-0.5 text-violet-800 ring-1 ring-violet-100">
                      Goal: {p.targetPages} pages
                    </span>
                  )}
                </div>

                {p.myProgress && (
                  <ProgressBar
                    booksRead={p.myProgress.booksRead}
                    pagesRead={p.myProgress.pagesRead}
                    targetBooks={p.targetBooks}
                    targetPages={p.targetPages}
                    isComplete={p.myProgress.isComplete}
                  />
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New reading programme"
        footer={null}
      >
        <CreateProgrammeForm onClose={() => setCreateOpen(false)} />
      </Modal>
    </div>
  );
}

function ProgressBar({
  booksRead,
  pagesRead,
  targetBooks,
  targetPages,
  isComplete,
}: {
  booksRead: number;
  pagesRead: number;
  targetBooks: number | null;
  targetPages: number | null;
  isComplete: boolean;
}) {
  // Use whichever metric the programme is tracking. If both, show book progress.
  const target = targetBooks ?? targetPages ?? 0;
  const value = targetBooks !== null ? booksRead : pagesRead;
  const label = targetBooks !== null ? 'books' : 'pages';
  const pct = target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 0;

  return (
    <div>
      <div className="flex items-center justify-between text-xs text-gray-700">
        <span className="font-medium">
          My progress: {value} / {target} {label}
        </span>
        <span className={isComplete ? 'font-semibold text-emerald-700' : 'text-gray-500'}>
          {isComplete ? '✓ Complete' : pct + '%'}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-gray-100">
        <div
          className={'h-full ' + (isComplete ? 'bg-emerald-500' : 'bg-campus-500')}
          style={{ width: pct + '%' }}
        />
      </div>
    </div>
  );
}

function CreateProgrammeForm({ onClose }: { onClose: () => void }) {
  const create = useCreateReadingProgramme();
  const toast = useToast();

  const [form, setForm] = useState<CreateReadingProgrammePayload>({
    name: '',
    description: '',
    targetAudienceType: 'SCHOOL_WIDE',
  });
  const [targetBooks, setTargetBooks] = useState<string>('');
  const [targetPages, setTargetPages] = useState<string>('');

  const update = <K extends keyof CreateReadingProgrammePayload>(
    key: K,
    value: CreateReadingProgrammePayload[K],
  ) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!form.name.trim()) return;
        const payload: CreateReadingProgrammePayload = {
          name: form.name.trim(),
          targetAudienceType: form.targetAudienceType,
        };
        if (form.description?.trim()) payload.description = form.description.trim();
        if (form.startDate) payload.startDate = form.startDate;
        if (form.endDate) payload.endDate = form.endDate;
        const tb = Number(targetBooks);
        const tp = Number(targetPages);
        if (targetBooks && !isNaN(tb) && tb > 0) payload.targetBooks = tb;
        if (targetPages && !isNaN(tp) && tp > 0) payload.targetPages = tp;
        if (!payload.targetBooks && !payload.targetPages) {
          toast.toast('Set a target — books, pages, or both.', 'error');
          return;
        }
        try {
          await create.mutateAsync(payload);
          toast.toast('Programme created.');
          onClose();
        } catch (err) {
          toast.toast(err instanceof Error ? err.message : 'Could not create programme', 'error');
        }
      }}
      className="space-y-3"
    >
      <Field label="Name" required>
        <input
          value={form.name}
          onChange={(e) => update('name', e.target.value)}
          required
          maxLength={120}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        />
      </Field>
      <Field label="Description">
        <textarea
          value={form.description ?? ''}
          onChange={(e) => update('description', e.target.value)}
          rows={2}
          maxLength={1000}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Target books">
          <input
            type="number"
            min={0}
            value={targetBooks}
            onChange={(e) => setTargetBooks(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
        <Field label="Target pages">
          <input
            type="number"
            min={0}
            value={targetPages}
            onChange={(e) => setTargetPages(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start date">
          <input
            type="date"
            value={form.startDate ?? ''}
            onChange={(e) => update('startDate', e.target.value || undefined)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
        <Field label="End date">
          <input
            type="date"
            value={form.endDate ?? ''}
            onChange={(e) => update('endDate', e.target.value || undefined)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
      </div>
      <Field label="Audience">
        <select
          value={form.targetAudienceType}
          onChange={(e) =>
            update('targetAudienceType', e.target.value as ReadingProgrammeAudienceType)
          }
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        >
          {READING_PROGRAMME_AUDIENCE_TYPES.map((t) => (
            <option key={t} value={t}>
              {READING_PROGRAMME_AUDIENCE_LABELS[t]}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={create.isPending || !form.name.trim()}
          className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-60"
        >
          {create.isPending ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-700">
        {label}
        {required && <span className="text-rose-600"> *</span>}
      </span>
      {children}
    </label>
  );
}
