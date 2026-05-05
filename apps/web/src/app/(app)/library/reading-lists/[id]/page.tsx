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
  useAddReadingListItem,
  useCatalogueSearch,
  useReadingList,
  useRemoveReadingListItem,
  useUpdateReadingList,
} from '@/hooks/use-library';
import {
  READING_LIST_ITEM_PILL,
  READING_LIST_ITEM_TYPES,
  READING_LIST_ITEM_TYPE_LABELS,
  READING_LIST_TYPE_LABELS,
  formatDate,
} from '@/lib/library-format';
import type { LibraryCatalogueItemSearchHitDto, ReadingListItemType } from '@/lib/types';

/**
 * /library/reading-lists/[id] — Reading list detail with the curated
 * book list. Authors / librarians can add + remove items, change list
 * type, and publish/unpublish via the multi-column `published_chk`
 * lockstep keystone (Step 7 service stamps both atomically).
 */
export default function ReadingListDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? null;
  const user = useAuthStore((s) => s.user);
  const isWriter = !!user && hasAnyPermission(user, ['sch-001:admin', 'lib-003:write']);

  const listQ = useReadingList(id);
  const update = useUpdateReadingList(id ?? '');
  const remove = useRemoveReadingListItem(id ?? '');
  const toast = useToast();

  const [addOpen, setAddOpen] = useState(false);

  if (listQ.isLoading) return <LoadingSpinner />;
  if (!listQ.data) {
    return (
      <div className="space-y-4">
        <PageHeader title="Reading list" />
        <p className="rounded-md bg-rose-50 p-3 text-sm text-rose-800">
          This reading list was not found.
        </p>
      </div>
    );
  }

  const list = listQ.data;
  const items = list.items ?? [];

  const togglePublish = async () => {
    try {
      await update.mutateAsync({ isPublished: !list.isPublished });
      toast.toast(list.isPublished ? 'Unpublished.' : 'Published — visible to readers.');
    } catch (err) {
      toast.toast(err instanceof Error ? err.message : 'Could not update', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <Link
        href="/library/reading-lists"
        className="text-sm font-medium text-campus-700 hover:text-campus-800"
      >
        ← Back to reading lists
      </Link>

      <section className="rounded-lg border border-gray-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-2xl text-gray-900">{list.name}</h1>
              {!list.isPublished && (
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium uppercase text-amber-800 ring-1 ring-amber-200">
                  Draft
                </span>
              )}
              <span className="rounded bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800 ring-1 ring-violet-100">
                {READING_LIST_TYPE_LABELS[list.listType]}
              </span>
            </div>
            <div className="mt-2 text-sm text-gray-600">
              Curated by {list.createdByName ?? '—'}
              {list.publishedAt && ` · Published ${formatDate(list.publishedAt)}`}
            </div>
          </div>
          {isWriter && (
            <div className="flex items-center gap-2">
              <button
                onClick={togglePublish}
                disabled={update.isPending}
                className={
                  'rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60 ' +
                  (list.isPublished
                    ? 'border border-gray-300 bg-white text-gray-800 hover:bg-gray-50'
                    : 'bg-emerald-600 text-white hover:bg-emerald-700')
                }
              >
                {list.isPublished ? 'Unpublish' : 'Publish'}
              </button>
            </div>
          )}
        </div>
        {list.description && (
          <p className="mt-4 text-sm leading-relaxed text-gray-700">{list.description}</p>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-900">Books on this list</h2>
          {isWriter && (
            <button
              onClick={() => setAddOpen(true)}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
            >
              Add book
            </button>
          )}
        </div>

        {items.length === 0 ? (
          <p className="mt-4 text-sm text-gray-600">
            No books on this list yet.
            {isWriter && ' Click "Add book" to get started.'}
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-gray-100">
            {items
              .slice()
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((item) => (
                <li key={item.id} className="flex items-start gap-3 py-3">
                  {item.itemCoverImageUrl ? (
                    <div className="h-16 w-12 flex-shrink-0 overflow-hidden rounded bg-gray-100" />
                  ) : (
                    <div className="flex h-16 w-12 flex-shrink-0 items-center justify-center rounded bg-gray-100 text-xl">
                      📕
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/library/catalogue/${item.catalogueItemId}`}
                      className="font-medium text-gray-900 hover:text-campus-700"
                    >
                      {item.itemTitle ?? '—'}
                    </Link>
                    <div className="mt-0.5 text-xs text-gray-600">{item.itemAuthor ?? '—'}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span
                        className={
                          'rounded px-2 py-0.5 text-[10px] font-medium ' +
                          READING_LIST_ITEM_PILL[item.itemType]
                        }
                      >
                        {READING_LIST_ITEM_TYPE_LABELS[item.itemType]}
                      </span>
                      {item.notes && <span className="text-xs text-gray-600">{item.notes}</span>}
                    </div>
                  </div>
                  {isWriter && (
                    <button
                      onClick={async () => {
                        if (!window.confirm(`Remove "${item.itemTitle ?? 'this book'}"?`)) return;
                        try {
                          await remove.mutateAsync(item.id);
                          toast.toast('Removed.');
                        } catch (err) {
                          toast.toast(
                            err instanceof Error ? err.message : 'Could not remove',
                            'error',
                          );
                        }
                      }}
                      className="text-xs font-medium text-rose-700 hover:text-rose-800"
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
          </ul>
        )}
      </section>

      {id && (
        <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add book" footer={null}>
          <AddItemForm listId={id} onClose={() => setAddOpen(false)} />
        </Modal>
      )}
    </div>
  );
}

function AddItemForm({ listId, onClose }: { listId: string; onClose: () => void }) {
  const add = useAddReadingListItem(listId);
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<LibraryCatalogueItemSearchHitDto | null>(null);
  const [itemType, setItemType] = useState<ReadingListItemType>('RECOMMENDED');
  const [notes, setNotes] = useState('');

  const searchQ = useCatalogueSearch({ q: search.length >= 2 ? search : undefined });
  const results = searchQ.data ?? [];

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!selected) return;
        try {
          await add.mutateAsync({
            catalogueItemId: selected.id,
            itemType,
            notes: notes.trim() || undefined,
          });
          toast.toast('Book added to list.');
          onClose();
        } catch (err) {
          toast.toast(err instanceof Error ? err.message : 'Could not add', 'error');
        }
      }}
      className="space-y-3"
    >
      {!selected ? (
        <>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-700">Find book</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title or author"
              autoFocus
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
                      onClick={() => setSelected(r)}
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
              <div className="font-medium text-gray-900">{selected.title}</div>
              <div className="text-xs text-gray-600">{selected.author ?? '—'}</div>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-xs font-medium text-campus-700"
            >
              Change
            </button>
          </div>
        </div>
      )}

      {selected && (
        <>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-700">Type</span>
            <select
              value={itemType}
              onChange={(e) => setItemType(e.target.value as ReadingListItemType)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              {READING_LIST_ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {READING_LIST_ITEM_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-700">Notes (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="Why is this book on the list?"
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
          disabled={!selected || add.isPending}
          className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-60"
        >
          {add.isPending ? 'Adding…' : 'Add to list'}
        </button>
      </div>
    </form>
  );
}
