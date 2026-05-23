'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useAuthStore } from '@/lib/auth-store';
import {
  useCatalogueSearch,
  useLogBook,
  useReadingLog,
  useUpdateReadingLog,
} from '@/hooks/use-library';
import { formatDate, formatRelative } from '@/lib/library-format';
import type { LibraryCatalogueItemSearchHitDto, ReadingLogDto } from '@/lib/types';

/**
 * /library/reading-log — STUDENT-FACING reading log. The second
 * student-input surface in CampusOS after Cycle 11.1 wellbeing.
 *
 * Students see only their own log (server-side row scope binds writes to
 * their own student_id). Logging a book with a `completedDate` triggers
 * the Step 7 ReadingLogService programme-progress auto-upsert.
 */
export default function ReadingLogPage() {
  const user = useAuthStore((s) => s.user);
  const isStudent = user?.activePersona?.type === 'STUDENT';

  const logQ = useReadingLog();
  const log = logQ.data ?? [];

  const [logOpen, setLogOpen] = useState(false);

  if (!isStudent) {
    return (
      <div className="space-y-4">
        <PageHeader title="Reading log" />
        <p className="rounded-md bg-amber-50 p-4 text-sm text-amber-900">
          The reading log is for students. Visit{' '}
          <Link href="/library" className="font-medium underline">
            /library
          </Link>{' '}
          for the librarian and patron dashboards.
        </p>
      </div>
    );
  }

  const completed = log.filter((l) => l.completedDate);
  const inProgress = log.filter((l) => !l.completedDate);

  return (
    <div className="space-y-6">
      <PageHeader
        title="My reading log"
        description="Track books you're reading. Logging a book with a completion date counts toward any active reading programme."
      />

      <Link href="/library" className="text-sm font-medium text-campus-700 hover:text-campus-800">
        ← Back to library
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label="Books completed" value={String(completed.length)} />
          <Stat label="In progress" value={String(inProgress.length)} />
          <Stat
            label="Pages read"
            value={String(log.reduce((sum, l) => sum + (l.pagesRead ?? 0), 0))}
          />
        </div>
        <button
          onClick={() => setLogOpen(true)}
          className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
        >
          Log a book
        </button>
      </div>

      {logQ.isLoading ? (
        <LoadingSpinner />
      ) : log.length === 0 ? (
        <EmptyState
          title="Your reading log is empty"
          description="Log a book you're reading to start tracking your progress."
        />
      ) : (
        <>
          {inProgress.length > 0 && (
            <section>
              <h2 className="text-base font-semibold text-gray-900">In progress</h2>
              <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {inProgress.map((l) => (
                  <LogEntry key={l.id} entry={l} />
                ))}
              </ul>
            </section>
          )}
          {completed.length > 0 && (
            <section>
              <h2 className="text-base font-semibold text-gray-900">Completed</h2>
              <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {completed.map((l) => (
                  <LogEntry key={l.id} entry={l} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <Modal open={logOpen} onClose={() => setLogOpen(false)} title="Log a book" footer={null}>
        <LogForm onClose={() => setLogOpen(false)} />
      </Modal>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-gray-900">{value}</div>
    </div>
  );
}

function LogEntry({ entry }: { entry: ReadingLogDto }) {
  const [editOpen, setEditOpen] = useState(false);
  return (
    <li className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-gray-900">{entry.itemTitle ?? '—'}</div>
          {entry.itemAuthor && (
            <div className="mt-0.5 text-xs text-gray-600">{entry.itemAuthor}</div>
          )}
          <div className="mt-2 text-xs text-gray-500">
            Started {formatDate(entry.startedDate)}
            {entry.completedDate && ` · Finished ${formatDate(entry.completedDate)}`}
            {entry.pagesRead !== null && ` · ${entry.pagesRead} pages`}
          </div>
          {entry.rating !== null && (
            <div className="mt-1 text-sm text-amber-600">
              {'★'.repeat(entry.rating)}
              <span className="text-gray-300">{'★'.repeat(5 - entry.rating)}</span>
            </div>
          )}
          {entry.reviewText && (
            <p className="mt-2 line-clamp-3 text-sm text-gray-700">{entry.reviewText}</p>
          )}
        </div>
        <button
          onClick={() => setEditOpen(true)}
          className="text-xs font-medium text-campus-700 hover:text-campus-800"
        >
          Edit
        </button>
      </div>

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit reading log entry"
        footer={null}
      >
        <EditForm entry={entry} onClose={() => setEditOpen(false)} />
      </Modal>
    </li>
  );
}

function LogForm({ onClose }: { onClose: () => void }) {
  const log = useLogBook();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [selectedItem, setSelectedItem] = useState<LibraryCatalogueItemSearchHitDto | null>(null);
  const [startedDate, setStartedDate] = useState('');
  const [completedDate, setCompletedDate] = useState('');
  const [pagesRead, setPagesRead] = useState('');
  const [rating, setRating] = useState(0);
  const [reviewText, setReviewText] = useState('');

  const searchQ = useCatalogueSearch({ q: search.length >= 2 ? search : undefined });
  const results = searchQ.data ?? [];

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!selectedItem) return;
        try {
          await log.mutateAsync({
            catalogueItemId: selectedItem.id,
            startedDate: startedDate || undefined,
            completedDate: completedDate || undefined,
            pagesRead: pagesRead ? Number(pagesRead) : undefined,
            rating: rating > 0 ? rating : undefined,
            reviewText: reviewText.trim() || undefined,
          });
          toast.toast('Book logged.');
          onClose();
        } catch (err) {
          toast.toast(err instanceof Error ? err.message : 'Could not log book', 'error');
        }
      }}
      className="space-y-3"
    >
      {!selectedItem ? (
        <>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-700">Find the book</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title or author"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
          {search.length >= 2 && (
            <ul className="max-h-48 overflow-y-auto rounded-md border border-gray-200">
              {results.length === 0 ? (
                <li className="p-3 text-sm text-gray-500">No matches.</li>
              ) : (
                results.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedItem(r)}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-campus-50"
                    >
                      <div className="font-medium text-gray-900">{r.title}</div>
                      <div className="text-xs text-gray-500">{r.author ?? '—'}</div>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </>
      ) : (
        <div className="rounded-md border border-campus-200 bg-campus-50/40 p-3 text-sm">
          <div className="flex items-start justify-between">
            <div>
              <div className="font-medium text-gray-900">{selectedItem.title}</div>
              <div className="text-xs text-gray-600">{selectedItem.author ?? '—'}</div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedItem(null)}
              className="text-xs font-medium text-campus-700"
            >
              Change
            </button>
          </div>
        </div>
      )}

      {selectedItem && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-700">Started</span>
              <input
                type="date"
                value={startedDate}
                onChange={(e) => setStartedDate(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-700">Completed</span>
              <input
                type="date"
                value={completedDate}
                onChange={(e) => setCompletedDate(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-700">Pages read</span>
            <input
              type="number"
              min={0}
              value={pagesRead}
              onChange={(e) => setPagesRead(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <RatingPicker rating={rating} onChange={setRating} />
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-700">Notes (optional)</span>
            <textarea
              value={reviewText}
              onChange={(e) => setReviewText(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="What did you think of this book?"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </>
      )}

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
          disabled={!selectedItem || log.isPending}
          className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-60"
        >
          {log.isPending ? 'Logging…' : 'Log book'}
        </button>
      </div>
    </form>
  );
}

function EditForm({ entry, onClose }: { entry: ReadingLogDto; onClose: () => void }) {
  const update = useUpdateReadingLog(entry.id);
  const toast = useToast();

  const [startedDate, setStartedDate] = useState(entry.startedDate ?? '');
  const [completedDate, setCompletedDate] = useState(entry.completedDate ?? '');
  const [pagesRead, setPagesRead] = useState(entry.pagesRead?.toString() ?? '');
  const [rating, setRating] = useState(entry.rating ?? 0);
  const [reviewText, setReviewText] = useState(entry.reviewText ?? '');

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await update.mutateAsync({
            startedDate: startedDate || undefined,
            completedDate: completedDate || undefined,
            pagesRead: pagesRead ? Number(pagesRead) : undefined,
            rating: rating > 0 ? rating : undefined,
            reviewText: reviewText.trim() || undefined,
          });
          toast.toast('Updated.');
          onClose();
        } catch (err) {
          toast.toast(err instanceof Error ? err.message : 'Could not save', 'error');
        }
      }}
      className="space-y-3"
    >
      <div className="rounded-md bg-gray-50 p-3 text-sm">
        <div className="font-medium text-gray-900">{entry.itemTitle ?? '—'}</div>
        <div className="text-xs text-gray-500">{entry.itemAuthor ?? '—'}</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-700">Started</span>
          <input
            type="date"
            value={startedDate}
            onChange={(e) => setStartedDate(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-700">Completed</span>
          <input
            type="date"
            value={completedDate}
            onChange={(e) => setCompletedDate(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-gray-700">Pages read</span>
        <input
          type="number"
          min={0}
          value={pagesRead}
          onChange={(e) => setPagesRead(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
      </label>
      <RatingPicker rating={rating} onChange={setRating} />
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-gray-700">Notes</span>
        <textarea
          value={reviewText}
          onChange={(e) => setReviewText(e.target.value)}
          rows={3}
          maxLength={2000}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
      </label>
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
          disabled={update.isPending}
          className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-60"
        >
          {update.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="text-xs text-gray-500">Logged {formatRelative(entry.createdAt)}.</p>
    </form>
  );
}

function RatingPicker({ rating, onChange }: { rating: number; onChange: (r: number) => void }) {
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-gray-700">Rating</span>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(rating === n ? 0 : n)}
            className={
              'text-2xl transition ' +
              (rating >= n ? 'text-amber-500' : 'text-gray-300 hover:text-amber-300')
            }
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
          >
            ★
          </button>
        ))}
        {rating > 0 && (
          <button
            type="button"
            onClick={() => onChange(0)}
            className="ml-2 text-xs text-gray-500 hover:text-gray-700"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
