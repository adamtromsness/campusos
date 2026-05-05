'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useReadingProgramme,
  useReadingProgrammeLeaderboard,
  useUpdateReadingProgramme,
} from '@/hooks/use-library';
import {
  READING_PROGRAMME_AUDIENCE_LABELS,
  formatDate,
  formatRelative,
} from '@/lib/library-format';
import type { UpdateReadingProgrammePayload } from '@/lib/types';

/**
 * /library/programmes/[id] — programme detail with leaderboard. Librarians
 * can edit metadata + deactivate. Students see their own progress card +
 * the public leaderboard.
 */
export default function ProgrammeDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? null;
  const user = useAuthStore((s) => s.user);
  const isLibrarian = !!user && hasAnyPermission(user, ['sch-001:admin', 'lib-003:write']);

  const programmeQ = useReadingProgramme(id);
  const leaderboardQ = useReadingProgrammeLeaderboard(id, 25);

  const [editOpen, setEditOpen] = useState(false);

  if (programmeQ.isLoading) return <LoadingSpinner />;
  if (!programmeQ.data) {
    return (
      <div className="space-y-4">
        <PageHeader title="Reading programme" />
        <p className="rounded-md bg-rose-50 p-3 text-sm text-rose-800">
          This programme was not found.
        </p>
      </div>
    );
  }

  const p = programmeQ.data;
  const leaderboard = leaderboardQ.data ?? [];

  return (
    <div className="space-y-6">
      <Link
        href="/library/programmes"
        className="text-sm font-medium text-campus-700 hover:text-campus-800"
      >
        ← Back to programmes
      </Link>

      <section className="rounded-lg border border-gray-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-2xl text-gray-900">{p.name}</h1>
              {!p.isActive && (
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium uppercase text-gray-600">
                  Inactive
                </span>
              )}
              <span className="rounded bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-800 ring-1 ring-sky-100">
                {READING_PROGRAMME_AUDIENCE_LABELS[p.targetAudienceType]}
              </span>
            </div>
            <div className="mt-2 text-sm text-gray-600">
              {formatDate(p.startDate)} → {formatDate(p.endDate)}
            </div>
          </div>
          {isLibrarian && (
            <button
              onClick={() => setEditOpen(true)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50"
            >
              Edit
            </button>
          )}
        </div>
        {p.description && (
          <p className="mt-4 text-sm leading-relaxed text-gray-700">{p.description}</p>
        )}

        <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Target books" value={p.targetBooks?.toString() ?? '—'} />
          <Stat label="Target pages" value={p.targetPages?.toString() ?? '—'} />
          <Stat label="Status" value={p.isActive ? 'Active' : 'Inactive'} />
          <Stat label="Last updated" value={formatRelative(p.updatedAt)} />
        </dl>
      </section>

      {p.myProgress && (
        <section className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-6">
          <h2 className="text-sm font-semibold text-emerald-900">My progress</h2>
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-emerald-800">Books read</div>
              <div className="mt-1 text-2xl font-semibold text-emerald-900">
                {p.myProgress.booksRead}
                {p.targetBooks !== null && (
                  <span className="text-base font-normal text-emerald-700"> / {p.targetBooks}</span>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-emerald-800">Pages read</div>
              <div className="mt-1 text-2xl font-semibold text-emerald-900">
                {p.myProgress.pagesRead}
                {p.targetPages !== null && (
                  <span className="text-base font-normal text-emerald-700"> / {p.targetPages}</span>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-emerald-800">Status</div>
              <div className="mt-1 text-lg font-semibold text-emerald-900">
                {p.myProgress.isComplete ? '✓ Complete' : 'In progress'}
              </div>
            </div>
          </div>
          <p className="mt-4 text-xs text-emerald-800">
            Log a book on{' '}
            <Link href="/library/reading-log" className="font-medium underline">
              your reading log
            </Link>{' '}
            to count toward this programme.
          </p>
        </section>
      )}

      <section className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-base font-semibold text-gray-900">Leaderboard</h2>
        <p className="mt-1 text-xs text-gray-500">
          Top readers in this programme. Updated continuously.
        </p>
        {leaderboardQ.isLoading ? (
          <LoadingSpinner />
        ) : leaderboard.length === 0 ? (
          <p className="mt-4 text-sm text-gray-600">No participants yet.</p>
        ) : (
          <table className="mt-4 min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
                <th className="py-2 text-left font-medium">Rank</th>
                <th className="py-2 text-left font-medium">Student</th>
                <th className="py-2 text-right font-medium">Books</th>
                <th className="py-2 text-right font-medium">Pages</th>
                <th className="py-2 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {leaderboard.map((entry, i) => (
                <tr key={entry.studentId}>
                  <td className="py-2 text-gray-500">#{i + 1}</td>
                  <td className="py-2 font-medium text-gray-900">{entry.studentName ?? '—'}</td>
                  <td className="py-2 text-right text-gray-700">{entry.booksRead}</td>
                  <td className="py-2 text-right text-gray-700">{entry.pagesRead}</td>
                  <td className="py-2 text-right">
                    {entry.isComplete ? (
                      <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
                        Complete
                      </span>
                    ) : (
                      <span className="text-xs text-gray-500">In progress</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit programme"
        footer={null}
      >
        <EditForm programme={p} onClose={() => setEditOpen(false)} />
      </Modal>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-gray-900">{value}</dd>
    </div>
  );
}

function EditForm({
  programme,
  onClose,
}: {
  programme: NonNullable<ReturnType<typeof useReadingProgramme>['data']>;
  onClose: () => void;
}) {
  const update = useUpdateReadingProgramme(programme.id);
  const toast = useToast();

  const [name, setName] = useState(programme.name);
  const [description, setDescription] = useState(programme.description ?? '');
  const [targetBooks, setTargetBooks] = useState(programme.targetBooks?.toString() ?? '');
  const [targetPages, setTargetPages] = useState(programme.targetPages?.toString() ?? '');
  const [startDate, setStartDate] = useState(programme.startDate ?? '');
  const [endDate, setEndDate] = useState(programme.endDate ?? '');
  const [isActive, setIsActive] = useState(programme.isActive);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const payload: UpdateReadingProgrammePayload = {};
        if (name.trim() !== programme.name) payload.name = name.trim();
        const desc = description.trim();
        if (desc !== (programme.description ?? '')) {
          payload.description = desc;
        }
        const tb = targetBooks ? Number(targetBooks) : null;
        if (tb !== programme.targetBooks && targetBooks) payload.targetBooks = Number(targetBooks);
        const tp = targetPages ? Number(targetPages) : null;
        if (tp !== programme.targetPages && targetPages) payload.targetPages = Number(targetPages);
        if (startDate !== (programme.startDate ?? '')) payload.startDate = startDate;
        if (endDate !== (programme.endDate ?? '')) payload.endDate = endDate;
        if (isActive !== programme.isActive) payload.isActive = isActive;

        try {
          await update.mutateAsync(payload);
          toast.toast('Programme updated.');
          onClose();
        } catch (err) {
          toast.toast(err instanceof Error ? err.message : 'Could not save', 'error');
        }
      }}
      className="space-y-3"
    >
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-gray-700">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-gray-700">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={1000}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-700">Target books</span>
          <input
            type="number"
            min={0}
            value={targetBooks}
            onChange={(e) => setTargetBooks(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-700">Target pages</span>
          <input
            type="number"
            min={0}
            value={targetPages}
            onChange={(e) => setTargetPages(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-700">Start</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-700">End</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-campus-600 focus:ring-campus-500"
        />
        Active
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
    </form>
  );
}
