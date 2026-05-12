'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useCreateItDoc, useItDocs } from '@/hooks/use-it-advanced';
import {
  IT_DOC_CATEGORIES,
  IT_DOC_CATEGORY_LABELS,
  IT_DOC_CATEGORY_PILL,
  formatItDateTime,
} from '@/lib/it-advanced-format';
import type { ItConfigDocCategory } from '@/lib/types';

export default function DocumentationPage() {
  const user = useAuthStore((s) => s.user);
  const canWrite = hasAnyPermission(user, ['it-009:write']);
  const [filter, setFilter] = useState<ItConfigDocCategory | 'ALL'>('ALL');
  const docs = useItDocs(filter === 'ALL' ? undefined : filter);
  const create = useCreateItDoc();
  const { toast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<{
    title: string;
    category: ItConfigDocCategory;
    contentMarkdown: string;
    diagramS3Key: string;
  }>({
    title: '',
    category: 'NETWORK_TOPOLOGY',
    contentMarkdown: '',
    diagramS3Key: '',
  });

  const submit = async () => {
    if (!form.title.trim()) {
      toast('Title required.', 'warning');
      return;
    }
    if (!form.contentMarkdown.trim()) {
      toast('Content required.', 'warning');
      return;
    }
    try {
      await create.mutateAsync({
        title: form.title.trim(),
        category: form.category,
        contentMarkdown: form.contentMarkdown,
        diagramS3Key: form.diagramS3Key.trim() || undefined,
      });
      toast('Document created (v1).', 'success');
      setForm({
        title: '',
        category: 'NETWORK_TOPOLOGY',
        contentMarkdown: '',
        diagramS3Key: '',
      });
      setModalOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create document', 'error');
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <PageHeader
        title="IT documentation"
        description="Versioned configuration documentation with diagram attachments"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <FilterChip label="All" active={filter === 'ALL'} onClick={() => setFilter('ALL')} />
          {IT_DOC_CATEGORIES.map((c) => (
            <FilterChip
              key={c}
              label={IT_DOC_CATEGORY_LABELS[c]}
              active={filter === c}
              onClick={() => setFilter(c)}
            />
          ))}
        </div>
        {canWrite ? (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
          >
            New document
          </button>
        ) : null}
      </div>
      {docs.data?.length === 0 ? (
        <div className="rounded-md border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
          No documents in this category.
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {docs.data?.map((d) => (
            <li
              key={d.id}
              className="rounded-md border border-gray-200 bg-white p-4 transition hover:border-campus-400"
            >
              <div className="flex items-center justify-between">
                <Link
                  href={`/it/documentation/${d.id}`}
                  className="text-base font-medium hover:underline"
                >
                  {d.title}
                </Link>
                <span className={`rounded px-2 py-0.5 text-xs ${IT_DOC_CATEGORY_PILL[d.category]}`}>
                  v{d.version}
                </span>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {IT_DOC_CATEGORY_LABELS[d.category]} · updated {formatItDateTime(d.lastUpdatedAt)}
                {d.lastUpdatedByName ? ` by ${d.lastUpdatedByName}` : ''}
              </p>
              {d.diagramS3Key ? <p className="mt-2 text-xs text-sky-700">📎 Has diagram</p> : null}
              <p className="mt-2 line-clamp-3 text-sm text-gray-700">
                {d.contentMarkdown.slice(0, 200)}
              </p>
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="New IT document"
        size="lg"
        footer={
          <>
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={create.isPending}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-campus-700"
            >
              Create v1
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium uppercase text-gray-500">Title</label>
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                placeholder="Network topology"
              />
            </div>
            <div>
              <label className="text-xs font-medium uppercase text-gray-500">Category</label>
              <select
                value={form.category}
                onChange={(e) =>
                  setForm({ ...form, category: e.target.value as ItConfigDocCategory })
                }
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {IT_DOC_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {IT_DOC_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium uppercase text-gray-500">
              Content (markdown)
            </label>
            <textarea
              value={form.contentMarkdown}
              onChange={(e) => setForm({ ...form, contentMarkdown: e.target.value })}
              rows={10}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
              placeholder="# Title&#10;&#10;Details…"
            />
          </div>
          <div>
            <label className="text-xs font-medium uppercase text-gray-500">
              Diagram S3 key (optional)
            </label>
            <input
              value={form.diagramS3Key}
              onChange={(e) => setForm({ ...form, diagramS3Key: e.target.value })}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono"
              placeholder="it-docs/network-topology-v1.png"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium ${
        active
          ? 'bg-campus-600 text-white'
          : 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
      }`}
    >
      {label}
    </button>
  );
}
