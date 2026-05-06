'use client';

import { useState } from 'react';
import { PageHeader, useToast } from '@/components/ui';
import {
  useApproveSection,
  useCreateSection,
  usePreviewAudience,
  useDistribute,
  usePublications,
  useSections,
  useUpdatePublicationStatus,
} from '@/hooks/use-publications';
import { PUBLICATION_STATUSES, SECTION_TYPE_LABELS, STATUS_PILL } from '@/lib/publications-format';
import type { PubStatus } from '@/lib/types';

export default function EditionEditorPage({ params }: { params: { id: string } }) {
  const { toast } = useToast();
  // Resolve the publication corresponding to this edition.
  const drafts = usePublications();
  const editionPub = drafts.data?.find((p) => p.editionId === params.id);

  const sectionsQ = useSections(editionPub?.id ?? null);
  const updateStatus = useUpdatePublicationStatus(editionPub?.id ?? '');
  const approveSection = useApproveSection();
  const createSection = useCreateSection(editionPub?.id ?? '');
  const previewAudience = usePreviewAudience(editionPub?.id ?? '');
  const distribute = useDistribute(editionPub?.id ?? '');

  const [showCreate, setShowCreate] = useState(false);
  const [newSectionTitle, setNewSectionTitle] = useState('');
  const [newSectionBody, setNewSectionBody] = useState('');

  if (!editionPub) {
    return <p className="p-6 text-sm text-gray-500">Loading edition…</p>;
  }

  const handleStatus = async (status: PubStatus) => {
    try {
      await updateStatus.mutateAsync(status);
      toast(`Status: ${status}`);
    } catch (err) {
      toast(`Failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleApprove = async (sectionId: string) => {
    try {
      await approveSection.mutateAsync(sectionId);
      toast('Section approved');
    } catch (err) {
      toast(`Failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleAddSection = async () => {
    if (!newSectionTitle) return;
    try {
      await createSection.mutateAsync({ title: newSectionTitle, body: newSectionBody });
      setNewSectionTitle('');
      setNewSectionBody('');
      setShowCreate(false);
      toast('Section added');
    } catch (err) {
      toast(`Failed: ${(err as Error).message}`, 'error');
    }
  };

  const handlePreview = async () => {
    try {
      const r = await previewAudience.mutateAsync();
      toast(`Audience: ${r.totalRecipients} (excluded ${r.excludedUnsubscribed} unsubscribed)`);
    } catch (err) {
      toast(`Failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleDistribute = async () => {
    if (!confirm('Distribute this edition to all matching recipients?')) return;
    try {
      const r = await distribute.mutateAsync();
      toast(`Distributed to ${r.totalRecipients} recipients`);
    } catch (err) {
      toast(`Failed: ${(err as Error).message}`, 'error');
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader
        title={editionPub.title}
        description={`Edition #${editionPub.editionNumber ?? ''}`}
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-xs ${STATUS_PILL[editionPub.status]}`}>
          {editionPub.status}
        </span>
        {PUBLICATION_STATUSES.filter((s) => s !== editionPub.status).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => handleStatus(s)}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
          >
            → {s}
          </button>
        ))}
      </div>

      {editionPub.status === 'APPROVED' && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handlePreview}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            Preview audience
          </button>
          <button
            type="button"
            onClick={handleDistribute}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
          >
            Distribute
          </button>
        </div>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Sections ({editionPub.pendingSectionCount} pending)
          </h2>
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
          >
            {showCreate ? 'Cancel' : 'Add section'}
          </button>
        </div>

        {showCreate && (
          <div className="mb-3 space-y-2 rounded-md border border-gray-200 bg-white p-3">
            <input
              type="text"
              value={newSectionTitle}
              onChange={(e) => setNewSectionTitle(e.target.value)}
              placeholder="Section title"
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
            <textarea
              value={newSectionBody}
              onChange={(e) => setNewSectionBody(e.target.value)}
              placeholder="Section body"
              rows={4}
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
            <button
              type="button"
              onClick={handleAddSection}
              disabled={!newSectionTitle}
              className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800 disabled:opacity-50"
            >
              Save section
            </button>
          </div>
        )}

        {(sectionsQ.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">No sections yet.</p>
        ) : (
          <ul className="space-y-2">
            {sectionsQ.data!.map((sec) => (
              <li
                key={sec.id}
                className={`rounded-md border p-3 ${sec.isApproved ? 'border-gray-200 bg-white' : 'border-amber-300 bg-amber-50/40'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900">{sec.title}</p>
                    <p className="text-xs text-gray-500">
                      {SECTION_TYPE_LABELS[sec.sectionType]}
                      {sec.ownerName ? ` · ${sec.ownerName}` : ''}
                    </p>
                  </div>
                  {!sec.isApproved && (
                    <button
                      type="button"
                      onClick={() => handleApprove(sec.id)}
                      className="rounded-md bg-campus-700 px-2 py-1 text-xs text-white hover:bg-campus-800"
                    >
                      Approve
                    </button>
                  )}
                </div>
                {sec.body && (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">{sec.body}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
