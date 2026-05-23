'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageHeader, EmptyState, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useAccAdoptions,
  useAccEvidenceByStatus,
  useAccEvidenceForStandard,
  useAccFrameworks,
  useAccStandards,
  useCreateAccEvidence,
  useReviewAccEvidence,
} from '@/hooks/use-accreditation';
import {
  ACC_EVIDENCE_STATUS_LABEL,
  ACC_EVIDENCE_STATUS_PILL,
  ACC_EVIDENCE_TYPE_LABEL,
  ACC_EVIDENCE_TYPE_PILL,
  formatRelative,
} from '@/lib/accreditation-format';
import { ACC_EVIDENCE_TYPES } from '@/lib/types';
import type { AccEvidenceItemDto, AccEvidenceStatus, AccEvidenceType } from '@/lib/types';

type StatusFilter = AccEvidenceStatus | 'ALL';

export default function EvidenceManagerPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user?.activePersona?.type === 'STAFF';
  const showStaffSurfaces = isStaff || isAdmin;

  const search = useSearchParams();
  const focusedStandardId = search.get('standardId') || undefined;

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('SUBMITTED');
  const queueQ = useAccEvidenceByStatus(statusFilter === 'ALL' ? undefined : statusFilter);
  const standardEvidenceQ = useAccEvidenceForStandard(focusedStandardId);

  const [createOpen, setCreateOpen] = useState(false);
  const [reviewing, setReviewing] = useState<AccEvidenceItemDto | null>(null);

  // Row source: focused standard view OR overall queue
  const rows = focusedStandardId ? (standardEvidenceQ.data ?? []) : (queueQ.data ?? []);

  if (!showStaffSurfaces) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <PageHeader title="Evidence Manager" />
        <EmptyState
          title="Not available"
          description="Accreditation evidence is restricted to staff and administrators."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Evidence Manager"
        description={
          focusedStandardId
            ? 'Evidence linked to the selected standard. Upload more or send drafts for review.'
            : 'Coordinator queue of submitted evidence pending approval. Upload new evidence for any standard.'
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/accreditation"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          ← Dashboard
        </Link>
        <Link
          href="/accreditation/standards"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          Standards
        </Link>
        <button
          type="button"
          className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white hover:bg-campus-700"
          onClick={() => setCreateOpen(true)}
        >
          Upload evidence
        </button>
      </div>

      {/* Filters */}
      {!focusedStandardId && (
        <div className="flex flex-wrap gap-2">
          {(['ALL', 'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={
                'rounded-full border px-3 py-1 text-xs ' +
                (statusFilter === s
                  ? 'border-campus-600 bg-campus-50 text-campus-700'
                  : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')
              }
              onClick={() => setStatusFilter(s)}
            >
              {s === 'ALL' ? 'All' : ACC_EVIDENCE_STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      )}

      {focusedStandardId && (
        <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
          Filtering to evidence linked to standard{' '}
          <span className="font-mono text-xs">{focusedStandardId.slice(0, 8)}…</span>{' '}
          <Link href="/accreditation/evidence" className="underline">
            (clear)
          </Link>
        </div>
      )}

      {/* Table */}
      {rows.length === 0 ? (
        <EmptyState
          title="No evidence"
          description={
            focusedStandardId
              ? 'No evidence has been linked to this standard yet.'
              : 'No evidence matches this status filter.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Title</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Submitted</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-gray-100">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-800">{row.title}</div>
                    {row.description && (
                      <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">{row.description}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
                        ACC_EVIDENCE_TYPE_PILL[row.evidenceType]
                      }
                    >
                      {ACC_EVIDENCE_TYPE_LABEL[row.evidenceType]}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
                        ACC_EVIDENCE_STATUS_PILL[row.status]
                      }
                    >
                      {ACC_EVIDENCE_STATUS_LABEL[row.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {formatRelative(row.submittedAt ?? row.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50"
                      onClick={() => setReviewing(row)}
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create modal */}
      <CreateEvidenceModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        prefilledStandardId={focusedStandardId}
      />

      {/* Review modal */}
      {reviewing && (
        <ReviewEvidenceModal
          item={reviewing}
          open={!!reviewing}
          onClose={() => setReviewing(null)}
        />
      )}
    </div>
  );
}

function CreateEvidenceModal({
  open,
  onClose,
  prefilledStandardId,
}: {
  open: boolean;
  onClose: () => void;
  prefilledStandardId?: string;
}) {
  const { toast } = useToast();
  const create = useCreateAccEvidence();
  const frameworksQ = useAccFrameworks(open);
  const adoptionsQ = useAccAdoptions(open);
  const adopted = useMemo(
    () => (frameworksQ.data ?? []).filter((f) => f.isAdopted),
    [frameworksQ.data],
  );
  const [frameworkId, setFrameworkId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!frameworkId && adopted.length > 0) {
      setFrameworkId(adopted[0]?.id);
    }
  }, [adopted, frameworkId]);
  const standardsQ = useAccStandards(frameworkId);

  const [standardId, setStandardId] = useState(prefilledStandardId ?? '');
  const [evidenceType, setEvidenceType] = useState<AccEvidenceType>('DOCUMENT');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [s3Key, setS3Key] = useState('');
  const [url, setUrl] = useState('');
  const [metricValue, setMetricValue] = useState('');

  useEffect(() => {
    if (prefilledStandardId) setStandardId(prefilledStandardId);
  }, [prefilledStandardId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!standardId) {
      toast('Pick a standard', 'error');
      return;
    }
    if (!title.trim()) {
      toast('Title is required', 'error');
      return;
    }
    if (evidenceType === 'DOCUMENT' && !s3Key.trim()) {
      toast('DOCUMENT evidence requires an s3Key', 'error');
      return;
    }
    if (evidenceType === 'URL' && !url.trim()) {
      toast('URL evidence requires a url', 'error');
      return;
    }
    if (evidenceType === 'METRIC' && !metricValue.trim()) {
      toast('METRIC evidence requires a metricValue', 'error');
      return;
    }
    try {
      await create.mutateAsync({
        standardId,
        evidenceType,
        title: title.trim(),
        description: description || undefined,
        s3Key: s3Key || undefined,
        url: url || undefined,
        metricValue: metricValue || undefined,
      });
      toast('Evidence drafted', 'success');
      setStandardId(prefilledStandardId ?? '');
      setEvidenceType('DOCUMENT');
      setTitle('');
      setDescription('');
      setS3Key('');
      setUrl('');
      setMetricValue('');
      adoptionsQ.refetch();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      toast(msg, 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Upload evidence"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="evidence-form"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm text-white"
            disabled={create.isPending}
          >
            Save draft
          </button>
        </div>
      }
    >
      <form id="evidence-form" onSubmit={submit} className="space-y-3">
        {!prefilledStandardId && (
          <>
            <label className="block text-sm">
              <span className="font-medium text-gray-700">Framework</span>
              <select
                value={frameworkId ?? ''}
                onChange={(e) => {
                  setFrameworkId(e.target.value || undefined);
                  setStandardId('');
                }}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {adopted.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.abbreviation ?? f.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-medium text-gray-700">Standard</span>
              <select
                value={standardId}
                onChange={(e) => setStandardId(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                required
              >
                <option value="">Select…</option>
                {(standardsQ.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.standardCode} — {s.standardText.slice(0, 80)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Type</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {ACC_EVIDENCE_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className={
                  'rounded-full px-3 py-1 text-xs font-medium ' +
                  (evidenceType === t
                    ? ACC_EVIDENCE_TYPE_PILL[t] + ' ring-2 ring-offset-1'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200')
                }
                onClick={() => setEvidenceType(t)}
              >
                {ACC_EVIDENCE_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            maxLength={300}
            required
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            rows={3}
            maxLength={4000}
          />
        </label>
        {evidenceType === 'DOCUMENT' && (
          <label className="block text-sm">
            <span className="font-medium text-gray-700">S3 key</span>
            <input
              type="text"
              value={s3Key}
              onChange={(e) => setS3Key(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="acc/2025-2026/mission-statement.pdf"
              maxLength={500}
              required
            />
            <p className="mt-1 text-xs text-gray-500">
              Upload your document to S3 first, then paste the resulting key here.
            </p>
          </label>
        )}
        {evidenceType === 'URL' && (
          <label className="block text-sm">
            <span className="font-medium text-gray-700">URL</span>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="https://…"
              maxLength={2000}
              required
            />
          </label>
        )}
        {evidenceType === 'METRIC' && (
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Metric value</span>
            <input
              type="text"
              value={metricValue}
              onChange={(e) => setMetricValue(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="92% (2024 NSLP participation)"
              maxLength={500}
              required
            />
          </label>
        )}
      </form>
    </Modal>
  );
}

function ReviewEvidenceModal({
  open,
  onClose,
  item,
}: {
  open: boolean;
  onClose: () => void;
  item: AccEvidenceItemDto;
}) {
  const { toast } = useToast();
  const review = useReviewAccEvidence();
  const [reviewerNotes, setReviewerNotes] = useState(item.reviewerNotes ?? '');

  async function transition(status: 'SUBMITTED' | 'APPROVED' | 'REJECTED') {
    if (status === 'REJECTED' && !reviewerNotes.trim()) {
      toast('Reviewer notes are required when rejecting', 'error');
      return;
    }
    try {
      await review.mutateAsync({
        id: item.id,
        body: { status, reviewerNotes: reviewerNotes || undefined },
      });
      toast(`Status updated to ${status}`, 'success');
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      toast(msg, 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={item.title}
      size="lg"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            Close
          </button>
          {item.status === 'DRAFT' && (
            <button
              type="button"
              className="rounded-md bg-amber-600 px-3 py-1.5 text-sm text-white"
              onClick={() => transition('SUBMITTED')}
              disabled={review.isPending}
            >
              Submit for review
            </button>
          )}
          {item.status === 'SUBMITTED' && (
            <>
              <button
                type="button"
                className="rounded-md bg-rose-600 px-3 py-1.5 text-sm text-white"
                onClick={() => transition('REJECTED')}
                disabled={review.isPending}
              >
                Reject
              </button>
              <button
                type="button"
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white"
                onClick={() => transition('APPROVED')}
                disabled={review.isPending}
              >
                Approve
              </button>
            </>
          )}
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <span
            className={
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
              ACC_EVIDENCE_TYPE_PILL[item.evidenceType]
            }
          >
            {ACC_EVIDENCE_TYPE_LABEL[item.evidenceType]}
          </span>
          <span
            className={
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
              ACC_EVIDENCE_STATUS_PILL[item.status]
            }
          >
            {ACC_EVIDENCE_STATUS_LABEL[item.status]}
          </span>
        </div>
        {item.description && (
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Description
            </span>
            <p className="mt-1 whitespace-pre-wrap text-gray-700">{item.description}</p>
          </div>
        )}
        {item.s3Key && (
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
              S3 key
            </span>
            <p className="mt-1 font-mono text-xs text-gray-700">{item.s3Key}</p>
          </div>
        )}
        {item.url && (
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-gray-500">URL</span>
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="block break-all text-campus-600 hover:text-campus-700"
            >
              {item.url}
            </a>
          </div>
        )}
        {item.metricValue && (
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Metric
            </span>
            <p className="mt-1 text-gray-700">{item.metricValue}</p>
          </div>
        )}
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Reviewer notes
          </span>
          <textarea
            value={reviewerNotes}
            onChange={(e) => setReviewerNotes(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            rows={3}
            maxLength={2000}
            placeholder="Required when rejecting."
          />
        </label>
        <div className="text-xs text-gray-500">
          Submitted {formatRelative(item.submittedAt ?? item.createdAt)}
          {item.reviewedAt ? ` · Reviewed ${formatRelative(item.reviewedAt)}` : ''}
        </div>
      </div>
    </Modal>
  );
}
