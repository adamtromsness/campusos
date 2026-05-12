'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useItDoc, useUpdateItDoc } from '@/hooks/use-it-advanced';
import {
  IT_DOC_CATEGORIES,
  IT_DOC_CATEGORY_LABELS,
  IT_DOC_CATEGORY_PILL,
  formatItDateTime,
} from '@/lib/it-advanced-format';
import type { ItConfigDocCategory } from '@/lib/types';

export default function DocumentationDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const doc = useItDoc(id);
  const update = useUpdateItDoc(id);
  const user = useAuthStore((s) => s.user);
  const canEdit = hasAnyPermission(user, ['it-009:write']);
  const { toast } = useToast();

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<ItConfigDocCategory>('OTHER');
  const [content, setContent] = useState('');
  const [diagramS3Key, setDiagramS3Key] = useState('');

  useEffect(() => {
    if (doc.data) {
      setTitle(doc.data.title);
      setCategory(doc.data.category);
      setContent(doc.data.contentMarkdown);
      setDiagramS3Key(doc.data.diagramS3Key ?? '');
    }
  }, [doc.data]);

  if (doc.isLoading) {
    return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  }
  if (!doc.data) {
    return <div className="p-6 text-sm text-rose-700">Document not found.</div>;
  }
  const d = doc.data;

  const save = async () => {
    if (!title.trim() || !content.trim()) {
      toast('Title and content are required.', 'warning');
      return;
    }
    try {
      const patch: {
        title?: string;
        category?: ItConfigDocCategory;
        contentMarkdown?: string;
        diagramS3Key?: string;
      } = {};
      if (title.trim() !== d.title) patch.title = title.trim();
      if (category !== d.category) patch.category = category;
      if (content !== d.contentMarkdown) patch.contentMarkdown = content;
      if ((diagramS3Key.trim() || null) !== d.diagramS3Key) {
        patch.diagramS3Key = diagramS3Key.trim() || undefined;
      }
      if (Object.keys(patch).length === 0) {
        toast('No changes to save.', 'info');
        setEditing(false);
        return;
      }
      const updated = await update.mutateAsync(patch);
      toast(`Saved v${updated.version}.`, 'success');
      setEditing(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <PageHeader
        title={d.title}
        description={`${IT_DOC_CATEGORY_LABELS[d.category]} · v${d.version}`}
      />
      <div className="rounded-md border border-gray-200 bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className={`rounded px-2 py-0.5 text-xs ${IT_DOC_CATEGORY_PILL[d.category]}`}>
              {IT_DOC_CATEGORY_LABELS[d.category]}
            </span>
            <p className="mt-2 text-xs text-gray-500">
              Version <strong>v{d.version}</strong> · updated {formatItDateTime(d.lastUpdatedAt)}
              {d.lastUpdatedByName ? ` by ${d.lastUpdatedByName}` : ''}
            </p>
            {d.diagramS3Key ? (
              <p className="mt-1 text-xs text-sky-700">
                📎 Diagram: <span className="font-mono">{d.diagramS3Key}</span>
              </p>
            ) : null}
          </div>
          {canEdit && !editing ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700"
            >
              Edit (creates v{d.version + 1})
            </button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="rounded-md border border-campus-200 bg-campus-50 p-4">
          <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            Saving will create version <strong>v{d.version + 1}</strong> atomically inside one
            tenant tx via locked-row UPDATE. The previous version is preserved in the version
            counter.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium uppercase text-gray-600">Title</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium uppercase text-gray-600">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as ItConfigDocCategory)}
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
          <div className="mt-3">
            <label className="text-xs font-medium uppercase text-gray-600">
              Content (markdown)
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={14}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
            />
          </div>
          <div className="mt-3">
            <label className="text-xs font-medium uppercase text-gray-600">Diagram S3 key</label>
            <input
              value={diagramS3Key}
              onChange={(e) => setDiagramS3Key(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
            />
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={update.isPending}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-campus-700"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                if (d) {
                  setTitle(d.title);
                  setCategory(d.category);
                  setContent(d.contentMarkdown);
                  setDiagramS3Key(d.diagramS3Key ?? '');
                }
              }}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <pre className="whitespace-pre-wrap font-sans text-sm text-gray-800">
            {d.contentMarkdown}
          </pre>
        </div>
      )}
    </div>
  );
}
