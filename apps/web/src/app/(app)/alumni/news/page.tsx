'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader, EmptyState, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useAlumniNews,
  useCreateAlumniNews,
  useDeleteAlumniNews,
  useUpdateAlumniNews,
} from '@/hooks/use-alumni';
import {
  ALUMNI_NEWS_CATEGORY_LABEL,
  ALUMNI_NEWS_CATEGORY_PILL,
  formatDateOnly,
  formatRelative,
} from '@/lib/alumni-format';
import { ALUMNI_NEWS_CATEGORIES } from '@/lib/types';
import type { AlumniNewsCategory, AlumniNewsDto } from '@/lib/types';

export default function AlumniNewsPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user?.personType === 'STAFF';
  const showStaffSurfaces = isStaff || isAdmin;

  const [categoryFilter, setCategoryFilter] = useState<'ALL' | AlumniNewsCategory>('ALL');
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const newsQ = useAlumniNews({
    category: categoryFilter === 'ALL' ? undefined : categoryFilter,
    includeDrafts: showStaffSurfaces && includeDrafts,
  });
  const [composeOpen, setComposeOpen] = useState(false);
  const [editing, setEditing] = useState<AlumniNewsDto | null>(null);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Alumni News"
        description={
          showStaffSurfaces
            ? 'Publish stories, opportunities, and event invitations to the alumni community.'
            : 'Stories, achievements, and opportunities from the alumni community.'
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/alumni"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          ← Directory
        </Link>
        {showStaffSurfaces && (
          <button
            type="button"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
            onClick={() => setComposeOpen(true)}
          >
            New article
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={
            'rounded-full border px-3 py-1 text-xs ' +
            (categoryFilter === 'ALL'
              ? 'border-campus-600 bg-campus-50 text-campus-700'
              : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')
          }
          onClick={() => setCategoryFilter('ALL')}
        >
          All
        </button>
        {ALUMNI_NEWS_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            className={
              'rounded-full border px-3 py-1 text-xs ' +
              (categoryFilter === c
                ? 'border-campus-600 bg-campus-50 text-campus-700'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')
            }
            onClick={() => setCategoryFilter(c)}
          >
            {ALUMNI_NEWS_CATEGORY_LABEL[c]}
          </button>
        ))}
        {showStaffSurfaces && (
          <label className="ml-2 flex items-center gap-1 text-xs text-gray-700">
            <input
              type="checkbox"
              checked={includeDrafts}
              onChange={(e) => setIncludeDrafts(e.target.checked)}
            />
            Show drafts
          </label>
        )}
      </div>

      {newsQ.isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (newsQ.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="No articles yet"
          description={showStaffSurfaces ? 'Publish the first.' : 'Check back soon.'}
        />
      ) : (
        <ul className="space-y-3">
          {newsQ.data!.map((n) => (
            <li key={n.id} className="rounded-md border border-gray-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-gray-900">{n.title}</h3>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className={
                        'rounded px-1.5 py-0.5 font-medium ' + ALUMNI_NEWS_CATEGORY_PILL[n.category]
                      }
                    >
                      {ALUMNI_NEWS_CATEGORY_LABEL[n.category]}
                    </span>
                    {n.publishedAt ? (
                      <span className="text-gray-500">
                        Published {formatRelative(n.publishedAt)} by {n.authorName ?? 'staff'}
                      </span>
                    ) : (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 font-medium text-gray-700 ring-1 ring-gray-200">
                        Draft
                      </span>
                    )}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">{n.body}</p>
                </div>
                {showStaffSurfaces && (
                  <div className="flex shrink-0 flex-col gap-1">
                    <button
                      type="button"
                      className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
                      onClick={() => setEditing(n)}
                    >
                      Edit
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {showStaffSurfaces && (
        <ComposeNewsModal open={composeOpen} onClose={() => setComposeOpen(false)} />
      )}
      {editing && (
        <EditNewsModal open={!!editing} onClose={() => setEditing(null)} article={editing} />
      )}
    </div>
  );
}

function ComposeNewsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateAlumniNews();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<AlumniNewsCategory>('GENERAL');

  const submit = async (publish: boolean) => {
    if (!title.trim() || !body.trim()) {
      toast('Title and body are required.', 'error');
      return;
    }
    try {
      await create.mutateAsync({ title: title.trim(), body: body.trim(), category, publish });
      toast(publish ? 'Published.' : 'Saved as draft.', 'success');
      setTitle('');
      setBody('');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New article"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={() => submit(false)}
            disabled={create.isPending}
          >
            Save draft
          </button>
          <button
            type="button"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
            onClick={() => submit(true)}
            disabled={create.isPending}
          >
            Publish
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Title</span>
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Category</span>
          <select
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={category}
            onChange={(e) => setCategory(e.target.value as AlumniNewsCategory)}
          >
            {ALUMNI_NEWS_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {ALUMNI_NEWS_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Body</span>
          <textarea
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            rows={10}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}

function EditNewsModal({
  open,
  onClose,
  article,
}: {
  open: boolean;
  onClose: () => void;
  article: AlumniNewsDto;
}) {
  const { toast } = useToast();
  const update = useUpdateAlumniNews(article.id);
  const del = useDeleteAlumniNews();
  const [title, setTitle] = useState(article.title);
  const [body, setBody] = useState(article.body);
  const [category, setCategory] = useState<AlumniNewsCategory>(article.category);

  const save = async (publish?: boolean) => {
    try {
      await update.mutateAsync({
        title: title.trim() || undefined,
        body: body.trim() || undefined,
        category,
        publish,
      });
      toast('Saved.', 'success');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this article? This cannot be undone.')) return;
    try {
      await del.mutateAsync(article.id);
      toast('Deleted.', 'success');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit article"
      size="lg"
      footer={
        <div className="flex w-full items-center justify-between">
          <button
            type="button"
            className="rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50"
            onClick={remove}
          >
            Delete
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={onClose}
            >
              Cancel
            </button>
            {article.publishedAt === null && (
              <button
                type="button"
                className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
                onClick={() => save(true)}
              >
                Publish
              </button>
            )}
            <button
              type="button"
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
              onClick={() => save()}
            >
              Save
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        {article.publishedAt && (
          <p className="text-xs text-gray-500">
            Published {formatDateOnly(article.publishedAt)} by {article.authorName ?? 'staff'}.
          </p>
        )}
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Title</span>
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Category</span>
          <select
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            value={category}
            onChange={(e) => setCategory(e.target.value as AlumniNewsCategory)}
          >
            {ALUMNI_NEWS_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {ALUMNI_NEWS_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500">Body</span>
          <textarea
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            rows={10}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}
