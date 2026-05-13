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
  useCreateInterlibraryLoan,
  useInterlibraryLoans,
  useUpdateInterlibraryLoan,
} from '@/hooks/use-library';
import {
  ILL_DIRECTION_LABELS,
  ILL_STATUS_LABELS,
  ILL_STATUS_PILL,
  formatDate,
} from '@/lib/library-format';
import type {
  CreateInterlibraryLoanPayload,
  IllDirection,
  IllStatus,
  InterlibraryLoanDto,
} from '@/lib/types';

/**
 * /library/ill — Librarian interlibrary loan manager.
 *
 * Tracks both BORROWED (we asked a partner for a title not in our
 * catalogue) and LENT (we shipped a copy out) loans through the
 * REQUESTED → IN_TRANSIT → ACTIVE → RETURNED / LOST state machine.
 * Overdue rows surface in rose tinting.
 */
export default function InterlibraryLoanPage() {
  const user = useAuthStore((s) => s.user);
  const isLibrarian = !!user && hasAnyPermission(user, ['sch-001:admin', 'lib-002:write']);

  const [statusFilter, setStatusFilter] = useState<IllStatus | 'ALL'>('ALL');
  const [directionFilter, setDirectionFilter] = useState<IllDirection | 'ALL'>('ALL');
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<InterlibraryLoanDto | null>(null);

  const listQ = useInterlibraryLoans({
    status: statusFilter === 'ALL' ? undefined : statusFilter,
    loanDirection: directionFilter === 'ALL' ? undefined : directionFilter,
  });

  if (!user) return null;
  if (!isLibrarian) {
    return (
      <EmptyState
        title="Librarian access required"
        description="Interlibrary loans are managed by librarians."
      />
    );
  }

  const loans = listQ.data ?? [];
  const overdueCount = loans.filter((l) => l.status === 'OVERDUE').length;
  const activeCount = loans.filter((l) => l.status === 'ACTIVE').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Interlibrary loans"
        description="Borrow titles from district partners or lend copies out."
      />

      <Link href="/library" className="text-sm font-medium text-campus-700 hover:text-campus-800">
        ← Back to library
      </Link>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Active" value={String(activeCount)} tone="emerald" />
        <Stat
          label="Overdue"
          value={String(overdueCount)}
          tone={overdueCount > 0 ? 'rose' : 'gray'}
        />
        <Stat label="Total tracked" value={String(loans.length)} tone="sky" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <FilterPills
            values={['ALL', 'REQUESTED', 'IN_TRANSIT', 'ACTIVE', 'OVERDUE', 'RETURNED'] as const}
            current={statusFilter}
            onChange={(v) => setStatusFilter(v)}
            labels={{ ALL: 'All', ...ILL_STATUS_LABELS }}
          />
          <FilterPills
            values={['ALL', 'BORROWED', 'LENT'] as const}
            current={directionFilter}
            onChange={(v) => setDirectionFilter(v)}
            labels={{ ALL: 'All directions', ...ILL_DIRECTION_LABELS }}
          />
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700"
        >
          + New loan
        </button>
      </div>

      {listQ.isLoading ? (
        <LoadingSpinner />
      ) : loans.length === 0 ? (
        <EmptyState
          title="No interlibrary loans"
          description="Create a borrow or lend request to track it through the partner network."
        />
      ) : (
        <div className="grid gap-3">
          {loans.map((loan) => (
            <LoanRow key={loan.id} loan={loan} onOpen={() => setDetail(loan)} />
          ))}
        </div>
      )}

      <CreateLoanModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <LoanDetailModal loan={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

function FilterPills<T extends string>({
  values,
  current,
  onChange,
  labels,
}: {
  values: readonly T[];
  current: T;
  onChange: (v: T) => void;
  labels: Partial<Record<T, string>>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {values.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={
            'rounded-full px-3 py-1 text-xs font-medium ' +
            (current === v
              ? 'bg-campus-600 text-white'
              : 'border border-gray-200 bg-white text-gray-700 hover:border-campus-300')
          }
        >
          {labels[v] ?? v}
        </button>
      ))}
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
  tone: 'emerald' | 'rose' | 'sky' | 'gray';
}) {
  const palette: Record<typeof tone, string> = {
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    rose: 'bg-rose-50 border-rose-200 text-rose-800',
    sky: 'bg-sky-50 border-sky-200 text-sky-800',
    gray: 'bg-gray-50 border-gray-200 text-gray-800',
  };
  return (
    <div className={'rounded-lg border p-4 ' + palette[tone]}>
      <div className="text-xs uppercase tracking-wide opacity-75">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function LoanRow({ loan, onOpen }: { loan: InterlibraryLoanDto; onOpen: () => void }) {
  const overdue = loan.status === 'OVERDUE';
  return (
    <button
      type="button"
      onClick={onOpen}
      className={
        'block w-full rounded-lg border p-4 text-left transition ' +
        (overdue
          ? 'border-rose-300 bg-rose-50 hover:bg-rose-100'
          : 'border-gray-200 bg-white hover:border-campus-300')
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-gray-900">
            {loan.title}
            {loan.author ? (
              <span className="ml-2 text-sm font-normal text-gray-600">by {loan.author}</span>
            ) : null}
          </div>
          <div className="mt-1 text-sm text-gray-600">
            {ILL_DIRECTION_LABELS[loan.loanDirection]} · {loan.partnerInstitution}
            {loan.dueDate ? ' · Due ' + formatDate(loan.dueDate) : ''}
          </div>
        </div>
        <span
          className={'rounded-full px-2 py-0.5 text-xs font-medium ' + ILL_STATUS_PILL[loan.status]}
        >
          {ILL_STATUS_LABELS[loan.status]}
        </span>
      </div>
    </button>
  );
}

function CreateLoanModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateInterlibraryLoan();
  const today = new Date().toISOString().slice(0, 10);

  const [loanDirection, setLoanDirection] = useState<IllDirection>('BORROWED');
  const [partnerInstitution, setPartnerInstitution] = useState('');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [isbn, setIsbn] = useState('');
  const [catalogueItemId, setCatalogueItemId] = useState('');
  const [requestDate, setRequestDate] = useState(today);
  const [notes, setNotes] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!partnerInstitution.trim()) {
      toast('Provide a partner institution', 'error');
      return;
    }
    if (!title.trim()) {
      toast('Provide a title', 'error');
      return;
    }
    if (loanDirection === 'LENT' && !catalogueItemId.trim()) {
      toast('LENT loans must reference one of our catalogue items', 'error');
      return;
    }
    const body: CreateInterlibraryLoanPayload = {
      loanDirection,
      partnerInstitution: partnerInstitution.trim(),
      title: title.trim(),
      requestDate,
      author: author.trim() || undefined,
      isbn: isbn.trim() || undefined,
      catalogueItemId: catalogueItemId.trim() || undefined,
      notes: notes.trim() || undefined,
    };
    create.mutate(body, {
      onSuccess: () => {
        toast('Loan recorded', 'success');
        onClose();
      },
      onError: (err) => toast((err as Error).message, 'error'),
    });
  }

  return (
    <Modal open={open} title="Record an interlibrary loan" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Direction">
            <select
              value={loanDirection}
              onChange={(e) => setLoanDirection(e.target.value as IllDirection)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            >
              <option value="BORROWED">Borrowed (we asked a partner)</option>
              <option value="LENT">Lent (we shipped a copy)</option>
            </select>
          </Field>
          <Field label="Partner institution">
            <input
              value={partnerInstitution}
              onChange={(e) => setPartnerInstitution(e.target.value)}
              placeholder="e.g. Eastside Elementary"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </Field>
        </div>
        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Author (optional)">
            <input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </Field>
          <Field label="ISBN (optional)">
            <input
              value={isbn}
              onChange={(e) => setIsbn(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </Field>
        </div>
        {loanDirection === 'LENT' && (
          <Field label="Catalogue item id (required for LENT)">
            <input
              value={catalogueItemId}
              onChange={(e) => setCatalogueItemId(e.target.value)}
              placeholder="UUID of the lib_catalogue_items row being shipped"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </Field>
        )}
        <Field label="Request date">
          <input
            type="date"
            value={requestDate}
            onChange={(e) => setRequestDate(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
        <Field label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
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
            Record
          </button>
        </div>
      </form>
    </Modal>
  );
}

function LoanDetailModal({
  loan,
  onClose,
}: {
  loan: InterlibraryLoanDto | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const update = useUpdateInterlibraryLoan(loan?.id ?? '');

  function transition(status: IllStatus, extras: Record<string, string | undefined> = {}) {
    if (!loan) return;
    update.mutate(
      { status, ...extras },
      {
        onSuccess: () => {
          toast('Status set to ' + ILL_STATUS_LABELS[status], 'success');
          onClose();
        },
        onError: (err) => toast((err as Error).message, 'error'),
      },
    );
  }

  if (!loan) return null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Modal open={!!loan} title={loan.title} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div>
          <span className="text-gray-600">Direction:</span>{' '}
          <span className="font-medium">{ILL_DIRECTION_LABELS[loan.loanDirection]}</span>
        </div>
        <div>
          <span className="text-gray-600">Partner:</span>{' '}
          <span className="font-medium">{loan.partnerInstitution}</span>
        </div>
        {loan.author ? (
          <div>
            <span className="text-gray-600">Author:</span> {loan.author}
          </div>
        ) : null}
        {loan.isbn ? (
          <div>
            <span className="text-gray-600">ISBN:</span> {loan.isbn}
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-gray-600">Requested:</span> {formatDate(loan.requestDate)}
          </div>
          {loan.receivedDate && (
            <div>
              <span className="text-gray-600">Received:</span> {formatDate(loan.receivedDate)}
            </div>
          )}
          {loan.sentDate && (
            <div>
              <span className="text-gray-600">Sent:</span> {formatDate(loan.sentDate)}
            </div>
          )}
          {loan.dueDate && (
            <div>
              <span className="text-gray-600">Due:</span> {formatDate(loan.dueDate)}
            </div>
          )}
          {loan.returnedDate && (
            <div>
              <span className="text-gray-600">Returned:</span> {formatDate(loan.returnedDate)}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <span
            className={
              'rounded-full px-2 py-0.5 text-xs font-medium ' + ILL_STATUS_PILL[loan.status]
            }
          >
            {ILL_STATUS_LABELS[loan.status]}
          </span>
        </div>
        {loan.notes ? (
          <div className="rounded-md bg-gray-50 p-3 text-sm text-gray-700">{loan.notes}</div>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-3">
          {loan.status === 'REQUESTED' && (
            <button
              type="button"
              onClick={() => transition('IN_TRANSIT', { sentDate: today })}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-campus-700"
            >
              Mark in transit
            </button>
          )}
          {(loan.status === 'IN_TRANSIT' || loan.status === 'REQUESTED') && (
            <button
              type="button"
              onClick={() => transition('ACTIVE', { receivedDate: today })}
              className="rounded-md bg-campus-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-campus-700"
            >
              Mark active
            </button>
          )}
          {(loan.status === 'ACTIVE' || loan.status === 'OVERDUE') && (
            <button
              type="button"
              onClick={() => transition('RETURNED', { returnedDate: today })}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
            >
              Mark returned
            </button>
          )}
          {loan.status !== 'RETURNED' && loan.status !== 'LOST' && (
            <button
              type="button"
              onClick={() => transition('LOST')}
              className="rounded-md border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
            >
              Mark lost
            </button>
          )}
        </div>
      </div>
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
