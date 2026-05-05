'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useCreateReadingList, useReadingLists } from '@/hooks/use-library';
import { READING_LIST_TYPES, READING_LIST_TYPE_LABELS, formatRelative } from '@/lib/library-format';
import type { CreateReadingListPayload, ReadingListType } from '@/lib/types';

/**
 * /library/reading-lists — Curated reading lists. Published-only by
 * default; librarians can toggle drafts and create new lists.
 */
export default function ReadingListsPage() {
  const user = useAuthStore((s) => s.user);
  const isWriter = !!user && hasAnyPermission(user, ['sch-001:admin', 'lib-003:write']);

  const [includeUnpublished, setIncludeUnpublished] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const listsQ = useReadingLists(includeUnpublished);
  const lists = listsQ.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reading lists"
        description="Curated booklists from teachers and librarians. Click any list to see its books."
      />

      <Link href="/library" className="text-sm font-medium text-campus-700 hover:text-campus-800">
        ← Back to library
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {isWriter && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={includeUnpublished}
              onChange={(e) => setIncludeUnpublished(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-campus-600 focus:ring-campus-500"
            />
            Show drafts
          </label>
        )}
        {isWriter && (
          <button
            onClick={() => setCreateOpen(true)}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            New reading list
          </button>
        )}
      </div>

      {listsQ.isLoading ? (
        <LoadingSpinner />
      ) : lists.length === 0 ? (
        <EmptyState
          title="No reading lists"
          description={
            isWriter
              ? 'Create your first reading list — pick books your students should read.'
              : 'No reading lists are available yet.'
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {lists.map((l) => (
            <li
              key={l.id}
              className="rounded-lg border border-gray-200 bg-white p-5 transition hover:border-campus-300 hover:shadow-sm"
            >
              <Link href={`/library/reading-lists/${l.id}`} className="block">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-display text-lg text-gray-900">{l.name}</h3>
                  {!l.isPublished && (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase text-amber-800 ring-1 ring-amber-200">
                      Draft
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-xs">
                  <span className="rounded bg-violet-50 px-2 py-0.5 text-violet-800 ring-1 ring-violet-100">
                    {READING_LIST_TYPE_LABELS[l.listType]}
                  </span>
                  <span className="text-gray-500">
                    {l.itemCount} book{l.itemCount === 1 ? '' : 's'}
                  </span>
                </div>
                {l.description && (
                  <p className="mt-3 line-clamp-2 text-sm text-gray-700">{l.description}</p>
                )}
                <div className="mt-3 text-xs text-gray-500">
                  Curated by {l.createdByName ?? '—'}
                  {l.publishedAt && ' · Published ' + formatRelative(l.publishedAt)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New reading list"
        footer={null}
      >
        <CreateForm onClose={() => setCreateOpen(false)} />
      </Modal>
    </div>
  );
}

function CreateForm({ onClose }: { onClose: () => void }) {
  const create = useCreateReadingList();
  const toast = useToast();

  const [form, setForm] = useState<CreateReadingListPayload>({
    name: '',
    listType: 'GENERAL',
  });
  const [description, setDescription] = useState('');

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!form.name.trim()) return;
        try {
          const payload: CreateReadingListPayload = {
            name: form.name.trim(),
            listType: form.listType,
          };
          if (description.trim()) payload.description = description.trim();
          const created = await create.mutateAsync(payload);
          toast.toast('Reading list created. Add books to publish it.');
          onClose();
          window.location.href = '/library/reading-lists/' + created.id;
        } catch (err) {
          toast.toast(err instanceof Error ? err.message : 'Could not create', 'error');
        }
      }}
      className="space-y-3"
    >
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-gray-700">Name</span>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
          maxLength={120}
          placeholder="Grade 5 Adventure Reads"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-gray-700">List type</span>
        <select
          value={form.listType}
          onChange={(e) => setForm({ ...form, listType: e.target.value as ReadingListType })}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        >
          {READING_LIST_TYPES.map((t) => (
            <option key={t} value={t}>
              {READING_LIST_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-gray-700">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={1000}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        />
      </label>
      <p className="text-xs text-gray-500">
        Lists start as drafts. Publish when you&apos;ve added the books you want students to see.
      </p>
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
