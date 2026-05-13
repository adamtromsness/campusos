'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useCatalogueImport,
  useCatalogueImports,
  useCreateCatalogueImport,
} from '@/hooks/use-library';
import {
  IMPORT_STATUS_LABELS,
  IMPORT_STATUS_PILL,
  IMPORT_TYPE_LABELS,
  formatDate,
} from '@/lib/library-format';
import type {
  CatalogueImportJobDto,
  CreateCatalogueImportJobPayload,
  ImportType,
} from '@/lib/types';

/**
 * /library/imports — Librarian bulk catalogue import.
 *
 * Pastes ISBN list or supplies an S3 key for an uploaded CSV / MARC
 * file. The CatalogueImportWorker parses + inserts asynchronously
 * and the page polls every 3-5s while a job is running. Failures
 * generate a downloadable error log.
 */
export default function CatalogueImportPage() {
  const user = useAuthStore((s) => s.user);
  const isLibrarian = !!user && hasAnyPermission(user, ['sch-001:admin', 'lib-002:write']);

  const [createOpen, setCreateOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const jobsQ = useCatalogueImports();
  const detailQ = useCatalogueImport(activeId);

  if (!user) return null;
  if (!isLibrarian) {
    return (
      <EmptyState
        title="Librarian access required"
        description="Bulk catalogue imports are managed by librarians."
      />
    );
  }

  const jobs = jobsQ.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Catalogue import"
        description="Bulk-load titles from ISBN lists, MARC records, or CSV uploads."
      />

      <Link href="/library" className="text-sm font-medium text-campus-700 hover:text-campus-800">
        ← Back to library
      </Link>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700"
        >
          + New import
        </button>
      </div>

      {jobsQ.isLoading ? (
        <LoadingSpinner />
      ) : jobs.length === 0 ? (
        <EmptyState
          title="No imports yet"
          description="Paste a list of ISBNs or upload a CSV / MARC file to bulk-load titles."
        />
      ) : (
        <div className="grid gap-3">
          {jobs.map((j) => (
            <JobCard key={j.id} job={j} onOpen={() => setActiveId(j.id)} />
          ))}
        </div>
      )}

      <CreateImportModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <JobDetailModal
        job={detailQ.data ?? null}
        loading={detailQ.isLoading}
        onClose={() => setActiveId(null)}
        open={!!activeId}
      />
    </div>
  );
}

function JobCard({ job, onOpen }: { job: CatalogueImportJobDto; onOpen: () => void }) {
  const running = job.status === 'QUEUED' || job.status === 'PARSING' || job.status === 'IMPORTING';
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-full rounded-lg border border-gray-200 bg-white p-4 text-left transition hover:border-campus-300"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-gray-900">{IMPORT_TYPE_LABELS[job.importType]}</div>
          <div className="mt-1 text-sm text-gray-600">
            Started {formatDate(job.createdAt)}
            {job.initiatedByName ? ' · by ' + job.initiatedByName : ''}
          </div>
        </div>
        <span
          className={
            'rounded-full px-2 py-0.5 text-xs font-medium ' + IMPORT_STATUS_PILL[job.status]
          }
        >
          {IMPORT_STATUS_LABELS[job.status]}
        </span>
      </div>
      <ProgressRow job={job} />
      {running && (
        <div className="mt-2 text-xs text-sky-700">Processing — this page polls automatically.</div>
      )}
    </button>
  );
}

function ProgressRow({ job }: { job: CatalogueImportJobDto }) {
  const total = job.totalRecords ?? 0;
  const done = job.recordsImported + job.recordsSkipped + job.recordsFailed;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-3 text-xs">
        <Stat label="Imported" value={String(job.recordsImported)} tone="emerald" />
        <Stat label="Skipped (duplicate)" value={String(job.recordsSkipped)} tone="amber" />
        <Stat
          label="Failed"
          value={String(job.recordsFailed)}
          tone={job.recordsFailed > 0 ? 'rose' : 'gray'}
        />
        {total > 0 && <Stat label="Total" value={String(total)} tone="sky" />}
      </div>
      {total > 0 && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
          <div className="h-full bg-campus-500" style={{ width: pct + '%' }} />
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'emerald' | 'amber' | 'rose' | 'sky' | 'gray';
}) {
  const palette: Record<typeof tone, string> = {
    emerald: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700',
    sky: 'bg-sky-50 text-sky-700',
    gray: 'bg-gray-50 text-gray-700',
  };
  return (
    <div className={'rounded-md px-2 py-1 ' + palette[tone]}>
      <span className="font-semibold">{value}</span> <span className="opacity-75">{label}</span>
    </div>
  );
}

function CreateImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateCatalogueImport();

  const [importType, setImportType] = useState<ImportType>('ISBN_BATCH');
  const [isbnsRaw, setIsbnsRaw] = useState('');
  const [sourceFileS3Key, setSourceFileS3Key] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (importType === 'ISBN_BATCH') {
      const isbns = isbnsRaw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (isbns.length === 0) {
        toast('Paste at least one ISBN', 'error');
        return;
      }
      const body: CreateCatalogueImportJobPayload = { importType, isbns };
      create.mutate(body, {
        onSuccess: () => {
          toast('Import queued — ' + isbns.length + ' ISBN(s)', 'success');
          onClose();
        },
        onError: (err) => toast((err as Error).message, 'error'),
      });
      return;
    }
    if (!sourceFileS3Key.trim()) {
      toast(IMPORT_TYPE_LABELS[importType] + ' requires a source file S3 key', 'error');
      return;
    }
    create.mutate(
      { importType, sourceFileS3Key: sourceFileS3Key.trim() },
      {
        onSuccess: () => {
          toast('Import queued', 'success');
          onClose();
        },
        onError: (err) => toast((err as Error).message, 'error'),
      },
    );
  }

  return (
    <Modal open={open} title="New catalogue import" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Import type">
          <select
            value={importType}
            onChange={(e) => setImportType(e.target.value as ImportType)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          >
            <option value="ISBN_BATCH">ISBN batch (paste ISBN list)</option>
            <option value="CSV_UPLOAD">CSV upload</option>
            <option value="MARC_IMPORT">MARC records</option>
            <option value="WORLDCAT_SYNC">WorldCat sync</option>
          </select>
        </Field>
        {importType === 'ISBN_BATCH' ? (
          <Field label="ISBNs (one per line or comma-separated)">
            <textarea
              value={isbnsRaw}
              onChange={(e) => setIsbnsRaw(e.target.value)}
              rows={6}
              placeholder="9780544336261&#10;9780064400558&#10;9780440219071"
              className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </Field>
        ) : (
          <Field label="Source file S3 key">
            <input
              value={sourceFileS3Key}
              onChange={(e) => setSourceFileS3Key(e.target.value)}
              placeholder="library/imports/2026/march-batch.csv"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </Field>
        )}
        <div className="rounded-md bg-amber-50 p-3 text-xs text-amber-800">
          Duplicate ISBNs count as <strong>skipped</strong>, not failed. Failed rows generate a
          downloadable error log on the job detail page.
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            Queue import
          </button>
        </div>
      </form>
    </Modal>
  );
}

function JobDetailModal({
  job,
  loading,
  open,
  onClose,
}: {
  job: CatalogueImportJobDto | null;
  loading: boolean;
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <Modal
      open={open}
      title={job ? IMPORT_TYPE_LABELS[job.importType] + ' job' : 'Loading…'}
      onClose={onClose}
    >
      {loading || !job ? (
        <LoadingSpinner />
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <span
              className={
                'rounded-full px-2 py-0.5 text-xs font-medium ' + IMPORT_STATUS_PILL[job.status]
              }
            >
              {IMPORT_STATUS_LABELS[job.status]}
            </span>
            <span className="text-gray-600">Created {formatDate(job.createdAt)}</span>
          </div>
          {job.startedAt && (
            <div>
              <span className="text-gray-600">Started:</span> {formatDate(job.startedAt)}
            </div>
          )}
          {job.completedAt && (
            <div>
              <span className="text-gray-600">Completed:</span> {formatDate(job.completedAt)}
            </div>
          )}
          {job.initiatedByName && (
            <div>
              <span className="text-gray-600">Initiated by:</span> {job.initiatedByName}
            </div>
          )}
          <ProgressRow job={job} />
          {job.errorLogS3Key && (
            <div className="rounded-md bg-rose-50 p-3 text-sm text-rose-800">
              <strong>Error log:</strong>{' '}
              <span className="font-mono text-xs">{job.errorLogS3Key}</span>
              <div className="mt-1 text-xs">
                Download from the school&apos;s S3 bucket to inspect the failed rows.
              </div>
            </div>
          )}
          {job.sourceFileS3Key && (
            <div className="text-xs text-gray-600">
              Source: <span className="font-mono">{job.sourceFileS3Key}</span>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-600">
        {label}
      </span>
      {children}
    </label>
  );
}
